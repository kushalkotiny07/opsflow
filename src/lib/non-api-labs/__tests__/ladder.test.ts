import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arbitrate,
  buildLadder,
  recomputeAppointmentRungs,
  tokenExpiryFor,
  type LadderConfig,
} from "../ladder";
import { classifySourceOrder } from "../source-check";

const CONFIG: LadderConfig = {
  confirmationSlaMinutes: 60,
  reminderSlaMinutes: 180,
  escalationSlaMinutes: 300,
  appointmentRemindersEnabled: true,
  quietWindowMinutes: 10,
};

const at = (iso: string) => new Date(iso);
const keys = (rungs: Array<{ rungKey: string }>) => rungs.map((rung) => rung.rungKey);

// ── buildLadder ────────────────────────────────────────────────────────────

test("the original defect: a same-day order never schedules past the appointment", () => {
  // 09:00 order for a 09:30 appointment. The old code scheduled its first
  // reminder at 10:00 — half an hour after the patient was due.
  const now = at("2026-09-08T09:00:00.000Z");
  const ladder = buildLadder({
    orderId: 1,
    createdAt: now,
    appointmentTime: at("2026-09-08T09:30:00.000Z"),
    config: CONFIG,
    now,
  });

  assert.deepEqual(keys(ladder), ["APPT_T_MINUS_10M"]);
  assert.equal(ladder[0].runAt.toISOString(), "2026-09-08T09:20:00.000Z");
  for (const rung of ladder) {
    assert.ok(rung.runAt <= at("2026-09-08T09:30:00.000Z"), `${rung.rungKey} lands after the appointment`);
    assert.ok(rung.runAt > now, `${rung.rungKey} lands in the past`);
  }
});

test("an order with runway keeps the order clock exactly as before", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const ladder = buildLadder({
    orderId: 2,
    createdAt: now,
    appointmentTime: at("2026-09-15T09:00:00.000Z"),
    config: CONFIG,
    now,
  });

  const byKey = new Map(ladder.map((rung) => [rung.rungKey, rung]));
  assert.equal(byKey.get("ORDER_CONFIRMATION")!.runAt.toISOString(), "2026-09-08T10:00:00.000Z");
  assert.equal(byKey.get("ORDER_URGENT")!.runAt.toISOString(), "2026-09-08T12:00:00.000Z");
  assert.equal(byKey.get("ORDER_ESCALATION")!.runAt.toISOString(), "2026-09-08T14:00:00.000Z");
  // And the appointment clock is layered on top rather than replacing it.
  assert.equal(byKey.get("APPT_T_MINUS_24H")!.runAt.toISOString(), "2026-09-14T09:00:00.000Z");
  assert.equal(byKey.size, 7);
});

test("a null appointment falls back to the order clock without throwing", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const ladder = buildLadder({ orderId: 3, createdAt: now, appointmentTime: null, config: CONFIG, now });

  assert.deepEqual(keys(ladder), ["ORDER_CONFIRMATION", "ORDER_URGENT", "ORDER_ESCALATION"]);
});

test("appointment reminders can be turned off per lab", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const ladder = buildLadder({
    orderId: 4,
    createdAt: now,
    appointmentTime: at("2026-09-15T09:00:00.000Z"),
    config: { ...CONFIG, appointmentRemindersEnabled: false },
    now,
  });

  assert.ok(ladder.every((rung) => rung.anchor === "ORDER"));
  assert.equal(ladder.length, 3);
});

test("the escalation rung is the one that escalates", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const ladder = buildLadder({ orderId: 5, createdAt: now, appointmentTime: null, config: CONFIG, now });

  const escalation = ladder.find((rung) => rung.rungKey === "ORDER_ESCALATION")!;
  assert.equal(escalation.type, "ESCALATE");
  assert.ok(ladder.filter((rung) => rung.type === "ESCALATE").length === 1);
});

// ── recomputeAppointmentRungs ──────────────────────────────────────────────

test("moving an appointment earlier re-derives appointment rungs and drops the stale ones", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const actions = [
    { id: "a", rungKey: "APPT_T_MINUS_24H", anchor: "APPOINTMENT", offsetMinutes: -1440, runAt: at("2026-09-14T09:00:00.000Z") },
    { id: "b", rungKey: "APPT_T_MINUS_2H", anchor: "APPOINTMENT", offsetMinutes: -120, runAt: at("2026-09-15T07:00:00.000Z") },
  ];

  // Pulled forward from 15 Sep to 08 Sep 12:00.
  const outcomes = recomputeAppointmentRungs(actions, at("2026-09-08T12:00:00.000Z"), now);

  // T-24h would now be 07 Sep — already past, so it is suppressed, not fired late.
  assert.equal(outcomes[0].outcome, "SUPPRESSED");
  // T-2h becomes 10:00 on the 8th, still ahead of us.
  assert.equal(outcomes[1].outcome, "RESCHEDULED");
  assert.equal((outcomes[1] as { runAt: Date }).runAt.toISOString(), "2026-09-08T10:00:00.000Z");
});

test("an order rung stranded after a moved-up appointment is suppressed", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const actions = [
    { id: "o", rungKey: "ORDER_ESCALATION", anchor: "ORDER", offsetMinutes: 300, runAt: at("2026-09-08T14:00:00.000Z") },
  ];

  const outcomes = recomputeAppointmentRungs(actions, at("2026-09-08T11:00:00.000Z"), now);
  assert.equal(outcomes[0].outcome, "SUPPRESSED");
});

test("clearing the appointment suppresses appointment rungs but leaves order rungs alone", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const outcomes = recomputeAppointmentRungs(
    [
      { id: "a", rungKey: "APPT_T_MINUS_2H", anchor: "APPOINTMENT", offsetMinutes: -120, runAt: at("2026-09-15T07:00:00.000Z") },
      { id: "o", rungKey: "ORDER_URGENT", anchor: "ORDER", offsetMinutes: 180, runAt: at("2026-09-08T12:00:00.000Z") },
    ],
    null,
    now,
  );

  assert.equal(outcomes[0].outcome, "SUPPRESSED");
  assert.equal(outcomes[1].outcome, "UNCHANGED");
});

// ── arbitrate ──────────────────────────────────────────────────────────────

const due = (id: string, priority: number, runAt: string, rungKey: string) => ({
  id, priority, runAt: at(runAt), rungKey,
});

test("when both clocks fire together only the most urgent message goes out", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const decision = arbitrate(
    [
      due("order", 4, "2026-09-08T08:59:00.000Z", "ORDER_CONFIRMATION"),
      due("appt", 0, "2026-09-08T08:59:30.000Z", "APPT_T_MINUS_10M"),
    ],
    { quietWindowMinutes: 10, lastSentAt: null, now },
  );

  assert.equal(decision.send?.id, "appt");
  assert.equal(decision.suppress.length, 1);
  assert.equal(decision.suppress[0].action.id, "order");
  assert.equal(decision.defer.length, 0);
});

test("the quiet window defers a routine reminder instead of double-messaging", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const decision = arbitrate([due("order", 4, "2026-09-08T08:59:00.000Z", "ORDER_CONFIRMATION")], {
    quietWindowMinutes: 10,
    lastSentAt: at("2026-09-08T08:55:00.000Z"),
    now,
  });

  assert.equal(decision.send, null);
  assert.equal(decision.defer.length, 1);
  // Pushed to exactly the end of the quiet window, not dropped.
  assert.equal(decision.defer[0].runAt.toISOString(), "2026-09-08T09:05:00.000Z");
});

test("a P0 rung breaks the quiet window", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const decision = arbitrate([due("appt", 0, "2026-09-08T08:59:00.000Z", "APPT_T_MINUS_10M")], {
    quietWindowMinutes: 10,
    lastSentAt: at("2026-09-08T08:59:00.000Z"),
    now,
  });

  assert.equal(decision.send?.id, "appt");
  assert.equal(decision.defer.length, 0);
});

test("an elapsed quiet window sends normally", () => {
  const now = at("2026-09-08T09:00:00.000Z");
  const decision = arbitrate([due("order", 3, "2026-09-08T08:59:00.000Z", "ORDER_URGENT")], {
    quietWindowMinutes: 10,
    lastSentAt: at("2026-09-08T08:40:00.000Z"),
    now,
  });

  assert.equal(decision.send?.id, "order");
});

// ── tokenExpiryFor ─────────────────────────────────────────────────────────

test("action links outlive the appointment rather than the order ladder", () => {
  const escalationDeadline = at("2026-09-08T14:00:00.000Z");
  // Appointment well after the order ladder ends.
  assert.equal(
    tokenExpiryFor(at("2026-09-15T09:00:00.000Z"), escalationDeadline).toISOString(),
    "2026-09-15T11:00:00.000Z",
  );
  // Same-day appointment: never expire earlier than the order ladder would have.
  assert.equal(tokenExpiryFor(at("2026-09-08T09:30:00.000Z"), escalationDeadline), escalationDeadline);
  assert.equal(tokenExpiryFor(null, escalationDeadline), escalationDeadline);
});

// ── classifySourceOrder ────────────────────────────────────────────────────

test("a cancelled order closes the workflow instead of messaging the lab", () => {
  const verdict = classifySourceOrder({ orderStatus: "CANCELED", appointmentTime: null }, null);
  assert.equal(verdict.kind, "CLOSE");
  assert.equal((verdict as { workflowStatus: string }).workflowStatus, "CANCELLED");
});

test("an order that vanished upstream closes the workflow", () => {
  const verdict = classifySourceOrder(undefined, null);
  assert.equal(verdict.kind, "CLOSE");
  assert.equal((verdict as { workflowStatus: string }).workflowStatus, "CANCELLED");
});

test("a delivered or missed order closes as completed, not cancelled", () => {
  for (const status of ["REPORT_DELIVERED", "PATIENT_MISSED"]) {
    const verdict = classifySourceOrder({ orderStatus: status, appointmentTime: null }, null);
    assert.equal((verdict as { workflowStatus: string }).workflowStatus, "COMPLETED");
  }
});

test("a moved appointment asks for a reschedule, not a send", () => {
  const verdict = classifySourceOrder(
    { orderStatus: "PENDING", appointmentTime: at("2026-09-09T09:00:00.000Z") },
    at("2026-09-08T09:00:00.000Z"),
  );
  assert.equal(verdict.kind, "RESCHEDULE");
});

test("an unchanged live order sends", () => {
  const appointment = at("2026-09-08T09:00:00.000Z");
  const verdict = classifySourceOrder({ orderStatus: "PENDING", appointmentTime: appointment }, new Date(appointment));
  assert.equal(verdict.kind, "SEND");
});
