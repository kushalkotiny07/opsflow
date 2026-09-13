/**
 * Tell the provider when one of its orders blows an OpsFlow SLA.
 *
 * This is the half of provider communication that is common to every lab.
 *
 * The confirmation ladder next door (lib/non-api-labs) only ever made sense
 * for NON_API labs: it asks the provider to accept, reschedule or reject an
 * order over WhatsApp, which an API lab has already received through the API.
 * A breach is different. "Your order is past its deadline" is worth sending
 * however the order reached the lab, so this path deliberately does not look
 * at `integrationType` at all — only at whether the lab has a config, has it
 * switched on, and has somewhere to send.
 *
 * ── What it will not do ──────────────────────────────────────────────────
 * Repetition is capped PER ORDER, deliberately not per lab:
 *
 *   Per-order cap  One order can breach several task rules within minutes
 *                  (collection, then report follow-up, then escalation). The
 *                  provider does not need three messages about one order, so
 *                  `slaBreachMaxPerOrder` caps what leaves. Breaches are still
 *                  recorded in full by the SLA watcher — this only limits what
 *                  the provider is told.
 *
 *   Per task       `idempotencyKey = provider-breach:<taskId>` makes a retried
 *                  or concurrent watcher run harmless.
 *
 * There is no cross-order suppression, and the ladder's `quietWindowMinutes`
 * is not applied here. Both were tried and are wrong:
 *
 *   - Counting ladder messages would starve the feature outright. A busy
 *     NON_API lab gets a confirmation message per order all day, so a lab-wide
 *     window spanning both triggers would suppress essentially every breach
 *     alert while looking like it worked.
 *   - Suppressing across orders would drop real breaches permanently. The
 *     watcher marks a task BREACHED exactly once, so a message skipped here is
 *     never retried, and each message names a *different* late order.
 *
 * The cost is that a lab with thirty simultaneous breaches receives thirty
 * messages. That is noisy but true, and the per-lab volume control that would
 * fix it properly is a digest, not a dropped alert.
 *
 * Nothing here sends. It writes a wa_outbound row, carrying `groupId` so the
 * gateway's per-group sendEnabled guard still applies; see target.ts.
 */
import prisma from "@/lib/db/client";
import { loadEffectiveConfigsForLab } from "./sla-config";
import { resolveLabTarget, hasWhatsAppTarget } from "@/lib/non-api-labs/target";
import {
  PROVIDER_SLA_BREACH_TEMPLATE,
  ensureTemplate,
  renderLabTemplate,
  type TemplateVariables,
} from "@/lib/non-api-labs/templates";

/** One breached task, as the SLA watcher already knows it. */
export interface BreachedTaskInput {
  taskId: number;
  /** LabStack order id — `task.entityId`. */
  orderId: number;
  /** Resolved by the caller; tasks do not carry labId. */
  labId: number;
  taskTitle: string;
  slaDeadline: Date;
  breachedAt: Date;
  breachMinutes: number;
  /** `task.metadata`, used for patient/appointment detail when present. */
  metadata?: Record<string, unknown> | null;
}

export type BreachNotifyOutcome =
  | "queued"
  | "no-config"
  | "superseded"
  | "disabled"
  | "no-target"
  | "order-capped"
  | "duplicate"
  | "failed";

const TZ = process.env.TIMEZONE || "Asia/Kolkata";

function formatDate(value: Date | null): string {
  if (!value) return "Scheduled date";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ }).format(value);
}

function formatTime(value: Date | null): string {
  if (!value) return "scheduled time";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TZ }).format(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** `metadata.appointmentTime` is an ISO string on the task, not a Date. */
function appointmentFrom(metadata: Record<string, unknown> | null | undefined): Date | null {
  const raw = metadata?.appointmentTime;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Queue one breach alert to the order's lab.
 *
 * Returns why nothing was sent when nothing was, rather than throwing: a
 * provider being unreachable must never stop the SLA watcher from marking the
 * rest of the breaches.
 */
export async function notifyProviderOfBreach(input: BreachedTaskInput): Promise<BreachNotifyOutcome> {
  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: input.labId } });
  // Note the absence of an integrationType check. That is the whole point of
  // this module: an API lab with a config is a lab that wants to hear about
  // its breaches.
  if (!config || !config.isActive) return "no-config";
  if (!config.slaBreachAlertsEnabled) return "disabled";

  // The milestone breach engine (lib/provider-comms/breach-engine.ts) covers
  // the same ground for the same lab, on the order's milestones rather than
  // on whatever task rules happen to produce. Two systems messaging one lab
  // about one order is the failure mode here, so the milestone engine wins
  // wherever a lab has enabled even one milestone — explicitly, rather than
  // leaving it to whoever remembers to switch the other off.
  //
  // Resolved through loadEffectiveConfigsForLab rather than a direct query on
  // enabled rows: a lab row overrides the global wholesale, so a lab that
  // turns a globally-enabled milestone OFF is not covered by the milestone
  // engine at all. Querying `enabled: true OR labId: null` would read that
  // lab as covered and silence this path too, leaving it with no breach
  // message from either system.
  const effective = await loadEffectiveConfigsForLab(input.labId);
  if (effective.some((config) => config.enabled)) return "superseded";
  if (!hasWhatsAppTarget(config)) return "no-target";

  // Idempotent per task. The watcher only marks a task BREACHED once, but a
  // retried or concurrent run must not double-send, and the unique index is
  // the only thing that can promise that.
  const idempotencyKey = `provider-breach:${input.taskId}`;
  const already = await prisma.labCommunication.findUnique({ where: { idempotencyKey }, select: { id: true } });
  if (already) return "duplicate";

  // Per-order cap, counting only what actually went out for this order.
  if (config.slaBreachMaxPerOrder > 0) {
    const sentForOrder = await prisma.labCommunication.count({
      where: { labId: input.labId, orderId: input.orderId, type: "SLA_BREACH" },
    });
    if (sentForOrder >= config.slaBreachMaxPerOrder) return "order-capped";
  } else {
    return "disabled";
  }

  const metadata = input.metadata ?? null;
  const appointmentTime = appointmentFrom(metadata);
  const variables: TemplateVariables = {
    order_id: String(input.orderId),
    lab_name: str(metadata?.labName, config.labName),
    patient_name: str(metadata?.patientName, "Patient"),
    appointment_date: formatDate(appointmentTime),
    appointment_time: formatTime(appointmentTime),
    location: str(metadata?.storeName, "Location shared in LabStack"),
    tests: str(metadata?.tests, "Order details available in LabStack"),
    sla_deadline: `${formatDate(input.slaDeadline)} ${formatTime(input.slaDeadline)}`,
    task_title: input.taskTitle,
    breach_minutes: String(Math.max(0, input.breachMinutes)),
    breached_at: `${formatDate(input.breachedAt)} ${formatTime(input.breachedAt)}`,
  };

  try {
    const templateKey = config.slaBreachTemplateKey || PROVIDER_SLA_BREACH_TEMPLATE;
    const template = await ensureTemplate(templateKey);
    if (!template.isActive) return "disabled";

    // Resolved before the transaction: a group target may register a wa_groups
    // row, and that write does not belong inside the message transaction.
    const target = await resolveLabTarget(config);
    const text = renderLabTemplate(template.body, variables);

    await prisma.$transaction(async (tx) => {
      const communication = await tx.labCommunication.create({
        data: {
          // No workflow: an API lab has none, and a NON_API lab's confirmation
          // workflow is about a different question than "this task is late".
          workflowId: null,
          orderId: input.orderId,
          labId: input.labId,
          type: "SLA_BREACH",
          recipient: target.targetJid,
          templateKey,
          templateVariables: variables,
          idempotencyKey,
        },
      });
      const outbound = await tx.waOutbound.create({
        // groupId is what arms the gateway's sendEnabled guard.
        data: { targetJid: target.targetJid, text, groupId: target.groupId },
      });
      await tx.labCommunication.update({
        where: { id: communication.id },
        data: { waOutboundId: outbound.id, status: "QUEUED" },
      });
    });

    console.info(
      `[ProviderBreach] Queued SLA breach alert to lab ${input.labId} for order ${input.orderId}` +
      `${target.sendBlocked ? " (group sending still disabled)" : ""}`,
    );
    return "queued";
  } catch (error) {
    // P2002 means a concurrent watcher beat us to this task.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") return "duplicate";
    console.error(`[ProviderBreach] Failed to queue breach alert for order ${input.orderId}:`, error);
    return "failed";
  }
}
