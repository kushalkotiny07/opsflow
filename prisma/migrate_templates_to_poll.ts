/**
 * Move stored message templates off action links and onto the poll.
 *
 * Changing the DEFAULT_* bodies in lib/non-api-labs/templates.ts only affects
 * templates created from here on: ensureTemplate() seeds a row once and Ops can
 * edit it afterwards, so live rows keep whatever body they already had. This
 * rewrites those rows.
 *
 * It strips the {{accept_url}}/{{reschedule_url}}/{{reject_url}} LINES rather
 * than replacing the whole body, so any wording Ops has customised survives.
 *
 * Run with --apply to write; without it, prints the diff and changes nothing.
 *   node node_modules/.bin/tsx prisma/migrate_templates_to_poll.ts
 *   node node_modules/.bin/tsx prisma/migrate_templates_to_poll.ts --apply
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const URL_LINE = /^.*\{\{(accept_url|reschedule_url|reject_url)\}\}.*$/gm;
const POLL_LINE = "Tap an option in the poll below to respond.";

function rewrite(body: string): string {
  const stripped = body
    .replace(URL_LINE, "")
    .replace(/\n{3,}/g, "\n\n") // the removed lines leave a gap
    .trimEnd();
  return stripped.includes(POLL_LINE) ? stripped : `${stripped}\n\n${POLL_LINE}`;
}

async function main() {
  const rows = await prisma.labCommunicationTemplate.findMany({ select: { id: true, key: true, body: true } });
  const affected = rows.filter((r) => /\{\{(accept_url|reschedule_url|reject_url)\}\}/.test(r.body));

  if (affected.length === 0) {
    console.log("Nothing to do — no stored template references an action URL.");
    return;
  }

  for (const row of affected) {
    const next = rewrite(row.body);
    console.log(`\n=== ${row.key} ===`);
    console.log("--- before ---");
    console.log(row.body);
    console.log("--- after ----");
    console.log(next);
    if (APPLY) {
      await prisma.labCommunicationTemplate.update({ where: { id: row.id }, data: { body: next } });
    }
  }

  console.log(
    APPLY
      ? `\nRewrote ${affected.length} template(s).`
      : `\n${affected.length} template(s) would change. Re-run with --apply to write.`,
  );
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
