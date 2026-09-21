/**
 * POST /api/task-rules/:id/close-open-tasks
 *
 * Cancels every open (non-terminal, non-archived) task a rule created. Used by
 * the "Also close N open tasks?" prompt when a rule is disabled — disabling
 * stops NEW task creation but leaves already-open tasks in the queue, which is
 * confusing ("I turned the rule off but Smart View still shows its tasks").
 *
 * Cancellation mirrors the engine retirer: status=CANCELLED, a TaskHistory note,
 * and metadata.autoRetiredByEngine=true so the UI counts these as engine
 * closures (not team-completed) AND so they don't occupy the dedup slot — if the
 * rule is re-enabled and the source entity still matches, the rule re-fires.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskStatus } from "@prisma/client";
import { logRuleAudit } from "@/lib/engine/ruleAudit";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  const { id } = await params;
  if (id === "MANUAL") {
    return NextResponse.json({ error: "Cannot close MANUAL tasks this way", requestId }, { status: 400 });
  }

  const rule = await prisma.taskRule.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!rule) return NextResponse.json({ error: "Rule not found", requestId }, { status: 404 });

  try {
    const openTasks = await prisma.task.findMany({
      where: {
        taskRuleId: id,
        isArchived: false,
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
      },
      select: { id: true },
    });

    if (openTasks.length === 0) {
      return NextResponse.json({ closed: 0, requestId });
    }

    const ids = openTasks.map((t) => t.id);
    const now = new Date();
    const note = `Auto-closed — rule "${rule.name}" was disabled`;

    await prisma.$transaction(async (tx) => {
      await tx.task.updateMany({
        where: { id: { in: ids } },
        data: { status: TaskStatus.CANCELLED, completedAt: now, lastStatusUpdate: now },
      });
      // Mark as engine-closed (same flag the retirer uses) so Smart View books
      // these under auto-closed and they free the dedup slot for re-enable.
      await tx.$executeRawUnsafe(
        `UPDATE taskos."tasks"
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{autoRetiredByEngine}', 'true'::jsonb)
         WHERE id = ANY($1::int[])`,
        ids,
      );
      await tx.taskHistory.createMany({
        data: ids.map((taskId) => ({
          taskId,
          status: TaskStatus.CANCELLED,
          changedById: user.id,
          note,
        })),
      });
    });

    await logRuleAudit({
      action: "UPDATE",
      ruleId: id,
      changedById: user.id,
      metadata: { ruleName: rule.name, closedOpenTasks: ids.length },
    }).catch(() => {});

    return NextResponse.json({ closed: ids.length, requestId });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TaskRulesAPI.closeOpenTasks",
        code: "CLOSE_ERROR",
        userMessage: "Failed to close the rule's open tasks",
        error,
      }),
      { status: 500 },
    );
  }
}
