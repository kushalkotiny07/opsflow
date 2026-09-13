import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { validateNonApiLabConfig } from "@/lib/validation/non-api-labs";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

function forbidden(requestId: string) {
  return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
}

// GET /api/non-api-labs — Ops-owned integration configuration only.
export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return forbidden(requestId);

    const labs = await prisma.nonApiLabConfig.findMany({ orderBy: [{ isActive: "desc" }, { labName: "asc" }] });
    return NextResponse.json({ labs });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "NonApiLabsAPI.GET", code: "FETCH_ERROR", userMessage: "Failed to load non-API lab configuration", error }), { status: 500 });
  }
}

// POST /api/non-api-labs — registers one externally-owned LabStack lab.
export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return forbidden(requestId);

    const parsed = validateNonApiLabConfig(await request.json().catch(() => ({})));
    if (!parsed.ok) return NextResponse.json({ error: "Invalid lab configuration", code: "VALIDATION_ERROR", requestId, details: parsed.errors }, { status: 400 });

    const existing = await prisma.nonApiLabConfig.findUnique({ where: { labId: parsed.data.labId } });
    if (existing) return NextResponse.json({ error: "A configuration already exists for this LabStack lab", code: "CONFLICT", requestId }, { status: 409 });

    const lab = await prisma.nonApiLabConfig.create({ data: { ...parsed.data, createdById: user.id, updatedById: user.id } });
    return NextResponse.json({ lab }, { status: 201 });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "NonApiLabsAPI.POST", code: "CREATE_ERROR", userMessage: "Failed to save non-API lab configuration", error }), { status: 500 });
  }
}
