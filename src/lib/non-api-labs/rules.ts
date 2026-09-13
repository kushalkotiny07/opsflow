/**
 * Provider communication rules — "when does OpsFlow message a provider?"
 *
 * The built-in ladder (ladder.ts) answers that question with a fixed shape:
 * three order-clock rungs from the lab's SLA config plus four appointment
 * rungs. It is a good default and a poor policy — Ops cannot say "chase the
 * imaging labs harder", "never message before 8am", or "stop once the order
 * left CREATED".
 *
 * A rule is that policy, and it has two halves that run at different times:
 *
 *   PLAN TIME (workflow start) — scope + anchor + offset decide *whether and
 *     when* an action is scheduled. `planRuleActions` does this, and it keeps
 *     the ladder's two hard invariants: nothing fires in the past, and nothing
 *     fires after the appointment.
 *
 *   SEND TIME (every tick, once the moment arrives) — `sendCondition` decides
 *     whether the message is still worth sending, against state that did not
 *     exist when it was scheduled: the workflow's own status, the order's
 *     current LabStack status, when we last messaged this provider, and what
 *     time it is where they are. `evaluateSendCondition` does this.
 *
 * Splitting it that way matters because a reminder scheduled six hours ago is
 * a guess about the future, and the only honest place to check the guess is
 * the moment before it goes out.
 *
 * Every function here is pure: no Prisma, no Date.now(), no env. `now` and
 * `timeZone` are always arguments. Same reason as ladder.ts — this is the part
 * that decides whether a real provider's phone buzzes, so it has to be
 * testable in isolation.
 *
 * Priority is P0..P4 where **P0 is most urgent**, matching the ladder.
 */

import type { LabScheduleAnchor, LadderActionType } from "./ladder";

export type ProviderRuleRecipient = "LAB" | "MANAGER";

/** Workflow statuses where chasing the provider still makes sense. */
export const OPEN_WORKFLOW_STATUSES = ["WAITING_FOR_LAB_CONFIRMATION", "ESCALATED"] as const;

/**
 * The gates re-checked at send time. Every field is optional: a rule with an
 * empty condition sends whenever its scheduled moment arrives, as long as the
 * conversation is still open.
 */
export type SendCondition = {
  /** OpsFlow-side conversation state. Defaults to OPEN_WORKFLOW_STATUSES. */
  workflowStatusIn?: string[];
  /** LabStack-side order status, read fresh on the tick that sends. */
  sourceStatusIn?: string[];
  /** Skip orders with no appointment on file. */
  requireAppointment?: boolean;
  /** Leave the provider alone inside the final N minutes before the appointment. */
  skipWithinMinutesOfAppointment?: number;
  /** Minimum gap since the last message on this order. Defers, never drops. */
  minMinutesSinceLastMessage?: number;
  /** Local-time window messages may leave in. Outside it, defer to the next opening. */
  sendWindow?: { startHour: number; endHour: number };
};

export type CommunicationRule = {
  id: string;
  name: string;
  isActive: boolean;
  anchor: LabScheduleAnchor;
  action: LadderActionType;
  recipient: ProviderRuleRecipient;
  templateKey: string;
  /** Signed minutes from the anchor. Positive after the order, negative before the appointment. */
  offsetMinutes: number;
  priority: number;
  /** Empty means every configured provider lab. */
  allowedLabIds: number[];
  /** Empty means every order type. */
  allowedOrderTypes: string[];
  sendCondition: SendCondition;
};

/** The named gates, so the UI and the simulator can count and label failures. */
export type SendCheck =
  | "workflowStatusIn"
  | "sourceStatusIn"
  | "requireAppointment"
  | "skipWithinMinutesOfAppointment"
  | "minMinutesSinceLastMessage"
  | "sendWindow";

export type SendDecision =
  /** Send it now. */
  | { verdict: "SEND" }
  /** Overtaken by events — suppress, don't retry. */
  | { verdict: "SKIP"; check: SendCheck; reason: string }
  /** Right message, wrong minute — stay pending until `runAt`. */
  | { verdict: "DEFER"; check: SendCheck; reason: string; runAt: Date };

export type SendContext = {
  workflowStatus: string;
  /** Current LabStack status, or null when the caller could not read it. */
  sourceOrderStatus: string | null;
  appointmentTime: Date | null;
  /** When this provider was last messaged about this order, across all rules. */
  lastMessageAt: Date | null;
  /** IANA zone the provider's day is measured in. */
  timeZone: string;
};

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

// ── Scope ───────────────────────────────────────────────────────────────────

/**
 * An empty allow-list means "everything", matching TaskRule.allowedTypes. It
 * reads oddly the first time and is the right default: a new rule that has not
 * been narrowed yet should cover the whole estate, not nothing.
 */
export function ruleAppliesTo(
  rule: Pick<CommunicationRule, "allowedLabIds" | "allowedOrderTypes">,
  target: { labId: number; orderType?: string | null },
): boolean {
  if (rule.allowedLabIds.length > 0 && !rule.allowedLabIds.includes(target.labId)) return false;
  if (rule.allowedOrderTypes.length > 0) {
    if (!target.orderType) return false;
    if (!rule.allowedOrderTypes.includes(target.orderType)) return false;
  }
  return true;
}

export function selectRulesFor(
  rules: CommunicationRule[],
  target: { labId: number; orderType?: string | null },
): CommunicationRule[] {
  return rules.filter((rule) => rule.isActive && ruleAppliesTo(rule, target));
}

// ── Plan time ───────────────────────────────────────────────────────────────

export type PlannedRuleAction = {
  ruleId: string;
  ruleName: string;
  anchor: LabScheduleAnchor;
  type: LadderActionType;
  templateKey: string;
  recipient: ProviderRuleRecipient;
  priority: number;
  offsetMinutes: number;
  runAt: Date;
  idempotencyKey: string;
};

/** Why a rule scheduled nothing for this order. Surfaced by the simulator. */
export type PlanSkipReason =
  | "OUT_OF_SCOPE"
  | "NO_APPOINTMENT"
  | "APPOINTMENT_CLOCK_DISABLED"
  | "ALREADY_PAST"
  | "AFTER_APPOINTMENT";

export type RulePlanOutcome =
  | { ruleId: string; scheduled: true; action: PlannedRuleAction }
  | { ruleId: string; scheduled: false; reason: PlanSkipReason; detail: string };

/**
 * One action per rule per order. That is the deduplication boundary, and it is
 * enforced twice: here by construction, and in the database by the unique
 * idempotencyKey. A second chase is a second rule, exactly as a second task is
 * a second task rule — which keeps "what will this provider receive?" a
 * readable list rather than an emergent property of one rule's retry loop.
 */
export function planRuleOutcomes(input: {
  orderId: number;
  labId: number;
  orderType?: string | null;
  createdAt: Date;
  appointmentTime: Date | null;
  rules: CommunicationRule[];
  /** The lab's own appointment-clock toggle. An off switch beats a rule. */
  appointmentRemindersEnabled: boolean;
  now: Date;
}): RulePlanOutcome[] {
  const { orderId, labId, orderType, createdAt, appointmentTime, rules, appointmentRemindersEnabled, now } = input;

  return rules.map((rule): RulePlanOutcome => {
    if (!rule.isActive || !ruleAppliesTo(rule, { labId, orderType })) {
      return { ruleId: rule.id, scheduled: false, reason: "OUT_OF_SCOPE", detail: `Rule does not cover lab #${labId}${orderType ? ` / ${orderType}` : ""}` };
    }

    if (rule.anchor === "APPOINTMENT") {
      if (!appointmentTime) {
        return { ruleId: rule.id, scheduled: false, reason: "NO_APPOINTMENT", detail: "Appointment-anchored rule, but the order has no appointment time" };
      }
      if (!appointmentRemindersEnabled) {
        return { ruleId: rule.id, scheduled: false, reason: "APPOINTMENT_CLOCK_DISABLED", detail: "The lab's appointment clock is switched off" };
      }
    }

    const base = rule.anchor === "ORDER" ? createdAt : appointmentTime!;
    const runAt = addMinutes(base, rule.offsetMinutes);

    // A rung already in the past is dropped rather than fired immediately: a
    // "please confirm within the hour" message sent two hours late is worse
    // than silence.
    if (runAt.getTime() <= now.getTime()) {
      return { ruleId: rule.id, scheduled: false, reason: "ALREADY_PAST", detail: "That moment had already passed when the order arrived" };
    }
    // The appointment is the deadline, so it is the cutoff — the same
    // invariant buildLadder enforces, and for the same reason.
    if (appointmentTime && runAt.getTime() > appointmentTime.getTime()) {
      return { ruleId: rule.id, scheduled: false, reason: "AFTER_APPOINTMENT", detail: "Would land after the appointment" };
    }

    return {
      ruleId: rule.id,
      scheduled: true,
      action: {
        ruleId: rule.id,
        ruleName: rule.name,
        anchor: rule.anchor,
        type: rule.action,
        templateKey: rule.templateKey,
        recipient: rule.recipient,
        priority: rule.priority,
        offsetMinutes: rule.offsetMinutes,
        runAt,
        idempotencyKey: `non-api:${orderId}:rule:${rule.id}`,
      },
    };
  });
}

/** The scheduled actions only, soonest first — what the workflow writer wants. */
export function planRuleActions(input: Parameters<typeof planRuleOutcomes>[0]): PlannedRuleAction[] {
  return planRuleOutcomes(input)
    .flatMap((outcome) => (outcome.scheduled ? [outcome.action] : []))
    .sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.priority - b.priority);
}

// ── Send time ───────────────────────────────────────────────────────────────

/**
 * Wall-clock hour and minute where the provider is. Intl is the only
 * timezone-correct way to do this without pulling in a date library, and it
 * keeps the function pure — the zone arrives as an argument.
 */
function localTimeIn(instant: Date, timeZone: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone,
    }).formatToParts(instant);
    const read = (type: "hour" | "minute") => Number(parts.find((part) => part.type === type)?.value ?? "0");
    // en-GB renders midnight as 24 in some ICU versions; normalise it.
    return { hour: read("hour") % 24, minute: read("minute") };
  } catch {
    // An unknown zone must not stop a reminder. Fall back to UTC.
    return { hour: instant.getUTCHours(), minute: instant.getUTCMinutes() };
  }
}

/**
 * Minutes from `now` until the send window next opens. Zero when it is
 * already open.
 */
export function minutesUntilWindowOpens(
  now: Date,
  window: { startHour: number; endHour: number },
  timeZone: string,
): number {
  const { hour, minute } = localTimeIn(now, timeZone);
  const minutesIntoDay = hour * 60 + minute;
  const opens = window.startHour * 60;
  const closes = window.endHour * 60;
  if (minutesIntoDay >= opens && minutesIntoDay < closes) return 0;
  if (minutesIntoDay < opens) return opens - minutesIntoDay;
  return 24 * 60 - minutesIntoDay + opens;
}

/**
 * Should this scheduled message actually go out right now?
 *
 * Gate order is deliberate: the absolute answers ("this order is done",
 * "wrong status") come first and suppress, because a suppressed action is
 * cheap and correct. The two clock-based gates come last and *defer*, because
 * "not yet" is not "never" — with one exception below.
 */
export function evaluateSendCondition(
  rule: Pick<CommunicationRule, "sendCondition" | "anchor">,
  context: SendContext,
  now: Date,
): SendDecision {
  const condition = rule.sendCondition ?? {};

  // 1. The conversation must still be one worth continuing.
  const allowedWorkflowStatuses = condition.workflowStatusIn?.length
    ? condition.workflowStatusIn
    : [...OPEN_WORKFLOW_STATUSES];
  if (!allowedWorkflowStatuses.includes(context.workflowStatus)) {
    return {
      verdict: "SKIP",
      check: "workflowStatusIn",
      reason: `Workflow is ${context.workflowStatus}, rule sends only on ${allowedWorkflowStatuses.join(" or ")}`,
    };
  }

  // 2. LabStack's own view of the order. A null status means the caller could
  //    not read the source; that is not grounds to suppress, so the gate is
  //    skipped and the caller's own retry logic owns the outcome.
  if (condition.sourceStatusIn?.length && context.sourceOrderStatus !== null) {
    if (!condition.sourceStatusIn.includes(context.sourceOrderStatus)) {
      return {
        verdict: "SKIP",
        check: "sourceStatusIn",
        reason: `Order is ${context.sourceOrderStatus} in LabStack, rule sends only on ${condition.sourceStatusIn.join(" or ")}`,
      };
    }
  }

  // 3. Some messages only mean something with an appointment to quote.
  if (condition.requireAppointment && !context.appointmentTime) {
    return { verdict: "SKIP", check: "requireAppointment", reason: "Order has no appointment time on file" };
  }

  // 4. The quiet run-up to the appointment. Past this point the provider is
  //    either on their way or not, and another WhatsApp will not change it.
  if (condition.skipWithinMinutesOfAppointment !== undefined && context.appointmentTime) {
    const minutesLeft = minutesBetween(now, context.appointmentTime);
    if (minutesLeft <= condition.skipWithinMinutesOfAppointment) {
      return {
        verdict: "SKIP",
        check: "skipWithinMinutesOfAppointment",
        reason: `Appointment is ${Math.max(0, Math.round(minutesLeft))} min away; rule stays quiet inside ${condition.skipWithinMinutesOfAppointment} min`,
      };
    }
  }

  // 5. Per-rule gap on top of the lab's quiet window. Deferring rather than
  //    dropping is the point: the provider still needs this message, just not
  //    in the same minute as the last one.
  if (condition.minMinutesSinceLastMessage !== undefined && context.lastMessageAt) {
    const readyAt = addMinutes(context.lastMessageAt, condition.minMinutesSinceLastMessage);
    if (readyAt.getTime() > now.getTime()) {
      return deferOrSkip(readyAt, context.appointmentTime, {
        check: "minMinutesSinceLastMessage",
        reason: `Last message was ${Math.round(minutesBetween(context.lastMessageAt, now))} min ago; rule wants ${condition.minMinutesSinceLastMessage} min`,
      });
    }
  }

  // 6. The provider's own day. A 3am reminder gets read at 9am and resented
  //    at both times.
  if (condition.sendWindow) {
    const waitMinutes = minutesUntilWindowOpens(now, condition.sendWindow, context.timeZone);
    if (waitMinutes > 0) {
      return deferOrSkip(addMinutes(now, waitMinutes), context.appointmentTime, {
        check: "sendWindow",
        reason: `Outside the ${formatHour(condition.sendWindow.startHour)}–${formatHour(condition.sendWindow.endHour)} send window`,
      });
    }
  }

  return { verdict: "SEND" };
}

/**
 * A deferral that lands after the appointment is not a deferral, it is a
 * message nobody will act on. Suppress it instead of parking it — the same
 * call `recomputeAppointmentRungs` makes when an appointment moves past a
 * pending rung.
 */
function deferOrSkip(
  runAt: Date,
  appointmentTime: Date | null,
  meta: { check: SendCheck; reason: string },
): SendDecision {
  if (appointmentTime && runAt.getTime() > appointmentTime.getTime()) {
    return { verdict: "SKIP", check: meta.check, reason: `${meta.reason} — which is past the appointment` };
  }
  return { verdict: "DEFER", check: meta.check, reason: meta.reason, runAt };
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

// ── Shared formatting (UI, simulator, and audit payloads) ───────────────────

/** "2h after the order is detected" / "30m before the appointment". */
export function describeOffset(anchor: LabScheduleAnchor, offsetMinutes: number): string {
  const absolute = Math.abs(offsetMinutes);
  const unit =
    absolute === 0 ? "0m"
      : absolute % 1440 === 0 ? `${absolute / 1440}d`
        : absolute % 60 === 0 ? `${absolute / 60}h`
          : absolute >= 60 ? `${Math.floor(absolute / 60)}h ${absolute % 60}m`
            : `${absolute}m`;
  if (anchor === "ORDER") return `${unit} after the order is detected`;
  return offsetMinutes <= 0 ? `${unit} before the appointment` : `${unit} after the appointment`;
}
