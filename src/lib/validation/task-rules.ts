/**
 * zod schemas for the Task Rules API.
 *
 * Replaces the hand-rolled validation that lived inline in
 * src/app/api/task-rules/{route,[id]/route}.ts. Two upgrades over the
 * previous behaviour:
 *
 *   1. POST and PATCH share the same parser, so they can no longer drift
 *      (POST used to skip the validateTriggerConditionStatuses check that
 *      PATCH applied).
 *
 *   2. We bound `slaMinutes` and `pollingIntervalMinutes` so a typo
 *      (e.g. "1000000") can no longer overflow Date arithmetic at task
 *      creation time.
 *
 * Status validation against a source's `statusFieldEnumValues` is done
 * separately by `validateStatusesAgainstSource()` because it needs a DB
 * lookup; zod can't do that synchronously. Routes call both.
 */

import { z } from "zod";
import { TaskPriority } from "@prisma/client";
import prisma from "@/lib/db/client";
import { introspectColumnValues, tableNameFromReference } from "@/lib/data-sources/column-enums";

// ── Tunable bounds ──────────────────────────────────────────────────────────
export const SLA_MINUTES_MIN = 1;
export const SLA_MINUTES_MAX = 60 * 24 * 30;     // 30 days; anything more is a typo
export const POLLING_INTERVAL_MIN = 1;
export const POLLING_INTERVAL_MAX = 60 * 24;     // 24h
export const TIMING_OFFSET_MAX = 60 * 24 * 30;   // sanity-cap on minutesSince*/Before*

// ── Metadata condition ──────────────────────────────────────────────────────
const metadataOperator = z.enum([
  "exists", "not_exists",
  "equals", "not_equals",
  "contains", "starts_with", "ends_with",
  ">", ">=", "<", "<=",
]);

// Operators that need a value (everything except the existence checks).
const VALUE_REQUIRED_OPS = new Set([
  "equals", "not_equals", "contains", "starts_with", "ends_with",
  ">", ">=", "<", "<=",
]);

const metadataCondition = z.object({
  fieldPath: z.string().min(1, "fieldPath is required"),
  operator: metadataOperator,
  value: z.unknown().optional(),
  offsetMinutes: z.number().int().min(-TIMING_OFFSET_MAX).max(TIMING_OFFSET_MAX).optional(),
}).refine(
  (mc) => !VALUE_REQUIRED_OPS.has(mc.operator) || mc.value !== undefined,
  { message: "metadataCondition value is required for this operator", path: ["value"] }
);

// ── Trigger condition ───────────────────────────────────────────────────────
export const triggerConditionSchema = z.object({
  statusIn: z.array(z.string().min(1)).min(1, "triggerCondition.statusIn must have at least one status"),
  metadataConditions: z.array(metadataCondition).optional(),
  minutesSinceCreated: z.number().int().min(0).max(TIMING_OFFSET_MAX).optional(),
  minutesSinceStatusUpdated: z.number().int().min(0).max(TIMING_OFFSET_MAX).optional(),
  minutesBeforeAppointment: z.number().int().min(0).max(TIMING_OFFSET_MAX).optional(),
  minutesAfterAppointment: z.number().int().min(0).max(TIMING_OFFSET_MAX).optional(),
  requiresNoPreviousTaskOfType: z.boolean().optional(),
}).passthrough(); // tolerate forward-compatible new fields

// ── Rule body — create ──────────────────────────────────────────────────────
// Must match the CHECK constraint on task_rules.assignmentStrategy.
export const ASSIGNMENT_STRATEGIES = [
  "default", "round_robin", "store_affinity", "skill_based", "least_loaded",
] as const;
export const assignmentStrategySchema = z.enum(ASSIGNMENT_STRATEGIES);

export const createRuleSchema = z.object({
  name: z.string().min(1).transform((s) => s.trim()),
  dataSourceId: z.string().min(1),
  titleTemplate: z.string().min(1).transform((s) => s.trim()),
  slaMinutes: z.coerce.number().int().min(SLA_MINUTES_MIN).max(SLA_MINUTES_MAX),
  priority: z.enum(Object.values(TaskPriority) as [string, ...string[]]),
  triggerCondition: triggerConditionSchema,

  // Optional with defaults
  taskTypeId: z.coerce.number().int().positive().optional(),
  allowedTypes: z.array(z.string().min(1)).default([]),
  allowedStatuses: z.array(z.string().min(1)).default([]),
  pollingIntervalMinutes: z.coerce.number().int().min(POLLING_INTERVAL_MIN).max(POLLING_INTERVAL_MAX).default(15),
  escalationChainId: z.coerce.number().int().nullable().optional(),
  skillTagIds: z.array(z.coerce.number().int().positive()).default([]),
  assignmentStrategy: assignmentStrategySchema.default("default"),
  isDraft: z.boolean().default(false),
});

export type CreateRuleInput = z.infer<typeof createRuleSchema>;

// ── Rule body — update (partial; all fields optional) ───────────────────────
// We use `.partial()` so PATCH semantics are preserved (only the fields the
// caller sends are updated), but reuse the same per-field constraints.
export const updateRuleSchema = createRuleSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

// ── Status validation against the source's enum ─────────────────────────────

export interface StatusValidationResult {
  valid: boolean;
  invalidStatuses?: string[];
  validStatuses?: string[];
}

/**
 * Validate that every status in `statusIn` is one the data source actually emits.
 *
 * Resolution order for the "valid values" set:
 *   1. The source's stored `statusFieldEnumValues` (captured at registration).
 *   2. Live introspection of the source's status column on the LABSTACK
 *      replica — the SAME query the rule builder's status dropdown uses, so
 *      the UI's offered values and the server's accepted values never drift.
 *
 * We deliberately do NOT fall back to a hardcoded `LabstackOrderStatus` list:
 * that list was stale (it invented SAMPLE_IN_TRANSIT / REPORT_READY and omitted
 * PENDING / CREATED / SAMPLE_PROCESSED), so a null-enum source — e.g. every
 * source registered before enum capture, or any non-order source like
 * Appointments / PharmaOrder — would wrongly reject perfectly valid statuses.
 *
 * If neither the stored enum nor live introspection yields any values (replica
 * down, unusual column type), we pass rather than block the save: the poller
 * simply won't match a status the source never emits, so a permissive save is
 * safer than a false rejection.
 */
export async function validateStatusesAgainstSource(
  dataSourceId: string,
  statusIn: string[]
): Promise<StatusValidationResult> {
  const ds = await prisma.dataSource.findUnique({
    where: { id: dataSourceId },
    select: { statusFieldEnumValues: true, tableReference: true, statusFieldName: true },
  });

  if (!ds) return { valid: false, invalidStatuses: statusIn };

  const enumValues = ds.statusFieldEnumValues as unknown;
  let sourceStatuses: string[] =
    Array.isArray(enumValues) && enumValues.length > 0
      ? (enumValues as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

  // No stored enum → introspect the live column so newly-registered / non-order
  // sources validate against their real statuses instead of a stale order list.
  if (sourceStatuses.length === 0) {
    sourceStatuses = await introspectColumnValues(
      tableNameFromReference(ds.tableReference),
      ds.statusFieldName,
    );
  }

  // Still nothing knowable → don't block the save (see doc comment).
  if (sourceStatuses.length === 0) return { valid: true };

  const validSet = new Set(sourceStatuses);
  const invalid = statusIn.filter((s) => !validSet.has(s));

  if (invalid.length === 0) return { valid: true };
  return { valid: false, invalidStatuses: invalid, validStatuses: sourceStatuses };
}

/**
 * Translate a zod ZodError to the API's standard validation envelope.
 * Routes call this in their catch block so callers always see the same shape.
 */
export function zodErrorToResponse(err: z.ZodError) {
  const first = err.issues[0];
  return {
    error: "Validation failed",
    code: "VALIDATION_ERROR" as const,
    details: {
      field: first?.path.join(".") || "(root)",
      reason: first?.message || "Invalid input",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
  };
}
