/**
 * Acceptance tests for the SLA milestone breach engine.
 *
 * Driven entirely through `runSlaBreachTick()` against real rows — not the
 * UI, and not a hand-rolled imitation of the engine. Covers acceptance
 * criteria 1-6 and 8-10.
 *
 * Two labs are seeded on purpose: one NON_API and one **API**. The API lab is
 * the one that matters — it has no LabCommunicationWorkflow, so any part of
 * this feature that quietly depended on one would fail there and pass on the
 * other.
 *
 * Real operator state is left alone. Any rule or milestone config that would
 * cover the test labs is snapshotted and restored, the same discipline the
 * other provider-comms tests use for foreign wa_outbound rows.
 *
 * Run: npm run wa:test-sla-milestone
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

process.env.TASKOS_DATABASE_URL = process.env.TASKOS_DATABASE_URL || process.env.DATABASE_URL;

import { LabIntegrationType, PrismaClient, type SlaMilestone } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";
import { runSlaBreachTick } from "../src/lib/provider-comms/breach-engine";
import { SLA_MILESTONE_BREACH_TEMPLATE } from "../src/lib/non-api-labs/templates";

const prisma = new PrismaClient();

const NON_API_LAB = 999051;
const API_LAB = 999052;
const USER_ID = 999051;
const STORE_ID = 999051;
const NON_API_JID = "120363999000000051@g.us";
const API_JID = "120363999000000052@g.us";
const LABS = [NON_API_LAB, API_LAB];

/** One order per scenario, so scenarios never interfere with each other. */
const ORDERS = {
  nonApiBreach: 999051,   // criteria 1, 2 — detect, repeat, cap
  apiBreach: 999052,      // the API lab: same behaviour, no workflow
  completesBetween: 999053, // criterion 3
  completesJustBefore: 999054, // criterion 4
  cancelled: 999055,      // criterion 5
  rescheduled: 999056,    // criterion 6
  noStep: 999057,         // criterion 7 (lab with config but no breach step)
};
const ALL_ORDERS = Object.values(ORDERS);

let failures = 0;
let checks = 0;
function check(label: string, pass: boolean, detail = "") {
  checks += 1;
  if (!pass) failures += 1;
  console.log(`  ${pass ? "✔" : "✘"} ${label}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) {
  console.log(`\n\x1b[1m→ ${title}\x1b[0m`);
}

// ── fixture ───────────────────────────────────────────────────────────────
type RuleSnapshot = { id: string; isActive: boolean };
let pausedRules: RuleSnapshot[] = [];

async function pauseCoveringRules(): Promise<RuleSnapshot[]> {
  const rows = await prisma.providerCommunicationRule.findMany({
    where: { isActive: true },
    select: { id: true, isActive: true, allowedLabIds: true },
  });
  const covering = rows.filter((rule) => {
    const ids = Array.isArray(rule.allowedLabIds) ? (rule.allowedLabIds as number[]) : [];
    return ids.length === 0 || ids.some((id) => LABS.includes(id));
  });
  if (covering.length) {
    await prisma.providerCommunicationRule.updateMany({
      where: { id: { in: covering.map((r) => r.id) } }, data: { isActive: false },
    });
    console.log(`  (paused ${covering.length} real rule(s) covering the test labs)`);
  }
  return covering.map((r) => ({ id: r.id, isActive: r.isActive }));
}

/** Global milestone defaults are shared state: disable them for the run. */
let globalConfigSnapshot: Array<{ id: string; enabled: boolean }> = [];
async function disableGlobalConfigs() {
  const rows = await prisma.slaMilestoneConfig.findMany({ where: { labId: null }, select: { id: true, enabled: true } });
  globalConfigSnapshot = rows;
  await prisma.slaMilestoneConfig.updateMany({ where: { labId: null }, data: { enabled: false } });
}

async function seedSource() {
  await labstackWorkerQuery(`INSERT INTO public."User" (id, name, mobile, gender, city)
    VALUES (${USER_ID}, 'Milestone Test Patient', '+919999900051', 'FEMALE', 'Bengaluru') ON CONFLICT (id) DO NOTHING`);
  await labstackWorkerQuery(`INSERT INTO public."Store" (id, "storeName") VALUES (${STORE_ID}, 'Milestone Test Store') ON CONFLICT (id) DO NOTHING`);
  await labstackWorkerQuery(`INSERT INTO public."Lab" (id, "labName") VALUES
      (${NON_API_LAB}, 'Milestone NON_API Lab'), (${API_LAB}, 'Milestone API Lab') ON CONFLICT (id) DO NOTHING`);

  // Every order was created 4h ago and is still ORDER_SCHEDULED, so a
  // ORDER_CONFIRMED deadline of +60m is comfortably in the past.
  const rows: Array<[number, number, string]> = [
    [ORDERS.nonApiBreach, NON_API_LAB, "ORDER_SCHEDULED"],
    [ORDERS.apiBreach, API_LAB, "ORDER_SCHEDULED"],
    [ORDERS.completesBetween, NON_API_LAB, "ORDER_SCHEDULED"],
    [ORDERS.completesJustBefore, NON_API_LAB, "ORDER_SCHEDULED"],
    [ORDERS.cancelled, NON_API_LAB, "ORDER_SCHEDULED"],
    [ORDERS.rescheduled, NON_API_LAB, "ORDER_SCHEDULED"],
    [ORDERS.noStep, API_LAB, "ORDER_SCHEDULED"],
  ];
  for (const [orderId, labId, status] of rows) {
    await labstackWorkerQuery(`
      INSERT INTO public."Order" (
        id, "labOrderId", "userId", "storeId", "labId", "orderType", "orderStatus",
        "appointmentTime", "createdAt", "updatedAt", "statusUpdatedAt", "packageName", pincode, city
      ) VALUES (
        ${orderId}, 'MSTEST-${orderId}', ${USER_ID}, ${STORE_ID}, ${labId},
        'HOME_SAMPLE'::public."OrderType", '${status}'::public."OrderStatus",
        (now() AT TIME ZONE 'UTC') + interval '3 hours',
        (now() AT TIME ZONE 'UTC') - interval '4 hours',
        (now() AT TIME ZONE 'UTC') - interval '4 hours',
        (now() AT TIME ZONE 'UTC') - interval '4 hours',
        'Milestone Test Package', '560001', 'Bengaluru'
      ) ON CONFLICT (id) DO NOTHING`);
  }
}

async function cleanup() {
  const events = await prisma.slaBreachEvent.findMany({ where: { orderId: { in: ALL_ORDERS } }, select: { id: true } });
  const ids = events.map((e) => e.id);
  if (ids.length) {
    const sends = await prisma.slaBreachSend.findMany({ where: { breachEventId: { in: ids } }, select: { waOutboundId: true } });
    const outboundIds = sends.map((s) => s.waOutboundId).filter((v): v is string => !!v);
    await prisma.slaBreachSend.deleteMany({ where: { breachEventId: { in: ids } } });
    await prisma.slaBreachEvent.deleteMany({ where: { id: { in: ids } } });
    if (outboundIds.length) await prisma.waOutbound.deleteMany({ where: { id: { in: outboundIds } } });
  }
  await prisma.labCommunication.deleteMany({ where: { orderId: { in: ALL_ORDERS } } });
  await prisma.providerCommunicationRule.deleteMany({ where: { name: { startsWith: "TEST milestone " } } });
  await prisma.slaMilestoneConfig.deleteMany({ where: { labId: { in: LABS } } });
  await prisma.nonApiLabConfig.deleteMany({ where: { labId: { in: LABS } } });
  for (const jid of [NON_API_JID, API_JID]) {
    const group = await prisma.waGroup.findUnique({ where: { jid }, select: { id: true } });
    if (group) {
      await prisma.waOutbound.deleteMany({ where: { groupId: group.id } });
      await prisma.waGroup.delete({ where: { id: group.id } });
    }
  }
  await labstackWorkerQuery(`DELETE FROM public."Order" WHERE id IN (${ALL_ORDERS.join(",")})`);
  await labstackWorkerQuery(`DELETE FROM public."Lab" WHERE id IN (${LABS.join(",")})`);
  await labstackWorkerQuery(`DELETE FROM public."Store" WHERE id = ${STORE_ID}`);
  await labstackWorkerQuery(`DELETE FROM public."User" WHERE id = ${USER_ID}`);
}

async function setSettings(data: { slaBreachEnabled?: boolean; slaBreachDryRun?: boolean; perLabPerTickLimit?: number }) {
  await prisma.providerCommsSettings.upsert({ where: { id: "default" }, update: data, create: { id: "default", ...data } });
}

async function setOrderStatus(orderId: number, status: string) {
  await labstackWorkerQuery(
    `UPDATE public."Order" SET "orderStatus" = '${status}'::public."OrderStatus",
       "statusUpdatedAt" = (now() AT TIME ZONE 'UTC') WHERE id = ${orderId}`,
  );
}

async function eventFor(orderId: number, milestone: SlaMilestone = "ORDER_CONFIRMED") {
  return prisma.slaBreachEvent.findUnique({ where: { orderId_milestone: { orderId, milestone } } });
}

async function main() {
  console.log("\x1b[1m🧪  SLA milestone breach engine — acceptance tests\x1b[0m");
  console.log("    API and NON_API labs, fake transport, nothing leaves this machine\n");

  let settingsBefore: { slaBreachEnabled: boolean; slaBreachDryRun: boolean; perLabPerTickLimit: number } | null = null;

  try {
    await cleanup();
    pausedRules = await pauseCoveringRules();
    await disableGlobalConfigs();
    await seedSource();

    const existing = await prisma.providerCommsSettings.findUnique({ where: { id: "default" } });
    if (existing) settingsBefore = {
      slaBreachEnabled: existing.slaBreachEnabled,
      slaBreachDryRun: existing.slaBreachDryRun,
      perLabPerTickLimit: existing.perLabPerTickLimit,
    };

    // Fabricated jids that reach nobody; sendEnabled true so the queue path is exercised.
    for (const [jid, labId] of [[NON_API_JID, NON_API_LAB], [API_JID, API_LAB]] as const) {
      await prisma.waGroup.create({
        data: { jid, subject: "TEST — milestone breach (safe to delete)", role: "PROVIDER", labId, sendEnabled: true, active: true },
      });
    }
    await prisma.nonApiLabConfig.create({
      data: { labId: NON_API_LAB, labName: "Milestone NON_API Lab", integrationType: LabIntegrationType.NON_API, isActive: true, waGroupJid: NON_API_JID },
    });
    await prisma.nonApiLabConfig.create({
      // The lab that has no workflow, and therefore no acceptance signal
      // beyond the order's own status. Same breach behaviour is required.
      data: { labId: API_LAB, labName: "Milestone API Lab", integrationType: LabIntegrationType.API, isActive: true, waGroupJid: API_JID },
    });

    // ORDER_CONFIRMED at +60m from creation; orders were created 4h ago.
    for (const labId of LABS) {
      await prisma.slaMilestoneConfig.create({
        data: {
          labId, milestone: "ORDER_CONFIRMED", anchor: "ORDER_CREATED", offsetMinutes: 60,
          enabled: true, repeatIntervalMinutes: 30, maxAttempts: 2, ignoreQuietHours: true,
        },
      });
    }

    // A breach step for each lab except the `noStep` case — API_LAB gets one
    // scoped to itself, so ORDERS.noStep (also on API_LAB) is covered too.
    // Criterion 7 therefore needs its own lab-less arrangement; see below.
    await prisma.providerCommunicationRule.create({
      data: {
        name: "TEST milestone breach step", isActive: true,
        allowedLabIds: [NON_API_LAB, API_LAB], allowedOrderTypes: [],
        anchor: "ORDER", action: "SEND_REMINDER", offsetMinutes: 0, priority: 2,
        templateKey: SLA_MILESTONE_BREACH_TEMPLATE, recipient: "LAB", sendCondition: {},
        triggerKind: "SLA_BREACH", slaMilestone: "ORDER_CONFIRMED",
      },
    });

    await setSettings({ slaBreachEnabled: true, slaBreachDryRun: false, perLabPerTickLimit: 10 });

    // ── 1. Detection is idempotent ────────────────────────────────────
    section("1. One breach, one message, however many ticks run");
    const t1 = await runSlaBreachTick();
    const t2 = await runSlaBreachTick();
    const t3 = await runSlaBreachTick();

    const nonApiEvent = await eventFor(ORDERS.nonApiBreach);
    check("a breach event exists for the NON_API lab", !!nonApiEvent);
    check("exactly one attempt was sent", nonApiEvent?.attemptsSent === 1, `attemptsSent=${nonApiEvent?.attemptsSent}`);
    const sends = await prisma.slaBreachSend.count({ where: { breachEventId: nonApiEvent!.id } });
    check("exactly one send row", sends === 1, `${sends}`);
    check("repeat ticks added nothing", t2.detected === 0 && t3.detected === 0, `t2=${t2.detected} t3=${t3.detected}`);
    check("the deadline is recorded", !!nonApiEvent?.deadlineAt);

    // ── The API lab — the case that has no workflow ───────────────────
    section("2. The API lab behaves identically (no workflow exists for it)");
    const apiEvent = await eventFor(ORDERS.apiBreach);
    check("the API lab breached too", !!apiEvent, `attemptsSent=${apiEvent?.attemptsSent}`);
    const apiSend = await prisma.slaBreachSend.findFirst({ where: { breachEventId: apiEvent!.id } });
    check("addressed to the API lab's group", apiSend?.destination === API_JID, apiSend?.destination ?? "none");
    check("message names the milestone", !!apiSend?.renderedBody.includes("Order confirmed"));
    check("message states how overdue it is", /overdue/.test(apiSend?.renderedBody ?? ""));
    check("no workflow was required", (await prisma.labCommunicationWorkflow.count({ where: { orderId: ORDERS.apiBreach } })) === 0);
    const apiOutbound = apiSend?.waOutboundId
      ? await prisma.waOutbound.findUnique({ where: { id: apiSend.waOutboundId }, select: { groupId: true, targetJid: true } })
      : null;
    check("outbound carries groupId (arms the send guard)", !!apiOutbound?.groupId);

    console.log("\n  ── the lab receives ──");
    for (const line of (apiSend?.renderedBody ?? "").split("\n")) console.log(`  │ ${line}`);

    // ── 2. Repeat, then cap ───────────────────────────────────────────
    section("3. Repeats on schedule, then stops permanently at the cap");
    // maxAttempts is 2, so the next attempt is the last.
    await prisma.slaBreachEvent.update({ where: { id: nonApiEvent!.id }, data: { nextAttemptAt: new Date(Date.now() - 60_000) } });
    await runSlaBreachTick();
    const afterSecond = await eventFor(ORDERS.nonApiBreach);
    check("attempt 2 was sent", afterSecond?.attemptsSent === 2, `attemptsSent=${afterSecond?.attemptsSent}`);
    check("status is CAPPED", afterSecond?.status === "CAPPED", `status=${afterSecond?.status}`);
    check("nextAttemptAt is cleared", afterSecond?.nextAttemptAt === null);
    check("reason recorded", afterSecond?.resolutionReason === "MAX_ATTEMPTS", afterSecond?.resolutionReason ?? "");

    await runSlaBreachTick();
    const afterCap = await prisma.slaBreachSend.count({ where: { breachEventId: nonApiEvent!.id } });
    check("a further tick sends nothing more", afterCap === 2, `${afterCap} sends`);

    // ── 3. Completing between ticks resolves ──────────────────────────
    section("4. A lab that acts between ticks stops receiving messages");
    const betweenEvent = await eventFor(ORDERS.completesBetween);
    check("it had breached first", !!betweenEvent, `attemptsSent=${betweenEvent?.attemptsSent}`);
    await setOrderStatus(ORDERS.completesBetween, "PHLEBO_ASSIGNED");
    await runSlaBreachTick();
    const resolved = await eventFor(ORDERS.completesBetween);
    check("event resolved", resolved?.status === "RESOLVED", `status=${resolved?.status}`);
    check("reason is MILESTONE_COMPLETED", resolved?.resolutionReason === "MILESTONE_COMPLETED", resolved?.resolutionReason ?? "");
    const betweenSends = await prisma.slaBreachSend.count({ where: { breachEventId: betweenEvent!.id } });
    check("no further message went out", betweenSends === 1, `${betweenSends} sends`);

    // ── 4. The pre-send re-check ──────────────────────────────────────
    section("5. Acting in the seconds before a due attempt wins the race");
    const justBefore = await eventFor(ORDERS.completesJustBefore);
    const sendsBefore = await prisma.slaBreachSend.count({ where: { breachEventId: justBefore!.id } });
    // Make an attempt due, then complete the milestone — the same tick must
    // catch it at the pre-send re-check and send nothing.
    await prisma.slaBreachEvent.update({ where: { id: justBefore!.id }, data: { nextAttemptAt: new Date(Date.now() - 60_000) } });
    await setOrderStatus(ORDERS.completesJustBefore, "PHLEBO_ASSIGNED");
    await runSlaBreachTick();
    const sendsAfter = await prisma.slaBreachSend.count({ where: { breachEventId: justBefore!.id } });
    check("the due attempt was not sent", sendsAfter === sendsBefore, `${sendsBefore} → ${sendsAfter}`);
    const raced = await eventFor(ORDERS.completesJustBefore);
    check("it resolved instead", raced?.status === "RESOLVED", `status=${raced?.status}`);

    // ── 5. Cancelled order ────────────────────────────────────────────
    section("6. Cancelling the order stops everything");
    const cancelledEvent = await eventFor(ORDERS.cancelled);
    check("it had breached first", !!cancelledEvent);
    const cancelSendsBefore = await prisma.slaBreachSend.count({ where: { breachEventId: cancelledEvent!.id } });
    await setOrderStatus(ORDERS.cancelled, "CANCELED");
    await runSlaBreachTick();
    const cancelled = await eventFor(ORDERS.cancelled);
    check("event cancelled", cancelled?.status === "CANCELLED", `status=${cancelled?.status}`);
    check("reason is ORDER_CANCELLED", cancelled?.resolutionReason === "ORDER_CANCELLED", cancelled?.resolutionReason ?? "");
    const cancelSendsAfter = await prisma.slaBreachSend.count({ where: { breachEventId: cancelledEvent!.id } });
    check("nothing further was sent", cancelSendsAfter === cancelSendsBefore, `${cancelSendsBefore} → ${cancelSendsAfter}`);

    // ── 6. Rescheduling an appointment-anchored breach ────────────────
    section("7. Moving the appointment later cancels an appointment-anchored breach");
    // Switch this lab's milestone to an appointment anchor that is already past.
    await prisma.slaMilestoneConfig.updateMany({
      where: { labId: NON_API_LAB, milestone: "ORDER_CONFIRMED" },
      data: { anchor: "APPOINTMENT_TIME", offsetMinutes: -240 },
    });
    await labstackWorkerQuery(
      `UPDATE public."Order" SET "appointmentTime" = (now() AT TIME ZONE 'UTC') + interval '30 minutes' WHERE id = ${ORDERS.rescheduled}`,
    );
    await prisma.slaBreachEvent.deleteMany({ where: { orderId: ORDERS.rescheduled } });
    await runSlaBreachTick();
    const reschedEvent = await eventFor(ORDERS.rescheduled);
    check("breached on the appointment clock", !!reschedEvent, `deadline=${reschedEvent?.deadlineAt?.toISOString()}`);

    // Push the appointment far enough out that the recomputed deadline is ahead of now.
    await labstackWorkerQuery(
      `UPDATE public."Order" SET "appointmentTime" = (now() AT TIME ZONE 'UTC') + interval '12 hours' WHERE id = ${ORDERS.rescheduled}`,
    );
    await runSlaBreachTick();
    const afterReschedule = await eventFor(ORDERS.rescheduled);
    check("the breach was cancelled", afterReschedule?.status === "CANCELLED", `status=${afterReschedule?.status}`);
    check("reason is RESCHEDULED", afterReschedule?.resolutionReason === "RESCHEDULED", afterReschedule?.resolutionReason ?? "");
    await prisma.slaMilestoneConfig.updateMany({
      where: { labId: NON_API_LAB, milestone: "ORDER_CONFIRMED" },
      data: { anchor: "ORDER_CREATED", offsetMinutes: 60 },
    });

    // ── 7. A lab with config but no breach step ───────────────────────
    section("8. Enabled config without a breach step never sends");
    await prisma.providerCommunicationRule.updateMany({
      where: { name: "TEST milestone breach step" }, data: { allowedLabIds: [NON_API_LAB] },
    });
    await prisma.slaBreachEvent.deleteMany({ where: { orderId: ORDERS.noStep } });
    await runSlaBreachTick();
    const noStepEvent = await eventFor(ORDERS.noStep);
    check("no breach event was created for it", noStepEvent === null);
    await prisma.providerCommunicationRule.updateMany({
      where: { name: "TEST milestone breach step" }, data: { allowedLabIds: [NON_API_LAB, API_LAB] },
    });

    // ── 8. Dry run ────────────────────────────────────────────────────
    section("9. Dry run records and advances, but enqueues nothing");
    await setSettings({ slaBreachDryRun: true });
    await prisma.slaBreachEvent.deleteMany({ where: { orderId: ORDERS.noStep } });
    const outboundBefore = await prisma.waOutbound.count();
    await runSlaBreachTick();
    const dryEvent = await eventFor(ORDERS.noStep);
    const outboundAfter = await prisma.waOutbound.count();
    check("the attempt was recorded", dryEvent?.attemptsSent === 1, `attemptsSent=${dryEvent?.attemptsSent}`);
    const drySend = await prisma.slaBreachSend.findFirst({ where: { breachEventId: dryEvent!.id } });
    check("flagged as a dry run", drySend?.dryRun === true);
    check("the rendered body was captured", (drySend?.renderedBody?.length ?? 0) > 20);
    check("no outbound row was queued", outboundAfter === outboundBefore, `${outboundBefore} → ${outboundAfter}`);
    check("no waOutboundId on the send", drySend?.waOutboundId === null);
    check("attempt state still advanced", dryEvent?.nextAttemptAt !== null);
    await setSettings({ slaBreachDryRun: false });

    // ── 9. Kill switch ────────────────────────────────────────────────
    section("10. The kill switch stops breach sends only");
    await setSettings({ slaBreachEnabled: false });
    await prisma.slaBreachEvent.deleteMany({ where: { orderId: ORDERS.apiBreach } });
    const killed = await runSlaBreachTick();
    check("the tick does nothing at all", killed.detected === 0 && killed.sent === 0, JSON.stringify(killed));
    check("no event was created", (await eventFor(ORDERS.apiBreach)) === null);
    await setSettings({ slaBreachEnabled: true });

    // ── 10. Restart safety ────────────────────────────────────────────
    section("11. A restart mid-cycle loses nothing and duplicates nothing");
    // All scheduling state is in the row, so "restart" is simply calling the
    // tick again against the same rows — there is nothing in memory to lose.
    await prisma.slaBreachEvent.deleteMany({ where: { orderId: ORDERS.apiBreach } });
    await runSlaBreachTick();
    const beforeRestart = await eventFor(ORDERS.apiBreach);
    const sendsBeforeRestart = await prisma.slaBreachSend.count({ where: { breachEventId: beforeRestart!.id } });
    // Simulate the crash window: the send row exists but the tick never
    // finished. Re-running must not produce a second message for the attempt.
    await runSlaBreachTick();
    await runSlaBreachTick();
    const sendsAfterRestart = await prisma.slaBreachSend.count({ where: { breachEventId: beforeRestart!.id } });
    check("no duplicate sends across repeated ticks", sendsAfterRestart === sendsBeforeRestart, `${sendsBeforeRestart} → ${sendsAfterRestart}`);
    check("the pending attempt is still scheduled", (await eventFor(ORDERS.apiBreach))?.nextAttemptAt !== null);

    console.log(
      failures === 0
        ? `\n\x1b[32m\x1b[1m✅  ${checks} checks passed.\x1b[0m`
        : `\n\x1b[31m\x1b[1m❌  ${failures} of ${checks} checks failed.\x1b[0m`,
    );
  } finally {
    console.log("\n→ Cleaning up");
    if (settingsBefore) await prisma.providerCommsSettings.update({ where: { id: "default" }, data: settingsBefore });
    for (const snapshot of globalConfigSnapshot) {
      await prisma.slaMilestoneConfig.update({ where: { id: snapshot.id }, data: { enabled: snapshot.enabled } });
    }
    for (const rule of pausedRules) {
      await prisma.providerCommunicationRule.update({ where: { id: rule.id }, data: { isActive: rule.isActive } });
    }
    await cleanup();
    console.log("  ✔ Fixtures removed, real rules and settings restored");
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
