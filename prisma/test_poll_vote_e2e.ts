/**
 * End-to-end test of the half of the poll feature that does not need WhatsApp.
 *
 *   wa_polls (VOTED)  ← what the gateway writes when it decrypts a vote
 *     → processPollVotes()        ← the real tick entry point
 *       → applyProviderAction()   ← the writer the token route also uses
 *         → workflow REJECTED, communications ACTION_TAKEN, rungs SUPPRESSED
 *   then a late reason arrives
 *     → processPollVotes()
 *       → attachProviderReason()  → workflow.rejectionReason
 *
 * Only the WhatsApp transport is simulated: the vote row is written exactly as
 * lib/controltower.mjs recordPollVote() writes it. Everything downstream is the
 * code that runs in production.
 *
 * NOTE: this CONSUMES one real open workflow — it genuinely rejects that order,
 * which is the only honest way to prove the path. Dummy data, but it is spent.
 *
 * Run: node node_modules/.bin/tsx prisma/test_poll_vote_e2e.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import { processPollVotes } from "../src/lib/non-api-labs/poll-votes";

const prisma = new PrismaClient();
const LAB_ID = 378;
const JID = "120363425636716175@g.us";
const VOTER = "919999999999@s.whatsapp.net";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};

async function main() {
  const workflow = await prisma.labCommunicationWorkflow.findFirst({
    where: { labId: LAB_ID, status: "WAITING_FOR_LAB_CONFIRMATION" },
    orderBy: { createdAt: "asc" },
  });
  if (!workflow) throw new Error("no open workflow to test with");
  console.log(`Using workflow ${workflow.id} (order ${workflow.orderId}), status ${workflow.status}\n`);

  const group = await prisma.waGroup.findUnique({ where: { jid: JID } });
  const waMsgId = `TEST_POLL_${Date.now()}`;

  // Stand in for the message the gateway sent.
  const outbound = await prisma.waOutbound.create({
    data: {
      targetJid: JID,
      text: "[test] confirmation request",
      groupId: group?.id ?? null,
      status: "SENT",
      sentWaMsgId: `TEST_TXT_${Date.now()}`,
      sentAt: new Date(),
    },
  });

  // A rung that should be killed by the answer.
  const rung = await prisma.labScheduledAction.create({
    data: {
      workflowId: workflow.id,
      type: "SEND_REMINDER",
      status: "PENDING",
      anchor: "ORDER",
      runAt: new Date(Date.now() + 60_000),
      idempotencyKey: `test-poll-rung:${waMsgId}`,
    },
  });

  // ── 1. The gateway decrypts a "Cannot fulfil" tap ──────────────────────
  // Written exactly as recordPollVote() does, including awaitingReason.
  await prisma.waPoll.create({
    data: {
      waMsgId,
      outboundId: outbound.id,
      workflowId: workflow.id,
      options: [
        { label: "Accept", action: "ACCEPT" },
        { label: "Reschedule", action: "RESCHEDULE" },
        { label: "Cannot fulfil", action: "REJECT" },
      ],
      messageJson: { note: "transport simulated" },
      status: "VOTED",
      votedAction: "REJECT",
      voterJid: VOTER,
      votedAt: new Date(),
      awaitingReason: true,
    },
  });

  console.log("── vote applied by the tick ──");
  const first = await processPollVotes();
  check("one vote applied", first.applied === 1, JSON.stringify(first));

  const afterVote = await prisma.labCommunicationWorkflow.findUnique({ where: { id: workflow.id } });
  check("workflow is LAB_REJECTED", afterVote?.status === "LAB_REJECTED", `got ${afterVote?.status}`);
  check("rejectedAt recorded", !!afterVote?.rejectedAt);
  // The tap carried no text, so nothing should have been invented here.
  check(
    "rejectionReason left empty for the follow-up",
    !afterVote?.rejectionReason,
    `got ${JSON.stringify(afterVote?.rejectionReason)}`,
  );

  const afterRung = await prisma.labScheduledAction.findUnique({ where: { id: rung.id } });
  check("pending rung suppressed — provider is not chased again", afterRung?.status === "SUPPRESSED", `got ${afterRung?.status}`);

  const polled = await prisma.waPoll.findUnique({ where: { waMsgId } });
  check("poll marked APPLIED", polled?.status === "APPLIED", `got ${polled?.status}`);

  const idempotent = await processPollVotes();
  check("re-running the tick does nothing", idempotent.applied === 0, JSON.stringify(idempotent));

  // ── 2. The provider replies with the reason ────────────────────────────
  console.log("\n── late reason attached ──");
  await prisma.waPoll.update({
    where: { waMsgId },
    data: { reason: "No phlebotomist available in that pincode", reasonAt: new Date(), awaitingReason: false },
  });

  const second = await processPollVotes();
  check("one reason attached", second.reasonsAttached === 1, JSON.stringify(second));

  const afterReason = await prisma.labCommunicationWorkflow.findUnique({ where: { id: workflow.id } });
  check(
    "rejectionReason now carries the provider's words",
    afterReason?.rejectionReason === "No phlebotomist available in that pincode",
    `got ${JSON.stringify(afterReason?.rejectionReason)}`,
  );

  const again = await processPollVotes();
  check("reason is not re-attached every tick", again.reasonsAttached === 0, JSON.stringify(again));

  const events = await prisma.labCommunicationOrderEvent.findMany({
    where: { workflowId: workflow.id },
    orderBy: { occurredAt: "desc" },
    take: 2,
  });
  check("an audit trail exists for the lab's answer", events.some((e) => e.type === "LAB_REJECTED"));

  // Clean up only the simulated transport; the workflow change is the result.
  await prisma.waPoll.delete({ where: { waMsgId } });
  await prisma.labScheduledAction.delete({ where: { id: rung.id } });
  await prisma.waOutbound.delete({ where: { id: outbound.id } });

  console.log(failed === 0 ? "\nAll checks passed ✔" : `\n${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
