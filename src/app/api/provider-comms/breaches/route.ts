import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, type Prisma } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { MILESTONE_LABELS } from "@/lib/provider-comms/milestones";

/**
 * GET /api/provider-comms/breaches — the SLA breach list.
 *
 * Joins each event to its latest send so the operator sees delivery status
 * without a second call: "attempt 2 of 3, last one FAILED" is the line that
 * actually tells them whether to pick up the phone.
 */
export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }

    const params = request.nextUrl.searchParams;
    const where: Prisma.SlaBreachEventWhereInput = {};
    const status = params.get("status");
    const milestone = params.get("milestone");
    const labId = Number(params.get("labId"));
    if (status) where.status = status as never;
    if (milestone) where.milestone = milestone as never;
    if (Number.isInteger(labId) && labId > 0) where.labId = labId;

    const events = await prisma.slaBreachEvent.findMany({
      where,
      orderBy: [{ status: "asc" }, { firstBreachedAt: "desc" }],
      take: Math.min(200, Number(params.get("limit")) || 100),
      include: { sends: { orderBy: { attemptNo: "desc" }, take: 1 } },
    });

    const labNames = new Map(
      (await prisma.nonApiLabConfig.findMany({ select: { labId: true, labName: true } }))
        .map((lab) => [lab.labId, lab.labName]),
    );
    const outboundIds = events.map((e) => e.sends[0]?.waOutboundId).filter((id): id is string => !!id);
    const delivery = new Map(
      (await prisma.waOutbound.findMany({ where: { id: { in: outboundIds } }, select: { id: true, status: true, error: true } }))
        .map((row) => [row.id, row]),
    );

    // Three separate switches all have to be on before a single breach can
    // exist, and "No breaches recorded" tells an operator nothing about which
    // one is missing. So the list reports its own readiness and the screen
    // names the gap instead of leaving it to be guessed.
    const [breachStepCount, enabledMilestoneCount, settings] = await Promise.all([
      prisma.providerCommunicationRule.count({ where: { isActive: true, triggerKind: "SLA_BREACH" } }),
      prisma.slaMilestoneConfig.count({ where: { enabled: true } }),
      prisma.providerCommsSettings.findUnique({ where: { id: "default" } }),
    ]);

    const now = Date.now();
    return NextResponse.json({
      readiness: {
        engineEnabled: settings?.slaBreachEnabled ?? false,
        dryRun: settings?.slaBreachDryRun ?? true,
        breachStepCount,
        enabledMilestoneCount,
      },
      breaches: events.map((event) => {
        const latest = event.sends[0] ?? null;
        const outbound = latest?.waOutboundId ? delivery.get(latest.waOutboundId) ?? null : null;
        return {
          id: event.id,
          orderId: event.orderId,
          labId: event.labId,
          labName: labNames.get(event.labId) ?? `Lab #${event.labId}`,
          milestone: event.milestone,
          milestoneLabel: MILESTONE_LABELS[event.milestone],
          deadlineAt: event.deadlineAt,
          firstBreachedAt: event.firstBreachedAt,
          // Frozen at resolution rather than counted to "now": an event that
          // closed yesterday is not still getting later.
          overdueMinutes: Math.round(
            ((event.resolvedAt?.getTime() ?? now) - event.deadlineAt.getTime()) / 60_000,
          ),
          attemptsSent: event.attemptsSent,
          nextAttemptAt: event.nextAttemptAt,
          status: event.status,
          resolutionReason: event.resolutionReason,
          lastSentAt: event.lastSentAt,
          lastDeliveryStatus: latest?.dryRun ? "DRY_RUN" : outbound?.status ?? null,
          lastDeliveryError: outbound?.error ?? null,
        };
      }),
    });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "BreachesAPI.GET", code: "FETCH_ERROR", userMessage: "Failed to load SLA breaches", error }), { status: 500 });
  }
}
