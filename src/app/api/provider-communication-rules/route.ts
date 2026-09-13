/**
 * GET  /api/provider-communication-rules  — list every rule with send stats
 * POST /api/provider-communication-rules  — create a rule
 *
 * Validation is shared with PATCH via lib/validation/provider-communication-rules.ts,
 * so the two verbs cannot drift on what they accept.
 *
 * The list carries the things Ops judges a rule by and cannot infer from the
 * rule itself: how many messages it has actually sent, how many are queued
 * behind it right now, and the human names behind its template key and lab
 * ids. All of it in three grouped queries rather than one per rule.
 */
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import {
  createRuleSchema,
  validateRuleTargets,
  zodErrorToResponse,
  type CreateCommunicationRuleInput,
} from "@/lib/validation/provider-communication-rules";

const DAY_MS = 86_400_000;

async function requireOpsHead(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return { user: null, status: 401 as const };
  if (user.role !== UserRole.OPS_HEAD) return { user: null, status: 403 as const };
  return { user, status: 200 as const };
}

function asNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter((item) => Number.isInteger(item)) : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const auth = await requireOpsHead(request);
    if (!auth.user) return NextResponse.json({ error: auth.status === 401 ? "Unauthorized" : "Forbidden", requestId }, { status: auth.status });

    const rules = await prisma.providerCommunicationRule.findMany({
      orderBy: [{ anchor: "asc" }, { offsetMinutes: "asc" }, { priority: "asc" }, { name: "asc" }],
    });

    const ruleIds = rules.map((rule) => rule.id);
    const templateKeys = [...new Set(rules.map((rule) => rule.templateKey))];
    const labIds = [...new Set(rules.flatMap((rule) => asNumbers(rule.allowedLabIds)))];

    const [totals, recent, pending, templates, labs] = await Promise.all([
      ruleIds.length
        ? prisma.labCommunication.groupBy({ by: ["ruleId"], where: { ruleId: { in: ruleIds } }, _count: { _all: true } })
        : Promise.resolve([]),
      ruleIds.length
        ? prisma.labCommunication.groupBy({
          by: ["ruleId"],
          where: { ruleId: { in: ruleIds }, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
          _count: { _all: true },
        })
        : Promise.resolve([]),
      ruleIds.length
        ? prisma.labScheduledAction.groupBy({ by: ["ruleId"], where: { ruleId: { in: ruleIds }, status: "PENDING" }, _count: { _all: true } })
        : Promise.resolve([]),
      templateKeys.length
        ? prisma.labCommunicationTemplate.findMany({ where: { key: { in: templateKeys } }, select: { key: true, name: true, isActive: true } })
        : Promise.resolve([]),
      labIds.length
        ? prisma.nonApiLabConfig.findMany({ where: { labId: { in: labIds } }, select: { labId: true, labName: true } })
        : Promise.resolve([]),
    ]);

    const countBy = (rows: Array<{ ruleId: string | null; _count: { _all: number } }>) =>
      new Map(rows.map((row) => [row.ruleId ?? "", row._count._all]));
    const totalByRule = countBy(totals);
    const recentByRule = countBy(recent);
    const pendingByRule = countBy(pending);
    const templateByKey = new Map(templates.map((template) => [template.key, template]));
    const labNameById = new Map(labs.map((lab) => [lab.labId, lab.labName]));

    const shaped = rules.map((rule) => {
      const allowedLabIds = asNumbers(rule.allowedLabIds);
      const template = templateByKey.get(rule.templateKey);
      return {
        id: rule.id,
        name: rule.name,
        isActive: rule.isActive,
        anchor: rule.anchor,
        action: rule.action,
        offsetMinutes: rule.offsetMinutes,
        priority: rule.priority,
        recipient: rule.recipient,
        templateKey: rule.templateKey,
        // A rule pointing at a template that has since been deleted or
        // deactivated is the failure mode worth seeing from the list.
        templateName: template?.name ?? null,
        templateIsActive: template?.isActive ?? false,
        allowedLabIds,
        allowedLabNames: allowedLabIds.map((labId) => labNameById.get(labId) ?? `Lab #${labId}`),
        allowedOrderTypes: asStrings(rule.allowedOrderTypes),
        sendCondition: rule.sendCondition ?? {},
        // Without these the Templates screen cannot tell a breach watcher from
        // a sequence step: `triggerKind` arrives undefined, every rule falls
        // into SEQUENCE, and the SLA BREACH group reads zero.
        triggerKind: rule.triggerKind,
        slaMilestone: rule.slaMilestone,
        repeatIntervalMinutes: rule.repeatIntervalMinutes,
        maxAttempts: rule.maxAttempts,
        totalMessagesSent: totalByRule.get(rule.id) ?? 0,
        messagesLast24h: recentByRule.get(rule.id) ?? 0,
        pendingMessages: pendingByRule.get(rule.id) ?? 0,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      };
    });

    return NextResponse.json({ rules: shaped, requestId });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "ProviderCommunicationRulesAPI.GET",
        code: "FETCH_ERROR",
        userMessage: "Failed to load provider communication rules",
        error,
      }),
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  const auth = await requireOpsHead(request);
  if (!auth.user) return NextResponse.json({ error: auth.status === 401 ? "Unauthorized" : "Forbidden", requestId }, { status: auth.status });

  let parsed: CreateCommunicationRuleInput;
  try {
    parsed = createRuleSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ ...zodErrorToResponse(error), requestId }, { status: 400 });
    throw error;
  }

  try {
    const targets = await validateRuleTargets({ templateKey: parsed.templateKey, allowedLabIds: parsed.allowedLabIds });
    if (!targets.valid) {
      return NextResponse.json(
        { error: targets.error, code: "VALIDATION_ERROR", details: { field: targets.field, reason: targets.error }, requestId },
        { status: 400 },
      );
    }

    const collision = await prisma.providerCommunicationRule.findUnique({ where: { name: parsed.name }, select: { id: true } });
    if (collision) {
      return NextResponse.json({ error: `A rule named "${parsed.name}" already exists`, code: "NAME_CONFLICT", requestId }, { status: 409 });
    }

    const rule = await prisma.providerCommunicationRule.create({
      data: {
        name: parsed.name,
        anchor: parsed.anchor,
        action: parsed.action,
        offsetMinutes: parsed.offsetMinutes,
        priority: parsed.priority,
        templateKey: parsed.templateKey,
        recipient: parsed.recipient,
        allowedLabIds: parsed.allowedLabIds,
        allowedOrderTypes: parsed.allowedOrderTypes,
        sendCondition: parsed.sendCondition,
        triggerKind: parsed.triggerKind,
        slaMilestone: parsed.slaMilestone ?? null,
        repeatIntervalMinutes: parsed.repeatIntervalMinutes ?? null,
        maxAttempts: parsed.maxAttempts ?? null,
        // A draft is saved but silent: it cannot message a provider until the
        // author comes back and switches it on.
        isActive: !parsed.isDraft,
      },
    });

    return NextResponse.json({ rule, requestId }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "ProviderCommunicationRulesAPI.POST",
        code: "CREATE_ERROR",
        userMessage: "Failed to create provider communication rule",
        error,
      }),
      { status: 500 },
    );
  }
}
