import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const comms = await p.labCommunication.findMany({
  where: { type: "DAILY_DIGEST" },
  select: { id: true, labId: true, recipient: true, status: true, idempotencyKey: true, waOutboundId: true, createdAt: true },
  orderBy: { createdAt: "desc" },
});
console.log(`DAILY_DIGEST rows: ${comms.length}`);
for (const c of comms) console.log(`  key=${c.idempotencyKey} status=${c.status} → ${c.recipient}`);
for (const c of comms) {
  if (!c.waOutboundId) continue;
  const o = await p.waOutbound.findUnique({ where: { id: c.waOutboundId } });
  console.log(`\n  outbound ${o.id}: status=${o.status} attempts=${o.attempts} sentAt=${o.sentAt} waMsgId=${o.sentWaMsgId} err=${o.error ?? "-"}`);
  console.log("  ── text sent ──\n" + o.text.split("\n").map(l => "  | " + l).join("\n"));
}
await p.$disconnect();
