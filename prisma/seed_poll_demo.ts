/**
 * Dummy data for demonstrating the WhatsApp poll end to end.
 *
 * Creates ONE realistic Servocure order and puts a confirmation request for it
 * in front of the gateway, so the test group receives a message that reads like
 * a real one — patient, appointment, tests — followed by the Accept /
 * Reschedule / Cannot fulfil poll.
 *
 * Everything lives in the 9993xx id range and `npm run demo:poll -- --clean`
 * removes it, so the demo never leaves debris in the order board.
 *
 * Safe to run with the gateway down: the message queues and is delivered the
 * moment WhatsApp links. Nothing here sends anything itself.
 *
 *   node node_modules/.bin/tsx prisma/seed_poll_demo.ts
 *   node node_modules/.bin/tsx prisma/seed_poll_demo.ts --clean
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";

const prisma = new PrismaClient();

const LAB_ID = 378;                      // Servocure — routed to the test group
const ORDER_ID = 999301;                 // demo range, cleaned up by --clean
const EXPECTED_JID = "120363425636716175@g.us";
const CLEAN = process.argv.includes("--clean");

async function clean() {
  const workflow = await prisma.labCommunicationWorkflow.findUnique({ where: { orderId: ORDER_ID } });
  if (workflow) {
    // Children first; the workflow cascades some but not all of these.
    await prisma.waPoll.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labCommunication.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labScheduledAction.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.labCommunicationWorkflow.delete({ where: { id: workflow.id } });
  }
  await prisma.waOutbound.deleteMany({ where: { text: { contains: String(ORDER_ID) } } });
  await labstackWorkerQuery(`DELETE FROM public."Order" WHERE id = $1`, [ORDER_ID]);
  console.log(`Removed demo order ${ORDER_ID} and everything it created.`);
}

async function main() {
  if (CLEAN) return clean();

  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: LAB_ID } });
  if (!config) throw new Error(`Lab ${LAB_ID} has no provider configuration`);
  if (config.waGroupJid !== EXPECTED_JID) {
    throw new Error(`Refusing to run: lab ${LAB_ID} points at ${config.waGroupJid}, not the test group.`);
  }
  const group = await prisma.waGroup.findUnique({ where: { jid: EXPECTED_JID } });
  if (!group?.sendEnabled) throw new Error("The test group is not send-enabled — nothing would leave the queue.");

  await clean(); // idempotent: re-running gives a fresh demo, not a duplicate

  // A real order, so the message reads like production rather than a fixture.
  // Cloned from an existing Servocure row to inherit every NOT NULL column,
  // then overridden with the fields the message actually shows.
  const appointment = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3h out
  await labstackWorkerQuery(
    `INSERT INTO public."Order"
     SELECT * FROM jsonb_populate_record(
       NULL::public."Order",
       to_jsonb((SELECT o FROM public."Order" o WHERE o."labId" = $1 AND o."orderType" = 'HOME_SAMPLE' LIMIT 1))
       || jsonb_build_object(
            'id', $2::int,
            'orderStatus', 'ORDER_SCHEDULED',
            'appointmentTime', $3::text,
            'createdAt', now()::text,
            'updatedAt', now()::text,
            'statusUpdatedAt', now()::text
          )
     )
     ON CONFLICT (id) DO NOTHING`,
    [LAB_ID, ORDER_ID, appointment.toISOString()],
  );

  const created = await labstackWorkerQuery<{ id: number; orderStatus: string; appointmentTime: Date }>(
    `SELECT id, "orderStatus", "appointmentTime" FROM public."Order" WHERE id = $1`, [ORDER_ID],
  );
  if (created.length === 0) throw new Error("Could not create the demo order — is there a Servocure HOME_SAMPLE order to clone?");
  console.log(`Demo order ${ORDER_ID} created — ${created[0].orderStatus}, appointment ${created[0].appointmentTime.toISOString()}`);

  // The workflow the ladder hangs off. Snapshot fields are what the template
  // renders, so they are filled in deliberately rather than left blank.
  const now = new Date();
  const workflow = await prisma.labCommunicationWorkflow.create({
    data: {
      orderId: ORDER_ID,
      labId: LAB_ID,
      status: "WAITING_FOR_LAB_CONFIRMATION",
      sourceOrderStatus: "ORDER_SCHEDULED",
      appointmentTime: created[0].appointmentTime,
      orderSnapshot: {
        patientName: "Demo Patient (poll test)",
        location: "HSR Layout, Bengaluru",
        tests: "CBC, Vitamin D, Thyroid Profile",
      },
      confirmationDeadline: new Date(now.getTime() + config.confirmationSlaMinutes * 60_000),
      reminderDeadline: new Date(now.getTime() + config.reminderSlaMinutes * 60_000),
      escalationDeadline: new Date(now.getTime() + config.escalationSlaMinutes * 60_000),
    },
  });

  // One overdue rung, so the next tick sends rather than waiting out the clock.
  await prisma.labScheduledAction.create({
    data: {
      workflowId: workflow.id,
      type: "SEND_REMINDER",
      status: "PENDING",
      anchor: "ORDER",
      runAt: new Date(Date.now() - 60_000),
      idempotencyKey: `poll-demo:${workflow.id}:${Date.now()}`,
    },
  });

  console.log(`Workflow ${workflow.id} created with an overdue rung.

Within ~60s the tick builds the message and queues it with a poll.
The gateway sends it as soon as WhatsApp is linked.

Watch it:   node node_modules/.bin/tsx prisma/verify_achievers_reminder.ts
Clean up:   node node_modules/.bin/tsx prisma/seed_poll_demo.ts --clean`);
}

main()
  .catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
