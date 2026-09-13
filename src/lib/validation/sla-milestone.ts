/**
 * Validation for milestone SLA configuration.
 *
 * Two bounds here are deliberate rather than arbitrary:
 *
 *   offsetMinutes is SIGNED. A negative offset is the whole point of the
 *   APPOINTMENT_TIME anchor — "phlebotomist assigned" is due sixty minutes
 *   BEFORE the visit, not after it. So this cannot reuse the positive-int
 *   helpers used elsewhere in this module.
 *
 *   maxAttempts has a floor of 1, not 0. Zero would silently disable the
 *   milestone while `enabled` still read as true, which is exactly the kind
 *   of config that looks switched on and sends nothing.
 */
import type { SlaAnchor, SlaMilestone } from "@prisma/client";

const MILESTONES: readonly string[] = [
  "ORDER_CONFIRMED", "PHLEBO_ASSIGNED", "SAMPLE_COLLECTED", "SAMPLE_DELIVERED", "REPORT_UPLOADED",
];
const ANCHORS: readonly string[] = ["ORDER_CREATED", "APPOINTMENT_TIME", "PREV_MILESTONE_COMPLETED"];

/** ±14 days in minutes. Wide enough for a report TAT, narrow enough to catch a unit slip. */
const MAX_OFFSET_MINUTES = 14 * 24 * 60;

export type MilestoneConfigInput = Record<string, unknown>;

export type ValidatedMilestoneConfig = {
  labId: number | null;
  milestone: SlaMilestone;
  anchor: SlaAnchor;
  offsetMinutes: number;
  enabled: boolean;
  repeatIntervalMinutes: number;
  maxAttempts: number;
  ignoreQuietHours: boolean;
};

export function validateMilestoneConfig(
  input: MilestoneConfigInput,
): { ok: true; data: ValidatedMilestoneConfig } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  // null is meaningful: it addresses the global default row.
  let labId: number | null = null;
  if (input.labId !== null && input.labId !== undefined) {
    const value = Number(input.labId);
    if (!Number.isInteger(value) || value < 1) errors.labId = "must be a positive whole number, or null for the global default";
    else labId = value;
  }

  const milestone = typeof input.milestone === "string" ? input.milestone : "";
  if (!MILESTONES.includes(milestone)) errors.milestone = `must be one of ${MILESTONES.join(", ")}`;

  const anchor = typeof input.anchor === "string" ? input.anchor : "";
  if (!ANCHORS.includes(anchor)) errors.anchor = `must be one of ${ANCHORS.join(", ")}`;

  const offsetMinutes = Number(input.offsetMinutes);
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
    errors.offsetMinutes = `must be a whole number of minutes between -${MAX_OFFSET_MINUTES} and ${MAX_OFFSET_MINUTES}`;
  }
  // A negative offset only means anything against a fixed future instant.
  if (offsetMinutes < 0 && anchor !== "APPOINTMENT_TIME") {
    errors.offsetMinutes = "a negative offset only makes sense against the appointment time";
  }

  const repeatIntervalMinutes = Number(input.repeatIntervalMinutes ?? 30);
  if (!Number.isInteger(repeatIntervalMinutes) || repeatIntervalMinutes < 5 || repeatIntervalMinutes > 1440) {
    errors.repeatIntervalMinutes = "must be between 5 and 1440 minutes";
  }

  const maxAttempts = Number(input.maxAttempts ?? 3);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    errors.maxAttempts = "must be between 1 and 10";
  }

  for (const field of ["enabled", "ignoreQuietHours"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") errors[field] = "must be true or false";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      labId,
      milestone: milestone as SlaMilestone,
      anchor: anchor as SlaAnchor,
      offsetMinutes,
      enabled: typeof input.enabled === "boolean" ? input.enabled : false,
      repeatIntervalMinutes,
      maxAttempts,
      ignoreQuietHours: typeof input.ignoreQuietHours === "boolean" ? input.ignoreQuietHours : false,
    },
  };
}
