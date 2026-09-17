/**
 * Read-only check: did the manual reminder actually reach WhatsApp?
 *
 * Walks the same chain the tick does, in order, so a failure points at the
 * exact hop that broke:
 *   lab_scheduled_actions → lab_communications → wa_outbound → sentWaMsgId
 *
 * Run: node node_modules/.bin/tsx prisma/verify_achievers_reminder.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const LAB_ID = 378;

async function main() {
  const since = new Date(Date.now() - 30 * 60_000);

  const actions = await prisma.labScheduledAction.findMany({
    where: { rungKey: "manual-test" },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  console.log("── scheduled actions (manual-test) ──");
  for (const a of actions) {
    console.log(`  ${a.status.padEnd(10)} attempts=${a.attempts} runAt=${a.runAt.toISOString()}`);
    if (a.lastError) console.log(`     lastError: ${a.lastError}`);
  }
  if (actions.length === 0) console.log("  (none)");

  const comms = await prisma.labCommunication.findMany({
    where: { labId: LAB_ID, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log("\n── lab_communications (last 30 min) ──");
  for (const c of comms) {
    console.log(`  ${c.type} ${c.status} → ${c.recipient}  waOutboundId=${c.waOutboundId ?? "null"}`);
  }
  if (comms.length === 0) console.log("  (none)");

  const outbound = await prisma.waOutbound.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log("\n── wa_outbound (last 30 min) ──");
  for (const o of outbound) {
    console.log(`  ${o.status.padEnd(7)} → ${o.targetJid}`);
    console.log(`     sentWaMsgId=${o.sentWaMsgId ?? "null"} attempts=${o.attempts}`);
    if (o.error) console.log(`     error: ${o.error}`);
    console.log(`     text: ${JSON.stringify((o.text || "").slice(0, 90))}`);
  }
  if (outbound.length === 0) console.log("  (none)");

  const gw = await prisma.waGateway.findUnique({ where: { id: "default" } });
  const age = gw?.lastSeenAt ? Math.round((Date.now() - gw.lastSeenAt.getTime()) / 1000) : null;
  console.log(`\ngateway: ${gw?.status} dryRun=${gw?.dryRun} heartbeat=${age}s ago`);

  const delivered = outbound.find((o) => o.status === "SENT" && o.sentWaMsgId);
  console.log(delivered ? "\nRESULT: delivered to WhatsApp ✔" : "\nRESULT: not delivered yet");
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
