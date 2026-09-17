import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePollOptions } from "../poll-definitions";

// These options are read back off a wa_polls row when a vote arrives, and the
// reply is chosen from them. Anything this parser drops becomes an option the
// provider can tap and never hear back from — silently, because a dropped
// option looks identical to a poll that had no reply configured.
describe("parsePollOptions", () => {
  it("keeps a fully specified option", () => {
    const parsed = parsePollOptions([{ label: "Accept", action: "ACCEPT", ack: "Confirmed" }]);
    assert.deepEqual(parsed, [{ label: "Accept", action: "ACCEPT", ack: "Confirmed" }]);
  });

  // The regression: polls sent before replies were configurable stored
  // {label, action} only. Requiring `ack` made every one of those options
  // unmatchable, so a vote moved the order and the provider heard nothing.
  it("keeps a legacy option that predates configurable replies", () => {
    const parsed = parsePollOptions([
      { label: "Accept", action: "ACCEPT" },
      { label: "Cannot fulfil", action: "REJECT" },
    ]);
    assert.equal(parsed.length, 2, "legacy options must survive");
    assert.equal(parsed[0].ack, "", "a legacy option is silent, not missing");
    assert.equal(parsed[0].action, "ACCEPT");
  });

  it("treats a missing action as informational rather than dropping it", () => {
    const parsed = parsePollOptions([{ label: "Delayed", ack: "Noted" }]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].action, null);
  });

  it("drops what genuinely cannot be used", () => {
    const parsed = parsePollOptions([
      { label: "", action: "ACCEPT", ack: "x" },      // unmatchable: no label
      { label: "Bad", action: "EXPLODE", ack: "x" },  // not a real action
      "nonsense",
      null,
    ]);
    assert.deepEqual(parsed, []);
  });

  it("survives a column that is not an array at all", () => {
    assert.deepEqual(parsePollOptions(null), []);
    assert.deepEqual(parsePollOptions({ label: "Accept" }), []);
  });

  it("trims labels, because the vote is matched on exact text", () => {
    assert.equal(parsePollOptions([{ label: "  Accept  ", ack: "" }])[0].label, "Accept");
  });
});
