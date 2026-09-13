/**
 * Simulate a partly-worked day so the completion-driven features have input.
 *
 * SYNTHETIC ACTIVITY — this invents work that never happened. It exists
 * because several features measure *throughput*, not backlog, and read as
 * broken on a freshly seeded environment where nothing has been closed yet:
 *
 *   • Team leaderboard          — ranks agents by completed tasks (0 rows)
 *   • Analytics → agent breakdown, cohorts, completion rate (all empty)
 *   • Command Center            — completedToday, SLA health stuck at 100%
 *   • Archive                   — nothing terminal to archive
 *
 * Every transition goes through the same PATCH /api/tasks/{id} the UI calls,
 * so task_history rows, startedAt/completedAt stamps, checklist state and SLA
 * evaluation all land exactly as they would from real clicks — rather than
 * being back-dated into the tables behind the app's back.
 *
 * The shape of the day is deliberately imperfect: most work completes, some
 * is still in progress, a little is snoozed, and a slice is left untouched to
 * breach its SLA — so the SLA and stuck views have something real to show.
 *
 * Re-runnable: it only touches tasks that are still CREATED/ASSIGNED, so a
 * second run works the next slice of the backlog rather than double-counting.
 *
 * Run: npm run dummy:activity
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient, TaskStatus } from "@prisma/client";

const prisma = new PrismaClient();

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const AGENT_PASSWORD = "agent123";
/** Share of each agent's open tasks to work in this run. */
const WORK_FRACTION = 0.55;
/** Of the worked slice: completed / left in progress / snoozed. */
const SPLIT = { completed: 0.7, inProgress: 0.2, snoozed: 0.1 };
const SNOOZE_MINUTES = [15, 30, 60, 240];

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${APP_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const cookie = res.headers.getSetCookie?.().join("; ") ?? res.headers.get("set-cookie") ?? "";
  if (!cookie) throw new Error(`no session cookie returned for ${email}`);
  return cookie;
}

async function patchTask(cookie: string, taskId: number, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${APP_URL}/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function main() {
  console.log("🌱  Simulating a working day (synthetic activity)…");

  // Reachability first — every write goes through HTTP, so a down server
  // should fail loudly here rather than half-way through an agent's tasks.
  const health = await fetch(`${APP_URL}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`App not reachable at ${APP_URL} — start it first.`);

  const agents = await prisma.user.findMany({
    where: { role: "OPS_AGENT", isActive: true, email: { endsWith: ".agent@opsflow.local" } },
    select: { id: true, name: true, email: true },
    orderBy: { id: "asc" },
  });
  if (agents.length === 0) throw new Error("No seeded agents — run `npm run dummy:team` first.");

  let completed = 0;
  let inProgress = 0;
  let snoozed = 0;

  for (const agent of agents) {
    const open = await prisma.task.findMany({
      where: {
        assignedToId: agent.id,
        status: { in: [TaskStatus.CREATED, TaskStatus.ASSIGNED] },
        isArchived: false,
      },
      select: { id: true },
      orderBy: { slaDeadline: "asc" },
    });
    if (open.length === 0) continue;

    const cookie = await login(agent.email, AGENT_PASSWORD);

    const workCount = Math.floor(open.length * WORK_FRACTION);
    const slice = open.slice(0, workCount);
    const completeUpto = Math.floor(slice.length * SPLIT.completed);
    const progressUpto = completeUpto + Math.floor(slice.length * SPLIT.inProgress);

    for (const [i, task] of slice.entries()) {
      if (i < completeUpto) {
        // Through IN_PROGRESS first: completing straight from ASSIGNED would
        // leave startedAt null and make handling-time analytics meaningless.
        await patchTask(cookie, task.id, { status: TaskStatus.IN_PROGRESS });
        if (await patchTask(cookie, task.id, { status: TaskStatus.COMPLETED, note: "Confirmed with the lab over call." })) completed++;
      } else if (i < progressUpto) {
        if (await patchTask(cookie, task.id, { status: TaskStatus.IN_PROGRESS })) inProgress++;
      } else {
        const minutes = SNOOZE_MINUTES[i % SNOOZE_MINUTES.length];
        if (await patchTask(cookie, task.id, { snoozeMinutes: minutes })) snoozed++;
      }
    }

    console.log(`  ✔ ${agent.name.padEnd(15)} worked ${slice.length}/${open.length}`);
  }

  const remaining = await prisma.task.count({
    where: { status: { in: [TaskStatus.CREATED, TaskStatus.ASSIGNED] }, isArchived: false },
  });

  console.log(
    `\n✅  ${completed} completed, ${inProgress} in progress, ${snoozed} snoozed; ${remaining} left open.` +
    `\n    Leaderboard, analytics breakdowns and SLA health now have real transitions to read.`
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
