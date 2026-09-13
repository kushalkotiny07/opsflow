import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { loadProviderCommsSettings } from "@/lib/provider-comms/sla-config";

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    return NextResponse.json({ settings: await loadProviderCommsSettings() });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "ProviderCommsSettings.GET", code: "FETCH_ERROR", userMessage: "Failed to load settings", error }), { status: 500 });
  }
}

/** PUT — the kill switch, dry run, quiet hours and the per-lab tick ceiling. */
export async function PUT(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }
    const body = await request.json().catch(() => ({}));
    const errors: Record<string, string> = {};
    const data: Record<string, unknown> = {};

    for (const field of ["slaBreachEnabled", "slaBreachDryRun"] as const) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== "boolean") errors[field] = "must be true or false";
        else data[field] = body[field];
      }
    }
    for (const field of ["quietHoursStart", "quietHoursEnd"] as const) {
      if (body[field] !== undefined) {
        if (body[field] === null) { data[field] = null; continue; }
        const hour = Number(body[field]);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors[field] = "must be an hour between 0 and 23";
        else data[field] = hour;
      }
    }
    if (body.perLabPerTickLimit !== undefined) {
      const limit = Number(body.perLabPerTickLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) errors.perLabPerTickLimit = "must be between 1 and 50";
      else data.perLabPerTickLimit = limit;
    }

    // Both hours or neither: one alone describes no window at all, and
    // silently ignoring the half-set value would read as "quiet hours on".
    const start = data.quietHoursStart ?? undefined;
    const end = data.quietHoursEnd ?? undefined;
    if ((start === undefined) !== (end === undefined) && (start !== null && end !== null)) {
      errors.quietHours = "set both the start and end hour, or clear both";
    }

    if (Object.keys(errors).length > 0) {
      return NextResponse.json({ error: "Invalid settings", code: "VALIDATION_ERROR", requestId, details: errors }, { status: 400 });
    }

    const settings = await prisma.providerCommsSettings.upsert({
      where: { id: "default" }, update: data, create: { id: "default", ...data },
    });
    return NextResponse.json({ settings });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "ProviderCommsSettings.PUT", code: "UPDATE_ERROR", userMessage: "Failed to save settings", error }), { status: 500 });
  }
}
