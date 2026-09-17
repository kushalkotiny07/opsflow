/**
 * Does a poll tap get answered?
 *
 *   wa_polls VOTED  ->  processPollVotes()  ->  workflow updated
 *                                           ->  a reply QUEUED to the group
 *
 * Asserts the reply exists, is addressed to the right group, and — for ACCEPT —
 * actually repeats the order back. That last point is the whole reason the
 * ACCEPT template is not just "confirmed": the provider tapped a button on a
 * message that may be far up their chat, so a bare acknowledgement leaves them
 * unsure which order they just committed to.
 *
 * Uses its own throwaway order so it never disturbs a live poll waiting to be
 * tapped. Cleans up after itself.
 *
 * Run: node node_modules/.bin/tsx prisma/test_poll_acknowledgement.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient, type LabProviderActionType } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";
import { processPollVotes } from "../src/lib/non-api-labs/poll-votes";
import { resolvePoll, ORDER_CONFIRMATION_POLL } from "../src/lib/non-api-labs/poll-definitions";

const prisma = new PrismaClient();
const LAB_ID = 378;
const JID = "120363425636716175@g.us";
const ORDER_ID = 999303;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};

async function cleanup() {
  const wf = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: ORDER_ID } });
  if (wf) {
    await prisma.waPoll.deleteMany({ where: { workflowId: wf.id } });
    await prisma.labCommunication.deleteMany({ where: { workflowId: wf.id } });
    await prisma.labScheduledAction.deleteMany({ where: { workflowId: wf.id } });
    await prisma.labCommunicationWorkflow.delete({ where: { id: wf.id } });
  }
  await prisma.waOutbound.deleteMany({ where: { text: { contains: String(ORDER_ID) } } });
  await labstackWorkerQuery(`DELETE FROM public."Order" WHERE id = $1`, [ORDER_ID]);
}

/** Vote on a fresh throwaway workflow and return the reply that was queued. */
async function voteAndCollect(action: LabProviderActionType) {
  await cleanup();
  const appointment = new Date(Date.now() + 3 * 60 * 60 * 1000);
  await labstackWorkerQuery(
    `INSERT INTO public."Order"
     SELECT * FROM jsonb_populate_record(NULL::public."Order",
       to_jsonb((SELECT o FROM public."Order" o WHERE o."labId" = $1 AND o."orderType" = 'HOME_SAMPLE' LIMIT 1))
       || jsonb_build_object('id', $2::int, 'orderStatus', 'ORDER_SCHEDULED',
            'appointmentTime', $3::text, 'createdAt', now()::text,
            'updatedAt', now()::text, 'statusUpdatedAt', now()::text))
     ON CONFLICT (id) DO NOTHING`,
    [LAB_ID, ORDER_ID, appointment.toISOString()],
  );

  const now = new Date();
  const wf = await prisma.labCommunicationWorkflow.create({
    data: {
      orderId: ORDER_ID, labId: LAB_ID, status: "WAITING_FOR_LAB_CONFIRMATION",
      appointmentTime: appointment,
      orderSnapshot: { patientName: "Ack Test Patient", location: "Indiranagar, Bengaluru", tests: "CBC, Lipid Profile" },
      confirmationDeadline: new Date(now.getTime() + 60_000),
      reminderDeadline: new Date(now.getTime() + 120_000),
      escalationDeadline: new Date(now.getTime() + 300_000),
    },
  });

  await prisma.waPoll.create({
    data: {
      waMsgId: `ACK_TEST_${action}_${Date.now()}`,
      workflowId: wf.id,
      options: (await resolvePoll(ORDER_CONFIRMATION_POLL))!.options,
      votedLabel: (await resolvePoll(ORDER_CONFIRMATION_POLL))!.options.find((o) => o.action === action)!.label,
      messageJson: { note: "transport simulated" },
      status: "VOTED",
      votedAction: action,
      voterJid: "917000000000@s.whatsapp.net",
      votedAt: new Date(),
      awaitingReason: action !== "ACCEPT",
    },
  });

  const before = new Date();
  await processPollVotes();
  const reply = await prisma.waOutbound.findFirst({
    where: { createdAt: { gte: before }, text: { contains: String(ORDER_ID) } },
    orderBy: { createdAt: "desc" },
  });
  return { workflowId: wf.id, reply };
}

async function main() {
  console.log("── ACCEPT ──");
  const accept = await voteAndCollect("ACCEPT");
  check("a reply was queued", !!accept.reply);
  check("addressed to the test group", accept.reply?.targetJid === JID, accept.reply?.targetJid ?? "");
  check("confirms the order", /confirmed/i.test(accept.reply?.text ?? ""));
  check("repeats the order id", (accept.reply?.text ?? "").includes(String(ORDER_ID)));
  check("repeats the patient", (accept.reply?.text ?? "").includes("Ack Test Patient"));
  check("repeats the appointment", /Appointment:/.test(accept.reply?.text ?? ""));
  check("carries no poll (it is not asking anything)", !accept.reply?.pollName, accept.reply?.pollName ?? "none");
  console.log("\n" + (accept.reply?.text ?? "(nothing)") + "\n");

  for (const action of ["RESCHEDULE", "REJECT"] as const) {
    console.log(`── ${action} ──`);
    const result = await voteAndCollect(action);
    check("a reply was queued", !!result.reply);
    check("asks them to write back", /repl(y|ies)|write/i.test(result.reply?.text ?? ""));
    check("names the order", (result.reply?.text ?? "").includes(String(ORDER_ID)));
    console.log("\n" + (result.reply?.text ?? "(nothing)") + "\n");
  }

  await cleanup();
  console.log(failed === 0 ? "All checks passed ✔" : `${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch(async (e) => { console.error("FAILED:", e instanceof Error ? e.message : e); await cleanup().catch(() => {}); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
