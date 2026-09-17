/**
 * Regression: a message the gateway abandoned mid-send must come back.
 *
 * drainOutbound marks a row SENDING before handing it to WhatsApp. If the
 * process dies in that window the row stays SENDING forever, because the drain
 * only ever selects QUEUED — nothing retries it and nothing reports it. One
 * real message sat unsent for 23 hours before an audit noticed.
 *
 * Exercises the real reclaimStalledSends() against the real database. Creates
 * its own rows, never touches anything else, and cleans up.
 *
 * Run: node node_modules/.bin/tsx prisma/test_stalled_send_recovery.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

process.env.TASKOS_DATABASE_URL = process.env.TASKOS_DATABASE_URL || process.env.DATABASE_URL;

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const MARKER = "[stalled-send-test]";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};

async function cleanup() {
  await prisma.waOutbound.deleteMany({ where: { text: { contains: MARKER } } });
}

/** A SENDING row, aged by writing createdAt into the past. */
async function stalledRow(minutesAgo: number, attempts: number) {
  const row = await prisma.waOutbound.create({
    data: {
      targetJid: "000000000000@s.whatsapp.net",
      text: `${MARKER} abandoned ${minutesAgo}m ago`,
      status: "SENDING",
      attempts,
    },
  });
  await prisma.waOutbound.update({
    where: { id: row.id },
    data: { createdAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
  return row.id;
}

async function main() {
  await cleanup();
  const { reclaimStalledSends } = await import("../whatsapp-bot/lib/controltower.mjs");

  const stale = await stalledRow(30, 1);        // dropped long ago, retryable
  const fresh = await stalledRow(1, 1);         // may genuinely be in flight
  const exhausted = await stalledRow(30, 5);    // has failed too many times

  await reclaimStalledSends({ olderThanMinutes: 5, maxAttempts: 5 });

  const after = async (id: string) => (await prisma.waOutbound.findUnique({ where: { id } }))?.status;

  check("a long-abandoned send is requeued", await after(stale) === "QUEUED", `got ${await after(stale)}`);
  // The important half: a send that started seconds ago is probably still
  // running, and yanking it back would send the same message twice.
  check("a send that may still be in flight is left alone", await after(fresh) === "SENDING", `got ${await after(fresh)}`);
  check("a send that has exhausted its attempts fails instead of looping", await after(exhausted) === "FAILED", `got ${await after(exhausted)}`);

  const exhaustedRow = await prisma.waOutbound.findUnique({ where: { id: exhausted } });
  check("the failure says why", /abandoned mid-send/.test(exhaustedRow?.error ?? ""), exhaustedRow?.error ?? "no error recorded");

  // Running twice must not undo the first pass or double-count.
  const again = await reclaimStalledSends({ olderThanMinutes: 5, maxAttempts: 5 });
  check("a second pass finds nothing left", again === 0, `reclaimed ${again}`);

  await cleanup();
  console.log(failed === 0 ? "\nAll checks passed ✔" : `\n${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch(async (e) => { console.error("FAILED:", e instanceof Error ? e.message : e); await cleanup().catch(() => {}); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
