/**
 * The daily provider digest, on demand.
 *
 * The digest itself is automatic — the every-minute tick sends it when a lab's
 * slot opens (lib/provider-comms/daily-digest.ts). This route exists because
 * "wait until 19:00 and see" is not a way to check a message that goes to a
 * real provider group:
 *
 *   GET  ?labId=N   render exactly what would be sent, and send nothing
 *   POST { labId }  send it now, as a one-off, without consuming today's slot
 *
 * A manual send is recorded as its own event rather than as today's digest, so
 * testing at 15:00 does not silence the real one at 19:00.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { sendDigestForLab } from "@/lib/provider-comms/daily-digest";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

async function loadLab(labId: unknown) {
  const id = typeof labId === "number" ? labId : Number(labId);
  if (!Number.isInteger(id) || id < 1) return { error: "Invalid lab id" as const };
  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: id } });
  if (!config) return { error: "No such provider" as const };
  return { config };
}

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT)) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    const { config, error } = await loadLab(request.nextUrl.searchParams.get("labId"));
    if (error || !config) {
      return NextResponse.json({ error, code: "VALIDATION_ERROR", requestId }, { status: error === "No such provider" ? 404 : 400 });
    }

    // force: a preview must show the message even for a lab whose digest is
    // switched off or whose slot has not come round — that is the whole point
    // of looking at it before turning it on.
    const result = await sendDigestForLab(config, { force: true, previewOnly: true });
    return NextResponse.json({
      ...result,
      schedule: {
        enabled: config.dailyDigestEnabled,
        hour: config.dailyDigestHour,
        minute: config.dailyDigestMinute,
        skipWhenEmpty: config.dailyDigestSkipWhenEmpty,
        timeZone: process.env.TIMEZONE || "Asia/Kolkata",
      },
    });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId, scope: "ProviderDigestAPI.GET", code: "FETCH_ERROR",
        userMessage: "Failed to build the digest preview", error,
      }),
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    // Sending to a provider group is an Ops Head action, unlike reading one.
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    const body = await request.json().catch(() => ({}));
    const { config, error } = await loadLab(body.labId);
    if (error || !config) {
      return NextResponse.json({ error, code: "VALIDATION_ERROR", requestId }, { status: error === "No such provider" ? 404 : 400 });
    }

    const result = await sendDigestForLab(config, { force: true });
    if (result.outcome === "no-target") {
      return NextResponse.json(
        { error: `${config.labName} has no WhatsApp group or number configured`, code: "NO_TARGET", requestId },
        { status: 409 },
      );
    }
    if (result.outcome !== "queued") {
      return NextResponse.json(
        { error: result.error ?? `Digest not sent: ${result.outcome}`, code: "NOT_SENT", requestId, ...result },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId, scope: "ProviderDigestAPI.POST", code: "SEND_ERROR",
        userMessage: "Failed to queue the digest", error,
      }),
      { status: 500 },
    );
  }
}
