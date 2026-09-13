import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import {
  ensureDefaultMilestoneConfigs,
  loadEffectiveConfigsForLab,
  loadProviderCommsSettings,
} from "@/lib/provider-comms/sla-config";
import { MILESTONE_LABELS, MILESTONE_SEQUENCE } from "@/lib/provider-comms/milestones";
import { validateMilestoneConfig } from "@/lib/validation/sla-milestone";

function forbidden(requestId: string) {
  return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
}

/**
 * GET /api/provider-comms/sla-config?labId=123
 *
 * The effective config for a lab — its own rows with the global defaults
 * folded in — plus which rows are inherited, so the screen can show "using
 * the default" rather than making an operator diff two lists in their head.
 * Omitting labId returns the global defaults themselves.
 */
export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return forbidden(requestId);

    await ensureDefaultMilestoneConfigs();
    const settings = await loadProviderCommsSettings();

    const raw = request.nextUrl.searchParams.get("labId");
    const labId = raw === null ? null : Number(raw);
    if (raw !== null && (!Number.isInteger(labId) || labId! < 1)) {
      return NextResponse.json({ error: "Invalid lab id", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    }

    const configs = labId === null
      ? (await prisma.slaMilestoneConfig.findMany({ where: { labId: null } })).map((row) => ({
          milestone: row.milestone, anchor: row.anchor, offsetMinutes: row.offsetMinutes,
          enabled: row.enabled, repeatIntervalMinutes: row.repeatIntervalMinutes,
          maxAttempts: row.maxAttempts, ignoreQuietHours: row.ignoreQuietHours, inherited: false,
        }))
      : await loadEffectiveConfigsForLab(labId);

    // Which milestones have a breach step pointed at this lab. A milestone can
    // be enabled and still never fire without one, so the screen says so
    // rather than leaving an operator to wonder.
    const steps = await prisma.providerCommunicationRule.findMany({
      where: { isActive: true, triggerKind: "SLA_BREACH", slaMilestone: { not: null } },
      select: { slaMilestone: true, allowedLabIds: true },
    });
    const covered = new Set(
      steps
        .filter((step) => {
          if (labId === null) return true;
          const ids = Array.isArray(step.allowedLabIds) ? (step.allowedLabIds as number[]) : [];
          return ids.length === 0 || ids.includes(labId);
        })
        .map((step) => step.slaMilestone!),
    );

    return NextResponse.json({
      labId,
      settings,
      milestones: MILESTONE_SEQUENCE.map((milestone) => ({
        milestone,
        label: MILESTONE_LABELS[milestone],
        hasBreachStep: covered.has(milestone),
        config: configs.find((c) => c.milestone === milestone) ?? null,
      })),
    });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "SlaConfigAPI.GET", code: "FETCH_ERROR", userMessage: "Failed to load SLA configuration", error }), { status: 500 });
  }
}

/**
 * PUT /api/provider-comms/sla-config — upsert one (lab, milestone) row.
 * `labId: null` edits the global default.
 */
export async function PUT(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return forbidden(requestId);

    const parsed = validateMilestoneConfig(await request.json().catch(() => ({})));
    if (!parsed.ok) {
      return NextResponse.json({ error: "Invalid SLA configuration", code: "VALIDATION_ERROR", requestId, details: parsed.errors }, { status: 400 });
    }
    const { labId, milestone, ...data } = parsed.data;

    // findFirst + create/update rather than upsert: the unique index over
    // (labId, milestone) does not constrain the global rows, where labId is
    // NULL — Postgres treats NULLs as distinct. A partial unique index
    // enforces the single global row; this keeps Prisma's path agreeing.
    const existing = await prisma.slaMilestoneConfig.findFirst({ where: { labId, milestone }, select: { id: true } });
    const config = existing
      ? await prisma.slaMilestoneConfig.update({ where: { id: existing.id }, data })
      : await prisma.slaMilestoneConfig.create({ data: { labId, milestone, ...data } });

    return NextResponse.json({ config });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "SlaConfigAPI.PUT", code: "UPDATE_ERROR", userMessage: "Failed to save SLA configuration", error }), { status: 500 });
  }
}

/**
 * DELETE /api/provider-comms/sla-config?labId=123&milestone=ORDER_CONFIRMED
 * Drops a lab's override so it inherits the global default again. The global
 * rows themselves are not deletable — there would be nothing left to inherit.
 */
export async function DELETE(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return forbidden(requestId);

    const labId = Number(request.nextUrl.searchParams.get("labId"));
    const milestone = request.nextUrl.searchParams.get("milestone");
    if (!Number.isInteger(labId) || labId < 1) {
      return NextResponse.json({ error: "A lab id is required — global defaults cannot be reset", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    }
    if (!milestone || !MILESTONE_SEQUENCE.includes(milestone as never)) {
      return NextResponse.json({ error: "Unknown milestone", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    }

    await prisma.slaMilestoneConfig.deleteMany({ where: { labId, milestone: milestone as never } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "SlaConfigAPI.DELETE", code: "DELETE_ERROR", userMessage: "Failed to reset SLA configuration", error }), { status: 500 });
  }
}
