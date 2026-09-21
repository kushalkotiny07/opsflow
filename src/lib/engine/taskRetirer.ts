/**
 * Task auto-retirement
 * ─────────────────────
 * Closes open OpsFlow tasks whose source order has progressed past the
 * rule's `statusIn`. Without this, every rule that fires on a transient
 * status (e.g. R5 on SAMPLE_COLLECTED) leaves tasks orphaned in OpsFlow
 * forever — the lab work is done but the task is still "open" because
 * nothing told OpsFlow to close it.
 *
 * Observed before this fix: 260 open R5 tasks where only 42 were actually
 * still at SAMPLE_COLLECTED — the other 218 were at REPORT_DELIVERED /
 * SAMPLE_DELIVERED / etc. Smart View's "Stuck" tab ballooned to ~6×
 * reality, making the dashboard untrustworthy.
 *
 * Design choices:
 *  - Closes by setting status=CANCELLED with a TaskHistory note explaining
 *    the auto-close. CANCELLED is the only non-success terminal status the
 *    enum offers, and the history note distinguishes engine retirement
 *    from a human cancel.
 *  - Only retires tasks whose rule has a `statusIn` constraint. Rules
 *    without one (status-agnostic timers, etc.) are left alone.
 *  - Skips MANUAL tasks (taskRuleId='MANUAL') — humans own those.
 *  - Skips tasks newer than RETIRE_MIN_AGE_MS (default 10 min) — gives
 *    operators a small grace window where the task is visible even if
 *    the order has just advanced.
 *  - Bulk-fetches orderStatus from labstack (one query, IN-list of ids)
 *    instead of N round-trips.
 *
 * Returned stats are merged into the cycle's PollingLog metadata so
 * operators can see "R5 retired 218" on the dashboard.
 */
import prisma from "@/lib/db/client";
// Retirer is a poller-side housekeeping job → worker pool, isolated
// from API request slots.
import { labstackWorker as labstack } from "@/lib/db/labstack";
import { TaskStatus } from "@prisma/client";
import { isValidTableReference } from "@/lib/validation/data-sources";

const SQL_IDENT_RE = /^[a-zA-Z0-9_]+$/;

const TERMINAL_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.CANCELLED,
];

const RETIRE_MIN_AGE_MS = parseInt(
  process.env.TASK_RETIRE_MIN_AGE_MS ?? `${10 * 60_000}`,
  10
);

export interface RetirementStats {
  ruleId: string;
  ruleName: string;
  retired: number;
}

export interface RetirementResult {
  totalRetired: number;
  perRule: RetirementStats[];
}

/**
 * Scan open engine-created tasks, compare each one's source order status
 * to the originating rule's `statusIn`, and close any task whose order
 * has advanced past the rule's expected statuses.
 *
 * Safe to run every poll cycle: idempotent (no-op when nothing to retire)
 * and cheap when steady-state (one query for the open task set, one bulk
 * status query against labstack).
 */
export async function runTaskRetirer(): Promise<RetirementResult> {
  const now = new Date();
  const ageCutoff = new Date(now.getTime() - RETIRE_MIN_AGE_MS);

  // Pull open, engine-created, non-archived, sufficiently-aged tasks with
  // the originating rule's statusIn so we can compare in one pass.
  const openTasks = await prisma.task.findMany({
    where: {
      isArchived: false,
      status: { notIn: TERMINAL_TASK_STATUSES },
      taskRuleId: { not: "MANUAL" },
      // Every source is retire-eligible now (Order, Appointment, PharmaOrder…).
      // Each task's current status is re-checked against its OWN source table
      // below, keyed by the rule's data source. Previously hardcoded to
      // entityType:"ORDER", which left non-Order tasks to linger until the
      // nightly archive.
      createdAt: { lt: ageCutoff },
    },
    select: {
      id: true,
      entityId: true,
      taskRuleId: true,
      taskRule: {
        select: {
          id: true,
          name: true,
          triggerCondition: true,
          dataSourceId: true,
          dataSource: {
            select: { tableReference: true, statusFieldName: true, primaryKeyField: true },
          },
        },
      },
    },
  });

  if (openTasks.length === 0) {
    return { totalRetired: 0, perRule: [] };
  }

  // Build a per-rule statusIn map. Rules without a statusIn constraint
  // are skipped — we can't tell whether their tasks are stale just from
  // the order's status.
  const ruleStatusInById = new Map<string, Set<string>>();
  for (const t of openTasks) {
    const ruleId = t.taskRule.id;
    if (ruleStatusInById.has(ruleId)) continue;
    const cond = (t.taskRule.triggerCondition ?? {}) as Record<string, unknown>;
    const statusIn = Array.isArray(cond.statusIn)
      ? cond.statusIn.filter((s): s is string => typeof s === "string")
      : null;
    if (statusIn && statusIn.length > 0) {
      ruleStatusInById.set(ruleId, new Set(statusIn));
    } else {
      // Mark as "no constraint" so we skip its tasks without re-parsing.
      ruleStatusInById.set(ruleId, new Set());
    }
  }

  // Filter to tasks whose rule has a usable statusIn.
  const candidateTasks = openTasks.filter(
    (t) => (ruleStatusInById.get(t.taskRule.id)?.size ?? 0) > 0
  );

  if (candidateTasks.length === 0) {
    return { totalRetired: 0, perRule: [] };
  }

  // Bulk-fetch each entity's CURRENT status from its own source table. Tasks
  // are grouped by data source (Order, Appointment, …) so we run one query per
  // source, each casting the source's status column to text (avoids binding
  // the custom PG enum). Status is keyed by "<sourceKey>:<id>" so an Order #42
  // and an Appointment #42 never collide.
  interface SourceGroup {
    tableReference: string;
    statusField: string;
    pk: string;
    ids: Set<number>;
  }
  const groups = new Map<string, SourceGroup>();
  const taskSourceKey = new Map<number, string>(); // task.id → source group key
  for (const t of candidateTasks) {
    if (t.entityId == null) continue;
    const ds = t.taskRule.dataSource;
    // Legacy/Order fallback: a rule with no resolvable source is treated as the
    // Order table (matches the pre-source-aware behaviour).
    const tableReference = ds?.tableReference ?? `public."Order"`;
    const statusField = ds?.statusFieldName ?? "orderStatus";
    const pk = ds?.primaryKeyField ?? "id";
    // Defence in depth: skip a source with a malformed identifier rather than
    // build an unsafe query (registration validates these, but a direct DB
    // write could slip one through).
    if (!isValidTableReference(tableReference) || !SQL_IDENT_RE.test(statusField) || !SQL_IDENT_RE.test(pk)) {
      continue;
    }
    const key = `${tableReference}|${statusField}|${pk}`;
    let g = groups.get(key);
    if (!g) {
      g = { tableReference, statusField, pk, ids: new Set() };
      groups.set(key, g);
    }
    g.ids.add(t.entityId);
    taskSourceKey.set(t.id, key);
  }

  // "<sourceKey>:<id>" → current status text.
  const currentStatusByKey = new Map<string, string>();
  for (const [key, g] of groups) {
    const ids = Array.from(g.ids);
    if (ids.length === 0) continue;
    type StatusRow = { id: number; status: string };
    const rows = await labstack.$queryRawUnsafe<StatusRow[]>(
      `SELECT "${g.pk}" AS id, "${g.statusField}"::text AS status FROM ${g.tableReference} WHERE "${g.pk}" = ANY($1::int[])`,
      ids,
    );
    rows.forEach((r) => currentStatusByKey.set(`${key}:${r.id}`, r.status));
  }

  // Decide which tasks to retire: rule has statusIn AND current source status
  // is NOT in it. Entities deleted from the source also retire (defensive —
  // keeps the queue clean).
  const toRetire: { id: number; ruleId: string; ruleName: string; oldStatus: string }[] = [];
  for (const t of candidateTasks) {
    const statusIn = ruleStatusInById.get(t.taskRule.id);
    if (!statusIn || statusIn.size === 0) continue;
    const key = taskSourceKey.get(t.id);
    if (!key) continue;
    const current = currentStatusByKey.get(`${key}:${t.entityId}`) ?? "<entity-not-found>";
    if (!statusIn.has(current)) {
      toRetire.push({
        id: t.id,
        ruleId: t.taskRule.id,
        ruleName: t.taskRule.name,
        oldStatus: current,
      });
    }
  }

  if (toRetire.length === 0) {
    return { totalRetired: 0, perRule: [] };
  }

  // Retire in a single transaction so the count and the history rows stay
  // consistent. Update + history insert per task — Prisma doesn't bulk-
  // insert relations, so we batch but iterate. 218 rows is fine; if this
  // ever needs to retire 10K+ at once, a CTE-based raw query would scale
  // better.
  const idsToRetire = toRetire.map((x) => x.id);
  await prisma.$transaction(async (tx) => {
    await tx.task.updateMany({
      where: { id: { in: idsToRetire } },
      data: {
        status: TaskStatus.CANCELLED,
        completedAt: now,
        lastStatusUpdate: now,
      },
    });
    // Stamp metadata.autoRetiredByEngine=true via raw SQL so the UI can
    // distinguish engine cancellations from human ones (Smart View splits
    // "Done today" into team-completed vs auto-closed). One statement for
    // the whole batch; jsonb_set merges into existing metadata, defaulting
    // to '{}' for tasks that had no metadata.
    await tx.$executeRawUnsafe(
      `UPDATE taskos."tasks"
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{autoRetiredByEngine}',
           'true'::jsonb
         )
       WHERE id = ANY($1::int[])`,
      idsToRetire
    );
    await tx.taskHistory.createMany({
      data: toRetire.map((t) => ({
        taskId: t.id,
        status: TaskStatus.CANCELLED,
        changedById: null, // engine, not a user
        // "moved", not "advanced" — orders can also REGRESS out of a rule's
        // statusIn (e.g. SAMPLE_DELIVERED → SAMPLE_COLLECTED on a sample
        // re-collection). The close is correct either way; if the order
        // re-enters the rule's statusIn later, the creator re-fires the rule
        // (engine-retired tasks no longer occupy the dedup slot).
        note: `Auto-closed by engine — source entity moved to ${t.oldStatus} (out of rule's statusIn)`,
      })),
    });
  });

  // Per-rule breakdown for PollingLog metadata.
  const perRuleMap = new Map<string, RetirementStats>();
  for (const t of toRetire) {
    const existing = perRuleMap.get(t.ruleId);
    if (existing) {
      existing.retired++;
    } else {
      perRuleMap.set(t.ruleId, {
        ruleId: t.ruleId,
        ruleName: t.ruleName,
        retired: 1,
      });
    }
  }

  return {
    totalRetired: toRetire.length,
    perRule: Array.from(perRuleMap.values()),
  };
}
