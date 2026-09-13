import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildNonApiScheduledMessage } from "../scheduler";

describe("buildNonApiScheduledMessage", () => {
  it("renders reminder text with the action links and deadline", () => {
    const text = buildNonApiScheduledMessage(
      "REMINDER",
      {
        orderId: 42,
        labName: "City Lab",
        patientName: "Aditi Rao",
        appointmentTime: new Date("2026-01-05T10:30:00.000Z"),
        location: "Bengaluru",
        tests: "CBC, Vitamin D",
        confirmationDeadline: new Date("2026-01-05T11:00:00.000Z"),
      },
      "https://example.test/provider/action/accept",
      "https://example.test/provider/action/reschedule",
      "https://example.test/provider/action/reject",
    );

    assert.match(text, /Reminder/i);
    assert.match(text, /Aditi Rao/i);
    assert.match(text, /Accept/i);
    assert.match(text, /Reschedule/i);
    assert.match(text, /Cannot fulfil/i);
  });

  it("renders escalation prompts for a lab that has not yet answered", () => {
    const text = buildNonApiScheduledMessage(
      "ESCALATE",
      {
        orderId: 77,
        labName: "Redwood Diagnostics",
        patientName: "Vikram Nair",
        appointmentTime: new Date("2026-01-08T08:00:00.000Z"),
        location: "Mysuru",
        tests: "Lipid panel",
        confirmationDeadline: new Date("2026-01-08T09:00:00.000Z"),
      },
      "https://example.test/provider/action/accept",
      "https://example.test/provider/action/reschedule",
      "https://example.test/provider/action/reject",
    );

    assert.match(text, /Escalation/i);
    assert.match(text, /Vikram Nair/i);
    assert.match(text, /please confirm/i);
  });
});
