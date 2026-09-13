/**
 * Daily Summary — fires at 20:30 IST (15:00 UTC) every day.
 * Builds a shift digest and:
 *  1. Creates a DAILY_SUMMARY alert (in-app, visible in the bell)
 *  2. Sends a WhatsApp message to all OPS_HEAD users who have a phone
 */
import prisma from "@/lib/db/client";
import { AlertType, TaskStatus, UserRole } from "@prisma/client";
import { sendWhatsAppMessage } from "@/lib/alerts/whatsapp";

const DAILY_SUMMARY_TEMPLATE = "opsflow_daily_summary";

export async function sendDailySummary(): Promise<void> {
  console.log("[DailySummary] Generating daily summary…");

  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  // ── Gather stats ────────────────────────────────────────────────────────────
  const [createdToday, completedToday, breachedToday, openNow, agentStats] = await Promise.all([
    prisma.task.count({ where: { createdAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.task.count({ where: { status: TaskStatus.COMPLETED, completedAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.task.count({ where: { slaBreachedAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.task.count({ where: { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } } }),
    prisma.user.findMany({
      where: { isActive: true, role: { in: [UserRole.OPS_AGENT, UserRole.STORE_ADMIN] } },
      include: {
        assignedTasks: {
          where: { status: TaskStatus.COMPLETED, completedAt: { gte: dayStart, lt: dayEnd } },
          select: { id: true, slaBreachedAt: true },
        },
      },
    }),
  ]);

  const totalCompleted = completedToday;
  const totalCompliant = agentStats.reduce(
    (sum, a) => sum + a.assignedTasks.filter((t) => !t.slaBreachedAt).length,
    0
  );
  const slaHealth = totalCompleted > 0 ? Math.round((totalCompliant / totalCompleted) * 100) : 100;

  // Top 3 agents
  const topAgents = agentStats
    .filter((a) => a.assignedTasks.length > 0)
    .sort((a, b) => b.assignedTasks.length - a.assignedTasks.length)
    .slice(0, 3)
    .map((a) => `${a.name} (${a.assignedTasks.length})`);

  // ── Build in-app alert message ───────────────────────────────────────────────
  const dateLabel = dayStart.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const alertMessage =
    `Daily summary for ${dateLabel}: ` +
    `${createdToday} tasks created, ${completedToday} completed, ` +
    `${breachedToday} breached. SLA: ${slaHealth}%. Open: ${openNow}.` +
    (topAgents.length > 0 ? ` Top agents: ${topAgents.join(", ")}.` : "");

  await prisma.alert.create({
    data: {
      alertType: AlertType.DAILY_SUMMARY,
      severity: "MEDIUM",
      message: alertMessage,
      channel: "IN_APP",
      status: "PENDING",
      metadata: {
        date: dayStart.toISOString().split("T")[0],
        createdToday,
        completedToday,
        breachedToday,
        openNow,
        slaHealth,
        topAgents,
      },
    },
  });

  // ── WhatsApp to Ops Heads ────────────────────────────────────────────────────
  // {{1}} of opsflow_daily_summary — Meta places no limit on what text one
  // placeholder carries, only on the template having a fixed slot count, so
  // the whole digest goes in as a single parameter.
  const waMessage =
    `📊 *OpsFlow Daily Summary — ${dateLabel}*\n\n` +
    `Tasks Created: ${createdToday}\n` +
    `Completed: ${completedToday}\n` +
    `SLA Breached: ${breachedToday}\n` +
    `SLA Health: ${slaHealth}%\n` +
    `Still Open: ${openNow}\n` +
    (topAgents.length > 0 ? `\n🏆 Top Agents:\n${topAgents.map((a, i) => `${i + 1}. ${a}`).join("\n")}` : "") +
    `\n\n_Sent by OpsFlow_`;

  const opsHeads = await prisma.user.findMany({
    where: { role: UserRole.OPS_HEAD, isActive: true },
    select: { phone: true },
  });

  for (const head of opsHeads) {
    if (head.phone) {
      await sendWhatsAppMessage({ to: head.phone, template: DAILY_SUMMARY_TEMPLATE, params: [waMessage] }).catch((e) =>
        console.error("[DailySummary] WhatsApp send failed:", e)
      );
    }
  }

  console.log(`[DailySummary] Done — ${createdToday} created, ${completedToday} completed, SLA ${slaHealth}%`);
}
