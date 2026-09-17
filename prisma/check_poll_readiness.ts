/**
 * Preflight for the poll + confirmation-ladder path.
 *
 * Walks the chain in the order it actually runs and reports FAIL (it will not
 * work), WARN (it will work but surprise you) or OK. Read-only.
 *
 * Run: node node_modules/.bin/tsx prisma/check_poll_readiness.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const JID = "120363425636716175@g.us";
const LAB_ID = 378;

let fails = 0;
let warns = 0;
const ok = (m: string, d = "") => console.log(`  OK    ${m}${d ? `  — ${d}` : ""}`);
const warn = (m: string, d = "") => { warns++; console.log(`  WARN  ${m}${d ? `  — ${d}` : ""}`); };
const fail = (m: string, d = "") => { fails++; console.log(`  FAIL  ${m}${d ? `  — ${d}` : ""}`); };

async function main() {
  console.log("── 1. gateway ──");
  const gw = await prisma.waGateway.findUnique({ where: { id: "default" } });
  const hbAge = gw?.lastSeenAt ? (Date.now() - gw.lastSeenAt.getTime()) / 1000 : Infinity;
  if (!gw) fail("no gateway row");
  else {
    // A negative age is not "fresh" — it means the gateway wrote a timestamp
    // ahead of our clock, which is the pre-UTC-fix build still running.
    if (hbAge >= 0 && hbAge < 60) ok("gateway heartbeat is live", `${Math.round(hbAge)}s ago`);
    else if (hbAge < 0) fail("heartbeat is in the FUTURE", `${Math.round(-hbAge)}s ahead — gateway is running pre-UTC-fix code, restart it`);
    else fail("gateway is not running", `last heartbeat ${Math.round(hbAge)}s ago — nothing will send`);
    if (gw.dryRun === false) ok("DRY_RUN is off");
    else warn("DRY_RUN is on", "messages queue but never leave the machine");
  }

  console.log("\n── 2. target group ──");
  const group = await prisma.waGroup.findUnique({ where: { jid: JID } });
  if (!group) fail("target group not found");
  else {
    group.sendEnabled ? ok(`"${group.subject}" is send-enabled`) : fail("group is NOT send-enabled", "every message will be marked FAILED");
    group.active ? ok("group is active (inbound is ingested)") : warn("group is inactive", "poll follow-up replies will be ignored");
  }

  console.log("\n── 3. lab config ──");
  const cfg = await prisma.nonApiLabConfig.findUnique({ where: { labId: LAB_ID } });
  if (!cfg) fail(`no config for lab ${LAB_ID}`);
  else {
    cfg.isActive ? ok(`${cfg.labName} is active`) : fail("lab is paused", "the tick skips it entirely");
    cfg.waGroupJid === JID ? ok("routed to the test group") : fail("routed elsewhere", `${cfg.waGroupJid}`);
    if (cfg.integrationType === "NON_API") ok("NON_API — runs the confirmation ladder");
    else warn(`integrationType is ${cfg.integrationType}`, "API labs get breach alerts only, no ladder/poll");

    const { confirmationSlaMinutes: c, reminderSlaMinutes: r, escalationSlaMinutes: e, quietWindowMinutes: q } = cfg;
    if (c < r && r < e) ok("SLA rungs are ordered", `${c} / ${r} / ${e} min`);
    else fail("SLA rungs are out of order", `${c} / ${r} / ${e}`);

    // The one that silently stalls everything.
    if (q >= r - c || q >= e - r) {
      fail(
        "quiet window swallows the ladder",
        `quiet=${q}m but rungs are ${c}m apart. arbitrate() DEFERS any routine rung sent within the quiet window, ` +
        `so the reminder and escalation will not fire on your compressed timers. Set quiet window to 0 for testing.`,
      );
    } else ok("quiet window leaves room between rungs", `quiet=${q}m`);
  }

  console.log("\n── 4. templates ──");
  const templates = await prisma.labCommunicationTemplate.findMany({ select: { key: true, body: true, isActive: true } });
  const withUrl = templates.filter((t) => /\{\{(accept_url|reschedule_url|reject_url)\}\}/.test(t.body));
  withUrl.length === 0 ? ok("no template contains an action URL") : fail("templates still carry URLs", withUrl.map((t) => t.key).join(", "));
  const reminder = templates.find((t) => t.key === "NON_API_REMINDER");
  if (!reminder) warn("NON_API_REMINDER not seeded yet", "created on first use");
  else reminder.isActive ? ok("NON_API_REMINDER is active") : fail("NON_API_REMINDER is paused", "sendForAction will suppress");

  console.log("\n── 5. work for the ladder to do ──");
  const open = await prisma.labCommunicationWorkflow.count({
    where: { labId: LAB_ID, status: "WAITING_FOR_LAB_CONFIRMATION" },
  });
  open > 0 ? ok(`${open} open workflow(s)`) : warn("no open workflows", "nothing to remind about — trigger one or wait for a new order");
  const due = await prisma.labScheduledAction.count({ where: { status: "PENDING", runAt: { lte: new Date() } } });
  due > 0 ? ok(`${due} rung(s) due now`) : warn("no due rungs", "the tick will have nothing to send");

  console.log("\n── 6. queue and polls ──");
  const queued = await prisma.waOutbound.count({ where: { status: "QUEUED" } });
  queued === 0 ? ok("outbound queue is empty") : warn(`${queued} message(s) queued`, "will flush the moment the gateway starts");
  const polls = await prisma.waPoll.groupBy({ by: ["status"], _count: true }).catch(() => []);
  if (polls.length === 0) console.log("  INFO  no polls sent yet");
  else for (const p of polls) console.log(`  INFO  wa_polls ${p.status}: ${p._count}`);

  console.log(
    fails === 0 && warns === 0 ? "\nReady ✔"
      : fails === 0 ? `\nReady with ${warns} warning(s)`
      : `\n${fails} blocker(s), ${warns} warning(s) — fix the FAILs first`,
  );
}

main()
  .catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
