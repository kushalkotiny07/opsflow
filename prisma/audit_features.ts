/**
 * Feature audit — one pass over everything built in this cycle.
 *
 * Read-only. Sends nothing, changes nothing, and is safe to run at any time,
 * including while the gateway is live. Where a property cannot be proven
 * without sending a real message it says so rather than asserting a proxy.
 *
 * Run: node node_modules/.bin/tsx prisma/audit_features.ts
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";
import { resolvePoll, parsePollOptions, ORDER_CONFIRMATION_POLL, SLA_BREACH_POLL } from "../src/lib/non-api-labs/poll-definitions";
import { suggestGroup } from "../src/lib/non-api-labs/group-match";
import { PROVIDER_POLL_OPTIONS } from "../src/lib/non-api-labs/poll-config";

const prisma = new PrismaClient();
const JID = "120363425636716175@g.us";
const LAB_ID = 378;

const issues: string[] = [];
let checks = 0;
const ok = (m: string, d = "") => { checks++; console.log(`  PASS  ${m}${d ? `  — ${d}` : ""}`); };
const bad = (m: string, d = "") => { checks++; issues.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ISSUE ${m}${d ? `  — ${d}` : ""}`); };
const note = (m: string) => console.log(`  note  ${m}`);

async function main() {
  console.log("── 1. editable polls ──");
  for (const key of [ORDER_CONFIRMATION_POLL, SLA_BREACH_POLL]) {
    const poll = await resolvePoll(key);
    if (!poll) { bad(`${key} does not resolve`, "no poll would be attached"); continue; }
    poll.options.length >= 2
      ? ok(`${key} resolves`, `${poll.options.length} options`)
      : bad(`${key} has too few options`, "WhatsApp cannot render it");

    const labels = poll.options.map((o) => o.label.toLowerCase());
    new Set(labels).size === labels.length
      ? ok(`${key} labels are unique`)
      : bad(`${key} has duplicate labels`, "a vote could not be matched back");

    const noAck = poll.options.filter((o) => !o.ack?.trim()).map((o) => o.label);
    noAck.length === 0
      ? ok(`${key} every option replies`)
      : note(`${key}: silent options — ${noAck.join(", ")} (allowed, but the provider hears nothing)`);

    const longLabels = poll.options.filter((o) => o.label.length > 24).map((o) => o.label);
    if (longLabels.length) note(`${key}: long labels may truncate on a phone — ${longLabels.join(", ")}`);
  }

  console.log("\n── 2. poll definitions are stored, not hardcoded ──");
  const definitions = await prisma.waPollDefinition.findMany();
  definitions.length >= 2 ? ok("definitions persisted", definitions.map((d) => d.key).join(", ")) : bad("definitions missing", "engine would fall back to seeds every send");
  for (const d of definitions) {
    parsePollOptions(d.options).length === (d.options as unknown[]).length
      ? ok(`${d.key} options all parse`)
      : bad(`${d.key} has options the parser rejects`, "they would be silently dropped when sending");
  }

  console.log("\n── 3. acknowledgement wiring ──");
  const confirmation = await resolvePoll(ORDER_CONFIRMATION_POLL);
  const accept = confirmation?.options.find((o) => o.action === "ACCEPT");
  accept ? ok("an ACCEPT option exists") : bad("no ACCEPT option", "the ladder cannot be answered positively");
  accept && /\{\{order_id\}\}/.test(accept.ack)
    ? ok("ACCEPT reply repeats the order id")
    : bad("ACCEPT reply does not name the order", "provider cannot tell which order they confirmed");
  const breach = await resolvePoll(SLA_BREACH_POLL);
  const informational = breach?.options.filter((o) => o.action === null) ?? [];
  informational.length > 0
    ? ok("SLA breach has informational options", `${informational.length} record-only answers`)
    : note("SLA breach has no informational options — every answer moves the order");

  console.log("\n── 4. sent polls keep their own copy ──");
  const recent = await prisma.waPoll.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  if (recent.length === 0) note("no polls sent yet");
  for (const poll of recent.slice(0, 3)) {
    const opts = parsePollOptions(poll.options);
    opts.length >= 2
      ? ok(`poll ${poll.waMsgId.slice(0, 10)} carries its options`, `${poll.status}`)
      : bad(`poll ${poll.waMsgId.slice(0, 10)} has no usable options`, "its vote could not be answered");
    if (poll.status === "APPLIED" && poll.votedLabel === null && poll.votedAction !== null) {
      note(`poll ${poll.waMsgId.slice(0, 10)} predates votedLabel — its reply resolved by action instead`);
    }
  }

  console.log("\n── 5. lab catalogue ──");
  const sourceLabs = await labstackWorkerQuery<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public."Lab"`);
  const configs = await prisma.nonApiLabConfig.count();
  ok("LabStack reachable", `${sourceLabs[0].n} labs, ${configs} configured`);
  const groups = await prisma.waGroup.findMany({ select: { jid: true, subject: true } });
  const configured = await prisma.nonApiLabConfig.findMany({ select: { labId: true, labName: true, waGroupJid: true, isActive: true } });
  const known = new Set(groups.map((g) => g.jid));
  for (const config of configured) {
    if (config.waGroupJid && !known.has(config.waGroupJid)) {
      bad(`lab ${config.labId} (${config.labName}) points at an unknown group`, `${config.waGroupJid} — messages cannot be delivered`);
    }
  }
  const unrouted = configured.filter((c) => c.isActive && !c.waGroupJid);
  unrouted.length === 0 ? ok("every active lab has a target") : bad(`${unrouted.length} active lab(s) have no WhatsApp target`, unrouted.map((c) => c.labName).join(", "));

  console.log("\n── 6. group matching ──");
  const hyd = suggestGroup("Orange Health - Hyderabad", groups);
  hyd === null ? ok("refuses a sibling lab's group") : bad("suggests a sibling lab's group", `would route Hyderabad to "${hyd.group.subject}"`);

  console.log("\n── 7. message content ──");
  const templates = await prisma.labCommunicationTemplate.findMany({ select: { key: true, body: true, isActive: true } });
  const withUrl = templates.filter((t) => /\{\{(accept|reschedule|reject)_url\}\}|https?:\/\//.test(t.body));
  withUrl.length === 0 ? ok("no template contains an action URL") : bad("templates still contain URLs", withUrl.map((t) => t.key).join(", "));
  const paused = templates.filter((t) => !t.isActive).map((t) => t.key);
  if (paused.length) note(`paused templates (will not send): ${paused.join(", ")}`);

  console.log("\n── 8. gateway ──");
  const gw = await prisma.waGateway.findUnique({ where: { id: "default" } });
  const hb = gw?.lastSeenAt ? (Date.now() - gw.lastSeenAt.getTime()) / 1000 : Infinity;
  if (hb < 0) bad("gateway heartbeat is in the future", "it is running a pre-UTC-fix build");
  else if (hb < 60) ok("gateway is live", `heartbeat ${Math.round(hb)}s ago`);
  else bad("gateway is not running", `last seen ${Math.round(hb)}s ago — nothing sends`);
  gw?.dryRun === false ? ok("DRY_RUN is off") : bad("DRY_RUN is on", "messages queue but never leave");
  if (gw?.command) bad("a command is queued", `${gw.command} — it will run on the next connect`);
  else ok("no stale admin command queued");

  const group = await prisma.waGroup.findUnique({ where: { jid: JID } });
  group?.sendEnabled ? ok("test group is send-enabled") : bad("test group is not send-enabled", "every message would be marked FAILED");

  console.log("\n── 9. delivery health ──");
  const failed = await prisma.waOutbound.count({ where: { status: "FAILED" } });
  const queued = await prisma.waOutbound.count({ where: { status: "QUEUED" } });
  const sent = await prisma.waOutbound.count({ where: { status: "SENT" } });
  ok("outbound tallies", `${sent} sent, ${queued} queued, ${failed} failed`);
  if (queued > 5) bad(`${queued} messages stuck in the queue`, "the gateway may not be draining");
  const stuckSending = await prisma.waOutbound.count({ where: { status: "SENDING" } });
  if (stuckSending > 0) bad(`${stuckSending} message(s) stuck in SENDING`, "the gateway died mid-send; they will not retry");

  console.log("\n── 10. lab config integrity ──");
  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: LAB_ID } });
  if (config) {
    const { confirmationSlaMinutes: c, reminderSlaMinutes: r, escalationSlaMinutes: e, quietWindowMinutes: q } = config;
    c < r && r < e ? ok("SLA rungs ordered", `${c}/${r}/${e}m`) : bad("SLA rungs out of order", `${c}/${r}/${e}`);
    q < r - c ? ok("quiet window leaves room between rungs", `${q}m`) : bad("quiet window swallows the ladder", `quiet=${q}m vs ${r - c}m between rungs`);
  }

  console.log(`\n${checks} checks run.`);
  if (issues.length === 0) {
    console.log("No issues found ✔");
  } else {
    console.log(`\n${issues.length} ISSUE(S):`);
    issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
  }
  console.log(`
Not provable here (needs a real send or a human tap):
  - poll vote decryption      -> npm run wa:smoke, then tap
  - acknowledgement delivery  -> tap, then check the group
  - SLA breach poll in situ   -> waits for a real breach`);
  process.exitCode = issues.length === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error("AUDIT FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
