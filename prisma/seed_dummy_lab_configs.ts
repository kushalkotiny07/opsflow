/**
 * Point Provider Communication at labs that actually exist in the source.
 *
 * The two NonApiLabConfig rows this environment shipped with used invented lab
 * ids (1234 "Orange", 123 "Thyrocare"). The workflow engine resolves a config
 * by the ORDER's labId, and no order carries those ids, so nothing ever
 * matched: `lab_communication_workflows` sat at 0 rows and the Provider
 * Communication pages looked dead while being perfectly healthy.
 *
 * This re-points them at real labs from the source DB — chosen as the
 * providers a platform would plausibly chase over WhatsApp rather than an API
 * (the regional and smaller labs), each with real ids and names.
 *
 * Each lab is addressed by its WhatsApp GROUP, not a handset: a reply then
 * lands in front of the provider's whole desk. There is no manager on these
 * configs — escalations go back to the same group, which is the shape we run
 * with — so managerName / managerWhatsapp are explicitly cleared.
 *
 * Nothing is sent. The workflow writes wa_outbound rows with status QUEUED;
 * dispatch is the wa-gateway service's job and it is not running here. The
 * group ids below are fabricated and reach nobody, and every group is
 * registered with sendEnabled = false, so even a running gateway would refuse
 * them until a human enables that group in the console.
 *
 * Idempotent — upserts by labId.
 *
 * Run: npm run dummy:labs
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { LabIntegrationType, PrismaClient } from "@prisma/client";
import { labstackWorkerQuery } from "../src/lib/db/labstack";

const prisma = new PrismaClient();

/**
 * Labs to manage over WhatsApp, each addressed by a fabricated group id.
 *
 * `integrationType` decides which of the two triggers the lab gets:
 *
 *   NON_API  confirmation workflow (accept / reschedule / cannot fulfil) AND
 *            SLA breach alerts.
 *   API      SLA breach alerts only. The lab already received the order over
 *            the API, so asking it to confirm would be noise — but it still
 *            wants to hear when one of its orders blows a deadline.
 *
 * Orange Health is seeded as API deliberately: without at least one API lab,
 * the breach path looks identical to the old NON_API-only behaviour in this
 * environment. It also carries the most orders in the sheet (52), so breaches
 * actually occur against it.
 */
const MANAGED_LABS: Array<{ labId: number; groupJid: string; integrationType: LabIntegrationType }> = [
  { labId: 14,   groupJid: "120363000000000014@g.us", integrationType: LabIntegrationType.NON_API },
  { labId: 2,    groupJid: "120363000000000002@g.us", integrationType: LabIntegrationType.NON_API },
  { labId: 2229, groupJid: "120363000000002229@g.us", integrationType: LabIntegrationType.NON_API },
  { labId: 378,  groupJid: "120363000000000378@g.us", integrationType: LabIntegrationType.NON_API },
  { labId: 4,    groupJid: "120363000000000004@g.us", integrationType: LabIntegrationType.API },
];

/** Config ids that pointed at labs which do not exist in the source. */
const PLACEHOLDER_LAB_IDS = [123, 1234];

async function main() {
  console.log("🌱  Wiring Provider Communication to real labs…");
  let sendEnabledCount = 0;

  const labRows = await labstackWorkerQuery<{ id: number; labName: string }>(
    `SELECT id, "labName" FROM public."Lab" ORDER BY id`
  );
  const labNameById = new Map(labRows.map((l) => [l.id, l.labName]));
  if (labNameById.size === 0) throw new Error("No labs in the source DB — seed the dummy LabStack first.");

  const templates = await prisma.labCommunicationTemplate.findMany({ select: { key: true } });
  const templateKeys = new Set(templates.map((t) => t.key));
  const requireTemplate = (key: string) => {
    if (!templateKeys.has(key)) throw new Error(`Template "${key}" missing — the config would reference nothing.`);
    return key;
  };

  for (const lab of MANAGED_LABS) {
    const labName = labNameById.get(lab.labId);
    if (!labName) {
      console.warn(`  ⚠  lab ${lab.labId} not in source — skipped`);
      continue;
    }

    await prisma.nonApiLabConfig.upsert({
      where: { labId: lab.labId },
      // Manager fields nulled on update too: a previous run of this seed set
      // them, and a stale manager number would keep receiving escalations.
      update: { labName, isActive: true, integrationType: lab.integrationType, waGroupJid: lab.groupJid, whatsappNumber: null, managerName: null, managerWhatsapp: null, slaBreachAlertsEnabled: true },
      create: {
        labId: lab.labId,
        labName,
        integrationType: lab.integrationType,
        slaBreachAlertsEnabled: true,
        isActive: true,
        waGroupJid: lab.groupJid,
        whatsappNumber: null,
        managerName: null,
        managerWhatsapp: null,
        initialTemplateKey: requireTemplate("NON_API_NEW_ORDER"),
        reminderTemplateKey: requireTemplate("NON_API_REMINDER"),
        escalationTemplateKey: requireTemplate("NON_API_ESCALATION"),
        appointmentTemplateKey: requireTemplate("NON_API_APPOINTMENT_REMINDER"),
      },
    });
    // Registered up-front (disabled) so the group is visible in the console
    // before the first message is ever attempted.
    // sendEnabled is set on create only, never on update: turning it on is a
    // deliberate human decision made in the console, and a seed re-run must not
    // silently revoke it.
    const group = await prisma.waGroup.upsert({
      where: { jid: lab.groupJid },
      update: { subject: `${labName} (provider)`, role: "PROVIDER", labId: lab.labId },
      create: { jid: lab.groupJid, subject: `${labName} (provider)`, role: "PROVIDER", labId: lab.labId, sendEnabled: false, active: true },
      select: { sendEnabled: true },
    });
    if (group.sendEnabled) sendEnabledCount += 1;
    console.log(`  ✔ ${String(lab.labId).padStart(4)}  ${labName.padEnd(28)} ${lab.integrationType.padEnd(7)} ${lab.groupJid}  sending=${group.sendEnabled ? "ON" : "off"}`);
  }

  // Retire the invented-id rows so the Lab Config list stops showing labs that
  // no order can reference.
  const removed = await prisma.nonApiLabConfig.deleteMany({
    where: { labId: { in: PLACEHOLDER_LAB_IDS } },
  });
  if (removed.count > 0) console.log(`  ✔ Removed ${removed.count} placeholder config(s) (labIds ${PLACEHOLDER_LAB_IDS.join(", ")})`);

  // Workflow detection only sees orders the INCREMENTAL pass returns
  // (poller.ts calls startDetectedNonApiLabWorkflows with that batch; the
  // second-pass full scan feeds task creation only). The dummy orders are
  // static, so with the checkpoint already ahead of them nothing would ever
  // be re-observed and these configs would sit idle forever. Rewinding makes
  // the next cycle a full scan — safe, since workflow start is unique per
  // order and task creation dedups.
  const rewound = await prisma.engineCheckpoint.updateMany({
    data: { lastSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60_000) },
  });
  if (rewound.count > 0) console.log(`  ✔ Rewound ${rewound.count} engine checkpoint(s) so existing orders are re-observed`);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const polled = await fetch(`${appUrl}/api/debug/trigger-poller`).then((r) => r.ok).catch(() => false);

  console.log(
    `\n✅  ${MANAGED_LABS.length} labs wired to WhatsApp groups (no manager): ` +
    `${MANAGED_LABS.filter((l) => l.integrationType === "NON_API").length} NON_API (confirmation + breach alerts), ` +
    `${MANAGED_LABS.filter((l) => l.integrationType === "API").length} API (breach alerts only).` +
    (polled
      ? `\n    Poll triggered — workflows started for their orders.`
      : `\n    App not reachable; the 5-minute poller will start the workflows.`) +
    `\n    The tick walks each NON_API ladder every minute; breach alerts are` +
    `\n    queued by the SLA watcher inside each poll cycle.` +
    `\n\n    Messages only reach wa_outbound — no gateway runs here, so nothing` +
    `\n    leaves this machine either way.` +
    (sendEnabledCount > 0
      ? `\n    NOTE: ${sendEnabledCount} of these groups ${sendEnabledCount === 1 ? "already has" : "already have"} sending ENABLED in the` +
        `\n    console (see the per-lab lines above). New groups are always registered` +
        `\n    disabled; this seed never re-disables one a human turned on. The jids are` +
        `\n    fabricated and reach nobody, but start the gateway and those would send.`
      : `\n    Every group is registered sendEnabled=false, so nothing can leave until` +
        `\n    someone enables it in the console.`)
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
