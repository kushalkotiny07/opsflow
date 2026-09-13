import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { isNonApiTemplateKey, TEMPLATE_DEFAULTS, validateNonApiTemplateBody } from "@/lib/non-api-labs/templates";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

// PUT /api/non-api-labs/templates/:key
export async function PUT(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    const { key } = await params;
    if (!isNonApiTemplateKey(key)) return NextResponse.json({ error: "Unknown template", code: "NOT_FOUND", requestId }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const validated = validateNonApiTemplateBody(key, body.body);
    if (!validated.ok) return NextResponse.json({ error: validated.error, code: "VALIDATION_ERROR", requestId }, { status: 400 });
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120)) {
      return NextResponse.json({ error: "Template name must be 1–120 characters", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    }
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") return NextResponse.json({ error: "isActive must be true or false", code: "VALIDATION_ERROR", requestId }, { status: 400 });

    const template = await prisma.labCommunicationTemplate.update({
      where: { key },
      data: { body: validated.body, name: body.name?.trim(), isActive: body.isActive, updatedById: user.id },
    });
    return NextResponse.json({ template });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "NonApiTemplateAPI.PUT", code: "UPDATE_ERROR", userMessage: "Failed to update communication template", error }), { status: 500 });
  }
}


// DELETE /api/non-api-labs/templates/:key — retire an operator-authored
// template. Shipped keys (TEMPLATE_DEFAULTS) are never deletable: they are
// re-created by ensureNonApiTemplates() on the next GET (the upsert has
// nowhere else to get their default body from), so "deleting" one would
// just have it silently reappear — pausing it (isActive: false via PUT) is
// the real off switch for those. A custom template also can't be deleted
// while any lab config or authored rule still points at it, since that
// would leave the field naming a template that no longer exists; the
// response lists what to repoint first.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    const { key } = await params;
    if (!isNonApiTemplateKey(key)) return NextResponse.json({ error: "Unknown template", code: "NOT_FOUND", requestId }, { status: 404 });

    const existing = await prisma.labCommunicationTemplate.findUnique({ where: { key }, select: { key: true } });
    if (!existing) return NextResponse.json({ error: "Unknown template", code: "NOT_FOUND", requestId }, { status: 404 });

    if (key in TEMPLATE_DEFAULTS) {
      return NextResponse.json(
        { error: "Built-in templates can't be deleted — pause it instead, or point labs at a different message", code: "BUILT_IN_TEMPLATE", requestId },
        { status: 400 },
      );
    }

    const [configFields, rulesUsing] = await Promise.all([
      prisma.nonApiLabConfig.findMany({
        where: {
          OR: [
            { initialTemplateKey: key }, { reminderTemplateKey: key },
            { escalationTemplateKey: key }, { appointmentTemplateKey: key },
            { slaBreachTemplateKey: key },
          ],
        },
        select: { labId: true, labName: true },
      }),
      prisma.providerCommunicationRule.findMany({ where: { templateKey: key }, select: { id: true, name: true } }),
    ]);
    if (configFields.length > 0 || rulesUsing.length > 0) {
      const usedBy = [
        ...configFields.map((c) => `lab "${c.labName}"`),
        ...rulesUsing.map((r) => `rule "${r.name}"`),
      ].join(", ");
      return NextResponse.json(
        { error: `Still in use by ${usedBy} — point those at a different message first`, code: "TEMPLATE_IN_USE", requestId },
        { status: 409 },
      );
    }

    await prisma.labCommunicationTemplate.delete({ where: { key } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "NonApiTemplateAPI.DELETE", code: "DELETE_ERROR", userMessage: "Failed to delete communication template", error }), { status: 500 });
  }
}
