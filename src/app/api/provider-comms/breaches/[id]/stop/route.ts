import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

/**
 * POST /api/provider-comms/breaches/:id/stop
 *
 * The one manual action on a breach: stop sending. For when ops has already
 * handled it by phone and the lab does not need another message.
 *
 * Deliberately not a "resolve" — the milestone is still outstanding, and
 * recording it as completed would be a lie in the ledger. MANUAL_STOP says
 * what actually happened.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    const { id } = await params;

    const event = await prisma.slaBreachEvent.findUnique({ where: { id }, select: { status: true } });
    if (!event) return NextResponse.json({ error: "Unknown breach", code: "NOT_FOUND", requestId }, { status: 404 });
    if (event.status !== "ACTIVE") {
      return NextResponse.json(
        { error: `This breach is already ${event.status.toLowerCase()} — nothing further would be sent`, code: "NOT_ACTIVE", requestId },
        { status: 409 },
      );
    }

    const stopped = await prisma.slaBreachEvent.update({
      where: { id },
      data: { status: "CANCELLED", resolutionReason: "MANUAL_STOP", resolvedAt: new Date(), nextAttemptAt: null },
    });
    return NextResponse.json({ breach: stopped });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "BreachesAPI.STOP", code: "UPDATE_ERROR", userMessage: "Failed to stop this breach", error }), { status: 500 });
  }
}
