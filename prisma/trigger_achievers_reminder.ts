/**
 * Manual trigger: make the non-API lab ladder send ONE real reminder now.
 *
 * Why this exists: the Servocure (lab 378) workflows were created on Sept 9 and
 * every scheduled rung was consumed back then, so `processDueNonApiLabScheduledActions()`
 * has nothing due and the group stays silent. On top of that the workflow still
 * holds the appointment time it saw on Sept 9 while LabStack has since moved it,
 * so `classifySourceOrder()` returns RESCHEDULE and the tick recomputes instead
 * of sending.
 *
 * This script fixes both, for ONE workflow whose order is still open upstream:
 *   1. re-sync workflow.appointmentTime to what LabStack currently says
 *      → classifySourceOrder() now returns SEND
 *   2. insert one overdue PENDING SEND_REMINDER rung
 *      → the every-minute tick picks it up and sends for real
 *
 * Nothing about the transport is faked. The message is addressed by
 * resolveLabTarget(config), i.e. NonApiLabConfig.waGroupJid — which is why the
 * script refuses to run unless that resolves to the expected test group.
 *
 * Run: node node_modules/.bin/tsx prisma/trigger_achievers_reminder.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";

const prisma = new PrismaClient();

const LAB_ID = 378;
// Refuse to fire at anything but the agreed test group.
const EXPECTED_GROUP_JID = "120363425636716175@g.us";

// LabStack statuses that mean the tick would close the workflow instead of sending.
const DEAD = new Set(["CANCELED", "REPORT_DELIVERED", "PATIENT_MISSED"]);

async function main() {
  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: LAB_ID } });
  if (!config) throw new Error(`No NonApiLabConfig for lab ${LAB_ID}`);

  console.log(`lab ${LAB_ID} — ${config.labName}`);
  console.log(`  target group : ${config.waGroupJid}`);
  console.log(`  active       : ${config.isActive}`);
  console.log(`  quiet window : ${config.quietWindowMinutes} min`);

  if (config.waGroupJid !== EXPECTED_GROUP_JID) {
    throw new Error(
      `Refusing to run: lab ${LAB_ID} points at ${config.waGroupJid}, not the test group ${EXPECTED_GROUP_JID}.`,
    );
  }
  if (!config.isActive) throw new Error(`Refusing to run: lab ${LAB_ID} is paused.`);

  // The group must also be send-enabled or drainOutbound() will just mark the
  // row FAILED — the guard that saved us from the stale backlog earlier.
  const group = await prisma.waGroup.findUnique({ where: { jid: EXPECTED_GROUP_JID } });
  if (!group?.sendEnabled) {
    throw new Error(`Refusing to run: group ${EXPECTED_GROUP_JID} is not send-enabled.`);
  }
  console.log(`  wa_group     : "${group.subject}" sendEnabled=${group.sendEnabled}`);

  const workflows = await prisma.labCommunicationWorkflow.findMany({
    where: { labId: LAB_ID, status: "WAITING_FOR_LAB_CONFIRMATION" },
  });
  if (workflows.length === 0) throw new Error("No open workflows for this lab.");

  // Pick a workflow whose order is still live upstream; anything else would be
  // closed by the tick rather than sent.
  const rows = await labstackWorkerQuery<{ id: number; orderStatus: string; appointmentTime: Date | null }>(
    `SELECT id, "orderStatus", "appointmentTime" FROM public."Order" WHERE id = ANY($1::int[])`,
    [workflows.map((w) => w.orderId)],
  );
  const sourceById = new Map(rows.map((r) => [r.id, r]));

  const target = workflows.find((w) => {
    const src = sourceById.get(w.orderId);
    return src && !DEAD.has(src.orderStatus);
  });
  if (!target) throw new Error("Every open workflow's order is closed upstream — nothing safe to send.");

  const src = sourceById.get(target.orderId)!;
  console.log(`\nworkflow ${target.id} (order ${target.orderId}, upstream ${src.orderStatus})`);
  console.log(`  workflow appointment : ${target.appointmentTime?.toISOString() ?? "null"}`);
  console.log(`  labstack appointment : ${src.appointmentTime?.toISOString() ?? "null"}`);

  // 1. Re-sync so classifySourceOrder() returns SEND rather than RESCHEDULE.
  if (target.appointmentTime?.getTime() !== src.appointmentTime?.getTime()) {
    await prisma.labCommunicationWorkflow.update({
      where: { id: target.id },
      data: { appointmentTime: src.appointmentTime },
    });
    console.log("  ✔ appointment re-synced → verdict will be SEND");
  } else {
    console.log("  · appointment already in sync");
  }

  // 2. One overdue rung for the tick to pick up.
  const runAt = new Date(Date.now() - 60_000);
  const action = await prisma.labScheduledAction.create({
    data: {
      workflowId: target.id,
      type: "SEND_REMINDER",
      status: "PENDING",
      anchor: "ORDER",
      offsetMinutes: 0,
      priority: 4,
      rungKey: "manual-test",
      runAt,
      idempotencyKey: `manual-test:${target.id}:${Date.now()}`,
    },
  });
  console.log(`  ✔ scheduled action ${action.id} PENDING, runAt ${runAt.toISOString()} (overdue)`);

  console.log("\nThe tick runs every minute. Expect within ~60s:");
  console.log("  lab_communications  REMINDER → wa_outbound QUEUED → gateway → the group.");
}

main()
  .catch((e) => {
    console.error("\nFAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
