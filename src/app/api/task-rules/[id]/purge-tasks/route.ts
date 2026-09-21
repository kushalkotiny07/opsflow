/**
 * Remove tasks a rule created by mistake.
 *
 * GET  /api/task-rules/:id/purge-tasks
 *   → counts of what could be removed: { open, total } (non-archived tasks
 *     for this rule; `open` = non-terminal).
 *
 * POST /api/task-rules/:id/purge-tasks   body: { scope: "open" | "all" }
 *   → ARCHIVES the matching tasks (isArchived = true) so they vanish from every
 *     board and the Stuck tab. Open ones are also set CANCELLED (terminal) with
 *     a history note. Archived tasks don't occupy the engine's dedup slot, so a
 *     corrected rule can re-create the right tasks on the next cycle. Reversible
 *     via the Archived Tasks board.
 *
 * This is distinct from close-on-disable (which cancels but keeps tasks visible
 * as "auto-closed"): a purge is for tasks that should never have existed.
 *
 * Auth: OPS_HEAD only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskStatus } from "@prisma/client";
import { logRuleAudit } from "@/lib/engine/ruleAudit";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

const TERMINAL: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.CANCELLED];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const [open, total] = await Promise.all([
    prisma.task.count({ where: { taskRuleId: id, isArchived: false, status: { notIn: TERMINAL } } }),
    prisma.task.count({ where: { taskRuleId: id, isArchived: false } }),
  ]);
  return NextResponse.json({ open, total });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });

  const { id } = await params;
  if (id === "MANUAL") return NextResponse.json({ error: "Cannot purge MANUAL tasks this way", requestId }, { status: 400 });

  const rule = await prisma.taskRule.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!rule) return NextResponse.json({ error: "Rule not found", requestId }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const scope: "open" | "all" = body?.scope === "all" ? "all" : "open";

  try {
    // Everything the rule owns that isn't already archived (optionally only the
    // still-open ones).
    const where = {
      taskRuleId: id,
      isArchived: false,
      ...(scope === "open" ? { status: { notIn: TERMINAL } } : {}),
    };
    const targets = await prisma.task.findMany({ where, select: { id: true, status: true } });
    if (targets.length === 0) return NextResponse.json({ removed: 0, requestId });

    const ids = targets.map((t) => t.id);
    // Open tasks get cancelled + a history note; already-terminal ones (in
    // scope=all) are just archived without rewriting their status.
    const openIds = targets.filter((t) => !TERMINAL.includes(t.status)).map((t) => t.id);
    const now = new Date();
    const note = `Removed — tasks created in error by rule "${rule.name}" (archived)`;

    await prisma.$transaction(async (tx) => {
      // Archive the whole set.
      await tx.task.updateMany({ where: { id: { in: ids } }, data: { isArchived: true } });
      // Cancel the open subset so it's terminal, and stamp the marker.
      if (openIds.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: openIds } },
          data: { status: TaskStatus.CANCELLED, completedAt: now, lastStatusUpdate: now },
        });
        await tx.$executeRawUnsafe(
          `UPDATE taskos."tasks"
             SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{removedByRulePurge}', 'true'::jsonb)
           WHERE id = ANY($1::int[])`,
          openIds,
        );
        await tx.taskHistory.createMany({
          data: openIds.map((taskId) => ({ taskId, status: TaskStatus.CANCELLED, changedById: user.id, note })),
        });
      }
    });

    await logRuleAudit({
      action: "UPDATE",
      ruleId: id,
      changedById: user.id,
      metadata: { ruleName: rule.name, purgedTasks: ids.length, scope },
    }).catch(() => {});

    return NextResponse.json({ removed: ids.length, requestId });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TaskRulesAPI.purgeTasks",
        code: "PURGE_ERROR",
        userMessage: "Failed to remove the rule's tasks",
        error,
      }),
      { status: 500 },
    );
  }
}
