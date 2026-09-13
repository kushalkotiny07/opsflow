/**
 * Local feature run — the whole provider-communication chain, end to end.
 *
 * ── A real operator rule can silently steal this test's ladder ──────────
 * `workflow.ts` replaces the built-in ladder with any active authored rule
 * that covers the order's lab, and a rule with an EMPTY allowedLabIds
 * "covers" every lab in the system — including this test's throwaway one.
 * That is not hypothetical: this environment has exactly such a rule
 * ("confirm order", allowedLabIds: []), created through the message-flow UI,
 * and section 6 below asserts properties of the BUILT-IN ladder specifically
 * (rung keys, an escalation rung, appointment rungs). So any rule currently
 * covering LAB_ID is paused for the run and restored to its exact prior
 * state afterward — the same snapshot/restore discipline the SLA-breach test
 * already uses for other labs' wa_outbound rows, applied here to rules.
 *
 * The existing tests each prove one thing. This one exercises every built
 * feature in sequence against the running app, and it closes the loop the
 * other tests could not:
 *
 *   **The provider action centre has never actually been opened.** Action
 *   tokens are stored as SHA-256 hashes, so the raw token exists only inside
 *   the message that was dispatched. With no gateway, nothing was ever
 *   dispatched, so there was no raw token and `/provider/action/[token]` was
 *   unreachable. Here the real gateway drain runs with a fake transport, the
 *   captured message text is parsed for its links, and the page and its API
 *   are driven over HTTP exactly as a provider's phone would.
 *
 * Nothing leaves the machine. The only fake in the path is the transport
 * function handed to the real `drainOutbound`; every other line is the code
 * that runs in production.
 *
 * Requires the app on http://localhost:3000 (npm run dev) and the dummy
 * source DB. Everything it creates lives in the 9990xx id range and is
 * deleted in a finally block, including on failure.
 *
 * Run: npm run wa:test-features
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

process.env.TASKOS_DATABASE_URL = process.env.TASKOS_DATABASE_URL || process.env.DATABASE_URL;

import { LabIntegrationType, PrismaClient } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";
import { startNonApiLabWorkflow } from "../src/lib/non-api-labs/workflow";
import { processDueNonApiLabScheduledActions } from "../src/lib/non-api-labs/scheduler";
import { notifyProviderOfBreach } from "../src/lib/provider-comms/sla-breach";
import type { RawOrder } from "../src/lib/engine/labstack";

const prisma = new PrismaClient();
const APP = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const WEBHOOK_SECRET = process.env.NON_API_WHATSAPP_WEBHOOK_SECRET || "";

const LAB_ID = 999021;
const USER_ID = 999021;
const STORE_ID = 999021;
const GROUP_JID = "120363999000000021@g.us";
/** One order per provider response, plus one to walk the ladder. */
const ORDERS = { accept: 999021, reschedule: 999022, reject: 999023, ladder: 999024 };
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

// ── Fixture ────────────────────────────────────────────────────────────────
async function seedSource() {
  await labstackWorkerQuery(`
    INSERT INTO public."User" (id, name, mobile, gender, city)
    VALUES (${USER_ID}, 'Feature Run Patient', '+919999900021', 'FEMALE', 'Bengaluru')
    ON CONFLICT (id) DO NOTHING`);
  await labstackWorkerQuery(`
    INSERT INTO public."Store" (id, "storeName") VALUES (${STORE_ID}, 'Feature Run Store')
    ON CONFLICT (id) DO NOTHING`);
  await labstackWorkerQuery(`
    INSERT INTO public."Lab" (id, "labName") VALUES (${LAB_ID}, 'Feature Run Diagnostics')
    ON CONFLICT (id) DO NOTHING`);
  for (const orderId of ALL_ORDERS) {
    // The ladder order gets a distant appointment on purpose. buildLadder
    // drops any rung that would land after the appointment, so with a 4h
    // appointment and a 5h escalation SLA the escalation rung is never
    // scheduled at all — the ladder order needs room for its whole ladder.
    const hours = orderId === ORDERS.ladder ? 12 : 4;
    await labstackWorkerQuery(`
      INSERT INTO public."Order" (
        id, "labOrderId", "userId", "storeId", "labId", "orderType", "orderStatus",
        "appointmentTime", "createdAt", "updatedAt", "statusUpdatedAt", "packageName", pincode, city
      ) VALUES (
        ${orderId}, 'FEATRUN-${orderId}', ${USER_ID}, ${STORE_ID}, ${LAB_ID},
        'HOME_SAMPLE'::public."OrderType", 'ORDER_SCHEDULED'::public."OrderStatus",
        (now() AT TIME ZONE 'UTC') + interval '${hours} hours',
        (now() AT TIME ZONE 'UTC') - interval '30 minutes',
        (now() AT TIME ZONE 'UTC') - interval '30 minutes',
        (now() AT TIME ZONE 'UTC') - interval '30 minutes',
        'Feature Run Package', '560001', 'Bengaluru'
      ) ON CONFLICT (id) DO NOTHING`);
  }
}

/**
 * Read the seeded orders back out of the source.
 *
 * This matters more than it looks. The scheduler compares the workflow's
 * stored appointment against the source's to the millisecond, so a RawOrder
 * built from a fresh `new Date()` rather than from the row the source actually
 * stored reads as "appointment moved in LabStack" on the first tick — the
 * reminder is skipped in favour of a recompute pass. Production always gets
 * RawOrder from a SELECT, so the test has to as well.
 */
async function loadSourceOrders(): Promise<Map<number, RawOrder>> {
  const rows = await labstackWorkerQuery<{ id: number; appointmentTime: Date; createdAt: Date }>(
    `SELECT id, "appointmentTime", "createdAt" FROM public."Order" WHERE id = ANY($1::int[])`,
    [ALL_ORDERS],
  );
  const byId = new Map<number, RawOrder>();
  for (const row of rows) {
    byId.set(Number(row.id), {
      id: Number(row.id),
      labId: LAB_ID,
      labName: "Feature Run Diagnostics",
      orderType: "HOME_SAMPLE",
      orderStatus: "ORDER_SCHEDULED",
      patientName: "Feature Run Patient",
      storeName: "Feature Run Store",
      appointmentTime: row.appointmentTime,
      createdAt: row.createdAt,
      metadata: { tests: "CBC, HbA1c" },
    } as unknown as RawOrder);
  }
  return byId;
}

async function cleanup() {
  const workflows = await prisma.labCommunicationWorkflow.findMany({
    where: { orderId: { in: ALL_ORDERS } }, select: { id: true },
  });
  const ids = workflows.map((w) => w.id);
  const comms = await prisma.labCommunication.findMany({
    where: { OR: [{ workflowId: { in: ids } }, { labId: LAB_ID }, { orderId: { in: ALL_ORDERS } }] },
    select: { id: true, waOutboundId: true },
  });
  const outboundIds = comms.map((c) => c.waOutboundId).filter((v): v is string => !!v);

  if (ids.length) {
    await prisma.labCommunicationOrderEvent.deleteMany({ where: { workflowId: { in: ids } } });
    await prisma.labCommunicationAuditLog.deleteMany({ where: { workflowId: { in: ids } } });
    await prisma.labProviderActionToken.deleteMany({ where: { workflowId: { in: ids } } });
    await prisma.labCommunicationEscalation.deleteMany({ where: { workflowId: { in: ids } } });
    await prisma.labScheduledAction.deleteMany({ where: { workflowId: { in: ids } } });
  }
  await prisma.labCommunication.deleteMany({ where: { id: { in: comms.map((c) => c.id) } } });
  if (ids.length) await prisma.labCommunicationWorkflow.deleteMany({ where: { id: { in: ids } } });
  if (outboundIds.length) await prisma.waOutbound.deleteMany({ where: { id: { in: outboundIds } } });
  await prisma.slaMilestoneConfig.deleteMany({ where: { labId: LAB_ID } });
  await prisma.nonApiLabConfig.deleteMany({ where: { labId: LAB_ID } });

  const group = await prisma.waGroup.findUnique({ where: { jid: GROUP_JID }, select: { id: true } });
  if (group) {
    await prisma.waOutbound.deleteMany({ where: { groupId: group.id } });
    await prisma.waGroup.delete({ where: { id: group.id } });
  }

  await labstackWorkerQuery(`DELETE FROM public."Order" WHERE id IN (${ALL_ORDERS.join(",")})`);
  await labstackWorkerQuery(`DELETE FROM public."Lab" WHERE id = ${LAB_ID}`);
  await labstackWorkerQuery(`DELETE FROM public."Store" WHERE id = ${STORE_ID}`);
  await labstackWorkerQuery(`DELETE FROM public."User" WHERE id = ${USER_ID}`);
}

/**
 * Drain through the REAL gateway module with a fake transport.
 *
 * Two things are essential and were both got wrong first time round: the drain
 * takes a SEND FUNCTION (not a socket), and it processes the OLDEST queued
 * rows first — this environment has ~80 of them, so the default limit of 5
 * never reaches the rows under test. Foreign rows are snapshotted and restored
 * so a test never marks real seeded traffic as sent.
 */
async function drainCapturing(): Promise<Array<{ jid: string; text: string }>> {
  const { drainOutbound } = await import("../whatsapp-bot/lib/controltower.mjs");
  const sent: Array<{ jid: string; text: string }> = [];
  const foreign = await prisma.waOutbound.findMany({
    where: { status: "QUEUED", NOT: { targetJid: GROUP_JID } },
    select: { id: true, status: true, sentWaMsgId: true, sentAt: true, error: true, attempts: true },
  });
  await drainOutbound(
    async (jid: string, text: string) => { sent.push({ jid, text }); return `FAKE_WA_${sent.length}_${Date.now()}`; },
    { limit: foreign.length + 40 },
  );
  for (const row of foreign) {
    await prisma.waOutbound.update({
      where: { id: row.id },
      data: { status: row.status, sentWaMsgId: row.sentWaMsgId, sentAt: row.sentAt, error: row.error, attempts: row.attempts },
    });
  }
  return sent.filter((m) => m.jid === GROUP_JID);
}

type RuleSnapshot = { id: string; isActive: boolean };

/**
 * Pause any active authored rule that covers `labId` — matching the same
 * scoping the engine itself uses (empty allowedLabIds = every lab, otherwise
 * an explicit list) — and return exactly what to restore. See the file
 * header: a real, currently-active "applies to every provider" rule would
 * otherwise silently replace the built-in ladder this test's section 6
 * asserts against.
 */
async function pauseRulesCoveringLab(labId: number): Promise<RuleSnapshot[]> {
  const active = await prisma.providerCommunicationRule.findMany({
    where: { isActive: true },
    select: { id: true, isActive: true, allowedLabIds: true },
  });
  const covering = active.filter((rule) => {
    const ids = Array.isArray(rule.allowedLabIds) ? (rule.allowedLabIds as number[]) : [];
    return ids.length === 0 || ids.includes(labId);
  });
  if (covering.length > 0) {
    await prisma.providerCommunicationRule.updateMany({
      where: { id: { in: covering.map((rule) => rule.id) } },
      data: { isActive: false },
    });
    console.log(`  (pausing ${covering.length} real rule(s) that cover lab ${labId} for the duration of this run: ${covering.map((r) => r.id).join(", ")})`);
  }
  return covering.map((rule) => ({ id: rule.id, isActive: rule.isActive }));
}

async function restoreRules(snapshots: RuleSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    await prisma.providerCommunicationRule.update({ where: { id: snapshot.id }, data: { isActive: snapshot.isActive } });
  }
}

/** Pull the three action links out of a rendered message, by their labels. */
function linksFrom(text: string) {
  const grab = (label: RegExp) => text.split("\n").find((l) => label.test(l))?.match(/\/provider\/action\/([a-f0-9]{64})/)?.[1] ?? null;
  return {
    accept: grab(/^Accept/i),
    reschedule: grab(/^Reschedule/i),
    reject: grab(/^Cannot fulfil/i),
  };
}

async function postAction(token: string, action: string, extra: Record<string, string> = {}) {
  const response = await fetch(`${APP}/api/provider/action/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
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
  console.log("\x1b[1m🧪  Local feature run — provider communication over WhatsApp\x1b[0m");
  console.log(`    app=${APP}  transport=FAKE (nothing leaves this machine)\n`);

  let pausedRules: RuleSnapshot[] = [];

  try {
    await cleanup();
    await seedSource();
    pausedRules = await pauseRulesCoveringLab(LAB_ID);
    await isolateFromMilestoneEngine([LAB_ID]);

    // ── 0. App reachable ──────────────────────────────────────────────────
    section("Preflight");
    const health = await fetch(`${APP}/api/non-api-labs/templates`).then((r) => r.status).catch(() => 0);
    check("app is running", health === 200 || health === 403, `GET /api/non-api-labs/templates → ${health || "unreachable"}`);
    if (!health) throw new Error("App is not reachable — start it with `npm run dev` first.");

    // sendEnabled TRUE only because this jid is fabricated and reaches nobody.
    await prisma.waGroup.create({
      data: { jid: GROUP_JID, subject: "TEST — feature run (safe to delete)", role: "PROVIDER", labId: LAB_ID, sendEnabled: true, active: true },
    });
    await prisma.nonApiLabConfig.create({
      data: {
        labId: LAB_ID, labName: "Feature Run Diagnostics",
        integrationType: LabIntegrationType.NON_API, isActive: true,
        waGroupJid: GROUP_JID, whatsappNumber: null, managerName: null, managerWhatsapp: null,
        confirmationSlaMinutes: 60, reminderSlaMinutes: 180, escalationSlaMinutes: 300,
        quietWindowMinutes: 0, appointmentRemindersEnabled: true,
      },
    });

    // ── 1. Workflow start ─────────────────────────────────────────────────
    section("1. A new order reaches the provider");
    const sourceOrders = await loadSourceOrders();
    check("all four orders read back from the source", sourceOrders.size === 4, `${sourceOrders.size}/4`);
    for (const [name, orderId] of Object.entries(ORDERS)) {
      const outcome = await startNonApiLabWorkflow(sourceOrders.get(orderId)!);
      check(`workflow starts for the ${name} order`, outcome === "started", `outcome=${outcome}`);
    }
    const queued = await prisma.labCommunication.findMany({
      where: { workflow: { orderId: { in: ALL_ORDERS } }, type: "INITIAL_NOTIFICATION" },
      select: { recipient: true, status: true, waOutboundId: true },
    });
    check("each order queued one initial notification", queued.length === 4, `${queued.length} queued`);
    check("all addressed to the provider GROUP", queued.every((c) => c.recipient === GROUP_JID));
    const withGroupId = await prisma.waOutbound.count({
      where: { id: { in: queued.map((c) => c.waOutboundId!).filter(Boolean) }, groupId: { not: null } },
    });
    check("every outbound carries groupId (arms the send guard)", withGroupId === 4, `${withGroupId}/4`);

    const ladderRungs = await prisma.labScheduledAction.count({ where: { workflow: { orderId: ORDERS.ladder } } });
    check("the two-clock ladder was scheduled", ladderRungs > 0, `${ladderRungs} rungs`);

    // ── 2. The real gateway drain ─────────────────────────────────────────
    section("2. The gateway drains the queue (real drain, fake transport)");
    const sent = await drainCapturing();
    check("the gateway transmitted to the group", sent.length === 4, `${sent.length} message(s)`);
    const commsSent = await prisma.labCommunication.count({
      where: { workflow: { orderId: { in: ALL_ORDERS } }, status: "SENT" },
    });
    check("communications marked SENT", commsSent === 4, `${commsSent}/4`);
    const first = sent[0]?.text ?? "";
    check("message carries the order detail", /Order ID: 9990\d\d/.test(first) && first.includes("Feature Run Patient"));
    check("message carries the three action links", Object.values(linksFrom(first)).every(Boolean));
    check("gateway signed the message", first.includes("Sent by Labstack Operations"));

    console.log("\n  ── the provider group receives ──");
    for (const line of first.split("\n")) console.log(`  │ ${line}`);

    // Map each captured message back to its order so the right token is used.
    const byOrder = new Map<number, ReturnType<typeof linksFrom>>();
    for (const message of sent) {
      const orderId = Number(message.text.match(/Order ID: (\d+)/)?.[1]);
      if (orderId) byOrder.set(orderId, linksFrom(message.text));
    }

    // ── 3. The provider action centre, over HTTP ──────────────────────────
    section("3. The provider opens the link (this path has never been reachable before)");
    const acceptToken = byOrder.get(ORDERS.accept)?.accept ?? "";
    check("an accept token was recovered from the message", /^[a-f0-9]{64}$/.test(acceptToken));

    const pageResponse = await fetch(`${APP}/provider/action/${acceptToken}`);
    const pageHtml = await pageResponse.text();
    check("the action page loads", pageResponse.status === 200, `HTTP ${pageResponse.status}`);
    check("it shows the order, not an error", pageHtml.includes("Please choose an action"));
    check("it names the patient", pageHtml.includes("Feature Run Patient"));
    check("it offers all three actions", ["Accept", "Reschedule", "Cannot fulfil"].every((l) => pageHtml.includes(l)));

    const opened = await prisma.labCommunicationOrderEvent.count({
      where: { workflow: { orderId: ORDERS.accept }, type: "ACTION_LINK_OPENED" },
    });
    check("opening the link is tracked", opened === 1, `${opened} event(s)`);

    // ── 4. Accept ─────────────────────────────────────────────────────────
    section("4. The provider accepts");
    const accepted = await postAction(acceptToken, "ACCEPT");
    check("accept is recorded", accepted.status === 200, `HTTP ${accepted.status} ${JSON.stringify(accepted.body).slice(0, 90)}`);
    const acceptWorkflow = await prisma.labCommunicationWorkflow.findUnique({
      where: { orderId: ORDERS.accept }, select: { status: true, acceptedAt: true },
    });
    check("workflow moves to LAB_ACCEPTED", acceptWorkflow?.status === "LAB_ACCEPTED", `status=${acceptWorkflow?.status}`);
    check("acceptedAt is timestamped", !!acceptWorkflow?.acceptedAt);
    const actionTaken = await prisma.labCommunication.count({
      where: { workflow: { orderId: ORDERS.accept }, status: "ACTION_TAKEN" },
    });
    check("its messages are marked ACTION_TAKEN", actionTaken > 0, `${actionTaken}`);

    const reuse = await postAction(acceptToken, "ACCEPT");
    check("the link cannot be used twice", reuse.status === 409, `HTTP ${reuse.status}`);
    const wrongAction = await postAction(byOrder.get(ORDERS.accept)?.reject ?? "", "ACCEPT");
    check("a token cannot be used for a different action", wrongAction.status === 404, `HTTP ${wrongAction.status}`);
    const forged = await postAction("f".repeat(64), "ACCEPT");
    check("a forged token is rejected", forged.status === 404, `HTTP ${forged.status}`);

    // PRD §7: completed actions must suppress what was chasing them.
    await processDueNonApiLabScheduledActions();
    const stillPending = await prisma.labScheduledAction.count({
      where: { workflow: { orderId: ORDERS.accept }, status: "PENDING", runAt: { lte: new Date() } },
    });
    check("no further chasing is due for an accepted order", stillPending === 0, `${stillPending} still due`);

    // ── 5. Reschedule and reject ──────────────────────────────────────────
    section("5. The other two answers");
    const rescheduleToken = byOrder.get(ORDERS.reschedule)?.reschedule ?? "";
    const rescheduled = await postAction(rescheduleToken, "RESCHEDULE", {
      reason: "Phlebotomist unavailable in that slot",
      proposedAppointmentTime: "Tomorrow 9:00 AM",
    });
    check("reschedule is recorded", rescheduled.status === 200, `HTTP ${rescheduled.status}`);
    const rescheduleWorkflow = await prisma.labCommunicationWorkflow.findUnique({
      where: { orderId: ORDERS.reschedule }, select: { status: true, rescheduleRequestedAt: true },
    });
    check("workflow moves to LAB_RESCHEDULE_REQUESTED", rescheduleWorkflow?.status === "LAB_RESCHEDULE_REQUESTED", `status=${rescheduleWorkflow?.status}`);
    const rescheduleEvent = await prisma.labCommunicationOrderEvent.findFirst({
      where: { workflow: { orderId: ORDERS.reschedule }, type: "LAB_RESCHEDULE_REQUESTED" },
      select: { payload: true },
    });
    const payload = rescheduleEvent?.payload as { reason?: string; proposedAppointmentTime?: string } | null;
    check("the proposed slot is captured", payload?.proposedAppointmentTime === "Tomorrow 9:00 AM", payload?.proposedAppointmentTime ?? "missing");

    const rejectToken = byOrder.get(ORDERS.reject)?.reject ?? "";
    const rejected = await postAction(rejectToken, "REJECT", { reason: "No capacity in that pincode" });
    check("reject is recorded", rejected.status === 200, `HTTP ${rejected.status}`);
    const rejectWorkflow = await prisma.labCommunicationWorkflow.findUnique({
      where: { orderId: ORDERS.reject }, select: { status: true, rejectionReason: true },
    });
    check("workflow moves to LAB_REJECTED", rejectWorkflow?.status === "LAB_REJECTED", `status=${rejectWorkflow?.status}`);
    check("the rejection reason is stored", rejectWorkflow?.rejectionReason === "No capacity in that pincode", rejectWorkflow?.rejectionReason ?? "missing");

    // ── 6. The ladder, for a provider who says nothing ────────────────────
    section("6. The ladder chases a silent provider");
    const ladderWorkflow = await prisma.labCommunicationWorkflow.findUnique({
      where: { orderId: ORDERS.ladder }, select: { id: true },
    });
    const wid = ladderWorkflow!.id;
    // Backdate the order-clock rungs so the confirmation reminder is due now.
    // The ladder is timed from workflow start, not order age, so without this
    // nothing is due for another hour.
    await prisma.labScheduledAction.updateMany({
      where: { workflowId: wid, anchor: "ORDER", type: "SEND_REMINDER" },
      data: { runAt: new Date(Date.now() - 60_000) },
    });
    await processDueNonApiLabScheduledActions();
    const reminder = await prisma.labCommunication.findFirst({
      where: { workflowId: wid, type: "REMINDER" }, select: { id: true, templateKey: true },
    });
    check("a reminder is sent when nobody answers", !!reminder, reminder?.templateKey ?? "none");

    // Now make the escalation rung due.
    await prisma.labScheduledAction.updateMany({
      where: { workflowId: wid, type: "ESCALATE" },
      data: { runAt: new Date(Date.now() - 60_000), status: "PENDING" },
    });
    await processDueNonApiLabScheduledActions();
    const escalationComm = await prisma.labCommunication.findFirst({
      where: { workflowId: wid, type: "ESCALATION" }, select: { recipient: true },
    });
    check("it escalates when the SLA expires", !!escalationComm);
    const escalationRow = await prisma.labCommunicationEscalation.findFirst({
      where: { workflowId: wid }, select: { level: true, reason: true, status: true },
    });
    check("the escalation is recorded with its reason", !!escalationRow, escalationRow?.reason ?? "none");
    check("no manager on file falls back to the lab group", escalationComm?.recipient === GROUP_JID, escalationComm?.recipient ?? "");
    const escalated = await prisma.labCommunicationWorkflow.findUnique({ where: { id: wid }, select: { status: true } });
    check("the workflow is marked ESCALATED", escalated?.status === "ESCALATED", `status=${escalated?.status}`);

    const ladderSent = await drainCapturing();
    check("the chase messages transmit too", ladderSent.length >= 2, `${ladderSent.length} message(s)`);

    // ── 6b. The appointment moves upstream ────────────────────────────────
    // Two engine behaviours this pins down, both found while writing it:
    //
    //   1. The source is compared to the stored appointment to the
    //      millisecond, and any difference is a reschedule — the appointment
    //      rungs are recomputed and nothing is sent that tick.
    //   2. That check is LAZY. It runs only when a scheduled action comes due,
    //      so the workflow has to be visited for the move to be noticed. A
    //      move while nothing is due is picked up by the next rung, before it
    //      sends — which is why no wrong message escapes in the meantime.
    //
    // So a rung is made due deliberately here, and a DIFFERENT rung is used to
    // measure the shift.
    section("6b. The appointment moves in LabStack");
    const measured = "APPT_T_MINUS_30M";
    const runAtOf = async () =>
      (await prisma.labScheduledAction.findFirst({
        where: { workflowId: wid, rungKey: measured }, select: { runAt: true },
      }))?.runAt ?? null;
    const apptBefore = await runAtOf();
    check(`an ${measured} rung exists to measure`, apptBefore !== null);

    await labstackWorkerQuery(
      `UPDATE public."Order" SET "appointmentTime" = "appointmentTime" + interval '90 minutes' WHERE id = ${ORDERS.ladder}`,
    );
    // Nothing is due for ~10 hours, so make one rung due to get the workflow
    // visited — the move is invisible to the engine until then.
    await prisma.labScheduledAction.updateMany({
      where: { workflowId: wid, rungKey: "APPT_T_MINUS_2H" },
      data: { runAt: new Date(Date.now() - 60_000), status: "PENDING" },
    });
    await processDueNonApiLabScheduledActions();

    const apptAfter = await runAtOf();
    const movedBy = apptBefore && apptAfter
      ? Math.round((apptAfter.getTime() - apptBefore.getTime()) / 60_000)
      : 0;
    check("appointment rungs follow the new time", movedBy === 90, `moved ${movedBy} min`);
    const rescheduleLogged = await prisma.labCommunicationOrderEvent.findFirst({
      where: { workflowId: wid, type: "REMINDER_SCHEDULED", payload: { path: ["reason"], equals: "Appointment time changed in LabStack" } },
      select: { id: true },
    });
    check("the move is on the record", !!rescheduleLogged);
    const workflowAppt = await prisma.labCommunicationWorkflow.findUnique({ where: { id: wid }, select: { appointmentTime: true } });
    const sourceAppt = (await labstackWorkerQuery<{ appointmentTime: Date }>(
      `SELECT "appointmentTime" FROM public."Order" WHERE id = ${ORDERS.ladder}`,
    ))[0]?.appointmentTime;
    check(
      "the workflow now agrees with the source",
      !!workflowAppt?.appointmentTime && !!sourceAppt && workflowAppt.appointmentTime.getTime() === new Date(sourceAppt).getTime(),
      `workflow=${workflowAppt?.appointmentTime?.toISOString()} source=${sourceAppt && new Date(sourceAppt).toISOString()}`,
    );

    // ── 7. Delivery receipts ──────────────────────────────────────────────
    section("7. Delivery receipts come back from the gateway");
    const receiptTarget = await prisma.labCommunication.findFirst({
      where: { workflowId: wid, type: "REMINDER" },
      select: { id: true, waOutboundId: true },
    });
    const waMsgId = receiptTarget?.waOutboundId
      ? (await prisma.waOutbound.findUnique({ where: { id: receiptTarget.waOutboundId }, select: { sentWaMsgId: true } }))?.sentWaMsgId
      : null;
    if (!WEBHOOK_SECRET) {
      check("webhook secret configured", false, "NON_API_WHATSAPP_WEBHOOK_SECRET is unset — skipping receipts");
    } else {
      const unauthorized = await fetch(`${APP}/api/non-api-labs/whatsapp/webhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "delivered", waMsgId }),
      });
      check("the webhook rejects an unsigned call", unauthorized.status === 401, `HTTP ${unauthorized.status}`);

      for (const [wire, expected] of [["delivered", "DELIVERED"], ["read", "READ"]] as const) {
        const response = await fetch(`${APP}/api/non-api-labs/whatsapp/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-non-api-webhook-secret": WEBHOOK_SECRET },
          body: JSON.stringify({ status: wire, waMsgId }),
        });
        const ok = response.status === 200;
        const row = await prisma.labCommunication.findUnique({
          where: { id: receiptTarget!.id }, select: { status: true, deliveredAt: true, readAt: true },
        });
        check(`"${wire}" marks the message ${expected}`, ok && row?.status === expected, `HTTP ${response.status} status=${row?.status}`);
      }
      const readRow = await prisma.labCommunication.findUnique({
        where: { id: receiptTarget!.id }, select: { deliveredAt: true, readAt: true },
      });
      check("delivery and read are timestamped", !!readRow?.deliveredAt && !!readRow?.readAt);
    }

    // ── 8. The send guard ─────────────────────────────────────────────────
    section("8. The per-group send guard");
    await prisma.waGroup.update({ where: { jid: GROUP_JID }, data: { sendEnabled: false } });
    const guardOutbound = await prisma.waOutbound.create({
      data: {
        targetJid: GROUP_JID,
        text: "Guard check — must never transmit",
        groupId: (await prisma.waGroup.findUnique({ where: { jid: GROUP_JID }, select: { id: true } }))!.id,
      },
    });
    const afterGuard = await drainCapturing();
    check("a send-disabled group transmits nothing", afterGuard.length === 0, `${afterGuard.length} message(s)`);
    const guardRow = await prisma.waOutbound.findUnique({ where: { id: guardOutbound.id }, select: { status: true, error: true } });
    check("and the row says why", guardRow?.status === "FAILED" && !!guardRow.error?.includes("sending disabled"), guardRow?.error ?? "");
    await prisma.waGroup.update({ where: { jid: GROUP_JID }, data: { sendEnabled: true } });

    // ── 9. SLA breach alert ───────────────────────────────────────────────
    section("9. An SLA breach reaches the provider");
    const breach = await notifyProviderOfBreach({
      taskId: 999021, orderId: ORDERS.ladder, labId: LAB_ID,
      taskTitle: "Sample handover to lab", slaDeadline: new Date(Date.now() - 25 * 60_000),
      breachedAt: new Date(), breachMinutes: 25,
      metadata: { patientName: "Feature Run Patient", labName: "Feature Run Diagnostics" },
    });
    check("the breach alert queues", breach === "queued", `outcome=${breach}`);
    const breachComm = await prisma.labCommunication.findFirst({
      where: { type: "SLA_BREACH", labId: LAB_ID }, select: { workflowId: true, orderId: true, recipient: true, waOutboundId: true },
    });
    check("it stands alone, with no workflow", breachComm !== null && breachComm.workflowId === null);
    check("it is addressed to the group", breachComm?.recipient === GROUP_JID);
    const breachSent = await drainCapturing();
    check("it transmits", breachSent.length === 1, `${breachSent.length} message(s)`);
    if (breachSent[0]) {
      console.log("\n  ── the breach alert ──");
      for (const line of breachSent[0].text.split("\n")) console.log(`  │ ${line}`);
    }

    // ── 10. Audit trail ───────────────────────────────────────────────────
    section("10. Everything is on the record");
    const events = await prisma.labCommunicationOrderEvent.groupBy({
      by: ["type"], where: { workflow: { orderId: { in: ALL_ORDERS } } }, _count: { _all: true },
    });
    const kinds = events.map((e) => e.type);
    check("the order timeline is populated", events.length >= 5, kinds.join(", "));
    for (const required of ["WORKFLOW_STARTED", "ACTION_LINK_OPENED", "LAB_ACCEPTED", "LAB_REJECTED"] as const) {
      check(`${required} is logged`, kinds.includes(required));
    }
    const audits = await prisma.labCommunicationAuditLog.count({ where: { workflow: { orderId: { in: ALL_ORDERS } } } });
    check("the audit log has entries", audits > 0, `${audits} row(s)`);

    console.log(
      failures === 0
        ? `\n\x1b[32m\x1b[1m✅  ${checks} checks passed.\x1b[0m`
        : `\n\x1b[31m\x1b[1m❌  ${failures} of ${checks} checks failed.\x1b[0m`,
    );
  } finally {
    console.log("\n→ Cleaning up");
    await restoreRules(pausedRules);
    if (pausedRules.length > 0) console.log(`  ✔ Restored ${pausedRules.length} paused rule(s) to their prior state`);
    await cleanup();
    console.log("  ✔ Every fixture removed");
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
