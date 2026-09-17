/**
 * Full automation sample test — everything except the WhatsApp socket.
 *
 *   overdue rung
 *     → processDueNonApiLabScheduledActions()   ← the real every-minute tick
 *       → lab_communications + wa_outbound CARRYING A POLL
 *         → drainOutbound() from the real gateway module, FAKE transport
 *           → wa_polls row, options mapped to actions
 *             → recordPollVote()                ← what the gateway writes on a tap
 *               → processPollVotes()            ← the real tick again
 *                 → workflow LAB_ACCEPTED, rungs suppressed
 *
 * The only fake is the transport: `send` and `sendPoll` return ids instead of
 * talking to WhatsApp. Every other line is production code, including the
 * gateway's own drainOutbound and recordPollVote.
 *
 * Safe to run with the gateway stopped — in fact it should be, so the real
 * drain does not race this one for the queued row.
 *
 * NOTE: consumes one open workflow (it genuinely accepts that order).
 *
 * Run: node node_modules/.bin/tsx prisma/test_poll_automation_e2e.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// The gateway module reads its own connection string.
process.env.TASKOS_DATABASE_URL = process.env.TASKOS_DATABASE_URL || process.env.DATABASE_URL;

import { PrismaClient } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";
import { processDueNonApiLabScheduledActions } from "../src/lib/non-api-labs/scheduler";
import { processPollVotes } from "../src/lib/non-api-labs/poll-votes";

const prisma = new PrismaClient();
const LAB_ID = 378;
const JID = "120363425636716175@g.us";
const VOTER = "918888888888@s.whatsapp.net";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};

async function main() {
  const gw = await prisma.waGateway.findUnique({ where: { id: "default" } });
  const hbAge = gw?.lastSeenAt ? (Date.now() - gw.lastSeenAt.getTime()) / 1000 : Infinity;
  if (hbAge >= 0 && hbAge < 60) {
    throw new Error("The gateway is running — stop it first, or it will race this test for the queued row.");
  }

  const workflow = await prisma.labCommunicationWorkflow.findFirst({
    where: { labId: LAB_ID, status: "WAITING_FOR_LAB_CONFIRMATION" },
    orderBy: { createdAt: "asc" },
  });
  if (!workflow) throw new Error("no open workflow — nothing to test with");
  console.log(`Workflow ${workflow.id} (order ${workflow.orderId})\n`);

  // The tick refuses to send when its snapshot disagrees with LabStack, so
  // re-sync exactly as the trigger script does.
  const src = (await labstackWorkerQuery<{ appointmentTime: Date | null }>(
    `SELECT "appointmentTime" FROM public."Order" WHERE id = $1`, [workflow.orderId],
  ))[0];
  if (src && src.appointmentTime?.getTime() !== workflow.appointmentTime?.getTime()) {
    await prisma.labCommunicationWorkflow.update({
      where: { id: workflow.id }, data: { appointmentTime: src.appointmentTime },
    });
  }

  const rung = await prisma.labScheduledAction.create({
    data: {
      workflowId: workflow.id,
      type: "SEND_REMINDER",
      status: "PENDING",
      anchor: "ORDER",
      runAt: new Date(Date.now() - 60_000),
      idempotencyKey: `poll-e2e:${workflow.id}:${Date.now()}`,
    },
  });

  // ── 1. The tick builds the message ──────────────────────────────────────
  console.log("── tick: build the message ──");
  const stats = await processDueNonApiLabScheduledActions();
  check("the tick sent one message", stats.processed === 1, JSON.stringify(stats));

  const comm = await prisma.labCommunication.findFirst({
    where: { workflowId: workflow.id, type: "REMINDER" },
    orderBy: { createdAt: "desc" },
  });
  check("a REMINDER communication exists", !!comm);
  check("it records labId and orderId", comm?.labId === LAB_ID && comm?.orderId === workflow.orderId,
    `labId=${comm?.labId} orderId=${comm?.orderId}`);

  const outbound = comm?.waOutboundId
    ? await prisma.waOutbound.findUnique({ where: { id: comm.waOutboundId } })
    : null;
  check("an outbound row is queued", outbound?.status === "QUEUED", `got ${outbound?.status}`);
  check("addressed to the test group", outbound?.targetJid === JID, `got ${outbound?.targetJid}`);
  check("the body carries NO action URL", !/https?:\/\/|\{\{.*_url\}\}/.test(outbound?.text ?? ""),
    JSON.stringify((outbound?.text ?? "").slice(0, 60)));
  check("the outbound carries a poll", !!outbound?.pollName, `pollName=${outbound?.pollName}`);
  const opts = (outbound?.pollOptions ?? []) as Array<{ label: string; action: string }>;
  check("the poll offers the three actions",
    opts.map((o) => o.action).sort().join(",") === "ACCEPT,REJECT,RESCHEDULE",
    JSON.stringify(opts.map((o) => o.label)));

  // ── 2. The gateway sends it (fake transport) ────────────────────────────
  console.log("\n── gateway: drain with a fake transport ──");
  const { drainOutbound, recordPollVote } = await import("../whatsapp-bot/lib/controltower.mjs");

  const sentTexts: string[] = [];
  const sentPolls: Array<{ name: string; values: string[] }> = [];
  const fakeSend = async (_jid: string, text: string) => { sentTexts.push(text); return `FAKE_TXT_${Date.now()}`; };
  const fakeSendPoll = async (_jid: string, name: string, values: string[]) => {
    sentPolls.push({ name, values });
    return { key: { id: `FAKE_POLL_${Date.now()}`, remoteJid: JID }, message: { pollCreationMessage: { name } } };
  };

  const drained = await drainOutbound(fakeSend, { sendPoll: fakeSendPoll, limit: 10 });
  check("the drain sent it", drained.sent >= 1, JSON.stringify(drained));
  check("a poll went out alongside the text", sentPolls.length === 1, JSON.stringify(sentPolls));
  check("the poll shows the provider three options",
    sentPolls[0]?.values.length === 3, JSON.stringify(sentPolls[0]?.values));
  check("the signature is on the text", /Labstack Operations/.test(sentTexts[0] ?? ""));

  const poll = await prisma.waPoll.findFirst({ where: { outboundId: outbound!.id } });
  check("the gateway recorded the poll", !!poll, poll ? `status=${poll.status}` : "missing");
  check("the poll knows its workflow", poll?.workflowId === workflow.id, `got ${poll?.workflowId}`);

  // ── 3. The provider taps Accept ─────────────────────────────────────────
  console.log("\n── provider taps Accept ──");
  const saved = await recordPollVote(poll!.waMsgId, "ACCEPT", VOTER);
  check("the vote was recorded", !!saved);
  const voted = await prisma.waPoll.findUnique({ where: { waMsgId: poll!.waMsgId } });
  check("status is VOTED", voted?.status === "VOTED", `got ${voted?.status}`);
  check("ACCEPT does not ask for a reason", voted?.awaitingReason === false, `got ${voted?.awaitingReason}`);

  // ── 4. The tick applies it ──────────────────────────────────────────────
  console.log("\n── tick: apply the answer ──");
  const applied = await processPollVotes();
  check("one vote applied", applied.applied === 1, JSON.stringify(applied));

  const after = await prisma.labCommunicationWorkflow.findUnique({ where: { id: workflow.id } });
  check("workflow is LAB_ACCEPTED", after?.status === "LAB_ACCEPTED", `got ${after?.status}`);
  check("acceptedAt recorded", !!after?.acceptedAt);

  const stillPending = await prisma.labScheduledAction.count({
    where: { workflowId: workflow.id, status: { in: ["PENDING", "RUNNING"] } },
  });
  check("no rung is left to chase the provider", stillPending === 0, `${stillPending} still pending`);

  const commAfter = await prisma.labCommunication.findUnique({ where: { id: comm!.id } });
  check("the message is marked ACTION_TAKEN", commAfter?.status === "ACTION_TAKEN", `got ${commAfter?.status}`);

  // Leave the workflow result; clear only the simulated transport.
  await prisma.waPoll.delete({ where: { waMsgId: poll!.waMsgId } });
  await prisma.labScheduledAction.deleteMany({ where: { id: rung.id } });

  console.log(failed === 0 ? "\nAll checks passed ✔" : `\n${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
