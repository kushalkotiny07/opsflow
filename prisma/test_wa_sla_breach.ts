/**
 * End-to-end test: does a breached provider SLA actually message the lab's
 * WhatsApp GROUP?
 *
 * Covers the whole chain with one throwaway lab, and tears it all down again:
 *
 *   source Order (past-due)                    ← seeded into the dummy LabStack
 *     → startNonApiLabWorkflow()               ← real workflow code
 *       → ladder rungs scheduled on the SLA clocks
 *         → processDueNonApiLabScheduledActions()   ← real tick
 *           → lab_communications + wa_outbound      ← addressed to the GROUP
 *             → drainOutbound() from the real gateway module, with a FAKE
 *               transport, so no message leaves the machine
 *               → wa_outbound SENT + lab_communications SENT
 *
 * The transport is the only fake in the path. Everything else is the code
 * that runs in production, which is the point: a hand-rolled imitation of the
 * drain would pass while the real one refused to send.
 *
 * Two properties are asserted rather than eyeballed:
 *   1. the target is the group jid — NOT `<digits>@s.whatsapp.net`. The old
 *      addressing code would have silently turned the group id into a DM.
 *   2. the outbound row carries groupId, which is what arms the gateway's
 *      per-group sendEnabled guard.
 *
 * There is no manager on this config: escalations fall back to the lab group,
 * which is the shape we actually run with.
 *
 * Everything it creates is prefixed/ided in the 99900x range and deleted in a
 * finally block — including on failure. Run it against a dev database.
 *
 * Run: npm run wa:test-sla
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { LabIntegrationType, PrismaClient } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";
import { startNonApiLabWorkflow } from "../src/lib/non-api-labs/workflow";
import { processDueNonApiLabScheduledActions } from "../src/lib/non-api-labs/scheduler";
import type { RawOrder } from "../src/lib/engine/labstack";

const prisma = new PrismaClient();

// Fixture ids, all far outside the seeded sheet's ranges.
const LAB_ID = 999001;
const ORDER_ID = 999001;
const USER_ID = 999001;
const STORE_ID = 999001;
const GROUP_JID = "120363999000000001@g.us";

/** Minutes of SLA, deliberately tiny so the ladder is due immediately. */
const SLA = { confirmation: 1, reminder: 2, escalation: 3 };

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? "✔" : "✘"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Raw SQL against the dummy source DB; it is a stand-in we own, so writes are fine. */
async function sourceExec(statement: string): Promise<void> {
  await labstackWorkerQuery(statement);
}

async function seedSource(): Promise<void> {
  // Past-due on purpose: created 6 hours ago, appointment 2 hours out. Every
  // order-clock rung (confirm → remind → escalate) is therefore already due,
  // which is exactly the breach state under test.
  await sourceExec(`
    INSERT INTO public."User" (id, name, mobile, gender, city)
    VALUES (${USER_ID}, 'SLA Breach Test Patient', '+919999900001', 'FEMALE', 'Bengaluru')
    ON CONFLICT (id) DO NOTHING`);
  await sourceExec(`
    INSERT INTO public."Store" (id, "storeName") VALUES (${STORE_ID}, 'WA Automation Test Store')
    ON CONFLICT (id) DO NOTHING`);
  await sourceExec(`
    INSERT INTO public."Lab" (id, "labName") VALUES (${LAB_ID}, 'WA Automation Test Lab')
    ON CONFLICT (id) DO NOTHING`);
  await sourceExec(`
    INSERT INTO public."Order" (
      id, "labOrderId", "userId", "storeId", "labId", "orderType", "orderStatus",
      "appointmentTime", "createdAt", "updatedAt", "statusUpdatedAt", "packageName", pincode, city
    ) VALUES (
      ${ORDER_ID}, 'WATEST-${ORDER_ID}', ${USER_ID}, ${STORE_ID}, ${LAB_ID},
      'HOME_SAMPLE'::public."OrderType", 'ORDER_SCHEDULED'::public."OrderStatus",
      (now() AT TIME ZONE 'UTC') + interval '2 hours',
      (now() AT TIME ZONE 'UTC') - interval '6 hours',
      (now() AT TIME ZONE 'UTC') - interval '6 hours',
      (now() AT TIME ZONE 'UTC') - interval '6 hours',
      'WA Automation Test Package', '560001', 'Bengaluru'
    ) ON CONFLICT (id) DO NOTHING`);
}

async function cleanupSource(): Promise<void> {
  await sourceExec(`DELETE FROM public."Order" WHERE id = ${ORDER_ID}`);
  await sourceExec(`DELETE FROM public."Lab" WHERE id = ${LAB_ID}`);
  await sourceExec(`DELETE FROM public."Store" WHERE id = ${STORE_ID}`);
  await sourceExec(`DELETE FROM public."User" WHERE id = ${USER_ID}`);
}

async function cleanupTaskos(): Promise<void> {
  const workflow = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: ORDER_ID }, select: { id: true } });
  if (workflow) {
    const comms = await prisma.labCommunication.findMany({ where: { workflowId: workflow.id }, select: { waOutboundId: true } });
    const outboundIds = comms.map((c) => c.waOutboundId).filter((id): id is string => !!id);
    await prisma.labCommunicationOrderEvent.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labCommunicationAuditLog.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labProviderActionToken.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labCommunicationEscalation.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labScheduledAction.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labCommunication.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labCommunicationWorkflow.delete({ where: { id: workflow.id } });
    if (outboundIds.length) await prisma.waOutbound.deleteMany({ where: { id: { in: outboundIds } } });
  }
  await prisma.slaMilestoneConfig.deleteMany({ where: { labId: LAB_ID } });
  await prisma.nonApiLabConfig.deleteMany({ where: { labId: LAB_ID } });
  const group = await prisma.waGroup.findUnique({ where: { jid: GROUP_JID }, select: { id: true } });
  if (group) {
    await prisma.waOutbound.deleteMany({ where: { groupId: group.id } });
    await prisma.waGroup.delete({ where: { id: group.id } });
  }
}

/**
 * Keep the milestone breach engine out of this test's way.
 *
 * `notifyProviderOfBreach` now stands down for any lab covered by an enabled
 * SlaMilestoneConfig — the milestone engine owns that lab's breaches, and two
 * systems messaging one provider about one order is the failure mode the
 * guard exists to prevent. A globally enabled milestone therefore makes this
 * path return "superseded" for every lab, including this fixture's.
 *
 * Rather than disable the global rows (shared state a real operator may have
 * configured), this writes a lab-scoped override with `enabled: false` for
 * every milestone: a lab row overrides the global wholesale, so these labs
 * are genuinely not covered by the milestone engine, and nothing outside the
 * fixture is touched. Cleaned up with the rest of the lab's rows.
 */
async function isolateFromMilestoneEngine(labIds: number[]): Promise<void> {
  const milestones = ["ORDER_CONFIRMED", "PHLEBO_ASSIGNED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "REPORT_UPLOADED"] as const;
  for (const labId of labIds) {
    for (const milestone of milestones) {
      const existing = await prisma.slaMilestoneConfig.findFirst({ where: { labId, milestone }, select: { id: true } });
      if (existing) continue;
      await prisma.slaMilestoneConfig.create({
        data: { labId, milestone, anchor: "ORDER_CREATED", offsetMinutes: 60, enabled: false },
      });
    }
  }
}

async function main() {
  console.log("🧪  WhatsApp SLA-breach automation test\n");

  try {
    // ── 1. Fixture ────────────────────────────────────────────────────────
    console.log("→ Seeding a past-due order and a group-addressed lab config");
    await cleanupTaskos();
    await cleanupSource();
    await seedSource();
    await isolateFromMilestoneEngine([LAB_ID]);

    // sendEnabled TRUE only because this is a fabricated jid that reaches
    // nobody. Real groups start disabled (see lib/non-api-labs/target.ts).
    const group = await prisma.waGroup.create({
      data: {
        jid: GROUP_JID,
        subject: "TEST — WA automation (safe to delete)",
        role: "PROVIDER",
        labId: LAB_ID,
        sendEnabled: true,
        active: true,
      },
    });

    await prisma.nonApiLabConfig.create({
      data: {
        labId: LAB_ID,
        labName: "WA Automation Test Lab",
        integrationType: LabIntegrationType.NON_API,
        isActive: true,
        waGroupJid: GROUP_JID,
        whatsappNumber: null,   // group-only, to prove the group path is used
        managerName: null,      // no manager: escalation falls back to the group
        managerWhatsapp: null,
        confirmationSlaMinutes: SLA.confirmation,
        reminderSlaMinutes: SLA.reminder,
        escalationSlaMinutes: SLA.escalation,
        quietWindowMinutes: 0,  // otherwise the second rung is held back
        appointmentRemindersEnabled: true,
      },
    });

    // ── 2. Workflow start (real code) ─────────────────────────────────────
    const [order] = await labstackWorkerQuery<RawOrder>(`
      SELECT o.id, o."orderType", o."orderStatus", o."appointmentTime", o."storeId", o."labId",
             o."userId", o."createdAt", o."updatedAt", o."statusUpdatedAt",
             COALESCE(o."internalNotes", '') AS "internalNotes", COALESCE(o.notes, '') AS notes,
             COALESCE(o."phleboName", '') AS "phleboName", COALESCE(o."phleboNumber", '') AS "phleboNumber",
             u.name AS "patientName", l."labName" AS "labName", s."storeName" AS "storeName",
             to_jsonb(o.*) AS metadata
        FROM public."Order" o
        JOIN public."User" u ON u.id = o."userId"
        LEFT JOIN public."Lab" l ON l.id = o."labId"
        LEFT JOIN public."Store" s ON s.id = o."storeId"
       WHERE o.id = ${ORDER_ID}`);
    check("test order readable from the source", !!order, order ? `#${order.id}` : "missing");
    if (!order) throw new Error("fixture order not found");

    const started = await startNonApiLabWorkflow(order);
    check("workflow started for a group-only config", started === "started", `result=${started}`);

    const initial = await prisma.labCommunication.findFirst({
      where: { workflow: { orderId: ORDER_ID }, type: "INITIAL_NOTIFICATION" },
      include: { workflow: { select: { id: true, status: true } } },
    });
    check("initial notification created", !!initial, initial?.recipient ?? "");
    check(
      "addressed to the GROUP, not a DM",
      initial?.recipient === GROUP_JID,
      `recipient=${initial?.recipient}`,
    );

    const initialOutbound = initial?.waOutboundId
      ? await prisma.waOutbound.findUnique({ where: { id: initial.waOutboundId } })
      : null;
    check("outbound targets the group jid", initialOutbound?.targetJid === GROUP_JID, `targetJid=${initialOutbound?.targetJid}`);
    check("outbound carries groupId (arms the send guard)", initialOutbound?.groupId === group.id);

    // ── 3. The breach ─────────────────────────────────────────────────────
    // The ladder is built from the moment the workflow STARTS, not from the
    // order's age (workflow.ts passes `createdAt: now` to buildLadder), so a
    // past-due order alone leaves every rung in the future. Backdating the
    // rungs and the workflow's own deadlines is how we say "an hour passed
    // and the lab never confirmed" without sleeping through it.
    const ELAPSED_MINUTES = 120;
    const backdate = (d: Date) => new Date(d.getTime() - ELAPSED_MINUTES * 60_000);
    const workflowRow = await prisma.labCommunicationWorkflow.findUniqueOrThrow({ where: { orderId: ORDER_ID } });
    await prisma.labCommunicationWorkflow.update({
      where: { id: workflowRow.id },
      data: {
        createdAt: backdate(workflowRow.createdAt),
        confirmationDeadline: backdate(workflowRow.confirmationDeadline),
        reminderDeadline: backdate(workflowRow.reminderDeadline),
        escalationDeadline: backdate(workflowRow.escalationDeadline),
      },
    });
    for (const rung of await prisma.labScheduledAction.findMany({ where: { workflowId: workflowRow.id }, select: { id: true, runAt: true } })) {
      await prisma.labScheduledAction.update({ where: { id: rung.id }, data: { runAt: backdate(rung.runAt) } });
    }

    const pending = await prisma.labScheduledAction.findMany({
      where: { workflow: { orderId: ORDER_ID } },
      select: { type: true, runAt: true, status: true },
      orderBy: { runAt: "asc" },
    });
    const dueNow = pending.filter((a) => a.runAt <= new Date());
    console.log(`\n→ Ladder: ${pending.length} rung(s) scheduled, ${dueNow.length} already due (SLA breached)`);
    check("at least one rung is past its SLA deadline", dueNow.length > 0);

    const stats = await processDueNonApiLabScheduledActions();
    console.log(`  tick: sent=${stats.processed} suppressed=${stats.suppressed} deferred=${stats.deferred} failed=${stats.failed}`);
    check("tick queued at least one breach message", stats.processed > 0);

    const breachComms = await prisma.labCommunication.findMany({
      where: { workflow: { orderId: ORDER_ID }, type: { in: ["REMINDER", "ESCALATION"] } },
      orderBy: { createdAt: "asc" },
    });
    check("breach message(s) recorded", breachComms.length > 0, `${breachComms.length} message(s)`);
    check(
      "every breach message went to the group",
      breachComms.length > 0 && breachComms.every((c) => c.recipient === GROUP_JID),
      breachComms.map((c) => `${c.type}→${c.recipient}`).join(", "),
    );

    // ── 4. Drain through the REAL gateway module, fake transport ──────────
    console.log("\n→ Draining the outbound queue with the real gateway drain (fake transport)");
    process.env.TASKOS_DATABASE_URL = process.env.DATABASE_URL;
    const { drainOutbound } = await import("../whatsapp-bot/lib/controltower.mjs");

    // The real drain takes the whole queue, and this environment has other
    // labs' messages waiting in it. Snapshot those so they can be put back
    // exactly as they were — the test must not quietly "send" the rest of the
    // fixture's backlog just to exercise itself.
    const foreignQueued = await prisma.waOutbound.findMany({
      where: { status: "QUEUED", NOT: { targetJid: GROUP_JID } },
      select: { id: true },
    });
    const foreignIds = foreignQueued.map((r) => r.id);

    const transmitted: Array<{ jid: string; text: string }> = [];
    const result = await drainOutbound(
      async (jid: string, text: string) => {
        transmitted.push({ jid, text });
        return `FAKE_WA_ID_${transmitted.length}`;
      },
      { limit: Math.max(20, foreignIds.length + 10) },
    );
    console.log(`  gateway drained ${result.drained}, sent ${result.sent}`);

    const toGroup = transmitted.filter((m) => m.jid === GROUP_JID);
    check("gateway transmitted to the group jid", toGroup.length > 0, `${toGroup.length} message(s)`);
    // Scoped to this test's own messages: other labs in the fixture are
    // deliberately configured with numbers, so DM jids in the queue are
    // correct for them and prove nothing either way here.
    const testOutbound = await prisma.waOutbound.findMany({
      where: { targetJid: GROUP_JID },
      select: { targetJid: true, groupId: true, status: true },
    });
    check(
      "none of this lab's messages used a DM jid",
      testOutbound.every((o) => !o.targetJid.endsWith("@s.whatsapp.net")),
      testOutbound.map((o) => o.targetJid).join(", ") || "none",
    );

    const finalComms = await prisma.labCommunication.findMany({
      where: { workflow: { orderId: ORDER_ID } },
      select: { type: true, status: true, sentAt: true },
      orderBy: { createdAt: "asc" },
    });
    check(
      "communications marked SENT after the drain",
      finalComms.some((c) => c.status === "SENT"),
      finalComms.map((c) => `${c.type}=${c.status}`).join(", "),
    );

    if (toGroup[0]) {
      console.log("\n  ── message as the provider group would receive it ──");
      console.log(
        toGroup[0].text.split("\n").map((l) => `  │ ${l}`).join("\n").slice(0, 900),
      );
    }

    // ── 5. The guard still bites ──────────────────────────────────────────
    console.log("\n→ Re-checking the safety guard with sending disabled");
    await prisma.waGroup.update({ where: { id: group.id }, data: { sendEnabled: false } });
    const blocked = await prisma.waOutbound.create({
      data: { targetJid: GROUP_JID, text: "guard probe — must not be transmitted", groupId: group.id },
    });
    const before = transmitted.length;
    await drainOutbound(async (jid: string, text: string) => {
      transmitted.push({ jid, text });
      return "FAKE_SHOULD_NOT_HAPPEN";
    }, { limit: 20 });
    const probe = await prisma.waOutbound.findUnique({ where: { id: blocked.id } });
    check("send-disabled group is refused, not transmitted", transmitted.length === before && probe?.status === "FAILED", `status=${probe?.status} error=${probe?.error ?? ""}`);

    if (foreignIds.length) {
      await prisma.waOutbound.updateMany({
        where: { id: { in: foreignIds } },
        data: { status: "QUEUED", sentWaMsgId: null, sentAt: null, error: null },
      });
      await prisma.labCommunication.updateMany({
        where: { waOutboundId: { in: foreignIds } },
        data: { status: "QUEUED", sentAt: null },
      });
      console.log(`  ↩ restored ${foreignIds.length} unrelated queued message(s) the drain had picked up`);
    }
  } finally {
    console.log("\n→ Removing the test data");
    await cleanupTaskos();
    await cleanupSource();
    const leftoverConfig = await prisma.nonApiLabConfig.count({ where: { labId: LAB_ID } });
    const leftoverGroup = await prisma.waGroup.count({ where: { jid: GROUP_JID } });
    const leftoverOrder = await labstackWorkerQuery<{ n: bigint }>(`SELECT count(*) AS n FROM public."Order" WHERE id = ${ORDER_ID}`);
    check("test data removed", leftoverConfig === 0 && leftoverGroup === 0 && Number(leftoverOrder[0].n) === 0);
  }

  console.log(failures === 0 ? "\n✅  All checks passed." : `\n❌  ${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("\n💥 ", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
