/**
 * Per-lab milestone SLA config, and the deadline it produces.
 *
 * Two things live here because they are the same decision seen from two
 * sides: which rules apply to a lab, and what instant they resolve to.
 *
 * Resolution order for a (lab, milestone) pair is the lab's own row, then the
 * global default (`labId = NULL`), then nothing. A lab row overrides the
 * default wholesale — it is not a partial merge, because a half-inherited
 * cadence is impossible to reason about when reading a breach after the fact.
 */
import prisma from "@/lib/db/client";
import type { SlaAnchor, SlaMilestone, SlaMilestoneConfig } from "@prisma/client";
import { MILESTONE_SEQUENCE, previousMilestoneCompletion, type MilestoneOrder } from "./milestones";

export interface EffectiveSlaConfig {
  milestone: SlaMilestone;
  anchor: SlaAnchor;
  offsetMinutes: number;
  enabled: boolean;
  repeatIntervalMinutes: number;
  maxAttempts: number;
  ignoreQuietHours: boolean;
  /** True when this came from the global row rather than a lab-specific one. */
  inherited: boolean;
}

export type ConfigsByLab = Map<number, EffectiveSlaConfig[]>;

function toEffective(row: SlaMilestoneConfig, inherited: boolean): EffectiveSlaConfig {
  return {
    milestone: row.milestone,
    anchor: row.anchor,
    offsetMinutes: row.offsetMinutes,
    enabled: row.enabled,
    repeatIntervalMinutes: row.repeatIntervalMinutes,
    maxAttempts: row.maxAttempts,
    ignoreQuietHours: row.ignoreQuietHours,
    inherited,
  };
}

/**
 * Effective config for a set of labs, global defaults already folded in.
 * One query for all labs rather than one per lab — the engine calls this once
 * per tick.
 */
export async function loadEffectiveConfigs(labIds: number[]): Promise<ConfigsByLab> {
  const rows = await prisma.slaMilestoneConfig.findMany({
    where: { OR: [{ labId: null }, { labId: { in: labIds } }] },
  });
  const globals = new Map<SlaMilestone, SlaMilestoneConfig>();
  const perLab = new Map<number, Map<SlaMilestone, SlaMilestoneConfig>>();
  for (const row of rows) {
    if (row.labId === null) {
      globals.set(row.milestone, row);
    } else {
      if (!perLab.has(row.labId)) perLab.set(row.labId, new Map());
      perLab.get(row.labId)!.set(row.milestone, row);
    }
  }

  const result: ConfigsByLab = new Map();
  for (const labId of labIds) {
    const own = perLab.get(labId);
    const effective: EffectiveSlaConfig[] = [];
    for (const milestone of MILESTONE_SEQUENCE) {
      const override = own?.get(milestone);
      if (override) { effective.push(toEffective(override, false)); continue; }
      const fallback = globals.get(milestone);
      if (fallback) effective.push(toEffective(fallback, true));
    }
    result.set(labId, effective);
  }
  return result;
}

/** Effective config for one lab, for the config screen. */
export async function loadEffectiveConfigsForLab(labId: number): Promise<EffectiveSlaConfig[]> {
  return (await loadEffectiveConfigs([labId])).get(labId) ?? [];
}

export type DeadlineResult =
  | { ok: true; deadlineAt: Date; basis: string }
  /** The anchor has no instant to hang off for this order. No breach is
   *  possible, and that is a fact about the order, not a failure. */
  | { ok: false; reason: string };

/**
 * The instant a milestone is due for one order.
 *
 * `offsetMinutes` is signed throughout: -60 means sixty minutes BEFORE the
 * anchor. Minutes, always — never a bare number that could read as hours.
 */
export function computeDeadline(
  order: MilestoneOrder,
  config: EffectiveSlaConfig,
): DeadlineResult {
  const offsetMs = config.offsetMinutes * 60_000;

  if (config.anchor === "ORDER_CREATED") {
    return { ok: true, deadlineAt: new Date(order.createdAt.getTime() + offsetMs), basis: "ORDER_CREATED" };
  }

  if (config.anchor === "APPOINTMENT_TIME") {
    // Nullable in LabStack, and a home-collection order can legitimately have
    // no appointment yet. Anchoring to "now" would breach instantly, so the
    // milestone simply does not apply until an appointment exists.
    if (!order.appointmentTime) return { ok: false, reason: "Order has no appointment time" };
    return { ok: true, deadlineAt: new Date(order.appointmentTime.getTime() + offsetMs), basis: "APPOINTMENT_TIME" };
  }

  const previous = previousMilestoneCompletion(order, config.milestone);
  if (!previous) {
    return { ok: false, reason: `No completed earlier milestone to anchor ${config.milestone} to yet` };
  }
  return {
    ok: true,
    deadlineAt: new Date(previous.at.getTime() + offsetMs),
    // Names the milestone that actually supplied the instant, which is not
    // always the immediately-previous one — see previousMilestoneCompletion.
    basis: `PREV:${previous.from}`,
  };
}

/**
 * The shipped defaults, all disabled.
 *
 * Seeded as the global (`labId: NULL`) row for each milestone so a lab with
 * no configuration of its own still has something coherent to inherit and
 * display. Nothing fires until a human enables a milestone AND the global
 * kill switch, which ships off.
 */
export const DEFAULT_MILESTONE_CONFIGS: ReadonlyArray<{
  milestone: SlaMilestone;
  anchor: SlaAnchor;
  offsetMinutes: number;
  repeatIntervalMinutes: number;
  maxAttempts: number;
}> = [
  { milestone: "ORDER_CONFIRMED", anchor: "ORDER_CREATED", offsetMinutes: 60, repeatIntervalMinutes: 30, maxAttempts: 3 },
  // Before the appointment on purpose: an unassigned phlebotomist an hour out
  // is still recoverable, and at T+0 it is not.
  { milestone: "PHLEBO_ASSIGNED", anchor: "APPOINTMENT_TIME", offsetMinutes: -60, repeatIntervalMinutes: 20, maxAttempts: 3 },
  { milestone: "SAMPLE_COLLECTED", anchor: "APPOINTMENT_TIME", offsetMinutes: 30, repeatIntervalMinutes: 30, maxAttempts: 3 },
  { milestone: "SAMPLE_DELIVERED", anchor: "PREV_MILESTONE_COMPLETED", offsetMinutes: 180, repeatIntervalMinutes: 60, maxAttempts: 3 },
  { milestone: "REPORT_UPLOADED", anchor: "PREV_MILESTONE_COMPLETED", offsetMinutes: 1440, repeatIntervalMinutes: 120, maxAttempts: 2 },
];

/** Create the global defaults if they are absent. Idempotent. */
export async function ensureDefaultMilestoneConfigs(): Promise<void> {
  for (const preset of DEFAULT_MILESTONE_CONFIGS) {
    const existing = await prisma.slaMilestoneConfig.findFirst({
      where: { labId: null, milestone: preset.milestone },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.slaMilestoneConfig.create({
      data: { labId: null, enabled: false, ignoreQuietHours: false, ...preset },
    });
  }
}

/** The settings singleton, created on first read. */
export async function loadProviderCommsSettings() {
  return prisma.providerCommsSettings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
}
