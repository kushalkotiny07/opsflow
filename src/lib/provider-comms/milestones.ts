/**
 * What proves a milestone is done — the single source of truth for the whole
 * SLA-breach feature.
 *
 * Everything else reads milestone state only through `resolveMilestoneState`.
 * That matters because the answer is not uniform: two milestones have a
 * dedicated timestamp in LabStack, two are provable only from the order's
 * current status, and one has no replica signal at all.
 *
 * ── Status is a RANK, not a value ────────────────────────────────────────
 * `public."Order"."orderStatus"` is a progressive enum. An order that moves
 * from SAMPLE_COLLECTED to REPORT_READY between two ticks has plainly passed
 * SAMPLE_DELIVERED, even though it never equalled it. Comparing for equality
 * would report that milestone incomplete and breach an order that is running
 * *ahead* of schedule — so completion is always "at or beyond this rank".
 *
 * ── completedAt is sometimes unknowable, and that is not the same as
 *    incomplete ────────────────────────────────────────────────────────────
 * The replica keeps only the CURRENT status and `statusUpdatedAt`. Once an
 * order moves on, the instant it passed an earlier milestone is gone unless
 * that milestone has its own column. So `complete: true, completedAt: null`
 * is a real and common answer, and any caller that needs an instant (the
 * PREV_MILESTONE_COMPLETED anchor) has to handle it rather than assume.
 */
import type { SlaMilestone } from "@prisma/client";

/** The order fields this module needs. A subset of LabStack's public."Order". */
export interface MilestoneOrder {
  id: number;
  orderStatus: string;
  createdAt: Date;
  appointmentTime: Date | null;
  statusUpdatedAt: Date | null;
  sampleCollectedAt: Date | null;
  reportDeliveredAt: Date | null;
  /** OpsFlow-side acceptance, when a LabCommunicationWorkflow exists. */
  workflowAcceptedAt?: Date | null;
}

export interface MilestoneState {
  complete: boolean;
  /** Null when completion is certain but its instant is not recorded. */
  completedAt: Date | null;
  /** Why we believe it — surfaced in logs and the breach list. */
  source: string;
}

/**
 * Progressive order of LabStack's OrderStatus enum. Index is the rank.
 * PATIENT_MISSED and CANCELED are deliberately absent: they are terminal
 * outcomes, not progress, and are handled by `isTerminalStatus`.
 */
const STATUS_RANK: readonly string[] = [
  "ORDER_SCHEDULED",
  "RESCHEDULED",
  "PHLEBO_ASSIGNED",
  "PHLEBO_DISPATCHED",
  "PHLEBO_STARTED",
  "PATIENT_VISITED",
  "SAMPLE_COLLECTED",
  "SAMPLE_IN_TRANSIT",
  "SAMPLE_DELIVERED",
  "SAMPLE_PROCESSED",
  "PARTIAL_DELIVERED",
  "REPORT_READY",
  "REPORT_DELIVERED",
];

const TERMINAL_STATUSES = new Set(["CANCELED", "PATIENT_MISSED"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isCancelledStatus(status: string): boolean {
  return status === "CANCELED";
}

function rankOf(status: string): number {
  return STATUS_RANK.indexOf(status);
}

/** The status at or beyond which each milestone is certainly done. */
const MILESTONE_MIN_STATUS: Record<SlaMilestone, string> = {
  // Not ORDER_SCHEDULED or RESCHEDULED: those are LabStack's own scheduling,
  // which says nothing about the lab having taken the order. The first status
  // that only the lab can cause is PHLEBO_ASSIGNED.
  ORDER_CONFIRMED: "PHLEBO_ASSIGNED",
  PHLEBO_ASSIGNED: "PHLEBO_ASSIGNED",
  SAMPLE_COLLECTED: "SAMPLE_COLLECTED",
  SAMPLE_DELIVERED: "SAMPLE_DELIVERED",
  // "Uploaded" is REPORT_READY — REPORT_DELIVERED is a later, separate step.
  REPORT_UPLOADED: "REPORT_READY",
};

/** Chronological order, for the PREV_MILESTONE_COMPLETED anchor. */
export const MILESTONE_SEQUENCE: readonly SlaMilestone[] = [
  "ORDER_CONFIRMED",
  "PHLEBO_ASSIGNED",
  "SAMPLE_COLLECTED",
  "SAMPLE_DELIVERED",
  "REPORT_UPLOADED",
];

export const MILESTONE_LABELS: Record<SlaMilestone, string> = {
  ORDER_CONFIRMED: "Order confirmed",
  PHLEBO_ASSIGNED: "Phlebotomist assigned",
  SAMPLE_COLLECTED: "Sample collected",
  SAMPLE_DELIVERED: "Sample delivered to lab",
  REPORT_UPLOADED: "Report uploaded",
};

/**
 * Is this milestone verifiable from the data we actually have?
 *
 * All five are, for every lab — but ORDER_CONFIRMED is the weakest: for a
 * NON_API lab it has an explicit signal (the provider pressed Accept), while
 * for an API lab it can only be inferred from the order moving forward. Both
 * are real; the difference is recorded in `source` so a breach can be audited.
 */
export function isMilestoneVerifiable(_milestone: SlaMilestone): boolean {
  return true;
}

export function resolveMilestoneState(order: MilestoneOrder, milestone: SlaMilestone): MilestoneState {
  const rank = rankOf(order.orderStatus);
  const needed = rankOf(MILESTONE_MIN_STATUS[milestone]);

  // A terminal order never "completes" a milestone it had not already passed.
  // The engine cancels these events rather than resolving them, so returning
  // incomplete here is correct and the distinction is made by the caller.
  if (isTerminalStatus(order.orderStatus)) {
    return { complete: false, completedAt: null, source: `TERMINAL:${order.orderStatus}` };
  }

  // Unknown status — a value LabStack added that this build has not seen.
  // Refusing to guess is the safe answer: it cannot prove completion, and the
  // engine will not send on an order it cannot read.
  if (rank === -1) {
    return { complete: false, completedAt: null, source: `UNKNOWN_STATUS:${order.orderStatus}` };
  }

  // Dedicated timestamps first — the only precise answers available.
  if (milestone === "SAMPLE_COLLECTED" && order.sampleCollectedAt) {
    return { complete: true, completedAt: order.sampleCollectedAt, source: "COLUMN:sampleCollectedAt" };
  }
  if (milestone === "REPORT_UPLOADED" && order.reportDeliveredAt) {
    return { complete: true, completedAt: order.reportDeliveredAt, source: "COLUMN:reportDeliveredAt" };
  }

  // The provider pressing Accept is the strongest confirmation signal, and the
  // only one that exists before the order starts moving. NON_API labs only —
  // an API lab has no workflow and therefore no token to press.
  if (milestone === "ORDER_CONFIRMED" && order.workflowAcceptedAt) {
    return { complete: true, completedAt: order.workflowAcceptedAt, source: "WORKFLOW_ACCEPTED" };
  }

  if (rank >= needed) {
    // completedAt is only honest when the order is sitting ON the threshold
    // status: `statusUpdatedAt` is when it reached its CURRENT status, which
    // for a further-along order is a different, later milestone.
    const completedAt = rank === needed ? order.statusUpdatedAt ?? null : null;
    return { complete: true, completedAt, source: `STATUS:${order.orderStatus}` };
  }

  return { complete: false, completedAt: null, source: `STATUS:${order.orderStatus}` };
}

/**
 * The instant the milestone before `milestone` completed, for the
 * PREV_MILESTONE_COMPLETED anchor.
 *
 * Walks backwards past milestones whose completion instant is unrecorded.
 * REPORT_UPLOADED is the case that forces this: its predecessor
 * (SAMPLE_DELIVERED) has no timestamp column, so a strict reading would make
 * the anchor uncomputable and the milestone would never fire. Falling back to
 * the nearest recorded instant — in practice `sampleCollectedAt`, which is
 * also how report turnaround is measured operationally — keeps it usable, and
 * the milestone that actually supplied the anchor is returned so a deadline
 * can be explained rather than just asserted.
 */
export function previousMilestoneCompletion(
  order: MilestoneOrder,
  milestone: SlaMilestone,
): { at: Date; from: SlaMilestone } | null {
  const index = MILESTONE_SEQUENCE.indexOf(milestone);
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = MILESTONE_SEQUENCE[i];
    const state = resolveMilestoneState(order, candidate);
    if (state.complete && state.completedAt) return { at: state.completedAt, from: candidate };
  }
  return null;
}
