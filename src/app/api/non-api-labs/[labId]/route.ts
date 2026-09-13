import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { validateNonApiLabConfig } from "@/lib/validation/non-api-labs";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

function parseLabId(value: string): number | null {
  const labId = Number(value);
  return Number.isInteger(labId) && labId > 0 ? labId : null;
}

async function requireOpsHead(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD) return null;
  return user;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ labId: string }> }) {
  const requestId = newRequestId();
  try {
    if (!(await requireOpsHead(request))) return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    const labId = parseLabId((await params).labId);
    if (!labId) return NextResponse.json({ error: "Invalid lab id", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    const lab = await prisma.nonApiLabConfig.findUnique({ where: { labId } });
    if (!lab) return NextResponse.json({ error: "Non-API lab configuration not found", code: "NOT_FOUND", requestId }, { status: 404 });
    return NextResponse.json({ lab });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "NonApiLabAPI.GET", code: "FETCH_ERROR", userMessage: "Failed to load non-API lab configuration", error }), { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ labId: string }> }) {
  const requestId = newRequestId();
  try {
    const user = await requireOpsHead(request);
    if (!user) return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    const labId = parseLabId((await params).labId);
    if (!labId) return NextResponse.json({ error: "Invalid lab id", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    const existing = await prisma.nonApiLabConfig.findUnique({ where: { labId } });
    if (!existing) return NextResponse.json({ error: "Non-API lab configuration not found", code: "NOT_FOUND", requestId }, { status: 404 });

    // Validate the merged document, so PATCH-like edits cannot violate the SLA ordering invariant.
    const body = await request.json().catch(() => ({}));
    const parsed = validateNonApiLabConfig({ ...existing, ...body, labId });
    if (!parsed.ok) return NextResponse.json({ error: "Invalid lab configuration", code: "VALIDATION_ERROR", requestId, details: parsed.errors }, { status: 400 });

    const lab = await prisma.nonApiLabConfig.update({ where: { labId }, data: { ...parsed.data, updatedById: user.id } });
    return NextResponse.json({ lab });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "NonApiLabAPI.PUT", code: "UPDATE_ERROR", userMessage: "Failed to update non-API lab configuration", error }), { status: 500 });
  }
}
