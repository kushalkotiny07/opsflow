import prisma from "@/lib/db/client";
import { sendDigestForLab } from "@/lib/provider-comms/daily-digest";
async function main() {
  const c = await prisma.nonApiLabConfig.findUnique({ where: { labId: 378 } });
  const r = await sendDigestForLab(c!, { force: true });
  console.log(`outcome=${r.outcome} → ${r.recipient} sendBlocked=${r.sendBlocked}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
