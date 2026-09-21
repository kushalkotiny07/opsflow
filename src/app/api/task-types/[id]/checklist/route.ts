/**
 * Checklist template CRUD for a single task type.
 *
 * GET /api/task-types/{id}/checklist
 *   → returns the ordered list of steps for the task type, plus a count
 *     of active rules that reference this type (operators editing the
 *     checklist should know how many existing rules' tasks will inherit
 *     the change going forward).
 *
 * PUT /api/task-types/{id}/checklist
 *   → replaces the whole list. Body: { items: [{ stepText, isRequired,
 *     stepOrder }, ...] }. We delete-then-create rather than diff-merge
 *     because the order/text/required combos can all change at once and
 *     a full replace is simpler than tracking IDs across the wire.
 *
 * Note: existing in-flight tasks (TaskChecklistItem rows) are NOT
 * back-filled — those were copied from the template at creation time.
 * Only tasks created AFTER the edit pick up the new shape. This is
 * intentional (you don't want an agent's open task to gain a new "you
 * must do this" step mid-shift), but worth noting in the UI.
 *
 * Auth: OPS_HEAD only — touching rule configuration is a head concern.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(req);
  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { id } = await params;
  const taskTypeId = parseInt(id, 10);
  if (isNaN(taskTypeId)) {
    return NextResponse.json({ error: "Invalid task type id" }, { status: 400 });
  }

  const [taskType, items, ruleCount] = await Promise.all([
    prisma.taskType.findUnique({
      where: { id: taskTypeId },
      select: { id: true, name: true, label: true, nextStepComplete: true, nextStepIncomplete: true },
    }),
    prisma.checklistTemplate.findMany({
      where: { taskTypeId },
      orderBy: { stepOrder: "asc" },
      select: { id: true, stepOrder: true, stepText: true, isRequired: true, guidance: true, script: true },
    }),
    prisma.taskRule.count({ where: { taskTypeId, isActive: true } }),
  ]);

  if (!taskType) {
    return NextResponse.json({ error: "Task type not found" }, { status: 404 });
  }

  return NextResponse.json({ taskType, items, activeRuleCount: ruleCount });
}

interface ChecklistInput {
  stepText: string;
  isRequired?: boolean;
  stepOrder?: number;
  guidance?: string | null;
  script?: string | null;
}

// Trim to a string or null (blank → null so the DB column stays clean).
function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(req);
  if (!user || user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { id } = await params;
  const taskTypeId = parseInt(id, 10);
  if (isNaN(taskTypeId)) {
    return NextResponse.json({ error: "Invalid task type id" }, { status: 400 });
  }

  let body: { items?: ChecklistInput[]; nextStepComplete?: string | null; nextStepIncomplete?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems) {
    return NextResponse.json({ error: "Body must include items: []" }, { status: 400 });
  }

  // Normalise + validate: trim text, drop blanks, derive stepOrder from
  // array index if not provided. Clients can rely on the canonical
  // order in the response.
  const items = rawItems
    .map((it, idx) => ({
      stepText: typeof it.stepText === "string" ? it.stepText.trim() : "",
      isRequired: it.isRequired !== false,
      stepOrder: typeof it.stepOrder === "number" ? it.stepOrder : idx,
      guidance: trimOrNull(it.guidance),
      script: trimOrNull(it.script),
    }))
    .filter((it) => it.stepText.length > 0)
    .map((it, idx) => ({ ...it, stepOrder: idx })); // re-sequence 0..N-1

  // Verify task type exists before we wipe its checklist.
  const exists = await prisma.taskType.findUnique({
    where: { id: taskTypeId },
    select: { id: true },
  });
  if (!exists) {
    return NextResponse.json({ error: "Task type not found" }, { status: 404 });
  }

  // Replace in a transaction — delete-then-create. Existing in-flight
  // TaskChecklistItem rows are unaffected (they reference Task, not
  // ChecklistTemplate). New tasks created from this taskType will copy
  // the updated template.
  await prisma.$transaction([
    prisma.checklistTemplate.deleteMany({ where: { taskTypeId } }),
    prisma.checklistTemplate.createMany({
      data: items.map((it) => ({
        taskTypeId,
        stepText: it.stepText,
        isRequired: it.isRequired,
        stepOrder: it.stepOrder,
        guidance: it.guidance,
        script: it.script,
      })),
    }),
    // Task-level next-step guidance lives on the task type (copied onto each
    // task at creation). Only touch it when the client sent the keys.
    prisma.taskType.update({
      where: { id: taskTypeId },
      data: {
        ...("nextStepComplete" in body ? { nextStepComplete: trimOrNull(body.nextStepComplete) } : {}),
        ...("nextStepIncomplete" in body ? { nextStepIncomplete: trimOrNull(body.nextStepIncomplete) } : {}),
      },
    }),
  ]);

  const [fresh, tt] = await Promise.all([
    prisma.checklistTemplate.findMany({
      where: { taskTypeId },
      orderBy: { stepOrder: "asc" },
      select: { id: true, stepOrder: true, stepText: true, isRequired: true, guidance: true, script: true },
    }),
    prisma.taskType.findUnique({
      where: { id: taskTypeId },
      select: { nextStepComplete: true, nextStepIncomplete: true },
    }),
  ]);
  return NextResponse.json({ items: fresh, nextStepComplete: tt?.nextStepComplete ?? null, nextStepIncomplete: tt?.nextStepIncomplete ?? null });
}
