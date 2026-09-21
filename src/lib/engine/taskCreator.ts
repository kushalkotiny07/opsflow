/**
 * Task Creator — evaluates TaskRules against a labstack order and creates
 * Task records in the taskos schema when trigger conditions are met.
 *
 * Deduplication: one open task per (ruleId, orderId) at any time.
 * Assignment: round-robin among active roster agents who have the required skills.
 */
import prisma from "@/lib/db/client";
import { RawOrder } from "./labstack";
import { TaskRuleWithRelations, TriggerCondition, CreateTaskPayload, MetadataCondition, MetadataOperator } from "@/types";
import { TaskStatus, TaskPriority } from "@prisma/client";
import { isAvailableNow, getUTCDayOfWeek } from "@/lib/roster/availability";
import { renderTitleTemplate } from "@/lib/templating/title";
import { triggerConditionSchema } from "@/lib/validation/task-rules";

// Labstack stores timestamps as naive UTC (see labstack.ts for the
// empirical verification). pg reads them back as proper UTC Date
// objects with no SQL-side cast required. The old in-JS shim
// (`correctISTTimestamp`, IST_OFFSET_MS) and the earlier
// `AT TIME ZONE 'Asia/Kolkata'` cast are both gone — every RawOrder
// timestamp arrives as a proper UTC Date object. Fields that are null
// in the source remain null; callers handle that explicitly.
//
// Helper: a value is a usable Date iff it's a Date and not Invalid.
// (Prisma can theoretically hand back a string-shaped Date in edge cases,
// so we coerce + validate at the boundary just here.)
function asValidDate(d: Date | string | null | undefined): Date | null {
  if (d == null) return null;
  const v = d instanceof Date ? d : new Date(d);
  return isNaN(v.getTime()) ? null : v;
}

// ── Comparison helpers for metadata operators ────────────────────────────────

/** Single source of truth for the >, >=, <, <= comparison itself. */
function compareNumbers(op: ">" | ">=" | "<" | "<=", a: number, b: number): boolean {
  switch (op) {
    case ">":  return a > b;
    case ">=": return a >= b;
    case "<":  return a < b;
    case "<=": return a <= b;
  }
}

/**
 * Heuristic: does `v` look like an ISO date or datetime string?
 * Matches "2026-01-01", "2026-01-01T10:00:00Z", "2026-01-01T10:00:00.000+05:30", etc.
 * Pure numbers ("123", "2026") return false so the numeric branch can handle them.
 */
function isIsoDateLike(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return false;
  return !isNaN(Date.parse(v));
}

/** Coerce to a milliseconds-since-epoch number. NaN if it can't be parsed. */
function parseDateOrNaN(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") return Date.parse(v);
  if (typeof v === "number") return v;
  return NaN;
}

// ── Metadata Condition Evaluation (Phase 2) ───────────────────────────────────

/**
 * Evaluates all metadata conditions on an order.
 * ALL conditions must pass (AND logic).
 */
function evaluateMetadataConditions(
  order: RawOrder,
  conditions: MetadataCondition[] | undefined,
  now: Date
): boolean {
  if (!conditions || conditions.length === 0) {
    return true; // No metadata conditions = pass
  }

  // ALL metadata conditions must pass (AND logic)
  return conditions.every(cond => evaluateMetadataCondition(order, cond, now));
}

/**
 * Evaluates a single metadata condition.
 */
function evaluateMetadataCondition(
  order: RawOrder,
  condition: MetadataCondition,
  now: Date
): boolean {
  const { fieldPath, operator, value, offsetMinutes } = condition;

  // Get field value from order.metadata using dot notation
  const fieldValue = getNestedMetadataValue(order.metadata, fieldPath);

  switch (operator) {
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;

    case "not_exists":
      return fieldValue === undefined || fieldValue === null;

    case "equals":
      return fieldValue === value;

    case "not_equals":
      return fieldValue !== value;

    case "contains":
      return typeof fieldValue === 'string' && fieldValue.includes(String(value));

    case "starts_with":
      return typeof fieldValue === 'string' && fieldValue.startsWith(String(value));

    case "ends_with":
      return typeof fieldValue === 'string' && fieldValue.endsWith(String(value));

    case ">":
    case ">=":
    case "<":
    case "<=": {
      // Three comparison modes, dispatched in order:
      //
      //   1. Timestamp-with-offset: caller set `offsetMinutes` and the field
      //      is a string (e.g. reportETA, appointmentTime). Compares the
      //      parsed date against `now + offsetMinutes`.
      //
      //   2. Date-vs-date: neither offsetMinutes nor a numeric `value` —
      //      both sides parse as valid dates AND at least one side LOOKS
      //      like an ISO date string (rather than just a parseable number).
      //      This is the case the audit's W1.6 was about — previously the
      //      code fell straight to the numeric branch and `Number("2026-01-01")`
      //      → NaN → silent false.
      //
      //   3. Numeric: both sides coerce to finite numbers.
      //
      // Anything else: return false rather than silently passing.

      // Mode 1: timestamp + offsetMinutes
      if (offsetMinutes !== undefined && typeof fieldValue === "string") {
        const fieldTime = Date.parse(fieldValue);
        if (isNaN(fieldTime)) {
          console.warn(`[MetadataEval] ${fieldPath}: not a parseable date: ${fieldValue}`);
          return false;
        }
        const thresholdTime = now.getTime() + offsetMinutes * 60_000;
        return compareNumbers(operator, fieldTime, thresholdTime);
      }

      // Mode 2: date-vs-date — at least one side is an ISO-shaped string.
      const fieldIsIsoLike = isIsoDateLike(fieldValue);
      const valueIsIsoLike = isIsoDateLike(value);
      if (fieldIsIsoLike || valueIsIsoLike) {
        const fieldTime = parseDateOrNaN(fieldValue);
        const valueTime = parseDateOrNaN(value);
        if (isNaN(fieldTime) || isNaN(valueTime)) {
          console.warn(`[MetadataEval] ${fieldPath}: date comparison failed (${typeof fieldValue}, ${typeof value})`);
          return false;
        }
        return compareNumbers(operator, fieldTime, valueTime);
      }

      // Mode 3: pure numeric.
      const numField = Number(fieldValue);
      const numValue = Number(value);
      if (!Number.isFinite(numField) || !Number.isFinite(numValue)) {
        return false;
      }
      return compareNumbers(operator, numField, numValue);
    }

    default:
      console.warn(`[MetadataEval] Unknown operator: ${operator}`);
      return false;
  }
}

/**
 * Gets nested value from metadata object using dot notation.
 * Example: fieldPath "reportETA" → metadata.reportETA
 * Example: fieldPath "nested.field" → metadata.nested.field
 */
function getNestedMetadataValue(metadata: any, fieldPath: string): any {
  if (!metadata) return undefined;

  const parts = fieldPath.split('.');
  let value = metadata;

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return undefined;
    }
  }

  return value;
}

// ── Trigger evaluation ────────────────────────────────────────────────────────

/**
 * W5.2 — structured evaluation result so callers (engine + simulator) can
 * tell not just IF a rule matches but WHY it didn't. The polling engine just
 * reads `.matches`; the simulator surfaces `reason` to the operator.
 */
// W3 — when a trigger matches, we capture the human-readable facts that
// caused it to fire. These are stamped onto Task.metadata.whyThisTask so
// the agent's "Why this task?" panel can answer the question without
// re-evaluating the rule. Authoring tools (the simulator) reuse the same
// shape.
export type TriggerMatchedFact = {
  check: TriggerCheck;
  detail: string;
};

export type TriggerResult =
  | { matches: true; matchedFacts: TriggerMatchedFact[] }
  | { matches: false; reason: string; failedCheck: TriggerCheck };

export type TriggerCheck =
  | "statusIn"
  | "minutesSinceCreated"
  | "minutesSinceStatusUpdated"
  | "minutesBeforeAppointment"
  | "minutesAfterAppointment"
  | "metadataConditions";

export function evaluateTrigger(order: RawOrder, cond: TriggerCondition, now: Date): TriggerResult {
  // W3 — collect facts about each check that passed so the agent can later
  // see WHY their task fired. Matched facts are intentionally human-readable
  // (no JSON ids), since they end up rendered verbatim in TaskDetailPanel.
  const matchedFacts: TriggerMatchedFact[] = [];

  // 1. Order status must be in the allowed set
  if (!Array.isArray(cond.statusIn) || !cond.statusIn.includes(order.orderStatus)) {
    return {
      matches: false,
      failedCheck: "statusIn",
      reason: `order.orderStatus="${order.orderStatus}" not in [${(cond.statusIn ?? []).join(", ")}]`,
    };
  }
  matchedFacts.push({
    check: "statusIn",
    detail: `order is in ${order.orderStatus}`,
  });

  const msPerMin = 60_000;

  // Timestamps arrive as proper UTC Dates from labstack.ts (labstack stores
  // them as naive UTC; pg reads naive timestamps as UTC by default, no SQL
  // cast needed). Any of these can legitimately be null (e.g. an order
  // without a scheduled appointmentTime). When a check
  // needs a timestamp the order doesn't carry, fail that specific check
  // rather than evaluating against epoch.
  const createdAt = asValidDate(order.createdAt);
  const statusUpdatedAt = asValidDate(order.statusUpdatedAt);
  const appointmentTime = asValidDate(order.appointmentTime);

  // 2. Age since created
  if (cond.minutesSinceCreated !== undefined) {
    if (!createdAt) {
      return { matches: false, failedCheck: "minutesSinceCreated", reason: "order has no createdAt" };
    }
    const ageMin = (now.getTime() - createdAt.getTime()) / msPerMin;
    if (ageMin < cond.minutesSinceCreated) {
      return {
        matches: false,
        failedCheck: "minutesSinceCreated",
        reason: `order is ${Math.floor(ageMin)}m old, threshold is ${cond.minutesSinceCreated}m`,
      };
    }
    matchedFacts.push({
      check: "minutesSinceCreated",
      detail: `order is ${Math.floor(ageMin)}m old (threshold ${cond.minutesSinceCreated}m)`,
    });
  }

  // 3. Age since last status change
  if (cond.minutesSinceStatusUpdated !== undefined) {
    if (!statusUpdatedAt) {
      return { matches: false, failedCheck: "minutesSinceStatusUpdated", reason: "order has no statusUpdatedAt" };
    }
    const staleMin = (now.getTime() - statusUpdatedAt.getTime()) / msPerMin;
    if (staleMin < cond.minutesSinceStatusUpdated) {
      return {
        matches: false,
        failedCheck: "minutesSinceStatusUpdated",
        reason: `status was updated ${Math.floor(staleMin)}m ago, threshold is ${cond.minutesSinceStatusUpdated}m`,
      };
    }
    matchedFacts.push({
      check: "minutesSinceStatusUpdated",
      detail: `order has been in ${order.orderStatus} for ${Math.floor(staleMin)}m (threshold ${cond.minutesSinceStatusUpdated}m)`,
    });
  }

  // 4. Time before appointment
  if (cond.minutesBeforeAppointment !== undefined) {
    if (!appointmentTime) {
      return { matches: false, failedCheck: "minutesBeforeAppointment", reason: "order has no appointmentTime" };
    }
    const minBefore = (appointmentTime.getTime() - now.getTime()) / msPerMin;
    if (minBefore > cond.minutesBeforeAppointment) {
      return {
        matches: false,
        failedCheck: "minutesBeforeAppointment",
        reason: `appointment is ${Math.floor(minBefore)}m away, window is ${cond.minutesBeforeAppointment}m`,
      };
    }
    if (minBefore < 0) {
      return {
        matches: false,
        failedCheck: "minutesBeforeAppointment",
        reason: `appointment was ${Math.floor(-minBefore)}m ago — past, won't fire`,
      };
    }
    matchedFacts.push({
      check: "minutesBeforeAppointment",
      detail: `appointment is in ${Math.floor(minBefore)}m (window ${cond.minutesBeforeAppointment}m)`,
    });
  }

  // 5. Time after appointment
  if (cond.minutesAfterAppointment !== undefined) {
    if (!appointmentTime) {
      return { matches: false, failedCheck: "minutesAfterAppointment", reason: "order has no appointmentTime" };
    }
    const minAfter = (now.getTime() - appointmentTime.getTime()) / msPerMin;
    if (minAfter < cond.minutesAfterAppointment) {
      return {
        matches: false,
        failedCheck: "minutesAfterAppointment",
        reason: `appointment was ${Math.floor(minAfter)}m ago, threshold is ${cond.minutesAfterAppointment}m post-appt`,
      };
    }
    matchedFacts.push({
      check: "minutesAfterAppointment",
      detail: `appointment was ${Math.floor(minAfter)}m ago (threshold ${cond.minutesAfterAppointment}m)`,
    });
  }

  // 6. Metadata conditions (P2)
  if (cond.metadataConditions && cond.metadataConditions.length > 0) {
    for (const mc of cond.metadataConditions) {
      if (!evaluateMetadataCondition(order, mc, now)) {
        return {
          matches: false,
          failedCheck: "metadataConditions",
          reason: `metadata condition failed: ${mc.fieldPath} ${mc.operator}${mc.value !== undefined ? ` ${JSON.stringify(mc.value)}` : ""}`,
        };
      }
      matchedFacts.push({
        check: "metadataConditions",
        detail: `${mc.fieldPath} ${mc.operator}${mc.value !== undefined ? ` ${JSON.stringify(mc.value)}` : ""}`,
      });
    }
  }

  return { matches: true, matchedFacts };
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * W1.6 — dedup key is (entityType, taskRuleId, entityId), not just
 * (taskRuleId, entityId). Today every task has entityType="ORDER" so the
 * old key was effectively unique, but the moment a non-Order entity
 * (Appointment, Camp, …) arrives with the same numeric id, the previous
 * check would falsely report duplicate and silently skip the new task.
 *
 * Defaults entityType to "ORDER" so existing call sites don't have to
 * change all at once.
 */
async function isDuplicate(
  ruleId: string,
  entityId: number,
  entityType: string = "ORDER"
): Promise<boolean> {
  const existing = await prisma.task.findFirst({
    where: {
      taskRuleId: ruleId,
      entityType,
      entityId,
      isArchived: false,
    },
    select: { id: true },
  });
  return existing !== null;
}

// ── Assignment engine ─────────────────────────────────────────────────────────

async function applyRoundRobin(
  dataSourceId: string,
  candidates: Array<{ userId: number; teamMemberId: number }>
): Promise<number> {
  // Get current round-robin state for this data source
  let state = await prisma.roundRobinState.findUnique({
    where: { dataSourceId },
  });

  // State tracks by teamMemberId — use that for rotation lookup
  const candidateTeamMemberIds = candidates.map((c) => c.teamMemberId);

  // If no state, create it and return first candidate
  if (!state) {
    await prisma.roundRobinState.create({
      data: {
        dataSourceId,
        lastAssignedMemberId: candidates[0].teamMemberId,
      },
    });
    return candidates[0].userId;
  }

  // Find next in rotation (compare teamMemberId to teamMemberId)
  const currentIndex = candidateTeamMemberIds.indexOf(state.lastAssignedMemberId || -1);
  const nextIndex =
    currentIndex === -1 ? 0 : (currentIndex + 1) % candidates.length;

  // Update state with new selection
  const nextCandidate = candidates[nextIndex];
  await prisma.roundRobinState.upsert({
    where: { dataSourceId },
    update: {
      lastAssignedMemberId: nextCandidate.teamMemberId,
    },
    create: {
      dataSourceId,
      lastAssignedMemberId: nextCandidate.teamMemberId,
    },
  });

  return nextCandidate.userId;
}

// W4.2 — assignment strategies. Names match the CHECK constraint on
// task_rules.assignmentStrategy.
type AssignmentStrategy = "default" | "round_robin" | "store_affinity" | "skill_based" | "least_loaded";

/**
 * Select only the least-loaded subset of candidates. Used as the inner
 * preference for strategies that want load-aware fairness, and as the
 * default behaviour when no strategy is selected.
 */
function leastLoaded<T extends { _count: { assignedTasks: number } }>(entries: T[]): T[] {
  if (entries.length === 0) return entries;
  const minLoad = Math.min(...entries.map((e) => e._count.assignedTasks));
  return entries.filter((e) => e._count.assignedTasks === minLoad);
}

// W1.3 — pickAssignee returns a discriminated outcome instead of `number | null`.
// `null` previously hid two very different situations:
//   1. genuine "no eligible candidates" (off-hours, no capability) — expected
//   2. the function caught an exception — an actual bug, but silent
// The caller can now distinguish them and surface (1) as a normal task
// state vs (2) as an alertable engine failure.
export type PickAssigneeOutcome =
  | { ok: true;  userId: number; teamMemberId: number }
  | { ok: false; reason: "no_candidates" | "no_capability" | "no_active_roster" | "error"; detail?: string };

async function pickAssignee(
  requiredSkillIds: number[],
  storeId: number | null,
  dataSourceId: string,
  strategy: AssignmentStrategy = "default"
): Promise<PickAssigneeOutcome> {
  try {

    // Compute today's date range using local-date components (matches /api/team's
    // logic exactly so rosterStatus in the UI matches what the engine uses).
    // The server runs in IST; "today" must be the local-day view, anchored as a
    // UTC midnight so it lines up with PostgreSQL's DATE column representation.
    const now = new Date();
    const todayUTC = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
    );
    const tomorrowUTC = new Date(todayUTC);
    tomorrowUTC.setUTCDate(tomorrowUTC.getUTCDate() + 1);
    const todayDayOfWeek = getUTCDayOfWeek(todayUTC);

    // Load all OPS_AGENT team members matching store + skill filters, with their
    // weekly schedule for today's day-of-week and any roster exception for today.
    // Availability is then derived in JS via computeRosterStatus() — same logic
    // used by GET /api/team for displaying rosterStatus.
    const candidateMembers = await prisma.teamMember.findMany({
      where: {
        isActive: true,
        user: { isActive: true, role: "OPS_AGENT" },
        ...(storeId !== null
          ? { storeAssignments: { some: { storeId } } }
          : {}),
        ...(requiredSkillIds.length > 0
          ? { skills: { some: { skillTagId: { in: requiredSkillIds } } } }
          : {}),
      },
      include: {
        user: { select: { id: true } },
        capabilities: { select: { dataSourceId: true } },
        // Loaded for strategies that look beyond load (skill_based,
        // store_affinity). The base query already filters by required skills
        // when present, but strategies that PREFER more matches still need
        // the full skill set.
        skills: { select: { skillTagId: true } },
        storeAssignments: { select: { storeId: true } },
        weeklySchedules: { where: { dayOfWeek: todayDayOfWeek } },
        rosterExceptions: {
          where: { date: { gte: todayUTC, lt: tomorrowUTC } },
          take: 1,
        },
        _count: {
          select: {
            assignedTasks: {
              where: { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
            },
          },
        },
      },
      orderBy: { user: { id: "asc" } },
    });

    if (candidateMembers.length === 0) {
      const detail = `No team members match filters (dataSourceId=${dataSourceId}, storeId=${storeId}, skills=${requiredSkillIds.join(",")})`;
      console.warn(`[pickAssignee] ${detail}`);
      return { ok: false, reason: "no_candidates", detail };
    }

    // Filter by current schedule/exception status (must be ACTIVE right now)
    let eligibleEntries = candidateMembers.filter((m) => {
      const schedule = m.weeklySchedules[0] ?? null;
      const exception = m.rosterExceptions[0] ?? null;
      return isAvailableNow(schedule, exception, now);
    });

    if (eligibleEntries.length === 0) {
      const detail = `No members are currently ACTIVE per schedule/exception (dataSourceId=${dataSourceId}, storeId=${storeId})`;
      console.warn(`[pickAssignee] ${detail}`);
      return { ok: false, reason: "no_active_roster", detail };
    }

    // ── Data-source capability scoping ────────────────────────────────────
    // A member with ANY capability rows is a SPECIALIST: eligible only for the
    // data sources they're explicitly assigned (Team → Sources). A member with
    // NO capability rows is a GENERALIST: eligible for any source.
    //
    //   • If ≥1 member is explicitly scoped to THIS source, only those members
    //     handle it (that's the "restrict this source to these people" intent).
    //   • Otherwise only generalists may take it — a specialist scoped to a
    //     DIFFERENT source is never pulled in. (Fixes: Aryan, scoped to Lab
    //     Orders, was receiving Appointments tasks because Appointments had no
    //     scoped members and the old rule treated it as open-to-all.)
    const scopedToThis = eligibleEntries.filter((m) =>
      m.capabilities.some((c) => c.dataSourceId === dataSourceId)
    );
    eligibleEntries = scopedToThis.length > 0
      ? scopedToThis
      : eligibleEntries.filter((m) => m.capabilities.length === 0);

    if (eligibleEntries.length === 0) {
      const detail = `No eligible members for dataSourceId=${dataSourceId} — scope a handler in Team → Sources, or leave an agent unscoped as a generalist`;
      console.warn(`[pickAssignee] ${detail}`, { dataSourceId, requiredSkillIds, storeId });
      return { ok: false, reason: "no_capability", detail };
    }

    // ── Strategy dispatch ─────────────────────────────────────────────────
    // Each strategy first NARROWS the candidate set (preference), then
    // hands the survivors to a deterministic tiebreaker (round-robin) so
    // identical states still produce a fair rotation. Falling back to the
    // full eligibleEntries when a strategy doesn't apply means an unlucky
    // configuration never starves a task.

    let preferred: typeof eligibleEntries;

    switch (strategy) {
      case "round_robin":
        // Pure rotation across all eligible. No load consideration.
        preferred = eligibleEntries;
        break;

      case "store_affinity": {
        // Prefer agents who own the order's store; fall through to all
        // eligible if no perfect match exists (or if storeId is null).
        if (storeId === null) {
          preferred = eligibleEntries;
        } else {
          const affine = eligibleEntries.filter((m) =>
            m.storeAssignments.some((sa) => sa.storeId === storeId)
          );
          preferred = affine.length > 0 ? affine : eligibleEntries;
        }
        // Within store-affine candidates, pick least-loaded (busy phlebos
        // assigned to a store still get spread across the day's tasks).
        preferred = leastLoaded(preferred);
        break;
      }

      case "skill_based": {
        // Prefer agents with the MOST matching required skills. The base
        // query already filtered to ≥1 match when requiredSkillIds is set,
        // so this is a tie-resolver, not a gate.
        if (requiredSkillIds.length === 0) {
          preferred = eligibleEntries;
        } else {
          const requiredSet = new Set(requiredSkillIds);
          const scored = eligibleEntries.map((m) => ({
            m,
            matches: m.skills.filter((s) => requiredSet.has(s.skillTagId)).length,
          }));
          const maxMatches = Math.max(...scored.map((s) => s.matches));
          preferred = scored.filter((s) => s.matches === maxMatches).map((s) => s.m);
        }
        // Then least-loaded among the top-skill-match group.
        preferred = leastLoaded(preferred);
        break;
      }

      case "least_loaded":
      case "default":
      default:
        // The historical behaviour: pick the lowest current-load group,
        // then round-robin among ties. "default" and "least_loaded" are
        // identical semantically; the dropdown lists both so authors
        // coming from different mental models can find the right name.
        preferred = leastLoaded(eligibleEntries);
        break;
    }

    if (preferred.length === 0) {
      // Strategy filtered everything out — fall back to the full set so a
      // task is at least assigned, and warn so the operator can fix the
      // strategy config.
      console.warn(`[pickAssignee] Strategy "${strategy}" left zero candidates; falling back to least-loaded`);
      preferred = leastLoaded(eligibleEntries);
    }

    let selected: typeof eligibleEntries[0];
    if (preferred.length > 1) {
      const candidates = preferred.map((m) => ({ userId: m.user.id, teamMemberId: m.id }));
      const selectedUserId = await applyRoundRobin(dataSourceId, candidates);
      selected = preferred.find((m) => m.user.id === selectedUserId)!;
    } else {
      selected = preferred[0];
    }

    console.info(`[pickAssignee] strategy=${strategy} → user ${selected.user.id} (load: ${selected._count.assignedTasks})`, {
      dataSourceId,
      strategy,
      userId: selected.user.id,
      candidatePool: eligibleEntries.length,
      preferredPool: preferred.length,
    });

    return { ok: true, userId: selected.user.id, teamMemberId: selected.id };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[pickAssignee] Error storeId=${storeId} dsId=${dataSourceId}:`, error instanceof Error ? error.stack : String(error));
    return { ok: false, reason: "error", detail };
  }
}

// ── Core creator ──────────────────────────────────────────────────────────────

// Returns the assignment outcome plus what actually happened to the row:
// "created" (new task), "reopened" (engine-retired task resurrected in
// place — see the unique-constraint note in the body), or "skipped" (the
// (rule, entity) slot is held by a live/human-decided/archived task).
async function createTask(
  payload: CreateTaskPayload
): Promise<{ outcome: PickAssigneeOutcome; creation: "created" | "reopened" | "skipped" }> {
  const {
    taskRuleId, taskTypeId, title, entityType, entityId,
    storeId, orderType, dataSourceId, priority, slaDeadline, metadata, checklistSteps,
    assignmentStrategy, appointmentTime,
  } = payload;

  // W1.9 — defence in depth on SLA deadline. The API already bounds
  // slaMinutes via zod (≤ 30 days), but a legacy rule row could carry an
  // older absurd value, and a malformed slaDeadline (NaN / Invalid Date)
  // would propagate through every downstream query. Drop the task with a
  // log rather than persist a row that can't be sorted on slaDeadline.
  if (!(slaDeadline instanceof Date) || isNaN(slaDeadline.getTime())) {
    console.error(`[createTask] aborting — invalid slaDeadline for rule=${taskRuleId} entity=${entityId}`);
    return { outcome: { ok: false, reason: "error", detail: "invalid slaDeadline" }, creation: "skipped" };
  }

  // Fetch required skills for this rule
  const ruleSkills = await prisma.taskRuleSkill.findMany({
    where: { taskRuleId },
    select: { skillTagId: true },
  });
  const skillIds = ruleSkills.map((r) => r.skillTagId);

  // W1.3 — distinguish "no candidates" (expected) from "engine error" (bug).
  // assignmentMethod records the path so the dashboard can split unassigned
  // tasks into actionable buckets.
  const outcome = await pickAssignee(skillIds, storeId, dataSourceId, assignmentStrategy);
  const assigneeId = outcome.ok ? outcome.userId : null;
  // Audit arch finding: keep `teamMemberId` in lockstep with `assignedToId`.
  // Engine used to set only assignedToId while the manual-task path set both,
  // so any query filtering by teamMemberId silently missed auto-assigned tasks.
  const assigneeTeamMemberId = outcome.ok ? outcome.teamMemberId : null;
  const assignmentMethod = outcome.ok
    ? "auto"
    : outcome.reason === "error"
      ? "auto-failed"
      : `auto-${outcome.reason}`; // auto-no_candidates / auto-no_capability / auto-no_active_roster

  const now = new Date();

  // W2.3 — wrap the task + checklist + history + assignment in a single
  // transaction. Previously these were 3 sequential awaits; if the second
  // failed (e.g. taskHistory.create after task.create), the resulting state
  // was a task with no history and an inconsistent status, with no signal.
  // The transaction rolls back the whole thing on any sub-failure.
  // ── Reopen-or-create-or-skip (July 2026 incident) ────────────────────
  // The DB enforces @@unique([taskRuleId, entityId]) — one task per
  // (rule, order) FOREVER, and the archiver only flags rows (isArchived),
  // it never deletes them. So when the dedup layer allows a re-fire
  // (engine-retired CANCELLED task, order re-entered the rule's statusIn),
  // a plain create() hits P2002 — and before this fix, that single
  // violation aborted the ENTIRE poll cycle, taking the retirer and SLA
  // watcher down with it. The correct move under this constraint is to
  // REOPEN the existing engine-retired row in place: no constraint fight,
  // and the task keeps its full history across the retire/reopen bounce.
  // Any other occupant of the slot (open task, human cancel, completed,
  // archived history) → skip quietly; it's a dedup race, not an error.
  const sharedData = {
    taskTypeId,
    title,
    storeId,
    orderType,
    priority,
    slaDeadline,
    appointmentTime,
    // Stash the assignment outcome on the task's metadata so the operator
    // can see WHY a task is unassigned without grepping logs.
    metadata: {
      ...(metadata as Record<string, unknown>),
      ...(outcome.ok ? {} : { assignmentFailure: { reason: outcome.reason, detail: outcome.detail } }),
    } as Parameters<typeof prisma.task.create>[0]["data"]["metadata"],
    // If assigned, the task lands directly as ASSIGNED — saves one
    // round-trip vs the previous create-then-update pattern.
    status: assigneeId ? TaskStatus.ASSIGNED : TaskStatus.CREATED,
    assignedToId: assigneeId,
    teamMemberId: assigneeTeamMemberId,
    assignedAt: assigneeId ? now : null,
    lastStatusUpdate: now,
    assignmentMethod,
    assignmentRuleId: taskRuleId,
  };
  const historyCreate = assigneeId
    ? [
        {
          status: TaskStatus.CREATED,
          note: "Task auto-created by OpsFlow polling engine",
        },
        {
          status: TaskStatus.ASSIGNED,
          changedById: assigneeId,
          note: "Auto-assigned by OpsFlow engine",
        },
      ]
    : [
        {
          status: TaskStatus.CREATED,
          note: outcome.ok
            ? "Task auto-created by OpsFlow polling engine"
            : `Task auto-created (UNASSIGNED — ${outcome.reason}: ${outcome.detail ?? "no detail"})`,
        },
      ];

  const txResult = await prisma.$transaction(async (tx) => {
    const existing = await tx.task.findUnique({
      where: { taskRuleId_entityId: { taskRuleId, entityId } },
      select: { id: true, status: true, metadata: true },
    });

    if (existing) {
      const isEngineRetired =
        existing.status === TaskStatus.CANCELLED &&
        !!(existing.metadata as Record<string, unknown> | null)?.autoRetiredByEngine;
      if (!isEngineRetired) {
        // Slot held by a live task or a human decision — dedup race or
        // archived history. Not an error; just don't touch it.
        return { task: null, creation: "skipped" as const };
      }
      // Reopen: fresh fields + checklist, un-archive, clear terminal state.
      await tx.taskChecklistItem.deleteMany({ where: { taskId: existing.id } });
      const reopened = await tx.task.update({
        where: { id: existing.id },
        data: {
          ...sharedData,
          isArchived: false,
          completedAt: null,
          slaBreachedAt: null,
          snoozedUntil: null,
          checklistItems: {
            create: checklistSteps.map((s) => ({
              stepOrder: s.stepOrder,
              stepText: s.stepText,
              isRequired: s.isRequired,
              guidance: s.guidance ?? null,
              script: s.script ?? null,
              isDone: false,
            })),
          },
          history: {
            create: [
              {
                status: sharedData.status,
                note: "Reopened by engine — order re-entered the rule's statusIn after an auto-retirement",
              },
              ...(assigneeId
                ? [{ status: TaskStatus.ASSIGNED, changedById: assigneeId, note: "Auto-assigned by OpsFlow engine" }]
                : []),
            ],
          },
        },
      });
      return { task: reopened, creation: "reopened" as const };
    }

    const created = await tx.task.create({
      data: {
        ...sharedData,
        taskRuleId,
        entityType,
        entityId,
        checklistItems: {
          create: checklistSteps.map((s) => ({
            stepOrder: s.stepOrder,
            stepText: s.stepText,
            isRequired: s.isRequired,
            guidance: s.guidance ?? null,
            script: s.script ?? null,
            isDone: false,
          })),
        },
        history: { create: historyCreate },
      },
    });
    return { task: created, creation: "created" as const };
  });
  const task = txResult.task;
  if (!task) {
    return { outcome, creation: "skipped" as const };
  }

  // W1.3 — surface engine errors via the alert feed. "no candidates" /
  // "no roster" are normal off-hours cases; "error" is a bug worth waking
  // someone up. We dedupe on (dataSourceId) so a stuck rule doesn't spam.
  if (!outcome.ok && outcome.reason === "error") {
    try {
      const recentSimilar = await prisma.alert.findFirst({
        where: {
          alertType: "ESCALATION",
          status: { in: ["PENDING", "SENT"] },
          metadata: { path: ["scope", "dataSourceId"], equals: dataSourceId },
          createdAt: { gte: new Date(Date.now() - 15 * 60_000) }, // last 15 min
        },
        select: { id: true },
      });
      if (!recentSimilar) {
        await prisma.alert.create({
          data: {
            alertType: "ESCALATION",
            severity: "HIGH",
            entityType: "ENGINE",
            entityId: null,
            taskId: task.id,
            message: `pickAssignee threw for dataSource=${dataSourceId}: ${outcome.detail ?? "(no detail)"}`,
            metadata: {
              scope: { dataSourceId, storeId, taskRuleId },
              reason: outcome.reason,
              detail: outcome.detail,
              taskId: task.id,
            },
            status: "PENDING",
          },
        });
      }
    } catch (alertErr) {
      console.error("[createTask] failed to emit assignment-failure alert:", alertErr);
    }
  }

  // (W2.3 — assignment history + status are now created inside the
  // transaction above, so there's no follow-up block here.)
  return { outcome, creation: txResult.creation };
}

// ── Public entry point ────────────────────────────────────────────────────────

// W4 — per-rule fire log. Each cycle reports counts per rule so the operator
// can answer "did rule X fire?" without grepping logs or running an
// after-the-fact metrics query against the tasks table. The poller persists
// this on the PollingLog row's metadata.
export interface RuleCycleStats {
  ruleId: string;
  ruleName: string;
  fired: number;             // tasks actually created by this rule this cycle
  skippedDedup: number;      // matched trigger but already had an open task
  skippedTrigger: number;    // status / timing / metadata didn't pass
  skippedTypeFilter: number; // allowedTypes filtered the order out
  failedAssignment: number;  // task created but pickAssignee couldn't pick anyone
  failedCreate: number;      // insert/reopen threw (e.g. constraint race) — cycle continued
}

export async function evaluateAndCreateTasks(
  orders: RawOrder[],
  rules: TaskRuleWithRelations[]
): Promise<{ created: number; skipped: number; perRule: RuleCycleStats[] }> {
  const now = new Date();
  let created = 0;
  let skipped = 0;

  // Per-rule counters initialised for every active rule (so a rule with zero
  // fires still appears in the report, instead of being invisible).
  const perRule = new Map<string, RuleCycleStats>();
  for (const r of rules) {
    perRule.set(r.id, {
      ruleId: r.id, ruleName: r.name,
      fired: 0, skippedDedup: 0, skippedTrigger: 0,
      skippedTypeFilter: 0, failedAssignment: 0, failedCreate: 0,
    });
  }
  const bumpRule = (ruleId: string, key: keyof Omit<RuleCycleStats, "ruleId" | "ruleName">) => {
    const s = perRule.get(ruleId);
    if (s) s[key]++;
  };
  const msPerDay = 24 * 60 * 60 * 1000;
  const maxOrderAgeDays = 10;
  // Don't create tasks for orders whose appointment is far in the future —
  // they don't need attention yet and would clutter the active queue.
  // Tasks become eligible once the appointment is within this window.
  const maxOrderFutureDays = 3;

  // ─── W2.1: Pre-load dedup keys ─────────────────────────────────────────
  // Previously isDuplicate ran one DB roundtrip per (rule, order) pair that
  // passed the trigger — N+1 antipattern that scaled with orders × rules.
  // At 5K orders × 8 rules × 50% trigger rate this was ~20K queries per
  // cycle; well over the per-cycle budget at 10K+ orders.
  //
  // One query loads every active task's dedup key into a Set; the inner
  // loop swaps the DB call for an O(1) Set.has() check. The key shape
  // matches isDuplicate's where-clause: `<entityType>|<taskRuleId>|<entityId>`.
  // Keys observed in this cycle's hot loop are appended to the Set so two
  // rules trying to create for the same order in one cycle still dedupe.
  const ruleIds = rules.map((r) => r.id);
  const activeTaskKeys = new Set<string>();
  if (ruleIds.length > 0) {
    const existingActive = await prisma.task.findMany({
      where: {
        taskRuleId: { in: ruleIds },
        isArchived: false,
      },
      select: {
        taskRuleId: true, entityType: true, entityId: true,
        status: true, metadata: true,
      },
    });
    for (const t of existingActive) {
      // Engine-retired tasks do NOT occupy the dedup slot. When an order
      // regresses out of a rule's statusIn (e.g. SAMPLE_DELIVERED back to
      // SAMPLE_COLLECTED on a re-collection), the retirer cancels the task;
      // if the order later re-enters the rule's statusIn, the rule must be
      // able to fire again. Before this fix the cancelled row blocked
      // re-creation until the nightly archive swept it — orders like #65167
      // (July 2026) sat days without any open task or follow-up.
      //
      // Deliberately narrow: ONLY autoRetiredByEngine cancels are excluded.
      // Human-cancelled tasks still dedupe — an operator's "don't chase
      // this" decision must not be overridden by the next poll cycle.
      const isEngineRetired =
        t.status === TaskStatus.CANCELLED &&
        !!(t.metadata as Record<string, unknown> | null)?.autoRetiredByEngine;
      if (isEngineRetired) continue;
      activeTaskKeys.add(`${t.entityType}|${t.taskRuleId}|${t.entityId}`);
    }
  }
  const dedupKey = (entityType: string, ruleId: string, entityId: number) =>
    `${entityType}|${ruleId}|${entityId}`;

  for (const order of orders) {
    // Orders without an appointmentTime (e.g. some order types that aren't
    // appointment-driven) don't get age-gated — let the rule's own trigger
    // conditions decide whether they're eligible. Previously a null
    // appointmentTime collapsed to 1970 → "very old" → skipped silently.
    const appointmentTs = asValidDate(order.appointmentTime);
    // The age/future window is an ORDER-scheduling concept (don't surface an
    // order until its collection appointment is near). Non-Order entities carry
    // their own time semantics — an Appointment's appointmentDate is the event
    // itself, and a status-triggered "confirm booking" rule must fire at
    // booking time no matter how far out the appointment is. So gate the window
    // to ORDER entities and let every other source's rule triggers decide.
    const isOrderEntity = (order.entityType ?? "ORDER") === "ORDER";
    if (appointmentTs && isOrderEntity) {
      const ageDays = (now.getTime() - appointmentTs.getTime()) / msPerDay; // +ve = past, -ve = future

      // Skip very old orders (appointment 10+ days in the past)
      if (ageDays > maxOrderAgeDays) {
        skipped++;
        continue;
      }

      // Skip far-future orders — agents don't need to act on these yet.
      // Negative ageDays means appointment is in the future; flip the sign.
      if (-ageDays > maxOrderFutureDays) {
        skipped++;
        continue;
      }
    }

    for (const rule of rules) {
      // Filter by allowed types (if any are specified)
      if (Array.isArray(rule.allowedTypes) && rule.allowedTypes.length > 0) {
        if (!rule.allowedTypes.includes(order.orderType)) {
          bumpRule(rule.id, "skippedTypeFilter");
          continue;
        }
      }

      if (!rule.isActive) {
        continue;
      }

      const cond = rule.triggerCondition as TriggerCondition;

      // Validate trigger condition structure
      if (!cond || typeof cond !== 'object') {
        console.warn(`[TaskCreator] Rule ${rule.id} has invalid trigger condition:`, cond);
        bumpRule(rule.id, "skippedTrigger");
        skipped++;
        continue;
      }

      // Handle STATUS vs TIME-triggered rules differently
      const triggerType = rule.triggerType ?? "TIME";
      let shouldCreate = false;
      // W3 — capture the facts that caused this rule to fire so we can
      // stamp them on the task's metadata (read by "Why this task?" panel).
      let matchedFacts: TriggerMatchedFact[] = [];

      if (triggerType === "STATUS") {
        // STATUS-triggered: Create only if status matches (no time checks)
        if (Array.isArray(cond.statusIn) && cond.statusIn.includes(order.orderStatus)) {
          shouldCreate = true;
          matchedFacts = [{
            check: "statusIn",
            detail: `order is in ${order.orderStatus} (status-trigger rule)`,
          }];
        }
      } else {
        // TIME-triggered: Check all conditions. evaluateTrigger returns the
        // matched facts on success; the simulator endpoint surfaces failed
        // checks with reason strings.
        const result = evaluateTrigger(order, cond, now);
        if (result.matches) {
          shouldCreate = true;
          matchedFacts = result.matchedFacts;
        }
      }

      if (!shouldCreate) {
        bumpRule(rule.id, "skippedTrigger");
        skipped++;
        continue;
      }

      // W2.1 — dedup via the pre-loaded Set instead of a per-iteration query.
      // Key on the entity's real type (order.entityType, e.g. "APPOINTMENT"),
      // NOT a hardcoded "ORDER" — otherwise the pre-loaded keys (built from the
      // task's stored entityType) never match and every cycle re-creates the
      // same non-Order task. Defaults to "ORDER" for the legacy Order poller.
      const key = dedupKey(order.entityType ?? "ORDER", rule.id, order.id);
      if (activeTaskKeys.has(key)) {
        bumpRule(rule.id, "skippedDedup");
        skipped++;
        continue;
      }
      // Mark as taken so a later rule in this same cycle that targets the
      // same (rule, order) — vanishingly rare, but possible — also dedupes.
      activeTaskKeys.add(key);

      // ── SLA deadline ────────────────────────────────────────────────
      // For appointment-anchored time triggers, anchor on the appointment
      // instead of `now`. The previous behaviour (slaDeadline = now +
      // slaMinutes) created false urgency on rules that fired hours
      // before their work was actually due — driving "ack-and-snooze"
      // theatre to clear breach badges that didn't reflect real intent.
      //
      //   minutesAfterAppointment  → deadline = appt + (minutesAfter + slaMinutes)
      //                              (the rule's grace period beyond the
      //                              trigger moment)
      //   minutesBeforeAppointment → deadline = appointmentTime
      //                              (the implicit "by-then" deadline;
      //                              slaMinutes is the firing-window, not
      //                              the deadline grace)
      //   anything else            → deadline = now + slaMinutes (unchanged;
      //                              status-only and stale-status triggers
      //                              still need a fresh ticking clock)
      //
      // Safety floor: the resulting deadline is clamped to at least
      // now + 1 minute so a late poll cycle doesn't BREACH-at-birth.
      const triggerCond = (rule.triggerCondition ?? {}) as Record<string, unknown>;
      const minutesAfterAppt =
        typeof triggerCond.minutesAfterAppointment === "number"
          ? triggerCond.minutesAfterAppointment
          : null;
      const minutesBeforeAppt =
        typeof triggerCond.minutesBeforeAppointment === "number"
          ? triggerCond.minutesBeforeAppointment
          : null;

      let slaDeadline: Date;
      if (minutesAfterAppt !== null && appointmentTs) {
        slaDeadline = new Date(
          appointmentTs.getTime() + (minutesAfterAppt + rule.slaMinutes) * 60_000
        );
      } else if (minutesBeforeAppt !== null && appointmentTs) {
        slaDeadline = appointmentTs;
      } else {
        slaDeadline = new Date(now.getTime() + rule.slaMinutes * 60_000);
      }
      // Clamp: never set a deadline already in the past at creation.
      const minDeadline = now.getTime() + 60_000;
      if (slaDeadline.getTime() < minDeadline) {
        slaDeadline = new Date(minDeadline);
      }

      // Use the shared, regex-based substituter — handles repeated tokens
      // (the inline `.replace(string, ...)` only swapped the first match)
      // and renders unknown placeholders as `[missing: key]` so a typo or
      // newly-added rule placeholder fails loudly instead of leaking
      // `{{patientName}}` into user-visible task titles + alert messages.
      const title = renderTitleTemplate(rule.titleTemplate, {
        // Source-specific fields first (raw columns for non-Order sources —
        // e.g. an Appointment's appointmentType / referenceId — carried on
        // order.metadata), so a rule can template on its own source's fields.
        // The named fields below win on any key collision.
        ...(order.metadata && typeof order.metadata === "object" ? (order.metadata as Record<string, unknown>) : {}),
        patientName: order.patientName,
        orderId: order.id,
        storeName: order.storeName,
        labName: order.labName,
        phleboName: order.phleboName,
        appointmentTime: order.appointmentTime,
      });

      const payload: CreateTaskPayload = {
        taskRuleId: rule.id,
        taskTypeId: rule.taskTypeId,
        title,
        // Honour entityType from RawOrder when the caller sets it (e.g.
        // demo's Appointments fetcher passes "APPOINTMENTS"). Defaults
        // to "ORDER" since the legacy Lab-Orders poller never sets it.
        entityType: order.entityType ?? "ORDER",
        entityId: order.id,
        storeId: order.storeId,
        orderType: order.orderType,
        dataSourceId: rule.dataSourceId,
        // W4.2 — pass strategy down so pickAssignee can branch.
        assignmentStrategy: rule.assignmentStrategy as CreateTaskPayload["assignmentStrategy"],
        priority: rule.priority,
        slaDeadline,
        // Propagate the source order's scheduled time onto the Task row so
        // downstream sorting/bucketing (today/tomorrow/stuck in MyWorkBoard)
        // can use it directly without parsing metadata. Previously only
        // present in metadata, which left task.appointmentTime always null
        // and broke the new My Work view's time-based bucketing.
        appointmentTime: appointmentTs,
        metadata: {
          orderId: order.id,
          orderStatus: order.orderStatus,
          appointmentTime: order.appointmentTime,
          patientName: order.patientName,
          labName: order.labName,
          storeName: order.storeName,
          phleboName: order.phleboName,
          phleboNumber: order.phleboNumber,
          // W3 — "Why this task?" payload. Read verbatim by the agent
          // panel; do not embed ids the agent shouldn't see.
          whyThisTask: {
            ruleId: rule.id,
            ruleName: rule.name,
            triggerType,
            matchedFacts,
            evaluatedAt: now.toISOString(),
          },
          // Task-level next-step guidance — rule's own overrides the task-type
          // default, snapshotted so the drawer shows "what to do next".
          nextStep: {
            complete: rule.nextStepComplete ?? rule.taskType.nextStepComplete ?? null,
            incomplete: rule.nextStepIncomplete ?? rule.taskType.nextStepIncomplete ?? null,
          },
        },
        // Prefer the rule's OWN checklist; fall back to the task-type default
        // when the rule hasn't customised it. (Fixes cross-rule contamination.)
        checklistSteps: (rule.checklist && rule.checklist.length > 0
          ? rule.checklist
          : rule.taskType.checklistItems
        ).map((ci) => ({
          stepOrder: ci.stepOrder,
          stepText: ci.stepText,
          isRequired: ci.isRequired,
          guidance: ci.guidance ?? null,
          script: ci.script ?? null,
        })),
      };

      // Per-task error isolation (July 2026 incident): a single failed
      // insert used to throw out of this loop and abort the ENTIRE poll
      // cycle — killing task creation for every other order AND the
      // retirer/SLA watcher downstream (which is how 176 stale
      // confirm-booking tasks accumulated while cycles logged ERROR).
      // One bad task is one bad task; the cycle must survive it.
      try {
        const { outcome, creation } = await createTask(payload);
        if (creation === "skipped") {
          bumpRule(rule.id, "skippedDedup");
          continue;
        }
        bumpRule(rule.id, "fired");
        if (!outcome.ok) {
          bumpRule(rule.id, "failedAssignment");
        }
        created++;
      } catch (err) {
        bumpRule(rule.id, "failedCreate");
        console.error(
          `[taskCreator] create failed for rule=${rule.id} entity=${order.id} — continuing cycle (non-fatal):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return { created, skipped, perRule: Array.from(perRule.values()) };
}

// ── Active rules loader ───────────────────────────────────────────────────────

export async function loadActiveRules(): Promise<TaskRuleWithRelations[]> {
  const rules = await prisma.taskRule.findMany({
    where: { isActive: true },
    include: {
      requiredSkills: {
        include: { skillTag: { select: { name: true } } },
      },
      // The rule's OWN checklist (rule-scoped rows). Preferred over the
      // task-type default when present.
      checklist: {
        orderBy: { stepOrder: "asc" },
      },
      taskType: {
        include: {
          // Task-type DEFAULT rows only (taskRuleId = null) — used when a rule
          // has no rule-scoped checklist of its own yet.
          checklistItems: {
            where: { taskRuleId: null },
            orderBy: { stepOrder: "asc" },
          },
        },
      },
    },
  });

  // Defensive load: if a rule has a malformed `triggerCondition` (legacy
  // row, direct DB write, etc.) the engine should skip it loudly rather
  // than crash mid-poll. zod-parse here so the rest of the file can rely
  // on the shape; field-by-field validation is the same one POST/PATCH use.
  const mapped = rules
    .map((r) => {
      const parsed = triggerConditionSchema.safeParse(r.triggerCondition);
      if (!parsed.success) {
        console.warn(
          `[loadActiveRules] Skipping rule '${r.name}' (id=${r.id}) — triggerCondition fails validation:`,
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        );
        return null;
      }
      return {
        ...r,
        // triggerType is now properly typed by Prisma (schema field
        // TaskRuleTriggerType @default(TIME)); no cast needed.
        triggerType: r.triggerType,
        triggerCondition: parsed.data as unknown as TriggerCondition,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null) as TaskRuleWithRelations[];

  return mapped;
}

// ── Archive obsolete tasks (DEPRECATED — see W3) ─────────────────────────────
//
// `archiveObsoleteTasks` used to run inside every poll cycle, looping orders
// and querying tasks per order to archive those whose orders were >10 days
// old. The audit flagged it as a duplicate of `archiveOldTasks`
// (lib/engine/taskArchiver.ts) which does the same job in a single SQL
// UPDATE on a nightly cron. Two implementations of one job, the per-cycle
// one being O(N×M) for free.
//
// W3 — the per-cycle path is removed. `archiveOldTasks` (nightly at 02:00)
// is the single source of truth. If a fresh-archive case ever needs to run
// during a cycle, call `archiveOldTasks()` directly from the poller — it's
// already a single statement.
