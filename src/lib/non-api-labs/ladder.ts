/**
 * The two communication clocks (PRD §6).
 *
 * A workflow is chased on two independent schedules:
 *
 *   ORDER clock       — anchored to when we first saw the order. Answers
 *                       "the lab has had this for N hours and still hasn't
 *                       replied." Offsets come from the lab's own SLA config.
 *   APPOINTMENT clock — anchored to the patient's appointment. Answers
 *                       "the patient is due in N minutes and nobody has
 *                       confirmed." Offsets are fixed and negative.
 *
 * Every function here is pure: no Prisma, no Date.now(), no env. `now` is
 * always an argument. That is deliberate — arbitration between two clocks is
 * the subtle part of this feature and it has to be testable in isolation.
 *
 * Priority is P0..P4 where **P0 is most urgent**. Priority never orders the
 * ladder (runAt does); it only breaks ties when two rungs come due together.
 */

export type LabScheduleAnchor = "ORDER" | "APPOINTMENT";
export type LadderActionType = "SEND_REMINDER" | "ESCALATE";

export type LadderRungKey =
  | "ORDER_CONFIRMATION"
  | "ORDER_URGENT"
  | "ORDER_ESCALATION"
  | "APPT_T_MINUS_24H"
  | "APPT_T_MINUS_2H"
  | "APPT_T_MINUS_30M"
  | "APPT_T_MINUS_10M";

/** The slice of NonApiLabConfig the ladder needs. */
export type LadderConfig = {
  confirmationSlaMinutes: number;
  reminderSlaMinutes: number;
  escalationSlaMinutes: number;
  appointmentRemindersEnabled: boolean;
  quietWindowMinutes: number;
};

type RungDefinition = {
  key: LadderRungKey;
  anchor: LabScheduleAnchor;
  type: LadderActionType;
  priority: number;
  /** Signed minutes from the anchor. Negative means "before". */
  offsetMinutes: (config: LadderConfig) => number;
};

/**
 * Ordered by anchor then by offset. The appointment offsets are fixed rather
 * than configurable: they encode how late is too late for a patient, which is
 * a property of the patient's day, not of the lab's SLA agreement.
 */
export const LADDER_RUNGS: readonly RungDefinition[] = [
  { key: "ORDER_CONFIRMATION", anchor: "ORDER", type: "SEND_REMINDER", priority: 4, offsetMinutes: (c) => c.confirmationSlaMinutes },
  { key: "ORDER_URGENT", anchor: "ORDER", type: "SEND_REMINDER", priority: 3, offsetMinutes: (c) => c.reminderSlaMinutes },
  { key: "ORDER_ESCALATION", anchor: "ORDER", type: "ESCALATE", priority: 1, offsetMinutes: (c) => c.escalationSlaMinutes },
  { key: "APPT_T_MINUS_24H", anchor: "APPOINTMENT", type: "SEND_REMINDER", priority: 4, offsetMinutes: () => -1440 },
  { key: "APPT_T_MINUS_2H", anchor: "APPOINTMENT", type: "SEND_REMINDER", priority: 2, offsetMinutes: () => -120 },
  { key: "APPT_T_MINUS_30M", anchor: "APPOINTMENT", type: "SEND_REMINDER", priority: 1, offsetMinutes: () => -30 },
  { key: "APPT_T_MINUS_10M", anchor: "APPOINTMENT", type: "SEND_REMINDER", priority: 0, offsetMinutes: () => -10 },
] as const;

const RUNG_BY_KEY = new Map<string, RungDefinition>(LADDER_RUNGS.map((rung) => [rung.key, rung]));

export function rungDefinition(key: string | null | undefined): RungDefinition | null {
  return key ? RUNG_BY_KEY.get(key) ?? null : null;
}

/** How long an action link stays usable after the appointment has passed. */
export const TOKEN_GRACE_MINUTES = 120;

/**
 * Only a P0 rung may break the quiet window. Everything else waits — a lab
 * that just received a message does not need a second one in the same minute.
 */
const QUIET_WINDOW_OVERRIDE_PRIORITY = 0;

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

export type PlannedRung = {
  rungKey: LadderRungKey;
  anchor: LabScheduleAnchor;
  type: LadderActionType;
  priority: number;
  offsetMinutes: number;
  runAt: Date;
  idempotencyKey: string;
};

// Authored rules used to be planned here, by casting a rule id into a
// `rungKey`. They now live in rules.ts, which can express the scope and
// send-time conditions a rung key cannot carry. This file is the built-in
// default again — the ladder a provider gets when no rule covers them.

/**
 * The rungs to schedule for a freshly started workflow.
 *
 * Two filters, and both matter:
 *
 *  - a rung already in the past is dropped rather than fired immediately;
 *  - **no rung may land after the appointment.** This is the real fix for the
 *    original defect. A 09:00 order for a 09:30 appointment used to schedule
 *    its first reminder at 10:00, half an hour after the patient was due.
 *    Dropping only past rungs would not have helped: 10:00 is in the future.
 *    The appointment is the deadline, so it is the cutoff.
 *
 * That 09:00/09:30 order therefore ends up with exactly one rung — T-10m at
 * 09:20 — instead of three reminders that all arrive too late to matter.
 */
export function buildLadder(input: {
  orderId: number;
  createdAt: Date;
  appointmentTime: Date | null;
  config: LadderConfig;
  now: Date;
}): PlannedRung[] {
  const { orderId, createdAt, appointmentTime, config, now } = input;
  const planned: PlannedRung[] = [];

  for (const rung of LADDER_RUNGS) {
    if (rung.anchor === "APPOINTMENT") {
      if (!appointmentTime) continue;
      if (!config.appointmentRemindersEnabled) continue;
    }
    const base = rung.anchor === "ORDER" ? createdAt : appointmentTime;
    if (!base) continue;

    const offsetMinutes = rung.offsetMinutes(config);
    const runAt = addMinutes(base, offsetMinutes);
    if (runAt.getTime() <= now.getTime()) continue;
    if (appointmentTime && runAt.getTime() > appointmentTime.getTime()) continue;

    planned.push({
      rungKey: rung.key,
      anchor: rung.anchor,
      type: rung.type,
      priority: rung.priority,
      offsetMinutes,
      runAt,
      idempotencyKey: `non-api:${orderId}:${rung.key.toLowerCase()}`,
    });
  }

  return planned.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
}

export type RecomputableAction = {
  id: string;
  rungKey: string | null;
  anchor: string;
  offsetMinutes: number;
  runAt: Date;
};

export type RecomputeOutcome =
  | { id: string; outcome: "RESCHEDULED"; runAt: Date }
  | { id: string; outcome: "SUPPRESSED"; reason: string }
  | { id: string; outcome: "UNCHANGED" };

/**
 * Re-derive appointment-anchored rungs after the appointment moved in
 * LabStack. Order-anchored rungs are untouched — moving an appointment does
 * not change how long the lab has been sitting on the order.
 *
 * A rung whose recomputed time has already passed is suppressed rather than
 * fired late: a "your patient is due in 2 hours" message sent after the
 * appointment is worse than no message.
 */
export function recomputeAppointmentRungs(
  actions: RecomputableAction[],
  newAppointmentTime: Date | null,
  now: Date,
): RecomputeOutcome[] {
  return actions.map((action): RecomputeOutcome => {
    if (action.anchor !== "APPOINTMENT") {
      // Order-anchored rungs keep their time — how long the lab has sat on the
      // order didn't change. But the appointment is still the cutoff, so one
      // that now falls after the moved appointment is dropped rather than
      // arriving too late to be worth sending.
      if (newAppointmentTime && action.runAt.getTime() > newAppointmentTime.getTime()) {
        return { id: action.id, outcome: "SUPPRESSED", reason: "Appointment moved before this reminder was due" };
      }
      return { id: action.id, outcome: "UNCHANGED" };
    }
    if (!newAppointmentTime) {
      return { id: action.id, outcome: "SUPPRESSED", reason: "Appointment time was cleared in LabStack" };
    }

    const runAt = addMinutes(newAppointmentTime, action.offsetMinutes);
    if (runAt.getTime() <= now.getTime()) {
      return { id: action.id, outcome: "SUPPRESSED", reason: "Appointment moved past this reminder" };
    }
    if (runAt.getTime() === action.runAt.getTime()) return { id: action.id, outcome: "UNCHANGED" };
    return { id: action.id, outcome: "RESCHEDULED", runAt };
  });
}

export type ArbitrableAction = {
  id: string;
  priority: number;
  runAt: Date;
  rungKey: string | null;
};

export type Arbitration<T extends ArbitrableAction> = {
  /** The single action to act on this tick, if any. */
  send: T | null;
  /** Losers, to be marked SUPPRESSED with the given reason. */
  suppress: Array<{ action: T; reason: string }>;
  /** Held back by the quiet window — stays PENDING with a pushed-out runAt. */
  defer: Array<{ action: T; runAt: Date }>;
};

/**
 * Decide what a single workflow actually sends this tick.
 *
 * Two clocks against one WhatsApp number is exactly where double-messaging
 * appears, so at most one message per workflow per tick leaves here. When
 * several rungs come due together the most urgent wins and the rest are
 * suppressed — they have been overtaken by events and re-sending them later
 * would just be noise.
 *
 * `actions` must all belong to the same workflow.
 */
export function arbitrate<T extends ArbitrableAction>(
  actions: T[],
  options: { quietWindowMinutes: number; lastSentAt: Date | null; now: Date },
): Arbitration<T> {
  const result: Arbitration<T> = { send: null, suppress: [], defer: [] };
  if (actions.length === 0) return result;

  const ranked = [...actions].sort(
    (a, b) => a.priority - b.priority || a.runAt.getTime() - b.runAt.getTime(),
  );
  const [winner, ...losers] = ranked;

  for (const loser of losers) {
    result.suppress.push({
      action: loser,
      reason: `Superseded by a more urgent reminder (${winner.rungKey ?? "unknown"})`,
    });
  }

  const { quietWindowMinutes, lastSentAt, now } = options;
  if (lastSentAt && quietWindowMinutes > 0 && winner.priority > QUIET_WINDOW_OVERRIDE_PRIORITY) {
    const quietUntil = addMinutes(lastSentAt, quietWindowMinutes);
    if (quietUntil.getTime() > now.getTime()) {
      result.defer.push({ action: winner, runAt: quietUntil });
      return result;
    }
  }

  result.send = winner;
  return result;
}

/**
 * Action links must outlive the appointment, not the order ladder. Previously
 * they expired on `escalationDeadline`, so a link could die before the patient
 * was even due.
 */
export function tokenExpiryFor(appointmentTime: Date | null, fallback: Date): Date {
  if (!appointmentTime) return fallback;
  const afterAppointment = addMinutes(appointmentTime, TOKEN_GRACE_MINUTES);
  return afterAppointment.getTime() > fallback.getTime() ? afterAppointment : fallback;
}
