/**
 * Smoke test: does the poll feature still work, against REAL WhatsApp?
 *
 * Every other test in this repo fakes the transport. This one does not — it
 * puts an actual message and an actual poll in the test group, which is the
 * only way to catch the things a fake cannot: a gateway that is down, a group
 * whose sending was switched off, a Baileys release that changed how polls are
 * sent. Run it after touching the gateway, after a re-link, or before trusting
 * the ladder with a real provider.
 *
 * It walks the chain and waits at each hop, so a failure names the hop:
 *
 *   preflight            gateway live, group send-enabled, lab routed here
 *     -> seed            one order + workflow + an overdue rung
 *       -> tick          builds lab_communications + wa_outbound WITH a poll
 *         -> gateway     sends both, records wa_polls
 *           -> human     taps an option (the one part nobody can automate)
 *
 * SENDS A REAL MESSAGE every run. It cleans up its own order afterwards, but
 * the message and poll stay in the group — that is the evidence.
 *
 *   npm run wa:smoke              run it
 *   npm run wa:smoke -- --clean   remove the test order and stop
 *   npm run wa:smoke -- --keep    leave the order in place to tap and inspect
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";

const prisma = new PrismaClient();

const LAB_ID = 378;
const ORDER_ID = 999302;
const EXPECTED_JID = "120363425636716175@g.us";
const CLEAN_ONLY = process.argv.includes("--clean");
const KEEP = process.argv.includes("--keep");

let failed = 0;
const pass = (m: string, d = "") => console.log(`  PASS  ${m}${d ? `  — ${d}` : ""}`);
const fail = (m: string, d = "") => { failed++; console.log(`  FAIL  ${m}${d ? `  — ${d}` : ""}`); };

/** Poll a condition until it holds or the deadline passes. */
async function waitFor<T>(
  what: string,
  check: () => Promise<T | null>,
  { timeoutMs, everyMs = 3000 }: { timeoutMs: number; everyMs?: number },
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`  ...  waiting for ${what} `);
  while (Date.now() < deadline) {
    const result = await check();
    if (result) { process.stdout.write("\n"); return result; }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, everyMs));
  }
  process.stdout.write("\n");
  return null;
}

async function clean() {
  const workflow = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: ORDER_ID } });
  if (workflow) {
    await prisma.waPoll.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labCommunication.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labScheduledAction.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labCommunicationWorkflow.delete({ where: { id: workflow.id } });
  }
  await prisma.waOutbound.deleteMany({ where: { text: { contains: String(ORDER_ID) } } });
  await labstackWorkerQuery(`DELETE FROM public."Order" WHERE id = $1`, [ORDER_ID]);
}

async function main() {
  if (CLEAN_ONLY) {
    await clean();
    console.log(`Removed smoke-test order ${ORDER_ID}.`);
    return;
  }

  // ── 1. Preflight ────────────────────────────────────────────────────────
  // Every check here is a reason the test would otherwise fail confusingly
  // several minutes later.
  console.log("── preflight ──");
  const gw = await prisma.waGateway.findUnique({ where: { id: "default" } });
  const hb = gw?.lastSeenAt ? (Date.now() - gw.lastSeenAt.getTime()) / 1000 : Infinity;
  if (hb >= 0 && hb < 60) pass("gateway is live", `heartbeat ${Math.round(hb)}s ago`);
  else fail("gateway is not live", hb < 0 ? "heartbeat is in the future — pre-UTC-fix build" : `last seen ${Math.round(hb)}s ago`);
  if (gw?.dryRun === false) pass("DRY_RUN is off");
  else fail("DRY_RUN is on", "the message would queue but never send");

  const group = await prisma.waGroup.findUnique({ where: { jid: EXPECTED_JID } });
  if (group?.sendEnabled) pass(`group "${group.subject}" is send-enabled`);
  else fail("group is not send-enabled", "the drain would mark the message FAILED");

  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: LAB_ID } });
  if (config?.waGroupJid === EXPECTED_JID && config.isActive) pass(`${config.labName} is active and routed here`);
  else fail("lab is not routed to the test group", `waGroupJid=${config?.waGroupJid} active=${config?.isActive}`);

  if (failed > 0) {
    console.log("\nStopping: preflight failed, so nothing was sent.");
    process.exitCode = 1;
    return;
  }

  // ── 2. Seed ─────────────────────────────────────────────────────────────
  console.log("\n── seed ──");
  await clean();
  const appointment = new Date(Date.now() + 3 * 60 * 60 * 1000);
  await labstackWorkerQuery(
    `INSERT INTO public."Order"
     SELECT * FROM jsonb_populate_record(
       NULL::public."Order",
       to_jsonb((SELECT o FROM public."Order" o WHERE o."labId" = $1 AND o."orderType" = 'HOME_SAMPLE' LIMIT 1))
       || jsonb_build_object('id', $2::int, 'orderStatus', 'ORDER_SCHEDULED',
            'appointmentTime', $3::text, 'createdAt', now()::text,
            'updatedAt', now()::text, 'statusUpdatedAt', now()::text))
     ON CONFLICT (id) DO NOTHING`,
    [LAB_ID, ORDER_ID, appointment.toISOString()],
  );
  const now = new Date();
  const workflow = await prisma.labCommunicationWorkflow.create({
    data: {
      orderId: ORDER_ID, labId: LAB_ID, status: "WAITING_FOR_LAB_CONFIRMATION",
      sourceOrderStatus: "ORDER_SCHEDULED", appointmentTime: appointment,
      orderSnapshot: {
        patientName: `Smoke Test ${now.toISOString().slice(11, 19)}`,
        location: "HSR Layout, Bengaluru",
        tests: "CBC, Vitamin D",
      },
      confirmationDeadline: new Date(now.getTime() + config!.confirmationSlaMinutes * 60_000),
      reminderDeadline: new Date(now.getTime() + config!.reminderSlaMinutes * 60_000),
      escalationDeadline: new Date(now.getTime() + config!.escalationSlaMinutes * 60_000),
    },
  });
  await prisma.labScheduledAction.create({
    data: {
      workflowId: workflow.id, type: "SEND_REMINDER", status: "PENDING", anchor: "ORDER",
      runAt: new Date(Date.now() - 60_000),
      idempotencyKey: `smoke:${workflow.id}:${Date.now()}`,
    },
  });
  pass(`order ${ORDER_ID} and an overdue rung created`);

  // ── 3. The console's tick builds the message ────────────────────────────
  console.log("\n── tick (runs every minute) ──");
  const outbound = await waitFor("the tick to build the message",
    async () => prisma.waOutbound.findFirst({ where: { text: { contains: String(ORDER_ID) } }, orderBy: { createdAt: "desc" } }),
    { timeoutMs: 100_000 });

  if (!outbound) {
    fail("the tick never built a message", "is the dev server running? instrumentation starts the tick at boot");
    process.exitCode = 1;
    return;
  }
  pass("message built");
  if (outbound.pollName) pass("it carries a poll", outbound.pollName);
  else fail("no poll attached", "the app is running a scheduler build from before the poll feature — restart the dev server");
  if (!/https?:\/\//.test(outbound.text ?? "")) pass("no action URL in the body");
  else fail("the body still contains a URL");

  // ── 4. The gateway sends it ─────────────────────────────────────────────
  console.log("\n── gateway ──");
  const sent = await waitFor("the gateway to send it",
    async () => {
      const row = await prisma.waOutbound.findUnique({ where: { id: outbound.id } });
      if (row?.status === "FAILED") return row;         // stop early, do not wait out the clock
      return row?.status === "SENT" && row.sentWaMsgId ? row : null;
    },
    { timeoutMs: 90_000 });

  if (sent?.status === "SENT") pass("delivered to WhatsApp", `id ${sent.sentWaMsgId}`);
  else if (sent?.status === "FAILED") fail("the gateway refused it", sent.error ?? "");
  else fail("still not sent", "the gateway may have dropped its connection");

  const poll = await waitFor("the poll to be recorded",
    async () => prisma.waPoll.findFirst({ where: { outboundId: outbound.id } }),
    { timeoutMs: 45_000 });

  if (poll) {
    pass("poll recorded", `${(poll.options as { label: string }[]).map((o) => o.label).join(" / ")}`);
    if (poll.workflowId === workflow.id) pass("poll is linked to the workflow");
    else fail("poll is not linked to a workflow", "a vote could not be applied to anything");
  } else {
    fail("no poll reached the group", "the gateway is running a build without poll support — restart it");
  }

  // ── 5. Handover ─────────────────────────────────────────────────────────
  console.log(failed === 0 ? "\nAll automated checks passed ✔" : `\n${failed} check(s) FAILED`);
  if (failed === 0 && poll) {
    console.log(`
The message and poll are in the group now. The last hop needs a human:

  tap an option, then run
    node node_modules/.bin/tsx prisma/verify_achievers_reminder.ts

  Accept        -> workflow becomes LAB_ACCEPTED and chasing stops
  Cannot fulfil -> the bot asks for a reason; your next message is recorded

Vote decryption is the one part no fake transport can prove, which is why it
is left to a tap rather than asserted here.`);
  }

  if (!KEEP && failed === 0) {
    console.log(`
Leaving order ${ORDER_ID} in place so the vote has something to land on.
Remove it when you are done:  npm run wa:smoke -- --clean`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
