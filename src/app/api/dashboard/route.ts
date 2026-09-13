/**
 * GET /api/dashboard — aggregate stats for the OPS_HEAD command center.
 *
 * Audit W1 (feature 08) rewrites:
 *
 *  P0 — `dailyRosters` was the legacy table that no path writes any more
 *       (replaced by weekly_schedules + roster_exceptions in
 *       lib/roster/availability.ts). The dashboard kept reading it, so
 *       Team Status defaulted every member to "OFF" — every load of /head
 *       lied about who was working. Now uses computeRosterStatus(), the
 *       same helper /api/team and the assignment engine use.
 *
 *  P0 — `now.setHours(0, 0, 0, 0)` mutated the shared `now` reference, so
 *       every comparison after the "completedToday" query saw a midnight-
 *       anchored value instead of the original `now`. Switched to a
 *       non-mutating IST-anchored start-of-day computed via Intl rather
 *       than the Date.setHours mutation pattern.
 *
 *  P1 — No role check meant any authenticated user (incl. OPS_AGENT) could
 *       fetch the dashboard with team load + breaches + alerts. Now
 *       OPS_HEAD only.
 *
 *  P1 — "Today" comparisons used server-local midnight. The DB session is
 *       Asia/Kolkata; the JS server may be UTC. They produced different
 *       midnights, so "Done Today" silently included or excluded ~5h30m of
 *       events at the day boundary. Now anchored to IST.
 *
 *  P1 — `fetchAllActiveOrders().then(o => o.length).catch(() => 0)` ran
 *       the heaviest query in the codebase (full multi-join over every
 *       active order) JUST to read its length, then silently mapped any
 *       failure to 0 — indistinguishable from "no active orders". Now a
 *       single COUNT(*) on labstack."Order"; failure surfaces explicitly
 *       in the response so the UI can show a "labstack unreachable"
 *       state instead of a deceptive 0.
 *
 *  Arch — 12 parallel queries dropped to 7 by collapsing the six task
 *       counts (open / breached / warning / unassigned / completedToday
 *       / breachedToday) into a single FILTER-aggregate raw SQL. Same
 *       round-trip count, fewer query plans + fewer pool acquisitions.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import labstack from "@/lib/db/labstack";
import { TaskStatus, UserRole } from "@prisma/client";
import { computeRosterStatus, getUTCDayOfWeek } from "@/lib/roster/availability";

/**
 * Anchor "today" to midnight in IST. Returns the corresponding UTC instant
 * so Prisma's bindings compare correctly against stored timestamps. The DB
 * session is Asia/Kolkata; this matches how operational "today" is
 * interpreted by the rest of the product (rosters, /api/team, dashboards).
 */
function startOfTodayIST(): Date {
  const istDateKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  // "2026-05-10" + "T00:00:00+05:30" → real UTC instant for IST midnight.
  return new Date(`${istDateKey}T00:00:00+05:30`);
}

/**
 * Resolve the start-of-range for the dashboard's "Done in range" /
 * "Breached in range" tiles. Three buckets the head can toggle between
 * via the W4 segmented control:
 *
 *   today  — IST midnight today
 *   shift  — IST 09:00 today if we're past 09:00; otherwise IST 09:00
 *            yesterday. India ops typically run a 09:00–21:00 day shift,
 *            so this captures "what's happened since the shift began".
 *   week   — IST 00:00 of Monday this week.
 */
type DashboardRange = "today" | "shift" | "week";

function startOfRangeIST(range: DashboardRange): Date {
  const today = startOfTodayIST();
  if (range === "today") return today;

  if (range === "shift") {
    // IST 09:00 today.
    const istDateKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const shiftStart = new Date(`${istDateKey}T09:00:00+05:30`);
    if (Date.now() >= shiftStart.getTime()) return shiftStart;
    // Pre-09:00 IST — the active shift began at 09:00 yesterday.
    return new Date(shiftStart.getTime() - 24 * 60 * 60 * 1000);
  }

  // range === "week": Monday 00:00 IST. JS getDay(): Sunday=0..Saturday=6.
  // Monday = 1; if today is Sunday, Monday is 6 days ago.
  const istNow = new Date(today);
  const dow = istNow.getUTCDay(); // today is at IST midnight; UTC dow matches IST dow at midnight.
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  return new Date(today.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
}

interface TaskCountsRow {
  open_tasks: bigint;
  breached: bigint;
  warning: bigint;
  // Subset of `warning` within the critical 10-min sub-window. Rendered
  // alongside the 30-min total as "12 (3 critical)" so the urgency edge
  // isn't lost when broadening the actionable horizon.
  warning_critical: bigint;
  unassigned: bigint;
  // Age-in-minutes of the oldest currently-unassigned task. NULL when
  // none. Surfaced as a leading indicator on the dashboard — a snapshot
  // count alone hides whether tasks are sitting for 90 seconds or 90 min.
  oldest_unassigned_min: number | null;
  completed_today: bigint;
  breached_today: bigint;
  // Prior-period (same window, one window earlier) counterparts so the UI
  // can render a delta beside the headline: "23 (+4 vs last week)".
  completed_prior: bigint;
  breached_prior: bigint;
}

export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();
  // Near-SLA actionable horizon (30 min) + critical subset (10 min). The
  // previous threshold was 10 min only, which fired too late to act on —
  // by the time a task hit "warning" it was effectively already lost.
  // Store Overview was also recently unified to the same 30/10 pair.
  const warningThreshold = new Date(now.getTime() + 30 * 60_000); // 30 min
  const criticalThreshold = new Date(now.getTime() + 10 * 60_000); // 10 min (critical subset)
  const dayOfWeek = getUTCDayOfWeek(now);

  // W4 — `range` toggle for the "Done in range" / "Breached in range"
  // tiles. Defaults to "today" so existing callers behave identically.
  const rangeParam = request.nextUrl.searchParams.get("range");
  const range: DashboardRange =
    rangeParam === "shift" || rangeParam === "week" ? rangeParam : "today";
  const rangeStart = startOfRangeIST(range);

  // Prior-period anchor — same window length, one window earlier — so the
  // UI can render a delta ("23 (+4 vs last week)") on the breach & done
  // tiles. For range="today" this is exactly 7 days ago (Mon vs Mon comp);
  // for "week" it's the prior week; for "shift" it's the same shift on
  // the prior day. priorEnd == rangeStart so windows are non-overlapping.
  const windowLen = now.getTime() - rangeStart.getTime();
  const priorStart = new Date(rangeStart.getTime() - (range === "today" ? 7 * 24 * 60 * 60 * 1000 : windowLen));
  const priorEnd = rangeStart;

  // Roster exception window stays anchored to today — rosters are a
  // calendar-day concept; broadening to "this week" doesn't make sense.
  const dayStart = startOfTodayIST();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // Labstack outage marker. The fetchAllActiveOrders count used to silence
  // every error to `0`; we now distinguish "labstack returned 0" from
  // "labstack threw". UI can render a real banner on the latter.
  let activeOrders: number | null = 0;
  let labstackError: string | null = null;

  const [
    activeOrdersResult,
    taskCountsRow,
    riskTasks,
    teamStatus,
    recentAlerts,
    lastPoll,
    sourceStats,
    nonApiWorkflowStatsRow,
  ] = await Promise.all([
    // 1. Labstack active-order count via an approximate (instant) read
    //    from pg_class.reltuples instead of a real COUNT(*). The exact
    //    COUNT was found to hang for 70+ hours during a MultiXact SLRU
    //    storm on the labstack DB (every dashboard load piled a new
    //    doomed query onto the lock, taking OpsFlow down with it).
    //    reltuples is updated by ANALYZE and is accurate to within a
    //    percent or two for a dashboard tile — good enough.
    //
    //    Additional 5-second timeout race wraps the call so even an
    //    approximate fetch can't take the whole endpoint down if labstack
    //    is fully unreachable.
    Promise.race([
      labstack.$queryRaw<Array<{ count: bigint }>>`
        SELECT reltuples::bigint AS count
        FROM pg_class
        WHERE relname = 'Order'
      `,
      new Promise<null>((resolve) =>
        setTimeout(() => {
          labstackError = "labstack timed out after 5s — returning null for active-order count";
          resolve(null);
        }, 5000),
      ),
    ]).catch((err: unknown) => {
      labstackError = err instanceof Error ? err.message : String(err);
      return null;
    }),

    // 2. Six task counts in a single FILTER-aggregate query (down from
    //    six separate parallel prisma.task.count calls).
    //
    //    `slaDeadline` and `completedAt` / `slaBreachedAt` are naive
    //    TIMESTAMP columns; passing JS Dates as parameters binds them
    //    as naive timestamps the same way Prisma's where filters do, so
    //    comparisons are correct (verified in All Tasks W1 E2E).
    prisma.$queryRaw<TaskCountsRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED'))                                            AS open_tasks,
        COUNT(*) FILTER (WHERE status = 'BREACHED')                                                                AS breached,
        COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED','BREACHED')
                          AND "slaDeadline" >  ${now}
                          AND "slaDeadline" <= ${warningThreshold})                                                AS warning,
        COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED','BREACHED')
                          AND "slaDeadline" >  ${now}
                          AND "slaDeadline" <= ${criticalThreshold})                                               AS warning_critical,
        COUNT(*) FILTER (WHERE status = 'CREATED' AND "assignedToId" IS NULL)                                      AS unassigned,
        EXTRACT(EPOCH FROM (NOW() - MIN("createdAt") FILTER (WHERE status = 'CREATED' AND "assignedToId" IS NULL))) / 60
                                                                                                                   AS oldest_unassigned_min,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${rangeStart})                            AS completed_today,
        COUNT(*) FILTER (WHERE "slaBreachedAt" >= ${rangeStart})                                                   AS breached_today,
        -- Prior-period (same window, one window back) for deltas.
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= ${priorStart} AND "completedAt" < ${priorEnd})  AS completed_prior,
        COUNT(*) FILTER (WHERE "slaBreachedAt" >= ${priorStart} AND "slaBreachedAt" < ${priorEnd})                       AS breached_prior
      FROM taskos.tasks
      WHERE "isArchived" = false
    `,

    // 3. Risk zone — at-risk and breached open tasks for the inline-assign UI.
    prisma.task.findMany({
      where: {
        isArchived: false,
        status: { in: [TaskStatus.BREACHED, TaskStatus.CREATED, TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS] },
        OR: [
          { status: TaskStatus.BREACHED },
          { slaDeadline: { lte: warningThreshold } },
        ],
      },
      include: { assignedTo: { select: { id: true, name: true } } },
      orderBy: [{ status: "asc" }, { slaDeadline: "asc" }],
      take: 20,
    }),

    // 4. Team status — now reads weekly_schedules + roster_exceptions for
    //    today, so computeRosterStatus can decide ACTIVE / OFF / SICK /
    //    ON_LEAVE the same way /api/team and the engine do.
    prisma.user.findMany({
      where: { isActive: true, role: { in: [UserRole.OPS_AGENT, UserRole.STORE_ADMIN] } },
      include: {
        teamMember: {
          include: {
            storeAssignments: { select: { storeId: true } },
            weeklySchedules: { where: { dayOfWeek } },
            rosterExceptions: {
              where: { date: { gte: dayStart, lt: dayEnd } },
              take: 1,
            },
          },
        },
        assignedTasks: {
          where: {
            isArchived: false,
            status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
          },
          select: { id: true },
        },
      },
    }),

    // 5. Recent alerts (PENDING only — re-breaches show as new entries).
    prisma.alert.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { task: { select: { id: true, title: true, entityId: true } } },
    }),

    // 6. Last poll status.
    prisma.pollingLog.findFirst({ orderBy: { startedAt: "desc" } }),

    // 7. Per-source open task counts.
    prisma.dataSource.findMany({
      where: { isActive: true },
      select: {
        id: true,
        sourceId: true,
        displayName: true,
        taskRules: {
          select: {
            _count: {
              select: {
                tasks: {
                  where: { isArchived: false, status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
                },
              },
            },
          },
        },
      },
    }),

    prisma.$queryRaw<Array<{
      waiting_for_lab_confirmation: bigint;
      accepted: bigint;
      reschedule_requested: bigint;
      rejected: bigint;
      escalated: bigint;
      pending_reminder_actions: bigint;
      pending_escalation_actions: bigint;
    }>>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'WAITING_FOR_LAB_CONFIRMATION') AS "waiting_for_lab_confirmation",
        COUNT(*) FILTER (WHERE status = 'LAB_ACCEPTED') AS "accepted",
        COUNT(*) FILTER (WHERE status = 'LAB_RESCHEDULE_REQUESTED') AS "reschedule_requested",
        COUNT(*) FILTER (WHERE status = 'LAB_REJECTED') AS "rejected",
        COUNT(*) FILTER (WHERE status = 'ESCALATED') AS "escalated",
        COUNT(*) FILTER (
          WHERE "status" = 'WAITING_FOR_LAB_CONFIRMATION'
            AND "confirmationDeadline" <= ${now}
        ) AS "pending_reminder_actions",
        COUNT(*) FILTER (
          WHERE "status" IN ('WAITING_FOR_LAB_CONFIRMATION', 'ESCALATED')
            AND "escalationDeadline" <= ${now}
        ) AS "pending_escalation_actions"
      FROM "lab_communication_workflows"
    `,
  ]);

  if (activeOrdersResult && activeOrdersResult.length > 0) {
    activeOrders = Number(activeOrdersResult[0].count);
  } else if (labstackError) {
    // labstack outage — surface it instead of pretending zero.
    activeOrders = null;
  }

  // BigInt(0) rather than 0n — the project's TS target is below ES2020 so
  // BigInt literal syntax isn't available; the constructor produces the
  // same value at runtime.
  const z = BigInt(0);
  const counts = taskCountsRow[0] ?? {
    open_tasks: z, breached: z, warning: z, warning_critical: z,
    unassigned: z, oldest_unassigned_min: null,
    completed_today: z, breached_today: z,
    completed_prior: z, breached_prior: z,
  };
  const openTasksCount = Number(counts.open_tasks);
  const breachedCount = Number(counts.breached);
  const warningCount = Number(counts.warning);
  const warningCriticalCount = Number(counts.warning_critical);
  const unassignedCount = Number(counts.unassigned);
  const oldestUnassignedMin = counts.oldest_unassigned_min == null
    ? null
    : Math.round(Number(counts.oldest_unassigned_min));
  const totalDoneToday = Number(counts.completed_today);
  const totalBreachedToday = Number(counts.breached_today);
  const completedPrior = Number(counts.completed_prior);
  const breachedPrior = Number(counts.breached_prior);

  const slaHealth =
    openTasksCount > 0
      ? Math.round(((openTasksCount - breachedCount) / openTasksCount) * 100)
      : 100;

  // Risk items — `now` is unmutated here (it was the audit P0 #8). All
  // remaining-time calculations now use the original `now`.
  const riskItems = riskTasks.map((t) => ({
    taskId: t.id,
    title: t.title,
    priority: t.priority,
    status: t.status,
    entityId: t.entityId,
    orderType: t.orderType,
    storeId: t.storeId,
    slaDeadline: t.slaDeadline,
    slaBreachedAt: t.slaBreachedAt,
    assignedTo: t.assignedTo ? { id: t.assignedTo.id, name: t.assignedTo.name } : null,
    metadata: t.metadata as Record<string, unknown>,
    minutesRemaining: Math.round((t.slaDeadline.getTime() - now.getTime()) / 60_000),
  }));

  const team = teamStatus.map((u) => {
    const schedule = u.teamMember?.weeklySchedules[0] ?? null;
    const exception = u.teamMember?.rosterExceptions[0] ?? null;
    const rosterStatus = u.teamMember
      ? computeRosterStatus(schedule, exception, now)
      : "OFF";
    return {
      userId: u.id,
      name: u.name,
      role: u.role,
      rosterStatus,
      openTasks: u.assignedTasks.length,
      maxTasks: u.teamMember?.maxConcurrentTasks ?? 100,
      storeIds: u.teamMember?.storeAssignments.map((a) => a.storeId) ?? [],
    };
  });

  const shapedSourceStats = sourceStats.map((ds) => ({
    sourceId: ds.sourceId,
    displayName: ds.displayName,
    openTasks: ds.taskRules.reduce(
      (sum, rule) => sum + (rule._count?.tasks ?? 0),
      0
    ),
  }));

  const nonApiWorkflowStats = nonApiWorkflowStatsRow[0] ?? {
    waiting_for_lab_confirmation: BigInt(0),
    accepted: BigInt(0),
    reschedule_requested: BigInt(0),
    rejected: BigInt(0),
    escalated: BigInt(0),
    pending_reminder_actions: BigInt(0),
    pending_escalation_actions: BigInt(0),
  };

  const shapedNonApiWorkflowStats: NonApiWorkflowStats = {
    waitingForLabConfirmation: Number(nonApiWorkflowStats.waiting_for_lab_confirmation),
    accepted: Number(nonApiWorkflowStats.accepted),
    rescheduleRequested: Number(nonApiWorkflowStats.reschedule_requested),
    rejected: Number(nonApiWorkflowStats.rejected),
    escalated: Number(nonApiWorkflowStats.escalated),
    pendingReminderActions: Number(nonApiWorkflowStats.pending_reminder_actions),
    pendingEscalationActions: Number(nonApiWorkflowStats.pending_escalation_actions),
  };

  return NextResponse.json({
    stats: {
      activeOrders,
      openTasks: openTasksCount,
      breachedTasks: breachedCount,
      warningTasks: warningCount,                       // total within 30 min
      warningCriticalTasks: warningCriticalCount,       // subset within 10 min — surfaced as "X critical" sub-label
      slaHealthPercent: slaHealth,
      unassignedTasks: unassignedCount,
      oldestUnassignedMin: oldestUnassignedMin,         // age of oldest CREATED + null-assignee task; leading indicator vs snapshot count
      completedToday: totalDoneToday,
      completedPrior: completedPrior,                   // same window, one window earlier — for delta render
      breachedToday: totalBreachedToday,
      breachedPrior: breachedPrior,                     // same as above for breach trend
    },
    sourceStats: shapedSourceStats,
    riskItems,
    team,
    recentAlerts,
    lastPollAt: lastPoll?.finishedAt ?? null,
    nonApiWorkflowStats: shapedNonApiWorkflowStats,
    // W4 — echoes the resolved range so the UI can label the affected
    // tiles ("Done Today" vs "Done This Shift" vs "Done This Week").
    range: { key: range, since: rangeStart.toISOString() },
    // Surface labstack reachability so the UI can render a "labstack
    // unreachable" banner instead of treating activeOrders=null as 0.
    labstackError,
  });
}
