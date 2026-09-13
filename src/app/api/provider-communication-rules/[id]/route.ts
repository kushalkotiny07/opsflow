import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { assertAnchorOffset, assertMilestoneTrigger, updateRuleSchema, validateRuleTargets, zodErrorToResponse } from "@/lib/validation/provider-communication-rules";
import { ZodError } from "zod";

async function requireOpsHead(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  return user?.role === UserRole.OPS_HEAD;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    if (!(await requireOpsHead(request))) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    const { id } = await params;
    const existing = await prisma.providerCommunicationRule.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Rule not found", requestId }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    let parsed;
    try {
      parsed = updateRuleSchema.parse(body);
    } catch (error) {
      if (error instanceof ZodError) return NextResponse.json({ ...zodErrorToResponse(error), requestId }, { status: 400 });
      throw error;
    }
    // PATCH means "change only what was sent", and `parsed` does not mean
    // that. `.partial()` makes every field optional but does NOT remove the
    // `.default()` on them, so Zod injects defaults for keys the caller never
    // touched: a request of `{ templateKey }` comes back carrying
    // priority=4, recipient="LAB", sendCondition={}, allowedOrderTypes=[]
    // and — most damagingly — allowedLabIds=[], which silently converts a
    // lab-scoped rule into one that applies to EVERY provider. Merging or
    // writing that wholesale is data loss on an untouched field.
    //
    // So the patch is narrowed to keys actually present in the request body.
    const sentKeys = new Set(Object.keys((body ?? {}) as Record<string, unknown>));
    const patch = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => sentKeys.has(key)),
    ) as Partial<typeof parsed>;

    const merged = { ...existing, ...patch };
    const anchorError = assertAnchorOffset(merged);
    if (anchorError) return NextResponse.json({ error: anchorError, code: "VALIDATION_ERROR", requestId }, { status: 400 });
    // updateRuleSchema is `.partial()`, which drops the create schema's
    // refinements — so the merged trigger/milestone pair is checked here.
    // The DB CHECK constraint is the backstop; this is what makes the failure
    // readable instead of a raw constraint violation.
    const milestoneError = assertMilestoneTrigger(merged);
    if (milestoneError) return NextResponse.json({ error: milestoneError, code: "VALIDATION_ERROR", requestId }, { status: 400 });
    if (patch.templateKey || patch.allowedLabIds) {
      // `merged.allowedLabIds` is JsonValue when it came from the stored row
      // and number[] when it came from the patch, so it is coerced here rather
      // than asserted — a hand-written row with a malformed array degrades to
      // "unscoped", matching how rule-store.ts reads the same column.
      const scopedLabIds = Array.isArray(merged.allowedLabIds)
        ? (merged.allowedLabIds as unknown[]).map(Number).filter((id) => Number.isInteger(id) && id > 0)
        : [];
      const targets = await validateRuleTargets({ templateKey: merged.templateKey, allowedLabIds: scopedLabIds });
      if (!targets.valid) return NextResponse.json({ error: targets.error, code: "VALIDATION_ERROR", details: { field: targets.field, reason: targets.error }, requestId }, { status: 400 });
    }
    const { isDraft: _isDraft, ...data } = patch;
    const rule = await prisma.providerCommunicationRule.update({ where: { id }, data });
    return NextResponse.json({ rule });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "ProviderCommunicationRulesAPI.PATCH", code: "UPDATE_ERROR", userMessage: "Failed to update provider communication rule", error }), { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    if (!(await requireOpsHead(request))) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 403 });
    const { id } = await params;
    await prisma.providerCommunicationRule.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "ProviderCommunicationRulesAPI.DELETE", code: "DELETE_ERROR", userMessage: "Failed to delete provider communication rule", error }), { status: 500 });
  }
}
