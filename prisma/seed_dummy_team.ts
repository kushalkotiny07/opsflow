/**
 * Seed a local ops team so the assignment engine actually runs.
 *
 * Without this the poller creates tasks fine but every one of them stays
 * unassigned, logging `[pickAssignee] No team members match filters` — which
 * makes Smart View, the Team board, the leaderboard and the agent role all
 * look broken when they are simply working against an empty roster.
 *
 * pickAssignee() (src/lib/engine/taskCreator.ts) needs FIVE things to line up
 * before it will hand a task to anyone, so this seeds all five:
 *
 *   1. A User with role OPS_AGENT and isActive.
 *   2. An active TeamMember row for that user.
 *   3. A WeeklySchedule for TODAY's day-of-week whose window contains "now" —
 *      computeRosterStatus() returns OFF without one, and OFF members are
 *      filtered out before load balancing. Seeded for all 7 days, 00:00-23:59,
 *      so the roster never goes cold on a weekend or an overnight demo.
 *   4. TeamMemberSkill rows covering the skills the seeded HSC rules require
 *      (each rule declares 1-2 of HOME_SAMPLE / CUSTOMER_CARE / LOGISTICS /
 *      ESCALATION / PHLEBOTOMY, and the candidate query filters on them).
 *   5. A TeamMemberCapability per active DataSource — once any capability rows
 *      exist, the engine requires a matching one for the task's source.
 *   6. A StoreAssignment for every store in the source. This one is easy to
 *      get wrong: the candidate query applies
 *      `storeAssignments: { some: { storeId } }` whenever the task carries a
 *      storeId, so it is a hard requirement, not a whitelist that only bites
 *      when populated. With none, every order (all of which have a store)
 *      matches nobody. Seeding all stores × all agents makes the whole team
 *      eligible everywhere, which is what a dev fixture wants.
 *
 * Idempotent — upserts by email, resets passwords, replaces schedules.
 *
 * Run: npm run dummy:team
 */
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { AssignmentMode, PrismaClient, UserRole } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { labstackWorkerQuery } from "../src/lib/db/labstack";

const prisma = new PrismaClient();

/**
 * Store ids to make every agent eligible for. Read from the source DB so the
 * fixture tracks whatever is actually there; falls back to the store ids the
 * existing tasks reference if the source is unreachable.
 */
async function resolveStoreIds(): Promise<number[]> {
  try {
    const rows = await labstackWorkerQuery<{ id: number }>(`SELECT id FROM public."Store" ORDER BY id`);
    if (rows.length > 0) return rows.map((r) => r.id);
  } catch {
    console.warn("  ⚠  Source DB unreachable — deriving store ids from existing tasks.");
  }
  const grouped = await prisma.task.findMany({
    where: { storeId: { not: null } },
    distinct: ["storeId"],
    select: { storeId: true },
  });
  return grouped.map((g) => g.storeId!).filter((id) => Number.isInteger(id));
}

const PASSWORD = "agent123";

/** Skill mix chosen so every seeded HSC rule has at least two candidates. */
const AGENTS = [
  { name: "Aarti Menon",   email: "aarti.agent@opsflow.local",   skills: ["HOME_SAMPLE", "CUSTOMER_CARE", "LOGISTICS"] },
  { name: "Rohit Sharma",  email: "rohit.agent@opsflow.local",   skills: ["HOME_SAMPLE", "LOGISTICS", "PHLEBOTOMY"] },
  { name: "Sneha Iyer",    email: "sneha.agent@opsflow.local",   skills: ["HOME_SAMPLE", "CUSTOMER_CARE", "ESCALATION"] },
  { name: "Imran Qureshi", email: "imran.agent@opsflow.local",   skills: ["CUSTOMER_CARE", "ESCALATION", "LOGISTICS"] },
  { name: "Divya Nair",    email: "divya.agent@opsflow.local",   skills: ["HOME_SAMPLE", "PHLEBOTOMY", "CUSTOMER_CARE"] },
];

async function main() {
  console.log("🌱  Seeding local ops team…");

  const skillTags = await prisma.skillTag.findMany({ select: { id: true, name: true } });
  const skillIdByName = new Map(skillTags.map((s) => [s.name, s.id]));
  if (skillIdByName.size === 0) {
    throw new Error("No skill tags found — run `npm run db:seed` first.");
  }

  const dataSources = await prisma.dataSource.findMany({
    where: { isActive: true },
    select: { id: true, displayName: true },
  });
  if (dataSources.length === 0) {
    console.warn("  ⚠  No active data sources — capabilities skipped. Register one first.");
  }

  const storeIds = await resolveStoreIds();
  if (storeIds.length === 0) {
    console.warn("  ⚠  No stores found — store-scoped tasks will match nobody.");
  }

  const passwordHash = await hashPassword(PASSWORD);

  for (const agent of AGENTS) {
    const user = await prisma.user.upsert({
      where: { email: agent.email },
      update: { name: agent.name, role: UserRole.OPS_AGENT, isActive: true, passwordHash },
      create: { name: agent.name, email: agent.email, role: UserRole.OPS_AGENT, isActive: true, passwordHash },
    });

    const member = await prisma.teamMember.upsert({
      where: { userId: user.id },
      update: { isActive: true, autoAssignEnabled: true, assignmentMode: AssignmentMode.ROUND_ROBIN },
      create: {
        userId: user.id,
        isActive: true,
        autoAssignEnabled: true,
        assignmentMode: AssignmentMode.ROUND_ROBIN,
        assignmentPriority: 5,
      },
    });

    // Skills — replace wholesale so re-runs track edits to AGENTS above.
    const skillIds = agent.skills
      .map((name) => skillIdByName.get(name))
      .filter((id): id is number => typeof id === "number");
    await prisma.teamMemberSkill.deleteMany({ where: { teamMemberId: member.id } });
    await prisma.teamMemberSkill.createMany({
      data: skillIds.map((skillTagId) => ({ teamMemberId: member.id, skillTagId })),
      skipDuplicates: true,
    });

    // All seven days, full day. computeRosterStatus compares against the
    // server's local wall clock, so a 00:00-23:59 window keeps the member
    // ACTIVE whatever time the environment is started.
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      await prisma.weeklySchedule.upsert({
        where: { teamMemberId_dayOfWeek: { teamMemberId: member.id, dayOfWeek } },
        update: { isWorking: true, startTime: "00:00", endTime: "23:59", breakStart: null, breakEnd: null },
        create: { teamMemberId: member.id, dayOfWeek, isWorking: true, startTime: "00:00", endTime: "23:59" },
      });
    }

    // Any leave/off exception for today would override the schedule and make
    // the member ineligible — clear today's so a re-run always yields a
    // working roster.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
    await prisma.rosterException.deleteMany({
      where: { teamMemberId: member.id, date: { gte: todayStart, lt: tomorrowStart } },
    });

    await prisma.storeAssignment.createMany({
      data: storeIds.map((storeId) => ({ teamMemberId: member.id, storeId })),
      skipDuplicates: true,
    });

    for (const ds of dataSources) {
      await prisma.teamMemberCapability.upsert({
        where: { teamMemberId_dataSourceId: { teamMemberId: member.id, dataSourceId: ds.id } },
        update: {},
        create: { teamMemberId: member.id, dataSourceId: ds.id },
      });
    }

    console.log(`  ✔ ${agent.name.padEnd(15)} ${agent.email}  skills: ${agent.skills.join(", ")}`);
  }

  console.log(
    `\n✅  ${AGENTS.length} agents, 7-day schedules, ${storeIds.length} stores and ` +
    `${dataSources.length} source capability each.` +
    `\n    Sign in as any of them with password: ${PASSWORD}` +
    `\n    New tasks auto-assign from the next poll; to spread the existing ones:` +
    `\n      npm run dummy:realign`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
