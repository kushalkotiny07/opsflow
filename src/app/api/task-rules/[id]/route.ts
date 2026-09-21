/**
 * PATCH  /api/task-rules/:id — update any field on a task rule
 * DELETE /api/task-rules/:id — delete a task rule (blocks if non-archived tasks exist)
 */
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole, TaskStatus } from "@prisma/client";
import { logRuleAudit } from "@/lib/engine/ruleAudit";
import {
  updateRuleSchema,
  validateStatusesAgainstSource,
  zodErrorToResponse,
} from "@/lib/validation/task-rules";
import { getValidOrderStatuses } from "@/types";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  const { id } = await params;
  if (id === "MANUAL") {
    return NextResponse.json({ error: "Cannot modify the MANUAL sentinel rule", requestId }, { status: 400 });
  }

  const rule = await prisma.taskRule.findUnique({ where: { id } });
  if (!rule) return NextResponse.json({ error: "Rule not found", requestId }, { status: 404 });

  const body = await request.json();
  let parsed: import("@/lib/validation/task-rules").UpdateRuleInput;
  try {
    parsed = updateRuleSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ ...zodErrorToResponse(err), requestId }, { status: 400 });
    }
    throw err;
  }

  // Validate dataSourceId resolves
  if (parsed.dataSourceId !== undefined) {
    const ds = await prisma.dataSource.findUnique({ where: { id: parsed.dataSourceId } });
    if (!ds) return NextResponse.json({ error: "Data source not found", requestId }, { status: 404 });
  }

  // Validate triggerCondition statuses against the (effective) source.
  if (parsed.triggerCondition !== undefined) {
    const effectiveDataSourceId = parsed.dataSourceId ?? rule.dataSourceId;
    const statusValidation = await validateStatusesAgainstSource(
      effectiveDataSourceId,
      parsed.triggerCondition.statusIn
    );
    if (!statusValidation.valid) {
      return NextResponse.json({
        error: "Invalid order status in triggerCondition.statusIn",
        code: "VALIDATION_ERROR",
        invalidStatuses: statusValidation.invalidStatuses,
        validStatuses: statusValidation.validStatuses ?? getValidOrderStatuses(),
        requestId,
      }, { status: 400 });
    }
  }

  // Map parsed fields → Prisma update payload, omitting fields the caller didn't send.
  const updates: Record<string, unknown> = {};
  if (parsed.isActive !== undefined) updates.isActive = parsed.isActive;
  if (parsed.name !== undefined) updates.name = parsed.name;
  if (parsed.titleTemplate !== undefined) updates.titleTemplate = parsed.titleTemplate;
  if (parsed.dataSourceId !== undefined) updates.dataSourceId = parsed.dataSourceId;
  if (parsed.allowedTypes !== undefined) updates.allowedTypes = parsed.allowedTypes;
  if (parsed.allowedStatuses !== undefined) updates.allowedStatuses = parsed.allowedStatuses;
  if (parsed.pollingIntervalMinutes !== undefined) updates.pollingIntervalMinutes = parsed.pollingIntervalMinutes;
  if (parsed.slaMinutes !== undefined) updates.slaMinutes = parsed.slaMinutes;
  if (parsed.priority !== undefined) updates.priority = parsed.priority;
  if (parsed.triggerCondition !== undefined) updates.triggerCondition = parsed.triggerCondition;
  if (parsed.assignmentStrategy !== undefined) updates.assignmentStrategy = parsed.assignmentStrategy;
  // escalationChainId is allowed to be null (clear) or a number (set).
  if ("escalationChainId" in parsed) updates.escalationChainId = parsed.escalationChainId ?? null;

  const hasSkillUpdate = Array.isArray(parsed.skillTagIds);
  if (Object.keys(updates).length === 0 && !hasSkillUpdate) {
    return NextResponse.json({ error: "Nothing to update", requestId }, { status: 400 });
  }

  try {
    // Run skill update + field update in a transaction
    const updated = await prisma.$transaction(async (tx) => {
      if (hasSkillUpdate) {
        await tx.taskRuleSkill.deleteMany({ where: { taskRuleId: id } });
        if (parsed.skillTagIds!.length > 0) {
          await tx.taskRuleSkill.createMany({
            data: parsed.skillTagIds!.map((sid) => ({ taskRuleId: id, skillTagId: sid })),
          });
        }
      }

      if (Object.keys(updates).length > 0) {
        return tx.taskRule.update({
          where: { id },
          data: updates,
          include: {
            taskType: { select: { id: true, name: true, label: true } },
            requiredSkills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
            escalationChain: { select: { id: true, name: true } },
            dataSource: { select: { id: true, sourceId: true, displayName: true } },
          },
        });
      }

      return tx.taskRule.findUnique({
        where: { id },
        include: {
          taskType: { select: { id: true, name: true, label: true } },
          requiredSkills: { include: { skillTag: { select: { id: true, name: true, label: true } } } },
          escalationChain: { select: { id: true, name: true } },
          dataSource: { select: { id: true, sourceId: true, displayName: true } },
        },
      });
    });

    // Audit log with before/after summary for tracked fields
    if (Object.keys(updates).length > 0 || hasSkillUpdate) {
      const changesSummary: Record<string, { before: unknown; after: unknown }> = {};
      const trackedFields: (keyof typeof updates)[] = [
        "isActive", "name", "titleTemplate", "slaMinutes",
        "priority", "dataSourceId", "triggerCondition", "escalationChainId",
      ];
      for (const f of trackedFields) {
        if (updates[f] !== undefined) {
          changesSummary[f as string] = { before: rule[f as keyof typeof rule], after: updates[f] };
        }
      }
      await logRuleAudit({
        action: "UPDATE",
        ruleId: id,
        changedById: user.id,
        changesSummary: Object.keys(changesSummary).length > 0 ? changesSummary : undefined,
        metadata: { ruleName: updated?.name },
      });
    }

    // When this PATCH just disabled the rule, tell the client how many open
    // tasks it still owns so the UI can offer to close them (disabling stops
    // NEW creation but leaves already-open tasks in the queue). Close is a
    // separate, explicit action — see POST /close-open-tasks.
    let openTaskCount = 0;
    if (parsed.isActive === false && rule.isActive === true) {
      openTaskCount = await prisma.task.count({
        where: {
          taskRuleId: id,
          isArchived: false,
          status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
        },
      });
    }

    return NextResponse.json({ rule: updated, openTaskCount, requestId });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TaskRulesAPI.PATCH",
        code: "UPDATE_ERROR",
        userMessage: "Failed to update task rule",
        error,
      }),
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  const { id } = await params;
  if (id === "MANUAL") {
    return NextResponse.json({ error: "Cannot delete the MANUAL sentinel rule", requestId }, { status: 400 });
  }

  // W1.3 — only block delete when ACTIVE (non-archived) tasks reference the rule.
  // Operators were unable to delete rules whose only references were archived tasks
  // (which is the common end-of-life case for any rule that ever fired).
  const activeTaskCount = await prisma.task.count({
    where: { taskRuleId: id, isArchived: false },
  });
  if (activeTaskCount > 0) {
    return NextResponse.json(
      {
        error: `Cannot delete — ${activeTaskCount} active task(s) reference this rule. Deactivate it instead.`,
        code: "RULE_IN_USE",
        activeTaskCount,
        requestId,
      },
      { status: 409 }
    );
  }

  // Archived tasks: keep them but null out the FK so the rule can go.
  // The audit log preserves the ruleName so historical attribution is intact.
  const archivedTaskCount = await prisma.task.count({
    where: { taskRuleId: id, isArchived: true },
  });

  const rule = await prisma.taskRule.findUnique({ where: { id } });

  try {
    await prisma.$transaction([
      // Re-attribute archived tasks to the MANUAL sentinel so we don't break
      // their FK while keeping ruleName traceable via task.metadata if logged.
      prisma.task.updateMany({
        where: { taskRuleId: id, isArchived: true },
        data: { taskRuleId: "MANUAL" },
      }),
      prisma.taskRuleSkill.deleteMany({ where: { taskRuleId: id } }),
      prisma.taskRule.delete({ where: { id } }),
    ]);

    await logRuleAudit({
      action: "DELETE",
      ruleId: id,
      changedById: user.id,
      metadata: { ruleName: rule?.name, archivedTasksReattributed: archivedTaskCount },
    });

    return NextResponse.json({ success: true, archivedTasksReattributed: archivedTaskCount, requestId });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TaskRulesAPI.DELETE",
        code: "DELETE_ERROR",
        userMessage: "Failed to delete task rule",
        error,
      }),
      { status: 500 }
    );
  }
}
