/**
 * The daily provider digest — one WhatsApp message a day, per lab.
 *
 * Every other provider message in this codebase is triggered by a single
 * order: a new order arrives, a confirmation goes unanswered, a deadline is
 * missed. That is the right shape for exceptions and the wrong shape for
 * planning — a lab that has been told about forty orders one at a time still
 * has no picture of its own day.
 *
 * So this is the first message that is about a DAY rather than an order:
 *
 *   Today     what they handled, and what is still open. Sent in the evening,
 *             when the answer is settled and a gap is still fixable.
 *   Tomorrow  the counts, and the actual appointment list. The list is the
 *             point: a count tells a lab how busy tomorrow is, the list tells
 *             them what to staff.
 *
 * ── What it deliberately does not do ─────────────────────────────────────
 *
 * It does not consult the breach engine's quiet hours. Those exist to stop
 * event-driven alerts firing at 03:00, when nobody chose the moment. A digest
 * has a send time an operator picked on purpose, so the send time IS the
 * politeness policy. Honouring quiet hours here would mean a digest scheduled
 * inside them silently never sends — a config that reads as on and does
 * nothing, which is the failure this codebase keeps having to dig out.
 *
 * It does not carry a poll. The confirmation ladder asks a question about one
 * order and maps the answer onto that order's workflow; a digest spans a day
 * and has no workflow to move, so a tap would record a vote with nowhere to
 * go. Providers reply in the group instead, which is where the thread already
 * is.
 *
 * It does not send itself. Like every other provider message it writes a
 * wa_outbound row carrying `groupId`, so the gateway's per-group sendEnabled
 * guard still stands between this and a real provider group.
 */
import prisma from "@/lib/db/client";
import type { NonApiLabConfig } from "@prisma/client";
import { resolveLabTarget, hasWhatsAppTarget } from "@/lib/non-api-labs/target";
import {
  PROVIDER_DAILY_DIGEST_TEMPLATE,
  ensureTemplate,
  renderLabTemplate,
  type TemplateVariables,
} from "@/lib/non-api-labs/templates";
import {
  loadDaySummaries, loadDaySchedule, todayKey, tomorrowKey, localDayKey,
  TIME_ZONE, type ScheduledOrder,
} from "./day-summary";

/**
 * How late a digest may still go out, in minutes past its own slot.
 *
 * The tick catches up after a restart, which is what makes a missed 19:00
 * still arrive at 19:04. But "today's summary" delivered at 01:00 is not a
 * late message, it is a wrong one — the day it describes is over and the
 * reader has gone home. Past this, the slot is abandoned and said so in the
 * log rather than sent stale.
 */
const MAX_LATE_MINUTES = parseInt(process.env.PROVIDER_DIGEST_MAX_LATE_MINUTES ?? "180", 10);

/** A WhatsApp message has no second page, so the list is capped, not paged. */
const SCHEDULE_LIMIT = parseInt(process.env.PROVIDER_DIGEST_SCHEDULE_LIMIT ?? "12", 10);

export type DigestOutcome =
  | "queued"
  // Rendered and returned, nothing written. Distinct from "queued" so a caller
  // can never mistake a preview for a send.
  | "preview"
  | "not-due"
  | "already-sent"
  | "too-late"
  | "empty"
  | "no-target"
  | "disabled"
  | "failed";

export type DigestResult = {
  labId: number;
  labName: string;
  outcome: DigestOutcome;
  /** Present whenever the message was rendered, sent or not — powers preview. */
  text?: string;
  recipient?: string;
  /** True when the group exists but sending has not been switched on for it. */
  sendBlocked?: boolean;
  error?: string;
};

// ── Formatting ───────────────────────────────────────────────────────────

export function dateLabel(day: string, withYear: boolean): string {
  // `day` is ALREADY a local calendar date ("2026-09-17") — todayKey and
  // tomorrowKey resolved the timezone before it got here. So this formats the
  // date as given and does not re-project it: read back in the operating zone,
  // a UTC-midnight (or UTC-noon) anchor lands on the next calendar day for
  // anywhere past UTC+12, and the digest would be headed "Fri 18 Sept" on a
  // Thursday. Pinned by the Kiritimati case in the test.
  const at = new Date(`${day}T00:00:00Z`);
  // en-GB rather than the en-IN used elsewhere, for one reason: with a weekday
  // in the pattern en-IN renders "Thu, 17 Sept, 2026" — a stray comma before
  // the year. The weekday earns its place in a daily message, so the locale
  // gives way instead.
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(at);
}

function clock(at: Date | null, zone: string): string {
  if (!at) return "—";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(at);
}

function orderTypeLabel(orderType: string): string {
  if (orderType === "HOME_SAMPLE") return "Home";
  if (orderType === "CENTER_VISIT") return "Centre";
  return orderType.replaceAll("_", " ").toLowerCase();
}

/**
 * Tomorrow's appointments as message lines.
 *
 * `total` is the day's real count, which may exceed what was fetched — the
 * tail is reported as a number rather than dropped, so a lab with thirty
 * pickups is never told about twelve and left to discover the rest.
 */
export function scheduleBlock(orders: ScheduledOrder[], total: number, zone: string): string {
  if (orders.length === 0) return "No appointments on tomorrow's list yet.";
  const lines = orders.map((order) => {
    const parts = [
      clock(order.appointmentTime, zone),
      orderTypeLabel(order.orderType),
      order.patientName || `Order #${order.orderId}`,
    ];
    if (order.location) parts.push(order.location);
    return `• ${parts.join(" · ")}`;
  });
  const remaining = total - orders.length;
  if (remaining > 0) lines.push(`…and ${remaining} more — full list in LabStack.`);
  return ["Tomorrow's appointments:", ...lines].join("\n");
}

// ── Due check ────────────────────────────────────────────────────────────

/** Minutes past local midnight, in the operating timezone. */
function localMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone,
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * Is this lab's slot open right now?
 *
 * Returns how many minutes past the slot we are, or null when it has not
 * arrived yet. The caller decides what counts as too late, because "we are
 * catching up after a restart" and "this is stale" are the same measurement
 * read against different thresholds.
 */
export function minutesPastSlot(config: NonApiLabConfig, now: Date, zone: string): number | null {
  const slot = config.dailyDigestHour * 60 + config.dailyDigestMinute;
  const current = localMinutes(now, zone);
  return current >= slot ? current - slot : null;
}

// ── Building one digest ──────────────────────────────────────────────────

type BuiltDigest = { variables: TemplateVariables; hasContent: boolean };

/**
 * Count the orders on each day that the provider has still not answered for.
 *
 * Read from OpsFlow's own workflows rather than from LabStack: "unconfirmed"
 * is a fact about the conversation, and LabStack has no idea whether anyone
 * ever asked. Bucketed in JS by local day so this reuses the same day key the
 * counts use, instead of re-deriving local midnight in UTC and risking the two
 * disagreeing at the boundary.
 */
async function unconfirmedByDay(labId: number, zone: string): Promise<Map<string, number>> {
  const window = 3 * 86_400_000;
  const pending = await prisma.labCommunicationWorkflow.findMany({
    where: {
      labId,
      status: "WAITING_FOR_LAB_CONFIRMATION",
      appointmentTime: { gte: new Date(Date.now() - window), lt: new Date(Date.now() + window) },
    },
    select: { appointmentTime: true },
  });
  const byDay = new Map<string, number>();
  for (const workflow of pending) {
    if (!workflow.appointmentTime) continue;
    const key = localDayKey(workflow.appointmentTime, zone);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  return byDay;
}

/** Render one lab's digest variables. Reads only; sends nothing. */
export async function buildDigest(config: NonApiLabConfig, zone: string): Promise<BuiltDigest> {
  const today = todayKey(zone);
  const tomorrow = tomorrowKey(zone);

  const [summaries, unconfirmed] = await Promise.all([
    loadDaySummaries([config.labId], zone),
    unconfirmedByDay(config.labId, zone),
  ]);
  const days = summaries.get(config.labId)!;

  // Only fetched when there is something to list — an empty day should cost
  // nothing on a nightly job that runs for every configured lab.
  const schedule: ScheduledOrder[] = days.tomorrow.total > 0
    ? await loadDaySchedule(config.labId, zone, 1, SCHEDULE_LIMIT)
    : [];

  const count = (value: number) => String(value);

  const variables: TemplateVariables = {
    lab_name: config.labName,
    digest_date: dateLabel(today, true),
    today_total: count(days.today.total),
    today_home: count(days.today.homeCollections),
    today_centre: count(days.today.centreVisits),
    today_collected: count(days.today.collected),
    today_pending: count(days.today.awaitingCollection),
    today_reports_pending: count(days.today.reportPending),
    today_cancelled: count(days.today.cancelled),
    today_unconfirmed: count(unconfirmed.get(today) ?? 0),
    tomorrow_date: dateLabel(tomorrow, false),
    tomorrow_total: count(days.tomorrow.total),
    tomorrow_home: count(days.tomorrow.homeCollections),
    tomorrow_centre: count(days.tomorrow.centreVisits),
    tomorrow_first: clock(days.tomorrow.firstAppointment, zone),
    tomorrow_unconfirmed: count(unconfirmed.get(tomorrow) ?? 0),
    // The schedule count excludes cancellations, which the day total includes,
    // so the "…and N more" tail is measured against the list's own basis.
    tomorrow_schedule: scheduleBlock(
      schedule,
      Math.max(days.tomorrow.total - days.tomorrow.cancelled, schedule.length),
      zone,
    ),
  };

  return { variables, hasContent: days.today.total > 0 || days.tomorrow.total > 0 };
}

// ── Sending one digest ───────────────────────────────────────────────────

export type SendDigestOptions = {
  /** Skip the due check, the empty check and the once-a-day key. For testing and "send now". */
  force?: boolean;
  /** Render and return the message without queuing anything. */
  previewOnly?: boolean;
  now?: Date;
};

/**
 * Queue (or preview) one lab's digest.
 *
 * Returns the reason nothing was sent rather than throwing: one unreachable
 * provider must never stop the rest of the evening's digests.
 */
export async function sendDigestForLab(
  config: NonApiLabConfig,
  options: SendDigestOptions = {},
): Promise<DigestResult> {
  const zone = TIME_ZONE();
  const now = options.now ?? new Date();
  const base = { labId: config.labId, labName: config.labName };

  if (!options.force) {
    if (!config.isActive || !config.dailyDigestEnabled) return { ...base, outcome: "disabled" };
    const late = minutesPastSlot(config, now, zone);
    if (late === null) return { ...base, outcome: "not-due" };
    if (late > MAX_LATE_MINUTES) {
      console.warn(
        `[ProviderDigest] Lab ${config.labId} (${config.labName}) is ${late}m past its ` +
        `${config.dailyDigestHour}:${String(config.dailyDigestMinute).padStart(2, "0")} slot — ` +
        `abandoning today's digest rather than sending a stale one.`,
      );
      return { ...base, outcome: "too-late" };
    }
  }
  if (!hasWhatsAppTarget(config)) return { ...base, outcome: "no-target" };

  // A scheduled digest is once a day, enforced by the unique index rather than
  // by a read — two ticks can overlap. A manual send is a different event and
  // gets its own key, so testing never burns the day's slot or is blocked by it.
  const idempotencyKey = options.force
    ? `provider-digest:${config.labId}:manual:${now.toISOString()}`
    : `provider-digest:${config.labId}:${todayKey(zone)}`;

  try {
    const { variables, hasContent } = await buildDigest(config, zone);
    if (!hasContent && config.dailyDigestSkipWhenEmpty && !options.force) {
      return { ...base, outcome: "empty" };
    }

    const templateKey = config.dailyDigestTemplateKey || PROVIDER_DAILY_DIGEST_TEMPLATE;
    const template = await ensureTemplate(templateKey);
    if (!template.isActive) return { ...base, outcome: "disabled" };
    const text = renderLabTemplate(template.body, variables);

    // Resolved before the transaction: a group target may register a wa_groups
    // row, and that write does not belong inside the message transaction.
    const target = await resolveLabTarget(config);
    if (options.previewOnly) {
      return { ...base, outcome: "preview", text, recipient: target.targetJid, sendBlocked: target.sendBlocked };
    }

    await prisma.$transaction(async (tx) => {
      const communication = await tx.labCommunication.create({
        data: {
          // No workflow and no order: this message is about a day.
          workflowId: null,
          orderId: null,
          labId: config.labId,
          type: "DAILY_DIGEST",
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
      `[ProviderDigest] Queued daily summary for lab ${config.labId} (${config.labName})` +
      `${target.sendBlocked ? " — group sending still disabled" : ""}`,
    );
    return { ...base, outcome: "queued", text, recipient: target.targetJid, sendBlocked: target.sendBlocked };
  } catch (error) {
    // P2002 means another tick already wrote today's digest for this lab.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      return { ...base, outcome: "already-sent" };
    }
    console.error(`[ProviderDigest] Failed to queue digest for lab ${config.labId}:`, error);
    return { ...base, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

// ── The tick ─────────────────────────────────────────────────────────────

export type DigestTickStats = {
  queued: number; skipped: number; empty: number; failed: number;
};

/**
 * Every-minute sweep for labs whose digest slot has opened.
 *
 * A minute tick rather than a cron at 19:00 on purpose: a process restarting
 * across its own cron minute loses that day's digest silently and forever,
 * whereas a tick that asks "is the slot open and unsent?" simply catches up on
 * the next pass. `MAX_LATE_MINUTES` is what stops catching-up turning into
 * sending yesterday's news.
 */
export async function runDailyDigestTick(now: Date = new Date()): Promise<DigestTickStats> {
  const stats: DigestTickStats = { queued: 0, skipped: 0, empty: 0, failed: 0 };
  const zone = TIME_ZONE();

  const configs = await prisma.nonApiLabConfig.findMany({
    where: { isActive: true, dailyDigestEnabled: true },
  });
  if (configs.length === 0) return stats;

  // Whose slot has actually opened. Filtered before any LabStack read, so a
  // tick at 03:00 costs one small indexed query and nothing else.
  const due = configs.filter((config) => minutesPastSlot(config, now, zone) !== null);
  if (due.length === 0) return stats;

  // One round-trip to find who already has today's digest, rather than one per
  // lab: on all 1,439 other minutes of the day this is the only work done.
  const today = todayKey(zone);
  const alreadySent = await prisma.labCommunication.findMany({
    where: { idempotencyKey: { in: due.map((config) => `provider-digest:${config.labId}:${today}`) } },
    select: { idempotencyKey: true },
  });
  const sentKeys = new Set(alreadySent.map((row) => row.idempotencyKey));

  for (const config of due) {
    if (sentKeys.has(`provider-digest:${config.labId}:${today}`)) continue;
    const result = await sendDigestForLab(config, { now });
    if (result.outcome === "queued") stats.queued += 1;
    else if (result.outcome === "empty") stats.empty += 1;
    else if (result.outcome === "failed") stats.failed += 1;
    else stats.skipped += 1;
  }

  return stats;
}
