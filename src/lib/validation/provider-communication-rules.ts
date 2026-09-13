/**
 * zod schemas for the Provider Communication Rules API.
 *
 * Same split as lib/validation/task-rules.ts, for the same reasons: POST and
 * PATCH share one parser so they cannot drift, and every bound exists to stop
 * a typo becoming a scheduling bug rather than a validation error.
 *
 * Two constraints here are policy, not hygiene, and both are load-bearing:
 *
 *   - an ORDER-anchored offset must be positive, and an APPOINTMENT-anchored
 *     offset must be zero or negative. The anchors read as "N after the order"
 *     and "N before the appointment"; a negative order offset would schedule a
 *     message before the order existed, and a positive appointment offset
 *     would schedule one the planner drops on the spot (nothing is ever
 *     scheduled past the appointment).
 *
 *   - a send window must open before it closes. Wrapping windows ("22:00 to
 *     06:00") are rejected rather than silently reinterpreted, because a rule
 *     that quietly means the opposite of what it reads is worse than an error.
 *
 * Template and lab existence need database lookups, so they live in
 * `validateRuleTargets()` and routes call both.
 */

import { z } from "zod";
import prisma from "@/lib/db/client";

// ── Tunable bounds ──────────────────────────────────────────────────────────
/** One week either side of an anchor. Beyond that it is a typo, not a policy. */
export const OFFSET_MINUTES_MAX = 7 * 24 * 60;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 4;
/** Quiet gaps and appointment run-ups are minutes-to-hours concerns. */
export const GAP_MINUTES_MAX = 24 * 60;

export const ANCHORS = ["ORDER", "APPOINTMENT"] as const;
export const ACTIONS = ["SEND_REMINDER", "ESCALATE"] as const;
export const RECIPIENTS = ["LAB", "MANAGER"] as const;

/** Every workflow status a rule may legitimately be gated on. */
export const WORKFLOW_STATUSES = [
  "WAITING_FOR_LAB_CONFIRMATION",
  "ESCALATED",
  "LAB_ACCEPTED",
  "LAB_RESCHEDULE_REQUESTED",
  "LAB_REJECTED",
] as const;

const hour = z.coerce.number().int().min(0).max(23);

const sendWindowSchema = z
  .object({ startHour: hour, endHour: z.coerce.number().int().min(1).max(24) })
  .refine((window) => window.startHour < window.endHour, {
    message: "The send window must open before it closes",
    path: ["endHour"],
  });

export const sendConditionSchema = z.object({
  workflowStatusIn: z.array(z.enum(WORKFLOW_STATUSES)).optional(),
  sourceStatusIn: z.array(z.string().min(1).max(64)).optional(),
  requireAppointment: z.boolean().optional(),
  skipWithinMinutesOfAppointment: z.coerce.number().int().min(0).max(GAP_MINUTES_MAX).optional(),
  minMinutesSinceLastMessage: z.coerce.number().int().min(0).max(GAP_MINUTES_MAX).optional(),
  sendWindow: sendWindowSchema.optional(),
});

export type SendConditionInput = z.infer<typeof sendConditionSchema>;

const SLA_MILESTONES = [
  "ORDER_CONFIRMED", "PHLEBO_ASSIGNED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "REPORT_UPLOADED",
] as const;

const ruleShape = {
  name: z.string().min(1).max(120).transform((value) => value.trim()),
  anchor: z.enum(ANCHORS),
  action: z.enum(ACTIONS),
  offsetMinutes: z.coerce.number().int().min(-OFFSET_MINUTES_MAX).max(OFFSET_MINUTES_MAX),
  priority: z.coerce.number().int().min(PRIORITY_MIN).max(PRIORITY_MAX).default(4),
  templateKey: z.string().min(1).max(120).transform((value) => value.trim()),
  recipient: z.enum(RECIPIENTS).default("LAB"),
  allowedLabIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
  allowedOrderTypes: z.array(z.string().min(1).max(64)).max(50).default([]),
  sendCondition: sendConditionSchema.default({}),
  /** Drafts land inactive: saved, reviewable, and unable to message anyone. */
  isDraft: z.boolean().default(false),
  /** RELATIVE_DELAY = a timed sequence step. SLA_BREACH = a milestone watcher. */
  triggerKind: z.enum(["RELATIVE_DELAY", "SLA_BREACH"]).default("RELATIVE_DELAY"),
  slaMilestone: z.enum(SLA_MILESTONES).nullish(),
  /** Per-step cadence overrides. Null inherits the lab's milestone config. */
  repeatIntervalMinutes: z.coerce.number().int().min(5).max(1440).nullish(),
  maxAttempts: z.coerce.number().int().min(1).max(10).nullish(),
};

/**
 * The anchor decides which sign the offset may carry. See the header note.
 *
 * A breach step is exempt: its timing comes from the lab's SlaMilestoneConfig
 * (anchor + signed offset per milestone), so its own anchor/offset pair is
 * inert and would otherwise have to be filled with a lie to pass this check.
 */
function anchorAndOffsetAgree<T extends { anchor: string; offsetMinutes: number; triggerKind?: string }>(rule: T): boolean {
  if (rule.triggerKind === "SLA_BREACH") return true;
  return rule.anchor === "ORDER" ? rule.offsetMinutes > 0 : rule.offsetMinutes <= 0;
}

/** A milestone is required exactly when the step is a breach watcher. */
function milestoneMatchesTrigger<T extends { triggerKind?: string; slaMilestone?: string | null }>(rule: T): boolean {
  const isBreach = rule.triggerKind === "SLA_BREACH";
  return isBreach === Boolean(rule.slaMilestone);
}

const MILESTONE_TRIGGER_MESSAGE =
  "A breach step needs a milestone, and a sequence step must not carry one";

const ANCHOR_OFFSET_MESSAGE =
  "An order-anchored rule needs a positive offset (minutes after the order); an appointment-anchored rule needs zero or a negative offset (minutes before the appointment)";

export const createRuleSchema = z
  .object(ruleShape)
  .refine(anchorAndOffsetAgree, { message: ANCHOR_OFFSET_MESSAGE, path: ["offsetMinutes"] })
  .refine(milestoneMatchesTrigger, { message: MILESTONE_TRIGGER_MESSAGE, path: ["slaMilestone"] });

export type CreateCommunicationRuleInput = z.infer<typeof createRuleSchema>;

/**
 * PATCH semantics: only the sent fields change. The anchor/offset pair has to
 * be re-checked against the merged result, which a partial schema cannot see —
 * so the route merges first and calls `assertAnchorOffset` on the outcome.
 */
export const updateRuleSchema = z
  .object(ruleShape)
  .partial()
  .extend({ isActive: z.boolean().optional() });

export type UpdateCommunicationRuleInput = z.infer<typeof updateRuleSchema>;

export function assertMilestoneTrigger(rule: { triggerKind?: string; slaMilestone?: string | null }): string | null {
  return milestoneMatchesTrigger(rule) ? null : MILESTONE_TRIGGER_MESSAGE;
}

export function assertAnchorOffset(rule: { anchor: string; offsetMinutes: number; triggerKind?: string }): string | null {
  return anchorAndOffsetAgree(rule) ? null : ANCHOR_OFFSET_MESSAGE;
}

/** Flatten a ZodError into the { error, details } shape the drawer renders. */
export function zodErrorToResponse(error: z.ZodError) {
  const first = error.issues[0];
  return {
    error: first?.message ?? "Invalid rule",
    code: "VALIDATION_ERROR" as const,
    details: {
      field: first?.path.join(".") ?? "",
      reason: first?.message ?? "",
      issues: error.issues.map((issue) => ({ field: issue.path.join("."), reason: issue.message })),
    },
  };
}

// ── Database-backed checks ──────────────────────────────────────────────────

export type TargetValidationResult =
  | { valid: true }
  | { valid: false; error: string; field: "templateKey" | "allowedLabIds" };

/**
 * A rule that points at a deleted template or an unconfigured lab is a rule
 * that fails at 2am inside the scheduler, where the only symptom is a missing
 * message. Cheaper to reject it at save time.
 *
 * Drafts are held to the same standard: the whole point of a draft is that the
 * author comes back to a rule that will work when they activate it.
 */
export async function validateRuleTargets(input: {
  templateKey: string;
  allowedLabIds: number[];
}): Promise<TargetValidationResult> {
  const template = await prisma.labCommunicationTemplate.findUnique({
    where: { key: input.templateKey },
    select: { key: true, isActive: true },
  });
  if (!template) return { valid: false, error: `Message template "${input.templateKey}" does not exist`, field: "templateKey" };
  if (!template.isActive) return { valid: false, error: `Message template "${input.templateKey}" is inactive`, field: "templateKey" };

  if (input.allowedLabIds.length > 0) {
    const configured = await prisma.nonApiLabConfig.findMany({
      where: { labId: { in: input.allowedLabIds }, integrationType: "NON_API" },
      select: { labId: true },
    });
    const known = new Set(configured.map((lab) => lab.labId));
    const unknown = input.allowedLabIds.filter((labId) => !known.has(labId));
    if (unknown.length > 0) {
      return {
        valid: false,
        error: `No provider configuration for lab ${unknown.map((labId) => `#${labId}`).join(", ")}`,
        field: "allowedLabIds",
      };
    }
  }

  return { valid: true };
}
