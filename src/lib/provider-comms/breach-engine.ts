/**
 * The SLA milestone breach engine — one pass, run from the existing
 * every-minute provider-communication tick.
 *
 * Works for EVERY configured lab, API and NON_API alike. Nothing here touches
 * LabCommunicationWorkflow, because an API lab never has one: a breach is
 * keyed on the order and the lab, and the message goes to the lab's existing
 * WhatsApp target. That is the whole reason this is a separate path from the
 * confirmation ladder rather than another rung on it.
 *
 * ── Order of operations is load-bearing ─────────────────────────────────
 *   A. resolve and cancel existing breaches
 *   B. detect new ones
 *   C. send what is due
 *
 * A before C is what stops a message going out for a milestone the lab
 * completed since the last tick. And C re-checks state again immediately
 * before sending, because "since the last tick" is not good enough when the
 * lab acted ninety seconds ago: a message must never leave only because a
 * timer fired.
 *
 * ── Crash safety ────────────────────────────────────────────────────────
 * The SlaBreachSend row is written BEFORE the enqueue, so a crash between the
 * two loses a message rather than duplicating one. Losing one is recoverable
 * (the next attempt still fires); duplicating one is a message a provider
 * actually received twice.
 *
 * All scheduling state lives in `sla_breach_events.nextAttemptAt`. There are
 * no in-memory timers, so a restart mid-cycle resumes exactly where it was.
 */
import prisma from "@/lib/db/client";
import type { Prisma, SlaMilestone } from "@prisma/client";
import { resolveLabTarget, hasWhatsAppTarget } from "@/lib/non-api-labs/target";
import { ensureTemplate, renderLabTemplate, type TemplateVariables } from "@/lib/non-api-labs/templates";
import {
  isCancelledStatus,
  isTerminalStatus,
  MILESTONE_LABELS,
  resolveMilestoneState,
} from "./milestones";
import {
  computeDeadline,
  loadEffectiveConfigs,
  loadProviderCommsSettings,
  type EffectiveSlaConfig,
} from "./sla-config";
import { loadCandidateOrders, loadOrdersByIds, type BreachOrder } from "./order-source";

export interface BreachTickResult {
  resolved: number;
  cancelled: number;
  detected: number;
  sent: number;
  dryRun: number;
  capped: number;
  deferred: number;
  skipped: number;
  failed: number;
}

const EMPTY: BreachTickResult = {
  resolved: 0, cancelled: 0, detected: 0, sent: 0,
  dryRun: 0, capped: 0, deferred: 0, skipped: 0, failed: 0,
};

const TZ = process.env.TIMEZONE || "Asia/Kolkata";

function formatDateTime(value: Date | null): string {
  if (!value) return "not set";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: TZ,
  }).format(value);
}

function formatDate(value: Date | null): string {
  if (!value) return "Scheduled date";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ }).format(value);
}

function formatTime(value: Date | null): string {
  if (!value) return "scheduled time";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TZ }).format(value);
}

/** "1h 20m" — always unit-labelled, never a bare number. */
export function humanizeMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The wall-clock hour in the configured operating timezone, not UTC. */
function hourInTimezone(at: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ }).format(at),
  );
}

/**
 * Is `at` inside the configured quiet hours? Handles a window that wraps
 * midnight (21 → 8), which is the shape a real quiet window actually takes.
 */
export function inQuietHours(at: Date, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  const hour = hourInTimezone(at);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The next instant quiet hours are over. */
function quietHoursEndAfter(at: Date, end: number): Date {
  const next = new Date(at);
  for (let i = 0; i < 48; i += 1) {
    next.setTime(next.getTime() + 60 * 60_000);
    if (hourInTimezone(next) === end) {
      next.setMinutes(0, 0, 0);
      return next;
    }
  }
  return new Date(at.getTime() + 60 * 60_000);
}

/** A lab's breach steps, keyed by milestone. */
type BreachStep = {
  id: string;
  name: string;
  templateKey: string;
  repeatIntervalMinutes: number | null;
  maxAttempts: number | null;
};

/**
 * Breach steps are ProviderCommunicationRule rows with triggerKind =
 * SLA_BREACH. They are deliberately invisible to loadActiveCommunicationRules
 * so they can never replace a provider's sequence — see the schema comment.
 * Scope follows the same convention as sequence rules: an empty allowedLabIds
 * means every lab.
 */
async function loadBreachSteps(): Promise<Array<{ labIds: number[]; milestone: SlaMilestone; step: BreachStep }>> {
  const rows = await prisma.providerCommunicationRule.findMany({
    where: { isActive: true, triggerKind: "SLA_BREACH", slaMilestone: { not: null } },
    select: {
      id: true, name: true, templateKey: true, allowedLabIds: true,
      slaMilestone: true, repeatIntervalMinutes: true, maxAttempts: true,
    },
  });
  return rows.map((row) => ({
    labIds: Array.isArray(row.allowedLabIds)
      ? (row.allowedLabIds as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [],
    milestone: row.slaMilestone!,
    step: {
      id: row.id, name: row.name, templateKey: row.templateKey,
      repeatIntervalMinutes: row.repeatIntervalMinutes, maxAttempts: row.maxAttempts,
    },
  }));
}

function stepFor(
  steps: Array<{ labIds: number[]; milestone: SlaMilestone; step: BreachStep }>,
  labId: number,
  milestone: SlaMilestone,
): BreachStep | null {
  // A lab-scoped step beats an unscoped one for the same milestone.
  const matching = steps.filter((s) => s.milestone === milestone && (s.labIds.length === 0 || s.labIds.includes(labId)));
  const scoped = matching.find((s) => s.labIds.length > 0);
  return (scoped ?? matching[0])?.step ?? null;
}

export async function runSlaBreachTick(now: Date = new Date()): Promise<BreachTickResult> {
  const result: BreachTickResult = { ...EMPTY };

  const settings = await loadProviderCommsSettings();
  // The kill switch stops breach sending only. Sequence steps run from a
  // different path and are untouched by this.
  if (!settings.slaBreachEnabled) return result;

  const steps = await loadBreachSteps();
  if (steps.length === 0) return result;

  // Only labs that are configured, active, addressable AND have breach steps.
  // A lab with enabled milestone configs but no breach step on its path must
  // never produce a send.
  const configs = await prisma.nonApiLabConfig.findMany({
    where: { isActive: true },
    select: {
      labId: true, labName: true, waGroupJid: true, whatsappNumber: true,
    },
  });
  const labById = new Map(configs.map((c) => [c.labId, c]));
  const participating = configs
    .filter((c) => hasWhatsAppTarget(c))
    .map((c) => c.labId)
    .filter((labId) => steps.some((s) => s.labIds.length === 0 || s.labIds.includes(labId)));

  if (participating.length === 0) return result;
  const configsByLab = await loadEffectiveConfigs(participating);

  // ── A. Resolve and cancel ────────────────────────────────────────────
  const active = await prisma.slaBreachEvent.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, orderId: true, labId: true, milestone: true, deadlineAt: true, attemptsSent: true, nextAttemptAt: true },
  });

  const ordersById = await loadOrdersByIds(active.map((e) => e.orderId));

  for (const event of active) {
    const order = ordersById.get(event.orderId);

    if (!order) {
      await closeEvent(event.id, "CANCELLED", "ORDER_CANCELLED", now);
      result.cancelled += 1;
      continue;
    }

    if (isTerminalStatus(order.orderStatus)) {
      await closeEvent(event.id, "CANCELLED", isCancelledStatus(order.orderStatus) ? "ORDER_CANCELLED" : "RESCHEDULED", now);
      result.cancelled += 1;
      continue;
    }

    const state = resolveMilestoneState(order, event.milestone);
    if (state.complete) {
      await closeEvent(event.id, "RESOLVED", "MILESTONE_COMPLETED", now);
      result.resolved += 1;
      continue;
    }

    // The appointment moved far enough that the deadline is now in the
    // future. Cancel rather than mutate: if the new deadline is breached
    // later, detection creates a fresh event with the correct instant, and
    // the ledger keeps an honest record of both.
    const config = configsByLab.get(order.labId)?.find((c) => c.milestone === event.milestone);
    if (config?.anchor === "APPOINTMENT_TIME") {
      const recomputed = computeDeadline(order, config);
      if (recomputed.ok && recomputed.deadlineAt.getTime() > now.getTime()) {
        await closeEvent(event.id, "CANCELLED", "RESCHEDULED", now);
        result.cancelled += 1;
      }
    }
  }

  // ── B. Detect ────────────────────────────────────────────────────────
  const candidates = await loadCandidateOrders(participating);
  for (const order of candidates) {
    const labConfigs = configsByLab.get(order.labId);
    if (!labConfigs) continue;

    for (const config of labConfigs) {
      if (!config.enabled) continue;
      if (!stepFor(steps, order.labId, config.milestone)) continue;

      const deadline = computeDeadline(order, config);
      if (!deadline.ok) continue;
      if (deadline.deadlineAt.getTime() >= now.getTime()) continue;

      const state = resolveMilestoneState(order, config.milestone);
      if (state.complete) continue;

      // Idempotency comes from the unique (orderId, milestone) constraint,
      // never from a prior read — two runners racing here both call create and
      // exactly one wins. A plain `create` is used rather than an upsert so
      // that "already existed" is the P2002 branch: an upsert returns the
      // existing row indistinguishably from a new one, and dating them apart
      // by createdAt is wrong whenever two ticks run inside the same second.
      try {
        await prisma.slaBreachEvent.create({
          data: {
            orderId: order.id,
            labId: order.labId,
            milestone: config.milestone,
            deadlineAt: deadline.deadlineAt,
            firstBreachedAt: now,
            attemptsSent: 0,
            nextAttemptAt: now,
            status: "ACTIVE",
          },
          select: { id: true },
        });
        result.detected += 1;
      } catch (error) {
        // P2002 = this order already has an event for this milestone, which
        // is the normal steady state, not a failure.
        if ((error as { code?: string }).code !== "P2002") {
          console.error(`[SlaBreach] Could not record breach for order ${order.id} / ${config.milestone}:`, error);
          result.failed += 1;
        }
      }
    }
  }

  // ── C. Send what is due ──────────────────────────────────────────────
  const due = await prisma.slaBreachEvent.findMany({
    where: { status: "ACTIVE", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
  });

  const dueOrders = await loadOrdersByIds(due.map((e) => e.orderId));
  const sentThisTickByLab = new Map<number, number>();

  for (const event of due) {
    const lab = labById.get(event.labId);
    const order = dueOrders.get(event.orderId);
    const config = configsByLab.get(event.labId)?.find((c) => c.milestone === event.milestone);
    const step = stepFor(steps, event.labId, event.milestone);

    if (!lab || !order || !config || !step) { result.skipped += 1; continue; }

    // 1. Re-check immediately before sending. Acceptance criterion: a lab that
    //    acted in the ninety seconds since step A must receive nothing.
    if (isTerminalStatus(order.orderStatus)) {
      await closeEvent(event.id, "CANCELLED", "ORDER_CANCELLED", now);
      result.cancelled += 1;
      continue;
    }
    const state = resolveMilestoneState(order, event.milestone);
    if (state.complete) {
      await closeEvent(event.id, "RESOLVED", "MILESTONE_COMPLETED", now);
      result.resolved += 1;
      continue;
    }

    // Quiet hours defer the attempt without consuming one.
    if (!config.ignoreQuietHours && inQuietHours(now, settings.quietHoursStart, settings.quietHoursEnd)) {
      await prisma.slaBreachEvent.update({
        where: { id: event.id },
        data: { nextAttemptAt: quietHoursEndAfter(now, settings.quietHoursEnd!) },
      });
      result.deferred += 1;
      continue;
    }

    // Per-lab ceiling for this tick. The remainder keeps its nextAttemptAt so
    // it rolls into the next tick rather than being dropped.
    const alreadySent = sentThisTickByLab.get(event.labId) ?? 0;
    if (alreadySent >= settings.perLabPerTickLimit) { result.deferred += 1; continue; }

    const attemptNo = event.attemptsSent + 1;
    const maxAttempts = step.maxAttempts ?? config.maxAttempts;
    const repeatMinutes = step.repeatIntervalMinutes ?? config.repeatIntervalMinutes;

    try {
      const overdueMinutes = (now.getTime() - event.deadlineAt.getTime()) / 60_000;
      const variables: TemplateVariables = {
        order_id: String(order.id),
        lab_name: order.labName ?? lab.labName,
        patient_name: order.patientName ?? "Patient",
        appointment_date: formatDate(order.appointmentTime),
        appointment_time: formatTime(order.appointmentTime),
        location: order.storeName ?? "Location shared in LabStack",
        tests: order.packageName ?? "Order details available in LabStack",
        sla_milestone: MILESTONE_LABELS[event.milestone],
        sla_deadline: formatDateTime(event.deadlineAt),
        sla_overdue_by: humanizeMinutes(overdueMinutes),
        sla_attempt_no: String(attemptNo),
        sla_attempts_remaining: String(Math.max(0, maxAttempts - attemptNo)),
      };

      const template = await ensureTemplate(step.templateKey);
      if (!template.isActive) { result.skipped += 1; continue; }
      const body = renderLabTemplate(template.body, variables);

      const target = await resolveLabTarget(lab);
      const isDryRun = settings.slaBreachDryRun;

      // 2. Record the attempt BEFORE enqueueing — see the header.
      const send = await prisma.slaBreachSend.create({
        data: {
          breachEventId: event.id,
          attemptNo,
          ruleId: step.id,
          destination: target.targetJid,
          renderedBody: body,
          sentAt: now,
          dryRun: isDryRun,
        },
        select: { id: true },
      });

      if (!isDryRun) {
        // The one send path: a row on wa_outbound, drained by the gateway.
        // groupId is what arms the per-group sendEnabled guard; a bare jid
        // with a null groupId would slip straight past it.
        const outbound = await prisma.waOutbound.create({
          data: { targetJid: target.targetJid, text: body, groupId: target.groupId },
          select: { id: true },
        });
        await prisma.slaBreachSend.update({ where: { id: send.id }, data: { waOutboundId: outbound.id } });

        // Mirrored into the shared communication history so one order still
        // reads as one timeline alongside its sequence-step sends.
        await prisma.labCommunication.create({
          data: {
            workflowId: null,
            orderId: order.id,
            labId: event.labId,
            type: "SLA_BREACH",
            recipient: target.targetJid,
            templateKey: step.templateKey,
            templateVariables: variables as Prisma.InputJsonValue,
            ruleId: step.id,
            waOutboundId: outbound.id,
            status: "QUEUED",
            idempotencyKey: `sla-milestone:${event.id}:${attemptNo}`,
          },
        });
        result.sent += 1;
      } else {
        result.dryRun += 1;
      }

      // 3. Advance attempt state identically in dry run and live, so a dry
      //    run rehearses the real cadence rather than a different one.
      const capped = attemptNo >= maxAttempts;
      await prisma.slaBreachEvent.update({
        where: { id: event.id },
        data: {
          attemptsSent: attemptNo,
          lastSentAt: now,
          nextAttemptAt: capped ? null : new Date(now.getTime() + repeatMinutes * 60_000),
          status: capped ? "CAPPED" : "ACTIVE",
          resolvedAt: capped ? now : null,
          resolutionReason: capped ? "MAX_ATTEMPTS" : null,
        },
      });
      if (capped) result.capped += 1;
      sentThisTickByLab.set(event.labId, alreadySent + 1);
    } catch (error) {
      console.error(`[SlaBreach] Attempt ${attemptNo} failed for order ${event.orderId} / ${event.milestone}:`, error);
      result.failed += 1;
    }
  }

  return result;
}

async function closeEvent(
  id: string,
  status: "RESOLVED" | "CANCELLED",
  reason: string,
  now: Date,
): Promise<void> {
  await prisma.slaBreachEvent.update({
    where: { id },
    data: { status, resolvedAt: now, resolutionReason: reason, nextAttemptAt: null },
  });
}
