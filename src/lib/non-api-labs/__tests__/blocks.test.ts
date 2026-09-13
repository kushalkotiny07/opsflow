import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromBody, toBody, variablesIn, renderPreview } from "../blocks";
import { TEMPLATE_DEFAULTS } from "../templates";

/**
 * The block editor is a view over the stored text, so the round trip is the
 * property everything else rests on: if `toBody(fromBody(x)) !== x`, then
 * merely opening a template in the builder would rewrite it, and the raw-text
 * escape hatch and the block canvas would fight over the same string.
 */
describe("body ⇄ blocks round trip", () => {
  it("is lossless for every shipped template default", () => {
    const keys = Object.keys(TEMPLATE_DEFAULTS);
    assert.ok(keys.length >= 4, "expected the shipped template defaults to be present");
    for (const [key, { body }] of Object.entries(TEMPLATE_DEFAULTS)) {
      assert.equal(toBody(fromBody(body)), body, `template ${key} did not survive the round trip`);
    }
  });

  it("is lossless for the shapes the parser classifies", () => {
    const body = [
      "*LabStack New Order*",
      "",
      "Order ID: {{order_id}}",
      "Patient: {{patient_name}}",
      "",
      "Please confirm by {{sla_deadline}}.",
      "",
      "Accept order: {{accept_url}}",
      "Reschedule: {{reschedule_url}}",
    ].join("\n");
    assert.equal(toBody(fromBody(body)), body);
  });

  it("keeps unrecognised lines verbatim as text", () => {
    const odd = "-- 50% off :: not a field --";
    const blocks = fromBody(odd);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, "text");
    assert.equal(toBody(blocks), odd);
  });
});

describe("classification", () => {
  it("separates headings, fields, action links and spacers", () => {
    const blocks = fromBody(["*Title*", "", "Tests: {{tests}}", "Accept: {{accept_url}}"].join("\n"));
    assert.deepEqual(blocks.map((b) => b.kind), ["heading", "spacer", "field", "action"]);
  });

  it("treats any *_url variable as an action rather than a field", () => {
    const [block] = fromBody("Cannot fulfil: {{reject_url}}");
    assert.equal(block.kind, "action");
  });
});

describe("variablesIn", () => {
  it("collects variables from fields, actions and inline prose, without duplicates", () => {
    const blocks = fromBody(
      ["Order ID: {{order_id}}", "Due {{sla_deadline}} for {{order_id}}", "Accept: {{accept_url}}"].join("\n"),
    );
    assert.deepEqual(variablesIn(blocks), ["order_id", "sla_deadline", "accept_url"]);
  });
});

describe("renderPreview", () => {
  it("substitutes sample values", () => {
    assert.match(renderPreview("Order ID: {{order_id}}"), /Order ID: \d+/);
  });

  it("marks a variable it has no sample for, instead of blanking it", () => {
    assert.equal(renderPreview("{{not_a_variable}}"), "⟨not_a_variable?⟩");
  });
});
