import prisma from "@/lib/db/client";
import { sendDigestForLab } from "@/lib/provider-comms/daily-digest";
async function main() {
  const c = await prisma.nonApiLabConfig.findUnique({ where: { labId: 378 } });
  const r = await sendDigestForLab(c!, { force: true, previewOnly: true });
  console.log(`outcome=${r.outcome} → ${r.recipient}\n${"─".repeat(56)}\n${r.text}\n${"─".repeat(56)}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
