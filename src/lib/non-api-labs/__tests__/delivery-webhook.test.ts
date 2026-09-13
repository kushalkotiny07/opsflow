import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeDeliveryStatus } from "../delivery-events";

describe("normalizeDeliveryStatus", () => {
  it("maps the common WhatsApp lifecycle states", () => {
    assert.equal(normalizeDeliveryStatus("queued"), "SENT");
    assert.equal(normalizeDeliveryStatus("sent"), "SENT");
    assert.equal(normalizeDeliveryStatus("delivered"), "DELIVERED");
    assert.equal(normalizeDeliveryStatus("read"), "READ");
    assert.equal(normalizeDeliveryStatus("failed"), "FAILED");
  });

  it("ignores unknown statuses", () => {
    assert.equal(normalizeDeliveryStatus("pending"), "SENT");
    assert.equal(normalizeDeliveryStatus("unknown"), null);
  });
});
