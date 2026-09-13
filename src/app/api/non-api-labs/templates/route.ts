import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { allowedVariablesFor, ensureNonApiTemplates, requiredVariablesFor, validateCustomTemplateBody } from "@/lib/non-api-labs/templates";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

// GET /api/non-api-labs/templates — bootstraps the default order template so
// Ops can edit it before the first eligible order arrives.
export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    await ensureNonApiTemplates();
    const rows = await prisma.labCommunicationTemplate.findMany({ orderBy: { key: "asc" } });
    // Each key carries its own variable contract (templates.ts TEMPLATE_RULES).
    // Sending it with the row lets the editor guide authoring instead of
    // discovering the contract from a failed save.
    const templates = rows.map((template) => ({
      ...template,
      allowedVariables: allowedVariablesFor(template.key),
      requiredVariables: requiredVariablesFor(template.key),
    }));
    return NextResponse.json({ templates });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "NonApiTemplatesAPI.GET", code: "FETCH_ERROR", userMessage: "Failed to load communication templates", error }), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
      return NextResponse.json({ error: "Template name must be 1–120 characters", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    }
    const validated = validateCustomTemplateBody(body.body);
    if (!validated.ok) return NextResponse.json({ error: validated.error, code: "VALIDATION_ERROR", requestId }, { status: 400 });
    const slug = body.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "MESSAGE";
    const key = `NON_API_CUSTOM_${slug}_${Date.now().toString(36).toUpperCase()}`;
    const template = await prisma.labCommunicationTemplate.create({
      data: { key, name: body.name.trim(), body: validated.body, createdById: user.id, updatedById: user.id },
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "NonApiTemplatesAPI.POST", code: "CREATE_ERROR", userMessage: "Failed to create communication template", error }), { status: 500 });
  }
}
