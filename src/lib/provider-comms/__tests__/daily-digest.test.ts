import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NonApiLabConfig } from "@prisma/client";
import { minutesPastSlot, scheduleBlock, dateLabel } from "../daily-digest";
import { DEFAULT_PROVIDER_DAILY_DIGEST_BODY, PROVIDER_DAILY_DIGEST_TEMPLATE, validateNonApiTemplateBody, renderLabTemplate, DIGEST_VARIABLES } from "@/lib/non-api-labs/templates";
import type { ScheduledOrder } from "../day-summary";

const IST = "Asia/Kolkata";

/** Only the two digest-time columns are read, so the rest can stay absent. */
const labAt = (hour: number, minute = 0) =>
  ({ dailyDigestHour: hour, dailyDigestMinute: minute } as NonApiLabConfig);

/**
 * The slot check is the whole schedule. If it is wrong the digest either never
 * fires or fires at the wrong hour, and both look like "the feature is off"
 * rather than like a bug — so it is pinned here rather than discovered in
 * production at 19:00.
 */
describe("minutesPastSlot", () => {
  // 13:29 UTC is 18:59 IST — one minute before a 19:00 slot.
  it("is null before the slot opens", () => {
    assert.equal(minutesPastSlot(labAt(19), new Date("2026-09-17T13:29:00Z"), IST), null);
  });

  it("is 0 at the slot minute", () => {
    assert.equal(minutesPastSlot(labAt(19), new Date("2026-09-17T13:30:00Z"), IST), 0);
  });

  it("counts minutes since the slot, which is what the staleness cap reads", () => {
    assert.equal(minutesPastSlot(labAt(19), new Date("2026-09-17T15:00:00Z"), IST), 90);
  });

  it("reads the local clock, not UTC", () => {
    // 13:30 UTC is 19:00 IST but only 14:30 in London: a UTC-based check would
    // call this lab not-due for another four and a half hours.
    assert.equal(minutesPastSlot(labAt(19), new Date("2026-09-17T13:30:00Z"), "Europe/London"), null);
  });

  it("honours the minute, not just the hour", () => {
    assert.equal(minutesPastSlot(labAt(19, 30), new Date("2026-09-17T13:45:00Z"), IST), null);
    assert.equal(minutesPastSlot(labAt(19, 30), new Date("2026-09-17T14:05:00Z"), IST), 5);
  });

  it("treats a midnight slot as open all day rather than never", () => {
    assert.equal(minutesPastSlot(labAt(0), new Date("2026-09-17T13:30:00Z"), IST), 19 * 60);
  });
});

const order = (overrides: Partial<ScheduledOrder> = {}): ScheduledOrder => ({
  orderId: 101,
  labOrderId: null,
  appointmentTime: new Date("2026-09-18T02:30:00Z"), // 08:00 IST
  orderType: "HOME_SAMPLE",
  orderStatus: "ORDER_SCHEDULED",
  patientName: "Varun Banaal",
  location: "Solan",
  address: "Solan 173212",
  ...overrides,
});

const TODAY = { heading: "Today's orders:", empty: "No orders on today's list." };
const TOMORROW = { heading: "Tomorrow's appointments:", empty: "No appointments on tomorrow's list yet.", withAddress: true };

describe("scheduleBlock", () => {
  // renderLabTemplate throws on an empty variable, so an empty day must still
  // produce a line — otherwise a quiet day breaks the whole message.
  it("never renders empty", () => {
    assert.equal(scheduleBlock([], 0, IST, TODAY), TODAY.empty);
    assert.equal(scheduleBlock([], 0, IST, TOMORROW), TOMORROW.empty);
  });

  it("leads with the order reference, then the patient", () => {
    const line = scheduleBlock([order()], 1, IST, TODAY).split("\n")[1];
    assert.equal(line, "• #101 · Varun Banaal · 8:00 am · Home");
  });

  // Their reference, not ours, whenever the lab has one: our internal id means
  // nothing on their side of the conversation.
  it("prefers the lab's own order reference when there is one", () => {
    const line = scheduleBlock([order({ labOrderId: "SVC-8891" })], 1, IST, TODAY).split("\n")[1];
    assert.match(line, /^• SVC-8891 · Varun Banaal/);
    assert.doesNotMatch(line, /#101/, "showing both ids reads as two different orders");
  });

  it("adds the address to tomorrow's list but not today's", () => {
    assert.match(scheduleBlock([order()], 1, IST, TOMORROW), /Solan 173212/);
    assert.doesNotMatch(scheduleBlock([order()], 1, IST, TODAY), /173212/);
  });

  it("says so when the name is missing, rather than leaving a gap", () => {
    const line = scheduleBlock([order({ patientName: null })], 1, IST, TODAY);
    assert.match(line, /#101 · Name not on file/);
    assert.doesNotMatch(line, /· ·/);
  });

  it("holds the line together when tomorrow has no address on file", () => {
    const line = scheduleBlock([order({ address: null })], 1, IST, TOMORROW).split("\n")[1];
    assert.equal(line, "• #101 · Varun Banaal · 8:00 am · Home");
  });

  it("reports the tail it could not list instead of dropping it", () => {
    assert.match(scheduleBlock([order(), order({ orderId: 102 })], 9, IST, TODAY), /…and 7 more/);
  });

  it("says nothing about a tail when the whole day fits", () => {
    assert.doesNotMatch(scheduleBlock([order()], 1, IST, TODAY), /more/);
  });

  it("puts the heading first, so the list is never a wall of bullets", () => {
    assert.equal(scheduleBlock([order()], 1, IST, TOMORROW).split("\n")[0], TOMORROW.heading);
  });
});

describe("dateLabel", () => {
  it("labels the calendar date it was handed, not an instant near it", () => {
    assert.match(dateLabel("2026-09-17", true), /Thu, 17 Sept 2026/);
    // en-GB drops the comma when the year is absent.
    assert.equal(dateLabel("2026-09-17", false), "Thu 17 Sept");
  });

  // The day key is resolved in the operating timezone before it arrives, so
  // re-projecting it here can only move it. An earlier version anchored the
  // string at UTC noon and rendered it in the lab's zone, which printed
  // "Fri 18 Sept" on a Thursday for anywhere past UTC+12.
  it("is a pure function of the date string, whatever the host timezone", () => {
    assert.equal(dateLabel("2026-01-01", true), "Thu, 1 Jan 2026");
    assert.equal(dateLabel("2026-12-31", true), "Thu, 31 Dec 2026");
  });
});

/**
 * The shipped body has to survive the contract it is saved under, or the first
 * person to open it in the template editor cannot save it back.
 */
describe("the default digest template", () => {
  it("passes its own save-time contract", () => {
    const result = validateNonApiTemplateBody(PROVIDER_DAILY_DIGEST_TEMPLATE, DEFAULT_PROVIDER_DAILY_DIGEST_BODY);
    // `result.ok` is the discriminant, so reading .error needs the narrow.
    assert.ok(result.ok, result.ok ? "" : result.error);
  });

  it("rejects order variables, which a digest can never fill", () => {
    const result = validateNonApiTemplateBody(
      PROVIDER_DAILY_DIGEST_TEMPLATE,
      "Today: {{today_total}}, tomorrow: {{tomorrow_total}}, order {{order_id}}",
    );
    assert.equal(result.ok, false);
  });

  it("renders with the variables the engine actually supplies", () => {
    const supplied = Object.fromEntries(DIGEST_VARIABLES.map((name) => [name, "x"]));
    assert.doesNotThrow(() => renderLabTemplate(DEFAULT_PROVIDER_DAILY_DIGEST_BODY, supplied));
  });
});
