/**
 * End-to-end test: does an SLA breach message the lab — including an API lab?
 *
 * Provider communication used to do nothing at all for API labs. The
 * confirmation ladder is gated on integrationType, and nothing else messaged a
 * provider, so an API lab's config was inert. Breach alerts are the trigger
 * both integration types share, so the interesting case is the one this test
 * leads with: an **API** lab.
 *
 *   source Order  +  taskos Task with a deadline in the past
 *     → resolveLabIdsForOrders()        ← real source lookup (tasks have no labId)
 *       → notifyProviderOfBreach()      ← real notifier
 *         → lab_communications (SLA_BREACH, workflowId NULL) + wa_outbound
 *           → drainOutbound() from the real gateway module, FAKE transport
 *             → SENT, and nothing left the machine
 *
 * What is asserted beyond "a message appeared":
 *   1. The API lab is messaged. This is the whole point of the change.
 *   2. It is addressed to the GROUP jid, and the outbound row carries groupId —
 *      the flag that arms the gateway's per-group sendEnabled guard.
 *   3. workflowId is NULL and orderId/labId are set. An API lab has no
 *      confirmation workflow, so a breach row that needed one could not exist.
 *   4. No confirmation workflow is created for the API lab. "Common to both
 *      lab types" must not mean an API lab starts getting asked to accept
 *      orders it already received over the API.
 *   5. The per-order cap holds: a second and third breached task on one order
 *      yield one more message, then none.
 *   6. A lab with slaBreachAlertsEnabled = false is left alone.
 *
 * Everything is created in the 99901x id range and deleted in a finally
 * block, including on failure. Run it against a dev database.
 *
 * Run: npm run wa:test-breach
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// The gateway reads its own env var for the taskos connection.
process.env.TASKOS_DATABASE_URL = process.env.TASKOS_DATABASE_URL || process.env.DATABASE_URL;

import { LabIntegrationType, PrismaClient, TaskPriority, TaskStatus } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";
import { notifyProviderOfBreach } from "../src/lib/provider-comms/sla-breach";
import { resolveLabIdsForOrders } from "../src/lib/provider-comms/order-lab";
import { startNonApiLabWorkflow } from "../src/lib/non-api-labs/workflow";
import type { RawOrder } from "../src/lib/engine/labstack";

const prisma = new PrismaClient();

// Two labs: the API lab is the subject, the muted lab proves the off switch.
const API_LAB_ID = 999011;
const MUTED_LAB_ID = 999012;
const API_ORDER_ID = 999011;
const MUTED_ORDER_ID = 999012;
const USER_ID = 999011;
const STORE_ID = 999011;
const API_GROUP_JID = "120363999000000011@g.us";
const MUTED_GROUP_JID = "120363999000000012@g.us";
const RULE_ID = "test_provider_breach_rule";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? "✔" : "✘"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function sourceExec(statement: string): Promise<void> {
  await labstackWorkerQuery(statement);
}

async function seedSource(): Promise<void> {
  await sourceExec(`
    INSERT INTO public."User" (id, name, mobile, gender, city)
    VALUES (${USER_ID}, 'Provider Breach Test Patient', '+919999900011', 'MALE', 'Bengaluru')
    ON CONFLICT (id) DO NOTHING`);
  await sourceExec(`
    INSERT INTO public."Store" (id, "storeName") VALUES (${STORE_ID}, 'Breach Test Store')
    ON CONFLICT (id) DO NOTHING`);
  await sourceExec(`
    INSERT INTO public."Lab" (id, "labName") VALUES
      (${API_LAB_ID}, 'Breach Test API Lab'), (${MUTED_LAB_ID}, 'Breach Test Muted Lab')
    ON CONFLICT (id) DO NOTHING`);
  for (const [orderId, labId] of [[API_ORDER_ID, API_LAB_ID], [MUTED_ORDER_ID, MUTED_LAB_ID]] as const) {
    await sourceExec(`
      INSERT INTO public."Order" (
        id, "labOrderId", "userId", "storeId", "labId", "orderType", "orderStatus",
        "appointmentTime", "createdAt", "updatedAt", "statusUpdatedAt", "packageName", pincode, city
      ) VALUES (
        ${orderId}, 'BREACHTEST-${orderId}', ${USER_ID}, ${STORE_ID}, ${labId},
        'HOME_SAMPLE'::public."OrderType", 'ORDER_SCHEDULED'::public."OrderStatus",
        (now() AT TIME ZONE 'UTC') + interval '2 hours',
        (now() AT TIME ZONE 'UTC') - interval '6 hours',
        (now() AT TIME ZONE 'UTC') - interval '6 hours',
        (now() AT TIME ZONE 'UTC') - interval '6 hours',
        'Breach Test Package', '560001', 'Bengaluru'
      ) ON CONFLICT (id) DO NOTHING`);
  }
}

async function cleanupSource(): Promise<void> {
  await sourceExec(`DELETE FROM public."Order" WHERE id IN (${API_ORDER_ID}, ${MUTED_ORDER_ID})`);
  await sourceExec(`DELETE FROM public."Lab" WHERE id IN (${API_LAB_ID}, ${MUTED_LAB_ID})`);
  await sourceExec(`DELETE FROM public."Store" WHERE id = ${STORE_ID}`);
  await sourceExec(`DELETE FROM public."User" WHERE id = ${USER_ID}`);
}

async function cleanupTaskos(): Promise<void> {
  const labIds = [API_LAB_ID, MUTED_LAB_ID];
  const orderIds = [API_ORDER_ID, MUTED_ORDER_ID];

  const comms = await prisma.labCommunication.findMany({
    where: { OR: [{ labId: { in: labIds } }, { orderId: { in: orderIds } }] },
    select: { id: true, waOutboundId: true },
  });
  await prisma.labCommunication.deleteMany({ where: { id: { in: comms.map((c) => c.id) } } });
  const outboundIds = comms.map((c) => c.waOutboundId).filter((id): id is string => !!id);
  if (outboundIds.length) await prisma.waOutbound.deleteMany({ where: { id: { in: outboundIds } } });

  // Any confirmation workflow that should not exist, so a failure does not
  // leave a half-state that makes the next run pass for the wrong reason.
  for (const orderId of orderIds) {
    const workflow = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId }, select: { id: true } });
    if (!workflow) continue;
    const wid = workflow.id;
    await prisma.labCommunicationOrderEvent.deleteMany({ where: { workflowId: wid } });
    await prisma.labCommunicationAuditLog.deleteMany({ where: { workflowId: wid } });
    await prisma.labProviderActionToken.deleteMany({ where: { workflowId: wid } });
    await prisma.labCommunicationEscalation.deleteMany({ where: { workflowId: wid } });
    await prisma.labScheduledAction.deleteMany({ where: { workflowId: wid } });
    await prisma.labCommunication.deleteMany({ where: { workflowId: wid } });
    await prisma.labCommunicationWorkflow.delete({ where: { id: wid } });
  }

  await prisma.slaBreachLog.deleteMany({ where: { entityId: { in: orderIds } } });
  await prisma.taskHistory.deleteMany({ where: { task: { taskRuleId: RULE_ID } } });
  await prisma.task.deleteMany({ where: { taskRuleId: RULE_ID } });
  await prisma.slaMilestoneConfig.deleteMany({ where: { labId: { in: labIds } } });
  await prisma.nonApiLabConfig.deleteMany({ where: { labId: { in: labIds } } });

  for (const jid of [API_GROUP_JID, MUTED_GROUP_JID]) {
    const group = await prisma.waGroup.findUnique({ where: { jid }, select: { id: true } });
    if (group) {
      await prisma.waOutbound.deleteMany({ where: { groupId: group.id } });
      await prisma.waGroup.delete({ where: { id: group.id } });
    }
  }
  await prisma.taskRule.deleteMany({ where: { id: RULE_ID } });
}

/** A task that blew its deadline `minutesAgo` minutes ago. */
async function makeBreachedTask(orderId: number, title: string, minutesAgo: number) {
  const deadline = new Date(Date.now() - minutesAgo * 60_000);
  return prisma.task.create({
    data: {
      taskRuleId: RULE_ID,
      title,
      entityType: "ORDER",
      entityId: orderId,
      storeId: STORE_ID,
      orderType: "HOME_SAMPLE",
      priority: TaskPriority.HIGH,
      status: TaskStatus.ASSIGNED,
      slaDeadline: deadline,
      appointmentTime: new Date(Date.now() + 2 * 60 * 60_000),
      metadata: {
        orderId,
        labName: "Breach Test API Lab",
        patientName: "Provider Breach Test Patient",
        storeName: "Breach Test Store",
        appointmentTime: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      },
    },
  });
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
  console.log("🧪  Provider SLA-breach alerts — API and NON_API labs\n");

  try {
    console.log("→ Seeding two labs (one API, one muted) and a past-due order each");
    await cleanupTaskos();
    await cleanupSource();
    await seedSource();
    await isolateFromMilestoneEngine([API_LAB_ID, MUTED_LAB_ID]);

    // Task.taskRuleId is a foreign key, so a rule has to exist. It borrows the
    // environment's existing data source and task type rather than inventing
    // its own: both are themselves foreign keys, and a synthetic DataSource
    // would show up in the Data Sources console.
    const dataSource = await prisma.dataSource.findFirst({ select: { id: true } });
    const taskType = await prisma.taskType.findFirst({ select: { id: true } });
    if (!dataSource || !taskType) {
      throw new Error("No DataSource/TaskType in this database — run `npm run db:seed` first.");
    }
    await prisma.taskRule.create({
      data: {
        id: RULE_ID,
        name: "TEST — provider breach (safe to delete)",
        dataSourceId: dataSource.id,
        taskTypeId: taskType.id,
        titleTemplate: "TEST breach task for order {{orderId}}",
        triggerType: "STATUS",
        triggerCondition: { statusIn: ["ORDER_SCHEDULED"] },
        slaMinutes: 30,
        priority: TaskPriority.HIGH,
        // Inactive so the polling engine never picks it up and creates real
        // tasks from it while the test is mid-flight.
        isActive: false,
      },
    });

    // sendEnabled TRUE only because these jids are fabricated and reach
    // nobody. Real groups start disabled — see lib/non-api-labs/target.ts.
    for (const [jid, labId] of [[API_GROUP_JID, API_LAB_ID], [MUTED_GROUP_JID, MUTED_LAB_ID]] as const) {
      await prisma.waGroup.create({
        data: { jid, subject: "TEST — provider breach (safe to delete)", role: "PROVIDER", labId, sendEnabled: true, active: true },
      });
    }

    await prisma.nonApiLabConfig.create({
      data: {
        labId: API_LAB_ID,
        labName: "Breach Test API Lab",
        // The subject of the test. Before this change, this row did nothing.
        integrationType: LabIntegrationType.API,
        isActive: true,
        waGroupJid: API_GROUP_JID,
        whatsappNumber: null,
        managerName: null,
        managerWhatsapp: null,
        slaBreachAlertsEnabled: true,
        slaBreachMaxPerOrder: 2,
      },
    });
    await prisma.nonApiLabConfig.create({
      data: {
        labId: MUTED_LAB_ID,
        labName: "Breach Test Muted Lab",
        integrationType: LabIntegrationType.NON_API,
        isActive: true,
        waGroupJid: MUTED_GROUP_JID,
        slaBreachAlertsEnabled: false,
      },
    });

    // ── 1. The lab id has to be resolvable from the order ─────────────────
    console.log("\n→ Resolving lab ids for breached orders (tasks carry no labId)");
    const labIds = await resolveLabIdsForOrders([API_ORDER_ID, MUTED_ORDER_ID, 999999999]);
    check("API order resolves to its lab", labIds.get(API_ORDER_ID) === API_LAB_ID, `got ${labIds.get(API_ORDER_ID)}`);
    check("muted order resolves to its lab", labIds.get(MUTED_ORDER_ID) === MUTED_LAB_ID, `got ${labIds.get(MUTED_ORDER_ID)}`);
    check("an order the source does not have is omitted", !labIds.has(999999999));

    // ── 2. An API lab gets the breach alert ──────────────────────────────
    console.log("\n→ Breaching a task on the API lab's order");
    const task1 = await makeBreachedTask(API_ORDER_ID, "Collect sample from patient", 45);
    const outcome1 = await notifyProviderOfBreach({
      taskId: task1.id, orderId: API_ORDER_ID, labId: API_LAB_ID,
      taskTitle: task1.title, slaDeadline: task1.slaDeadline, breachedAt: new Date(),
      breachMinutes: 45, metadata: task1.metadata as Record<string, unknown>,
    });
    check("API lab is messaged on breach", outcome1 === "queued", `outcome=${outcome1}`);

    const comm = await prisma.labCommunication.findUnique({
      where: { idempotencyKey: `provider-breach:${task1.id}` },
      select: { id: true, type: true, workflowId: true, orderId: true, labId: true, recipient: true, waOutboundId: true, templateVariables: true },
    });
    check("a SLA_BREACH communication was written", comm?.type === "SLA_BREACH", `type=${comm?.type}`);
    check("it carries no workflow", comm !== null && comm.workflowId === null, `workflowId=${comm?.workflowId}`);
    check("it records the order and lab directly", comm?.orderId === API_ORDER_ID && comm?.labId === API_LAB_ID);
    check("it is addressed to the GROUP, not a DM", comm?.recipient === API_GROUP_JID, `recipient=${comm?.recipient}`);

    const outbound = comm?.waOutboundId
      ? await prisma.waOutbound.findUnique({ where: { id: comm.waOutboundId }, select: { targetJid: true, groupId: true, status: true, text: true } })
      : null;
    check("outbound carries groupId (arms the sendEnabled guard)", !!outbound?.groupId, `groupId=${outbound?.groupId ?? "null"}`);
    check("outbound targets the group jid", outbound?.targetJid === API_GROUP_JID);
    check("the message names the late task", !!outbound?.text?.includes("Collect sample from patient"));
    check("the message states how late it is", !!outbound?.text?.includes("45 minutes overdue"));
    check("the message carries no bearer action link", !outbound?.text?.includes("/provider/action/"));

    // ── 3. …but is NOT asked to confirm the order ────────────────────────
    console.log("\n→ Confirming the API lab is not pulled into the confirmation ladder");
    const rawOrder = {
      id: API_ORDER_ID, labId: API_LAB_ID, labName: "Breach Test API Lab",
      orderType: "HOME_SAMPLE", orderStatus: "ORDER_SCHEDULED",
      patientName: "Provider Breach Test Patient", storeName: "Breach Test Store",
      appointmentTime: new Date(Date.now() + 2 * 60 * 60_000),
      createdAt: new Date(Date.now() - 6 * 60 * 60_000), metadata: {},
    } as unknown as RawOrder;
    const started = await startNonApiLabWorkflow(rawOrder);
    check("confirmation workflow is skipped for an API lab", started === "skipped", `result=${started}`);
    const workflow = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: API_ORDER_ID } });
    check("no workflow row exists for the API lab's order", workflow === null);

    // ── 4. Per-order cap ────────────────────────────────────────────────
    console.log("\n→ Breaching two more tasks on the SAME order (cap is 2)");
    const task2 = await makeBreachedTask(API_ORDER_ID + 100000, "Second rule on same order", 20);
    // Same order id, different task: rewrite entityId so the unique
    // (taskRuleId, entityId) index does not collide while the ORDER stays one.
    const outcome2 = await notifyProviderOfBreach({
      taskId: task2.id, orderId: API_ORDER_ID, labId: API_LAB_ID,
      taskTitle: task2.title, slaDeadline: task2.slaDeadline, breachedAt: new Date(),
      breachMinutes: 20, metadata: task2.metadata as Record<string, unknown>,
    });
    check("the second breach on one order still sends", outcome2 === "queued", `outcome=${outcome2}`);
    const task3 = await makeBreachedTask(API_ORDER_ID + 200000, "Third rule on same order", 5);
    const outcome3 = await notifyProviderOfBreach({
      taskId: task3.id, orderId: API_ORDER_ID, labId: API_LAB_ID,
      taskTitle: task3.title, slaDeadline: task3.slaDeadline, breachedAt: new Date(),
      breachMinutes: 5, metadata: task3.metadata as Record<string, unknown>,
    });
    check("the third is capped, not sent", outcome3 === "order-capped", `outcome=${outcome3}`);

    console.log("\n→ Re-notifying the same task");
    const repeat = await notifyProviderOfBreach({
      taskId: task1.id, orderId: API_ORDER_ID, labId: API_LAB_ID,
      taskTitle: task1.title, slaDeadline: task1.slaDeadline, breachedAt: new Date(),
      breachMinutes: 45, metadata: task1.metadata as Record<string, unknown>,
    });
    check("a repeated notify for one task is a no-op", repeat === "duplicate", `outcome=${repeat}`);

    // ── 5. The off switch ───────────────────────────────────────────────
    console.log("\n→ A lab with breach alerts switched off");
    const mutedTask = await makeBreachedTask(MUTED_ORDER_ID, "Muted lab task", 60);
    const mutedOutcome = await notifyProviderOfBreach({
      taskId: mutedTask.id, orderId: MUTED_ORDER_ID, labId: MUTED_LAB_ID,
      taskTitle: mutedTask.title, slaDeadline: mutedTask.slaDeadline, breachedAt: new Date(),
      breachMinutes: 60, metadata: mutedTask.metadata as Record<string, unknown>,
    });
    check("slaBreachAlertsEnabled=false is respected", mutedOutcome === "disabled", `outcome=${mutedOutcome}`);
    const mutedComms = await prisma.labCommunication.count({ where: { labId: MUTED_LAB_ID } });
    check("nothing was written for the muted lab", mutedComms === 0, `rows=${mutedComms}`);

    console.log("\n→ An unconfigured lab");
    const unconfigured = await notifyProviderOfBreach({
      taskId: 999999, orderId: 999999, labId: 888888,
      taskTitle: "Task for a lab nobody configured", slaDeadline: new Date(), breachedAt: new Date(),
      breachMinutes: 10, metadata: null,
    });
    check("a lab with no config is skipped quietly", unconfigured === "no-config", `outcome=${unconfigured}`);

    // ── 6. The real gateway drain ───────────────────────────────────────
    console.log("\n→ Draining through the real gateway module with a fake transport");
    const { drainOutbound } = await import("../whatsapp-bot/lib/controltower.mjs");
    const sentCalls: Array<{ jid: string; text: string }> = [];
    // drainOutbound takes a SEND FUNCTION, not a socket, and returns the wa
    // message id. It is the one fake in the path.
    const fakeSend = async (jid: string, text: string) => {
      sentCalls.push({ jid, text });
      return `FAKE_WA_ID_${sentCalls.length}`;
    };

    // Other labs' QUEUED rows are snapshotted and restored: the drain is
    // process-wide, and a test must not mark real seeded traffic as SENT.
    // The limit matters as much as the restore — the drain takes the OLDEST
    // rows first and this environment has ~80 of them, so a default limit of 5
    // never reaches the rows under test.
    const foreignQueued = await prisma.waOutbound.findMany({
      where: { status: "QUEUED", NOT: { targetJid: { in: [API_GROUP_JID, MUTED_GROUP_JID] } } },
      select: { id: true, status: true, sentWaMsgId: true, sentAt: true, error: true, attempts: true },
    });

    const drained = await drainOutbound(fakeSend, { limit: foreignQueued.length + 20 });

    for (const row of foreignQueued) {
      await prisma.waOutbound.update({
        where: { id: row.id },
        data: { status: row.status, sentWaMsgId: row.sentWaMsgId, sentAt: row.sentAt, error: row.error, attempts: row.attempts },
      });
    }
    console.log(`  gateway drained ${drained.drained}, sent ${drained.sent} (${foreignQueued.length} foreign rows restored)`);

    const ourSends = sentCalls.filter((c) => c.jid === API_GROUP_JID);
    check("the gateway sent to the API lab's group", ourSends.length === 2, `sends=${ourSends.length}`);
    check("the gateway sent nothing to the muted lab", !sentCalls.some((c) => c.jid === MUTED_GROUP_JID));
    const afterDrain = comm?.waOutboundId
      ? await prisma.waOutbound.findUnique({ where: { id: comm.waOutboundId }, select: { status: true } })
      : null;
    check("the outbound row is SENT after the drain", afterDrain?.status === "SENT", `status=${afterDrain?.status}`);
    const commAfter = comm ? await prisma.labCommunication.findUnique({ where: { id: comm.id }, select: { status: true, sentAt: true } }) : null;
    check("the communication is SENT too", commAfter?.status === "SENT", `status=${commAfter?.status}`);

    // ── 7. The guard still bites ────────────────────────────────────────
    console.log("\n→ Turning the group's sending off and queueing another alert");
    await prisma.waGroup.update({ where: { jid: API_GROUP_JID }, data: { sendEnabled: false } });
    await prisma.nonApiLabConfig.update({ where: { labId: API_LAB_ID }, data: { slaBreachMaxPerOrder: 20 } });
    const guardTask = await makeBreachedTask(API_ORDER_ID + 300000, "Task after sending was disabled", 15);
    const guardOutcome = await notifyProviderOfBreach({
      taskId: guardTask.id, orderId: API_ORDER_ID, labId: API_LAB_ID,
      taskTitle: guardTask.title, slaDeadline: guardTask.slaDeadline, breachedAt: new Date(),
      breachMinutes: 15, metadata: guardTask.metadata as Record<string, unknown>,
    });
    check("it still queues", guardOutcome === "queued", `outcome=${guardOutcome}`);

    // Counted per-group, not in total: the foreign rows restored above are
    // QUEUED again, so this second drain legitimately re-sends them. Only
    // sends to the lab under test say anything about the guard.
    const before = sentCalls.filter((c) => c.jid === API_GROUP_JID).length;
    const foreignQueued2 = await prisma.waOutbound.findMany({
      where: { status: "QUEUED", NOT: { targetJid: { in: [API_GROUP_JID, MUTED_GROUP_JID] } } },
      select: { id: true, status: true, sentWaMsgId: true, sentAt: true, error: true, attempts: true },
    });
    await drainOutbound(fakeSend, { limit: foreignQueued2.length + 20 });
    for (const row of foreignQueued2) {
      await prisma.waOutbound.update({
        where: { id: row.id },
        data: { status: row.status, sentWaMsgId: row.sentWaMsgId, sentAt: row.sentAt, error: row.error, attempts: row.attempts },
      });
    }
    const afterGuard = sentCalls.filter((c) => c.jid === API_GROUP_JID).length;
    check("but the gateway refuses to send it", afterGuard === before, `new sends to the group=${afterGuard - before}`);
    const refused = await prisma.waOutbound.findFirst({
      where: { targetJid: API_GROUP_JID, status: "FAILED" },
      select: { error: true },
    });
    check("and says why", !!refused?.error?.includes("sending disabled for group"), refused?.error ?? "no FAILED row");

    console.log(failures === 0 ? "\n✅  All checks passed." : `\n❌  ${failures} check(s) failed.`);
  } finally {
    console.log("\n→ Cleaning up");
    await cleanupTaskos();
    await cleanupSource();
    console.log("  ✔ Test data removed");
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
