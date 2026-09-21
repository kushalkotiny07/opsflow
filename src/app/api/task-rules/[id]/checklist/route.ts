/**
 * Rule-scoped checklist template.
 *
 * GET  /api/task-rules/{id}/checklist
 *   → the rule's own checklist steps + next-step guidance. If the rule has no
 *     rule-scoped rows yet, we return the task type's DEFAULT steps (taskRuleId
 *     = null) as a starting point (`usingDefaults: true`), and the rule's
 *     next-step falls back to the task type's.
 *
 * PUT  /api/task-rules/{id}/checklist
 *   → replaces the rule's OWN checklist (rows with taskRuleId = this rule) and
 *     its next-step guidance. Never touches the task-type default or any other
 *     rule — fixes the bug where editing one rule's checklist changed every
 *     rule sharing the task type.
 *
 * Existing in-flight tasks (TaskChecklistItem rows) are NOT back-filled — the
 * template only applies to tasks created after the save.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

interface ChecklistInput {
  stepText: string;
  isRequired?: boolean;
  stepOrder?: number;
  guidance?: string | null;
  script?: string | null;
}

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromRequest(req);
  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { id } = await params;

  const rule = await prisma.taskRule.findUnique({
    where: { id },
    select: {
      id: true, name: true, taskTypeId: true,
      nextStepComplete: true, nextStepIncomplete: true,
      taskType: { select: { id: true, name: true, label: true, nextStepComplete: true, nextStepIncomplete: true } },
    },
  });
  if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });

  const ownItems = await prisma.checklistTemplate.findMany({
    where: { taskRuleId: id },
    orderBy: { stepOrder: "asc" },
    select: { id: true, stepOrder: true, stepText: true, isRequired: true, guidance: true, script: true },
  });

  const usingDefaults = ownItems.length === 0;
  const items = usingDefaults
    ? await prisma.checklistTemplate.findMany({
        where: { taskTypeId: rule.taskTypeId, taskRuleId: null },
        orderBy: { stepOrder: "asc" },
        select: { id: true, stepOrder: true, stepText: true, isRequired: true, guidance: true, script: true },
      })
    : ownItems;

  return NextResponse.json({
    taskType: { id: rule.taskType.id, name: rule.taskType.name, label: rule.taskType.label },
    ruleName: rule.name,
    usingDefaults,
    items,
    nextStepComplete: rule.nextStepComplete ?? rule.taskType.nextStepComplete ?? "",
    nextStepIncomplete: rule.nextStepIncomplete ?? rule.taskType.nextStepIncomplete ?? "",
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromRequest(req);
  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { id } = await params;

  const rule = await prisma.taskRule.findUnique({ where: { id }, select: { id: true, taskTypeId: true } });
  if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });

  let body: { items?: ChecklistInput[]; nextStepComplete?: string | null; nextStepIncomplete?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems) return NextResponse.json({ error: "Body must include items: []" }, { status: 400 });

  const items = rawItems
    .map((it, idx) => ({
      stepText: typeof it.stepText === "string" ? it.stepText.trim() : "",
      isRequired: it.isRequired !== false,
      stepOrder: typeof it.stepOrder === "number" ? it.stepOrder : idx,
      guidance: trimOrNull(it.guidance),
      script: trimOrNull(it.script),
    }))
    .filter((it) => it.stepText.length > 0)
    .map((it, idx) => ({ ...it, stepOrder: idx }));

  // Replace THIS rule's own rows only — task-type defaults + other rules untouched.
  await prisma.$transaction([
    prisma.checklistTemplate.deleteMany({ where: { taskRuleId: id } }),
    prisma.checklistTemplate.createMany({
      data: items.map((it) => ({
        taskTypeId: rule.taskTypeId,
        taskRuleId: id,
        stepText: it.stepText,
        isRequired: it.isRequired,
        stepOrder: it.stepOrder,
        guidance: it.guidance,
        script: it.script,
      })),
    }),
    prisma.taskRule.update({
      where: { id },
      data: {
        ...("nextStepComplete" in body ? { nextStepComplete: trimOrNull(body.nextStepComplete) } : {}),
        ...("nextStepIncomplete" in body ? { nextStepIncomplete: trimOrNull(body.nextStepIncomplete) } : {}),
      },
    }),
  ]);

  const [fresh, r] = await Promise.all([
    prisma.checklistTemplate.findMany({
      where: { taskRuleId: id },
      orderBy: { stepOrder: "asc" },
      select: { id: true, stepOrder: true, stepText: true, isRequired: true, guidance: true, script: true },
    }),
    prisma.taskRule.findUnique({ where: { id }, select: { nextStepComplete: true, nextStepIncomplete: true } }),
  ]);
  return NextResponse.json({
    items: fresh,
    usingDefaults: false,
    nextStepComplete: r?.nextStepComplete ?? "",
    nextStepIncomplete: r?.nextStepIncomplete ?? "",
  });
}
