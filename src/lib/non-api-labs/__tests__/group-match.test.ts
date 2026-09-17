import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreMatch, suggestGroup, tokenize } from "../group-match";

// These matter more than they look. The suggestion fills in a WhatsApp group
// jid, and a wrong one points a lab's orders at ANOTHER lab's group — a
// mistake that sends real messages to the wrong company and is invisible from
// the config screen afterwards. So the tests below care far more about refusing
// a bad match than about finding every good one.
describe("scoreMatch", () => {
  it("ignores words that say nothing about which lab it is", () => {
    assert.deepEqual(tokenize("Redcliffe Labs Pvt Ltd"), ["redcliffe"]);
    assert.deepEqual(tokenize("Thyrocare India"), ["thyrocare"]);
  });

  it("matches a lab to its own group despite decoration", () => {
    assert.equal(scoreMatch("Thyrocare India", "Thyrocare India (provider)"), 1);
    assert.equal(scoreMatch("advaitha Lab_KA,TN,KL_TN,AP", "advaitha Lab_KA,TN,KL_TN,AP (provider)"), 1);
  });

  // Deliberately scores LOW, and this is the trade being made: "Servocure ops
  // escalations" is probably the right group, but "healthtech" going unmatched
  // is indistinguishable from the signal that separates "Orange Health -
  // Mumbai" from "Orange Health - Bangalore". The scorer would rather offer
  // nothing and let someone pick from the list than guess between sibling labs.
  it("declines a partial name match rather than risk a sibling lab", () => {
    assert.ok(scoreMatch("Servocure Healthtech LLP", "Servocure ops escalations") < 0.75);
  });

  it("scores an unrelated group at zero", () => {
    assert.equal(scoreMatch("Thyrocare India", "Lost and Found"), 0);
  });
});

describe("suggestGroup", () => {
  const groups = [
    { jid: "1@g.us", subject: "Orange Health - Bangalore (provider)" },
    { jid: "2@g.us", subject: "Thyrocare India (provider)" },
    { jid: "3@g.us", subject: "Millions- NEXT GEN FINANCE CLUB" },
  ];

  it("suggests the matching group", () => {
    assert.equal(suggestGroup("Thyrocare India", groups)?.group.jid, "2@g.us");
  });

  // The regression that prompted the threshold: same brand, different city.
  it("refuses a sibling lab's group", () => {
    assert.equal(suggestGroup("Orange Health - Hyderabad", groups), null);
    assert.equal(suggestGroup("Orange Health - Mumbai", groups), null);
  });

  // "gene" must not prefix-match "gen".
  it("refuses a coincidental short prefix", () => {
    assert.equal(suggestGroup("The Gene Box", groups), null);
  });

  it("returns null rather than guessing when nothing is close", () => {
    assert.equal(suggestGroup("Healthians", groups), null);
    assert.equal(suggestGroup("Thyrocare India", []), null);
  });
});
