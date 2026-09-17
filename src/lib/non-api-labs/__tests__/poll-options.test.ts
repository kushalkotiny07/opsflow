import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_POLL_NAME,
  PROVIDER_POLL_OPTIONS,
  DEFAULT_NON_API_REMINDER_BODY,
  DEFAULT_NON_API_NEW_ORDER_BODY,
  DEFAULT_NON_API_ESCALATION_BODY,
  DEFAULT_NON_API_APPOINTMENT_BODY,
} from "../templates";

// A WhatsApp poll vote comes back as the option's TEXT, not its index. That
// makes these labels a wire format shared with every poll already sitting in a
// provider's group, so the properties below are the ones that would silently
// break vote handling rather than fail loudly.
describe("provider poll options", () => {
  it("covers exactly the three provider actions", () => {
    const actions = PROVIDER_POLL_OPTIONS.map((option) => option.action).sort();
    assert.deepEqual(actions, ["ACCEPT", "REJECT", "RESCHEDULE"]);
  });

  it("has unique labels, so a vote maps to exactly one action", () => {
    const labels = PROVIDER_POLL_OPTIONS.map((option) => option.label);
    assert.equal(new Set(labels).size, labels.length, "two options share a label");
  });

  it("has non-empty labels and a poll name WhatsApp will accept", () => {
    for (const option of PROVIDER_POLL_OPTIONS) {
      assert.ok(option.label.trim().length > 0, `empty label for ${option.action}`);
      // WhatsApp truncates long poll options; keep them tappable.
      assert.ok(option.label.length <= 24, `label too long: ${option.label}`);
    }
    assert.ok(PROVIDER_POLL_NAME.trim().length > 0);
  });

  it("gives WhatsApp at least two options to render a poll", () => {
    assert.ok(PROVIDER_POLL_OPTIONS.length >= 2);
  });
});

// The whole point of the change: providers answer by tapping, not by opening a
// link. A default body that still carried one would put a URL back in front of
// them the next time a template was seeded from scratch.
describe("default confirmation bodies", () => {
  const bodies = {
    reminder: DEFAULT_NON_API_REMINDER_BODY,
    newOrder: DEFAULT_NON_API_NEW_ORDER_BODY,
    escalation: DEFAULT_NON_API_ESCALATION_BODY,
    appointment: DEFAULT_NON_API_APPOINTMENT_BODY,
  };

  for (const [name, body] of Object.entries(bodies)) {
    it(`${name} carries no action URL`, () => {
      assert.doesNotMatch(body, /\{\{(accept_url|reschedule_url|reject_url)\}\}/);
      assert.doesNotMatch(body, /https?:\/\//);
    });
  }
});
