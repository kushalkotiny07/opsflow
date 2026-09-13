import { Prisma } from "@prisma/client";
import prisma from "@/lib/db/client";
import { hasWhatsAppTarget, resolveLabTarget } from "./target";
import { fetchOrderSnapshotsByIds } from "@/lib/engine/labstack";
import { ensureTemplate, isNonApiTemplateKey, renderLabTemplate, type TemplateVariables } from "./templates";
import { arbitrate, recomputeAppointmentRungs, rungDefinition, tokenExpiryFor } from "./ladder";
import { classifySourceOrder } from "./source-check";
import { toCommunicationRule } from "./rule-store";
import { evaluateSendCondition, type CommunicationRule } from "./rules";

export type NonApiScheduledKind = "REMINDER" | "ESCALATE";

export type NonApiWorkflowSnapshot = {
  orderId?: number;
  labName?: string;
  patientName?: string;
  appointmentTime?: string | Date | null;
  location?: string;
  tests?: string;
  confirmationDeadline?: Date | string | null;
};

const RUNNER_ID = "non-api-lab-scheduler";
const BATCH_SIZE = 200;

/**
 * A transient failure (replica timeout, breaker open) returns the action to
 * PENDING rather than killing it. Only after this many consecutive attempts do
 * we give up and raise an alert — previously any throw was terminal and silent,
 * so a single blip permanently dropped a reminder.
 */
const MAX_ATTEMPTS = 5;

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function actionUrl(token: string) {
  return `${(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")}/provider/action/${token}`;
}

const TIME_ZONE = () => process.env.TIMEZONE || "Asia/Kolkata";

function formatDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: TIME_ZONE() }).format(date);
}

/**
 * Time only. This used to render the full date here while workflow.ts rendered
 * time only, so a template reading "{{appointment_date}} at {{appointment_time}}"
 * repeated the date in every reminder.
 */
function formatTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE() }).format(date);
}

function formatDateTime(value: Date | string): string {
  return `${formatDate(value)} ${formatTime(value)}`;
}

function textForOrder(snapshot: NonApiWorkflowSnapshot): string {
  const patient = snapshot.patientName || "Patient";
  const orderId = snapshot.orderId ? `#${snapshot.orderId}` : "this order";
  const appointment = snapshot.appointmentTime ? formatDateTime(snapshot.appointmentTime) : "your scheduled appointment";
  const location = snapshot.location || "the agreed location";
  const tests = snapshot.tests || "the requested tests";
  return `${patient} (${orderId}) · ${appointment} · ${location} · ${tests}`;
}

export function buildNonApiScheduledMessage(
  kind: NonApiScheduledKind,
  snapshot: NonApiWorkflowSnapshot,
  acceptUrl: string,
  rescheduleUrl: string,
  rejectUrl: string,
): string {
  const orderSummary = textForOrder(snapshot);
  const deadline = snapshot.confirmationDeadline ? formatDateTime(snapshot.confirmationDeadline) : "the requested confirmation deadline";

  if (kind === "REMINDER") {
    return [
      "Reminder: please confirm this LabStack order.",
      `Patient/order: ${orderSummary}`,
      `Please confirm by ${deadline}.`,
      "",
      `Accept: ${acceptUrl}`,
      `Reschedule: ${rescheduleUrl}`,
      `Cannot fulfil: ${rejectUrl}`,
    ].join("\n");
  }

  return [
    "Escalation: we still need a confirmation from your team for this LabStack order.",
    `Patient/order: ${orderSummary}`,
    `Please confirm by ${deadline}.`,
    "",
    `Accept: ${acceptUrl}`,
    `Reschedule: ${rescheduleUrl}`,
    `Cannot fulfil: ${rejectUrl}`,
  ].join("\n");
}

function isWorkflowClosed(status: string | null | undefined) {
  return ["LAB_ACCEPTED", "LAB_RESCHEDULE_REQUESTED", "LAB_REJECTED", "COMPLETED", "CANCELLED"].includes(status ?? "");
}

type DueAction = {
  id: string;
  workflowId: string;
  type: "SEND_REMINDER" | "ESCALATE";
  runAt: Date;
  attempts: number;
  anchor: string;
  offsetMinutes: number;
  priority: number;
  rungKey: string | null;
  /** Set when a provider communication rule scheduled this action. */
  ruleId: string | null;
};

export type NonApiSchedulerResult = {
  processed: number;
  suppressed: number;
  deferred: number;
  rescheduled: number;
  closed: number;
  retried: number;
  failed: number;
};

/** In-app alert for Ops. There is no WHATSAPP member on AlertChannel; slaWatcher
 *  carries routing in metadata the same way. */
async function raiseOpsAlert(message: string, labId: number | null, metadata: Record<string, unknown>) {
  await prisma.alert
    .create({
      data: {
        alertType: "ESCALATION",
        severity: "URGENT",
        channel: "IN_APP",
        status: "PENDING",
        entityType: "non_api_lab",
        entityId: labId,
        message,
        metadata: metadata as Prisma.InputJsonValue,
      },
    })
    .catch((error) => console.error("[NonApiScheduler] Could not raise Ops alert:", error));
}

/**
 * Return actions to PENDING so a later tick retries them; give up after
 * MAX_ATTEMPTS.
 *
 * Every write is guarded on `status: "RUNNING"`. The catch-all in the main loop
 * hands us every action for the workflow, but by then arbitration may already
 * have SUPPRESSED the losing rungs or COMPLETED the winner — an unguarded
 * update would resurrect a suppressed reminder and send it later.
 */
async function releaseForRetry(actions: DueAction[], reason: string, result: NonApiSchedulerResult) {
  const now = new Date();
  for (const action of actions) {
    const attempts = action.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;

    const updated = await prisma.labScheduledAction
      .updateMany({
        where: { id: action.id, status: "RUNNING" },
        data: giveUp
          ? { status: "FAILED", attempts, lastError: reason, lockedAt: null, lockedBy: null, completedAt: now }
          : { status: "PENDING", attempts, lastError: reason, lockedAt: null, lockedBy: null },
      })
      .catch(() => ({ count: 0 }));
    if (updated.count === 0) continue;

    if (giveUp) {
      await raiseOpsAlert(
        `Lab reminder gave up after ${attempts} attempts: ${reason}`,
        null,
        { scheduledActionId: action.id, workflowId: action.workflowId, rungKey: action.rungKey },
      );
      result.failed += 1;
    } else {
      result.retried += 1;
    }
  }
}

/**
 * Hand an action back to a later tick. The claim is released so the next tick
 * can take it, and `runAt` moves to the moment it becomes sendable — a
 * deferred message keeps its place in the queue rather than being retried in a
 * tight loop until its window opens.
 */
async function deferAction(actionId: string, runAt: Date) {
  await prisma.labScheduledAction
    .updateMany({
      where: { id: actionId, status: "RUNNING" },
      data: { status: "PENDING", runAt, lockedAt: null, lockedBy: null },
    })
    .catch(() => ({ count: 0 }));
}

async function suppressActions(actions: DueAction[], workflowId: string, reason: string, result: NonApiSchedulerResult) {
  const now = new Date();
  for (const action of actions) {
    await prisma.labScheduledAction
      .update({
        where: { id: action.id },
        data: { status: "SUPPRESSED", completedAt: now, cancelledAt: now, lastError: reason, lockedAt: null, lockedBy: null },
      })
      .catch(() => undefined);
    result.suppressed += 1;
  }
  await prisma.labCommunicationOrderEvent
    .create({
      data: {
        workflowId,
        type: "REMINDER_SUPPRESSED",
        actorType: "SYSTEM",
        payload: { reason, scheduledActionIds: actions.map((a) => a.id) },
      },
    })
    .catch(() => undefined);
}

/**
 * The order is dead or done upstream. Suppress everything still pending for it
 * — not just what was due this tick — and close the workflow.
 */
async function closeWorkflow(
  workflowId: string,
  workflowStatus: "CANCELLED" | "COMPLETED",
  reason: string,
  result: NonApiSchedulerResult,
) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.labScheduledAction.updateMany({
      where: { workflowId, status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "SUPPRESSED", completedAt: now, cancelledAt: now, lastError: reason, lockedAt: null, lockedBy: null },
    });
    await tx.labCommunicationWorkflow.update({
      where: { id: workflowId },
      data: {
        status: workflowStatus,
        cancelledAt: workflowStatus === "CANCELLED" ? now : undefined,
        completedAt: workflowStatus === "COMPLETED" ? now : undefined,
      },
    });
    await tx.labCommunicationOrderEvent.create({
      data: {
        workflowId,
        // The enum has no WORKFLOW_COMPLETED member; a completion is recorded
        // as a suppression plus the audit entry below.
        type: workflowStatus === "CANCELLED" ? "WORKFLOW_CANCELLED" : "REMINDER_SUPPRESSED",
        actorType: "SYSTEM",
        payload: { reason, workflowStatus },
      },
    });
    await tx.labCommunicationAuditLog.create({
      data: {
        workflowId,
        action: `WORKFLOW_${workflowStatus}`,
        actorType: "SYSTEM",
        metadata: { reason, source: "labstack-recheck" },
      },
    });
  });
  result.closed += 1;
}

/** The appointment moved upstream. Re-derive every appointment-anchored rung. */
async function applyReschedule(
  workflowId: string,
  newAppointmentTime: Date | null,
  reason: string,
  claimed: DueAction[],
  result: NonApiSchedulerResult,
) {
  const now = new Date();
  const pending = await prisma.labScheduledAction.findMany({
    where: { workflowId, status: { in: ["PENDING", "RUNNING"] } },
  });

  const outcomes = recomputeAppointmentRungs(
    pending.map((action) => ({
      id: action.id,
      rungKey: action.rungKey,
      anchor: action.anchor,
      offsetMinutes: action.offsetMinutes,
      runAt: action.runAt,
    })),
    newAppointmentTime,
    now,
  );

  const claimedIds = new Set(claimed.map((a) => a.id));

  await prisma.$transaction(async (tx) => {
    await tx.labCommunicationWorkflow.update({
      where: { id: workflowId },
      data: { appointmentTime: newAppointmentTime },
    });

    for (const outcome of outcomes) {
      if (outcome.outcome === "RESCHEDULED") {
        await tx.labScheduledAction.update({
          where: { id: outcome.id },
          data: { status: "PENDING", runAt: outcome.runAt, lockedAt: null, lockedBy: null },
        });
      } else if (outcome.outcome === "SUPPRESSED") {
        await tx.labScheduledAction.update({
          where: { id: outcome.id },
          data: { status: "SUPPRESSED", completedAt: now, cancelledAt: now, lastError: outcome.reason, lockedAt: null, lockedBy: null },
        });
      } else if (claimedIds.has(outcome.id)) {
        // Order-anchored and still due — hand it back for the next tick rather
        // than sending on a tick where the appointment just moved under us.
        await tx.labScheduledAction.update({
          where: { id: outcome.id },
          data: { status: "PENDING", lockedAt: null, lockedBy: null },
        });
      }
    }

    await tx.labCommunicationOrderEvent.create({
      data: {
        workflowId,
        type: "REMINDER_SCHEDULED",
        actorType: "SYSTEM",
        payload: {
          reason,
          appointmentTime: newAppointmentTime ? newAppointmentTime.toISOString() : null,
          rescheduled: outcomes.filter((o) => o.outcome === "RESCHEDULED").length,
          suppressed: outcomes.filter((o) => o.outcome === "SUPPRESSED").length,
        },
      },
    });
  });

  result.rescheduled += 1;
}

/**
 * Runs every due reminder and escalation.
 *
 * Three guarantees this function did not previously provide:
 *  1. Nothing is sent without re-reading the order from LabStack first.
 *  2. At most one message per workflow per tick, arbitrated across both clocks.
 *  3. Escalations go to the lab's manager, not back to the silent lab inbox.
 */
export async function processDueNonApiLabScheduledActions(): Promise<NonApiSchedulerResult> {
  const result: NonApiSchedulerResult = {
    processed: 0, suppressed: 0, deferred: 0, rescheduled: 0, closed: 0, retried: 0, failed: 0,
  };
  const now = new Date();

  const due = await prisma.labScheduledAction.findMany({
    where: { status: "PENDING", runAt: { lte: now } },
    orderBy: { runAt: "asc" },
    take: BATCH_SIZE,
  });
  if (due.length === 0) return result;

  // Compare-and-set claim, one row at a time, so two runners can't both take
  // the same action.
  const claimed: DueAction[] = [];
  for (const action of due) {
    const won = await prisma.labScheduledAction.updateMany({
      where: { id: action.id, status: "PENDING" },
      data: { status: "RUNNING", lockedAt: now, lockedBy: RUNNER_ID },
    });
    if (won.count > 0) claimed.push(action as DueAction);
  }
  if (claimed.length === 0) return result;

  const byWorkflow = new Map<string, DueAction[]>();
  for (const action of claimed) {
    const bucket = byWorkflow.get(action.workflowId);
    if (bucket) bucket.push(action);
    else byWorkflow.set(action.workflowId, [action]);
  }

  const workflows = await prisma.labCommunicationWorkflow.findMany({
    where: { id: { in: [...byWorkflow.keys()] } },
  });
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));

  // Actions whose workflow vanished are dead weight, not retryable.
  for (const [workflowId, actions] of byWorkflow) {
    if (workflowById.has(workflowId)) continue;
    for (const action of actions) {
      await prisma.labScheduledAction
        .update({
          where: { id: action.id },
          data: { status: "CANCELLED", completedAt: now, cancelledAt: now, lastError: "Missing workflow", lockedAt: null, lockedBy: null },
        })
        .catch(() => undefined);
      result.failed += 1;
    }
    byWorkflow.delete(workflowId);
  }
  if (byWorkflow.size === 0) return result;

  // ── The re-read. One bounded, id-scoped query for the whole batch. ────────
  const snapshots = await fetchOrderSnapshotsByIds(workflows.map((workflow) => workflow.orderId));
  if (snapshots === null) {
    // Unknown is not cancelled. Hand everything back and try again next tick.
    await releaseForRetry([...byWorkflow.values()].flat(), "LabStack source re-read unavailable", result);
    return result;
  }

  const configs = await prisma.nonApiLabConfig.findMany({
    where: { labId: { in: workflows.map((workflow) => workflow.labId) } },
  });
  const configByLabId = new Map(configs.map((config) => [config.labId, config]));

  // The rules behind the rule-scheduled actions in this batch. One query for
  // the batch: a tick that wakes fifty workflows should not read the same
  // handful of rules fifty times.
  const ruleIds = [
    ...new Set(
      [...byWorkflow.values()].flat()
        .map((action) => action.ruleId)
        .filter((ruleId): ruleId is string => Boolean(ruleId)),
    ),
  ];
  const ruleById = new Map<string, CommunicationRule>();
  if (ruleIds.length > 0) {
    const rows = await prisma.providerCommunicationRule.findMany({ where: { id: { in: ruleIds } } });
    for (const row of rows) ruleById.set(row.id, toCommunicationRule(row));
  }

  for (const [workflowId, actions] of byWorkflow) {
    const workflow = workflowById.get(workflowId)!;
    try {
      if (isWorkflowClosed(workflow.status)) {
        await suppressActions(actions, workflowId, `Workflow already ${workflow.status}`, result);
        continue;
      }

      const config = configByLabId.get(workflow.labId);
      if (!config || !config.isActive || config.integrationType !== "NON_API" || !hasWhatsAppTarget(config)) {
        await suppressActions(actions, workflowId, "Lab config unavailable", result);
        continue;
      }

      const sourceSnapshot = snapshots.get(workflow.orderId);
      const verdict = classifySourceOrder(sourceSnapshot, workflow.appointmentTime);

      if (verdict.kind === "CLOSE") {
        await closeWorkflow(workflowId, verdict.workflowStatus, verdict.reason, result);
        result.suppressed += actions.length;
        continue;
      }

      if (verdict.kind === "RESCHEDULE") {
        await applyReschedule(workflowId, verdict.appointmentTime, verdict.reason, actions, result);
        continue;
      }

      // ── Arbitration: at most one message per workflow per tick. ──────────
      const lastCommunication = await prisma.labCommunication.findFirst({
        where: { workflowId },
        orderBy: { createdAt: "desc" },
        select: { sentAt: true, createdAt: true },
      });
      const lastSentAt = lastCommunication ? lastCommunication.sentAt ?? lastCommunication.createdAt : null;

      // ── Rule gates ───────────────────────────────────────────────────────
      // A rule-scheduled action is a guess the rule made when the order
      // arrived. This is the only honest place to check it: the workflow may
      // have moved on, the order may have changed status upstream, and it may
      // now be the middle of the provider's night. Built-in ladder rungs have
      // no rule and go straight to arbitration, exactly as before.
      const eligible: DueAction[] = [];
      for (const action of actions) {
        if (!action.ruleId) {
          eligible.push(action);
          continue;
        }
        const rule = ruleById.get(action.ruleId);
        if (!rule) {
          await suppressActions([action], workflowId, "The rule that scheduled this message no longer exists", result);
          continue;
        }
        if (!rule.isActive) {
          await suppressActions([action], workflowId, `Rule "${rule.name}" is switched off`, result);
          continue;
        }

        const gate = evaluateSendCondition(rule, {
          workflowStatus: workflow.status,
          sourceOrderStatus: sourceSnapshot?.orderStatus ?? null,
          appointmentTime: workflow.appointmentTime,
          lastMessageAt: lastSentAt,
          timeZone: TIME_ZONE(),
        }, now);

        if (gate.verdict === "SKIP") {
          await suppressActions([action], workflowId, `${rule.name}: ${gate.reason}`, result);
          continue;
        }
        if (gate.verdict === "DEFER") {
          await deferAction(action.id, gate.runAt);
          result.deferred += 1;
          continue;
        }
        eligible.push(action);
      }
      if (eligible.length === 0) continue;

      const decision = arbitrate(eligible, {
        quietWindowMinutes: config.quietWindowMinutes,
        lastSentAt,
        now,
      });

      for (const loser of decision.suppress) {
        await suppressActions([loser.action], workflowId, loser.reason, result);
      }
      for (const held of decision.defer) {
        await deferAction(held.action.id, held.runAt);
        result.deferred += 1;
      }
      if (!decision.send) continue;

      const outcome = await sendForAction(decision.send, workflow, config, now, decision.send.ruleId ? ruleById.get(decision.send.ruleId) ?? null : null);
      if (outcome?.suppressed) {
        await suppressActions([decision.send], workflowId, outcome.suppressed, result);
        continue;
      }
      result.processed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[NonApiScheduler] Workflow ${workflowId} failed:`, reason);
      await releaseForRetry(actions, reason, result);
    }
  }

  return result;
}

type WorkflowRow = Awaited<ReturnType<typeof prisma.labCommunicationWorkflow.findMany>>[number];
type ConfigRow = Awaited<ReturnType<typeof prisma.nonApiLabConfig.findMany>>[number];

/**
 * Returns a suppression reason instead of sending, when the step's message
 * turns out to be switched off. It used to throw for that case, which the
 * caller's catch treated as a transient failure and put the action back on
 * PENDING — so a deliberately paused template produced an endless retry every
 * minute until the attempt ceiling marked it FAILED, rather than the clean
 * "this step is off" a paused RULE already produces. Pausing is an intent, not
 * an error.
 */
async function sendForAction(
  action: DueAction,
  workflow: WorkflowRow,
  config: ConfigRow,
  now: Date,
  rule: CommunicationRule | null,
): Promise<{ suppressed: string } | null> {
  const isEscalation = action.type === "ESCALATE";
  const rung = rungDefinition(action.rungKey);
  const isAppointmentRung = rung?.anchor === "APPOINTMENT" || action.anchor === "APPOINTMENT";

  // Who hears about it. A rule states this outright; the built-in ladder
  // infers it from the action type, where an escalation exists to reach
  // someone *above* the inbox that has been ignoring us. Either way, falling
  // back to the lab number when no manager is on file keeps the message
  // moving, and the gap is surfaced to Ops rather than silently swallowed.
  const wantsManager = rule ? rule.recipient === "MANAGER" : isEscalation;
  const managerMissing = wantsManager && !config.managerWhatsapp;
  // A manager is a person, so that override addresses a handset; everything
  // else goes to the lab's own target, which is its group when one is set.
  const target = await resolveLabTarget(config, wantsManager ? config.managerWhatsapp : null);
  const recipient = target.targetJid;

  const selectedTemplateKey = rule?.templateKey ?? (isEscalation
    ? config.escalationTemplateKey
    : isAppointmentRung
      ? config.appointmentTemplateKey
      : config.reminderTemplateKey);
  const fallbackTemplateKey = isEscalation
    ? "NON_API_ESCALATION"
    : isAppointmentRung
      ? "NON_API_APPOINTMENT_REMINDER"
      : "NON_API_REMINDER";
  const templateKey = isNonApiTemplateKey(selectedTemplateKey) ? selectedTemplateKey : fallbackTemplateKey;
  const template = await ensureTemplate(templateKey);
  if (!template.isActive) return { suppressed: `Message "${template.name}" is paused` };

  const snapshot = (workflow.orderSnapshot ?? {}) as { patientName?: string; location?: string; tests?: string };
  const appointmentTime = workflow.appointmentTime;

  const tokenExpiry = tokenExpiryFor(appointmentTime, workflow.escalationDeadline);
  const rawTokens = await Promise.all(
    (["ACCEPT", "RESCHEDULE", "REJECT"] as const).map(async (actionType) => {
      const token = bearerToken();
      return { action: actionType, token, tokenHash: await sha256(token), expiresAt: tokenExpiry };
    }),
  );

  const variables: TemplateVariables = {
    order_id: String(workflow.orderId),
    lab_name: config.labName,
    manager_name: config.managerName || "team",
    patient_name: snapshot.patientName || "Patient",
    appointment_date: appointmentTime ? formatDate(appointmentTime) : "Scheduled appointment",
    appointment_time: appointmentTime ? formatTime(appointmentTime) : "scheduled time",
    location: snapshot.location || "Location shared in LabStack",
    tests: snapshot.tests || "Order details available in LabStack",
    sla_deadline: formatDateTime(workflow.confirmationDeadline),
    accept_url: actionUrl(rawTokens[0].token),
    reschedule_url: actionUrl(rawTokens[1].token),
    reject_url: actionUrl(rawTokens[2].token),
  };
  const message = renderLabTemplate(template.body, variables);

  await prisma.$transaction(async (tx) => {
    await tx.labProviderActionToken.createMany({
      data: rawTokens.map((entry) => ({
        workflowId: workflow.id,
        action: entry.action,
        tokenHash: entry.tokenHash,
        expiresAt: entry.expiresAt,
      })),
    });

    const communication = await tx.labCommunication.create({
      data: {
        workflowId: workflow.id,
        type: isEscalation ? "ESCALATION" : "REMINDER",
        recipient,
        templateKey,
        templateVariables: variables,
        // Attribution, so "what has this rule actually sent?" is a query
        // rather than a reconstruction from idempotency keys.
        ruleId: action.ruleId,
        idempotencyKey: `non-api:${workflow.orderId}:${action.ruleId ?? action.rungKey ?? action.type.toLowerCase()}:${action.runAt.toISOString()}`,
      },
    });

    const outbound = await tx.waOutbound.create({
      // groupId is what arms the gateway's sendEnabled guard for group
      // targets; a bare jid with no groupId would bypass it entirely.
      data: { targetJid: target.targetJid, text: message, groupId: target.groupId },
    });

    await tx.labCommunication.update({
      where: { id: communication.id },
      data: { waOutboundId: outbound.id, status: "QUEUED" },
    });

    if (isEscalation) {
      await tx.labCommunicationWorkflow.update({
        where: { id: workflow.id },
        data: { status: "ESCALATED" },
      });
      await tx.labCommunicationEscalation.upsert({
        where: { workflowId_level: { workflowId: workflow.id, level: 1 } },
        create: {
          workflowId: workflow.id,
          level: 1,
          status: "NOTIFIED",
          recipient,
          reason: rule
            ? `Rule "${rule.name}" escalated; ${managerMissing ? "no manager on file, notified the lab" : "notified the lab manager"}`
            : managerMissing
              ? "Lab confirmation SLA expired; no manager on file, notified the lab"
              : "Lab confirmation SLA expired; notified the lab manager",
          notifiedAt: now,
        },
        update: { notifiedAt: now, recipient, status: "NOTIFIED" },
      });
    }

    await tx.labScheduledAction.update({
      where: { id: action.id },
      data: { status: "COMPLETED", completedAt: now, attempts: action.attempts + 1, lockedAt: null, lockedBy: null },
    });

    await tx.labCommunicationOrderEvent.create({
      data: {
        workflowId: workflow.id,
        type: isEscalation ? "ESCALATION_TRIGGERED" : "REMINDER_SENT",
        actorType: "SYSTEM",
        payload: {
          scheduledActionId: action.id,
          communicationId: communication.id,
          outboundId: outbound.id,
          rungKey: action.rungKey,
          ruleId: action.ruleId,
          ruleName: rule?.name ?? null,
          anchor: action.anchor,
          priority: action.priority,
          recipient,
        },
      },
    });

    await tx.labCommunicationAuditLog.create({
      data: {
        workflowId: workflow.id,
        action: isEscalation ? "ESCALATION_TRIGGERED" : "REMINDER_SENT",
        actorType: "SYSTEM",
        metadata: { scheduledActionId: action.id, communicationId: communication.id, rungKey: action.rungKey, ruleId: action.ruleId, ruleName: rule?.name ?? null, recipient },
      },
    });
  });

  if (managerMissing) {
    await raiseOpsAlert(
      `${config.labName} has no manager WhatsApp configured — ${rule ? `rule "${rule.name}"` : "the escalation"} for order #${workflow.orderId} fell back to the lab's own number.`,
      config.labId,
      { workflowId: workflow.id, orderId: workflow.orderId, rungKey: action.rungKey, ruleId: action.ruleId },
    );
  }

  return null;
}
