/**
 * POST /api/task-rules/simulate   ← W5.2 — the rule simulator
 *
 * The audit's #1 highest-leverage missing feature: "run this rule against
 * the last N orders and tell me which would fire". Authors had no way to
 * sanity-check a rule before deploying except waiting for the next polling
 * cycle and watching whether tasks appeared.
 *
 * Body shape — accepts either a saved rule by id, or an unsaved rule from
 * the editor (so authors can test changes before clicking Save):
 *
 *   {
 *     ruleId?: string,
 *     rule?: {
 *       dataSourceId: string,
 *       allowedTypes?: string[],
 *       triggerType?: "TIME" | "STATUS",
 *       triggerCondition: TriggerCondition,
 *       titleTemplate?: string,
 *     },
 *     limit?: number    // # of recent orders to test against, default 100, max 500
 *   }
 *
 * Response:
 *   {
 *     ruleName: "...",
 *     summary: {
 *       sampled: 100,
 *       wouldFire: 12,
 *       wouldNotFire: 88,
 *       wouldDedup: 3,                          // already had a task for this rule+order
 *       failedChecks: { statusIn: 50, minutesSinceCreated: 30, ... }
 *     },
 *     results: [
 *       { entityId, orderType, orderStatus, appointmentTime, patientName,
 *         wouldFire, wouldDedup, renderedTitle?, reason?, failedCheck? }
 *     ]
 *   }
 *
 * Limitations (documented for the user):
 *   - Pulls from `fetchAllActiveOrders` (Order table). Multi-source
 *     simulation is a future iteration when the per-source poller is wired.
 *   - Does NOT actually run pickAssignee — too expensive at simulation
 *     scale, and the audit's W4.2 just landed so authors can already see
 *     what assignment strategy a rule will use.
 *   - Does NOT enforce the future-cap (>3 days out skip from
 *     evaluateAndCreateTasks); the simulator shows what WOULD match by
 *     trigger conditions alone, since the future-cap is a separate
 *     business gate the author can read on the engine page.
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";
import { evaluateTrigger, type TriggerCheck } from "@/lib/engine/taskCreator";
import { fetchAllActiveOrders } from "@/lib/engine/labstack";
import { labstackOr } from "@/lib/db/labstack";
import type { RawOrder } from "@/lib/engine/labstack";
import { fetchSourceSample } from "@/lib/engine/sourceSample";
import { bareTableName } from "@/lib/validation/data-sources";
import { renderTitleTemplate } from "@/lib/templating/title";
import { triggerConditionSchema, zodErrorToResponse } from "@/lib/validation/task-rules";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import type { TriggerCondition } from "@/types";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const inlineRuleSchema = z.object({
  dataSourceId: z.string().min(1),
  allowedTypes: z.array(z.string().min(1)).default([]),
  allowedStatuses: z.array(z.string().min(1)).default([]),
  triggerType: z.enum(["TIME", "STATUS"]).default("TIME"),
  triggerCondition: triggerConditionSchema,
  titleTemplate: z.string().min(1).default("(no title template)"),
});

const bodySchema = z.object({
  ruleId: z.string().optional(),
  rule: inlineRuleSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
}).refine(
  (b) => !!b.ruleId || !!b.rule,
  { message: "Provide either `ruleId` (saved rule) or `rule` (unsaved rule body)" }
);

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ ...zodErrorToResponse(err), requestId }, { status: 400 });
    }
    throw err;
  }

  try {
    // ─── Resolve the rule (saved or inline) ───────────────────────────────
    let ruleName: string;
    let ruleId: string | null;
    let dataSourceId: string;
    let allowedTypes: string[];
    let triggerType: "TIME" | "STATUS";
    let triggerCondition: TriggerCondition;
    let titleTemplate: string;

    if (parsed.ruleId) {
      const stored = await prisma.taskRule.findUnique({
        where: { id: parsed.ruleId },
        select: {
          id: true, name: true, dataSourceId: true,
          allowedTypes: true, triggerType: true,
          triggerCondition: true, titleTemplate: true,
        },
      });
      if (!stored) {
        return NextResponse.json({ error: "Rule not found", requestId }, { status: 404 });
      }
      ruleId = stored.id;
      ruleName = stored.name;
      dataSourceId = stored.dataSourceId;
      allowedTypes = Array.isArray(stored.allowedTypes) ? (stored.allowedTypes as string[]) : [];
      triggerType = stored.triggerType;
      triggerCondition = stored.triggerCondition as unknown as TriggerCondition;
      titleTemplate = stored.titleTemplate;
    } else {
      const inline = parsed.rule!;
      ruleId = null;
      ruleName = "(unsaved rule)";
      dataSourceId = inline.dataSourceId;
      allowedTypes = inline.allowedTypes;
      triggerType = inline.triggerType;
      triggerCondition = inline.triggerCondition as unknown as TriggerCondition;
      titleTemplate = inline.titleTemplate;
    }

    // ─── Resolve the source so we sample the RIGHT table ──────────────────
    // Previously this always sampled the Order table, so an Appointments /
    // PharmaOrder rule was dry-run against ORDER rows and every row "skipped"
    // on the wrong entity. Sample from the rule's own source instead.
    const source = await prisma.dataSource.findUnique({
      where: { id: dataSourceId },
      select: {
        tableReference: true, primaryKeyField: true,
        typeFieldName: true, statusFieldName: true, metadataFieldMapping: true,
      },
    });
    if (!source) {
      return NextResponse.json({ error: "Data source not found", requestId }, { status: 404 });
    }
    const isOrderSource = bareTableName(source.tableReference) === "Order";

    // ─── Fetch sample entities ────────────────────────────────────────────
    // Two perf protections carry over to both paths:
    //
    // 1. since cursor: only entities touched in the last 7 days. Unbounded
    //    scans are cheap on a healthy labstack, devastating on a lock storm.
    //    Simulate is a UI dry-run; a 7-day sample is plenty representative.
    //
    // 2. labstackOr ceiling (10s, worker pool): if the query hangs (labstack
    //    outage / network), return a clean JSON 503 instead of letting nginx
    //    504 with an HTML body the client can't parse.
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    // Non-Order sources: cap the recent window generously, then slice to limit,
    // so "available" reflects recent volume like the Order path does.
    const SOURCE_SAMPLE_CAP = Math.max(parsed.limit, 500);
    const allOrders = await labstackOr<RawOrder[] | null>(
      isOrderSource
        ? fetchAllActiveOrders(since)
        : fetchSourceSample(
            {
              tableReference: source.tableReference,
              primaryKeyField: source.primaryKeyField,
              typeFieldName: source.typeFieldName,
              statusFieldName: source.statusFieldName,
              metadataFieldMapping:
                (source.metadataFieldMapping as Record<string, string> | null) ?? null,
            },
            since,
            SOURCE_SAMPLE_CAP,
          ),
      null,
      10_000,
      { breakerKey: "worker" },
    );
    if (allOrders === null) {
      return NextResponse.json(
        {
          error: "Source database temporarily unavailable — try simulate again in a moment",
          code: "LABSTACK_TIMEOUT",
          requestId,
        },
        { status: 503 },
      );
    }
    const sample = allOrders.slice(0, parsed.limit);

    // ─── Active dedup keys ────────────────────────────────────────────────
    // Pre-load the (ruleId, entityId) pairs that already have an open
    // task so the simulator can flag dedup. Skip when simulating an
    // unsaved rule — there's no saved id to dedup against.
    let dedupSet = new Set<number>();
    if (ruleId) {
      const existing = await prisma.task.findMany({
        where: { taskRuleId: ruleId, isArchived: false },
        select: { entityId: true },
      });
      dedupSet = new Set(existing.map((t) => t.entityId));
    }

    // ─── Evaluate ─────────────────────────────────────────────────────────
    const now = new Date();
    let wouldFire = 0;
    let wouldDedup = 0;
    const failedChecks: Record<TriggerCheck | "allowedTypes", number> = {
      statusIn: 0,
      minutesSinceCreated: 0,
      minutesSinceStatusUpdated: 0,
      minutesBeforeAppointment: 0,
      minutesAfterAppointment: 0,
      metadataConditions: 0,
      allowedTypes: 0,
    };

    interface SimResult {
      entityId: number;
      orderType: string;
      orderStatus: string;
      appointmentTime: Date | string | null;
      patientName: string | null;
      storeName: string | null;
      wouldFire: boolean;
      wouldDedup: boolean;
      renderedTitle?: string;
      reason?: string;
      failedCheck?: TriggerCheck | "allowedTypes";
    }

    const results: SimResult[] = sample.map((order) => {
      // Step 1 — allowedTypes gate
      if (allowedTypes.length > 0 && !allowedTypes.includes(order.orderType)) {
        failedChecks.allowedTypes++;
        return {
          entityId: order.id,
          orderType: order.orderType,
          orderStatus: order.orderStatus,
          appointmentTime: order.appointmentTime,
          patientName: order.patientName ?? null,
          storeName: order.storeName ?? null,
          wouldFire: false,
          wouldDedup: false,
          failedCheck: "allowedTypes",
          reason: `orderType="${order.orderType}" not in [${allowedTypes.join(", ")}]`,
        };
      }

      // Step 2 — STATUS-triggered short-circuit (matches engine behaviour)
      if (triggerType === "STATUS") {
        const statuses = (triggerCondition as { statusIn?: string[] }).statusIn ?? [];
        if (!statuses.includes(order.orderStatus)) {
          failedChecks.statusIn++;
          return {
            entityId: order.id,
            orderType: order.orderType,
            orderStatus: order.orderStatus,
            appointmentTime: order.appointmentTime,
            patientName: order.patientName ?? null,
            storeName: order.storeName ?? null,
            wouldFire: false,
            wouldDedup: false,
            failedCheck: "statusIn",
            reason: `orderStatus="${order.orderStatus}" not in [${statuses.join(", ")}]`,
          };
        }
      } else {
        // Step 3 — full TIME-triggered evaluation
        const eval_ = evaluateTrigger(order, triggerCondition, now);
        if (!eval_.matches) {
          failedChecks[eval_.failedCheck]++;
          return {
            entityId: order.id,
            orderType: order.orderType,
            orderStatus: order.orderStatus,
            appointmentTime: order.appointmentTime,
            patientName: order.patientName ?? null,
            storeName: order.storeName ?? null,
            wouldFire: false,
            wouldDedup: false,
            failedCheck: eval_.failedCheck,
            reason: eval_.reason,
          };
        }
      }

      // Step 4 — dedup check (saved rules only)
      const isDedup = dedupSet.has(order.id);
      if (isDedup) wouldDedup++;
      else wouldFire++;

      return {
        entityId: order.id,
        orderType: order.orderType,
        orderStatus: order.orderStatus,
        appointmentTime: order.appointmentTime,
        patientName: order.patientName ?? null,
        storeName: order.storeName ?? null,
        wouldFire: !isDedup,
        wouldDedup: isDedup,
        renderedTitle: renderTitleTemplate(titleTemplate, {
          patientName: order.patientName,
          orderId: order.id,
          storeName: order.storeName,
          labName: order.labName,
          phleboName: order.phleboName,
          appointmentTime: order.appointmentTime,
        }),
      };
    });

    return NextResponse.json({
      ruleId,
      ruleName,
      dataSourceId,
      summary: {
        sampled: sample.length,
        availableOrders: allOrders.length,
        wouldFire,
        wouldDedup,
        wouldNotFire: sample.length - wouldFire - wouldDedup,
        failedChecks,
      },
      results,
      requestId,
    });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "TaskRulesAPI.simulate",
        code: "SIMULATE_ERROR",
        userMessage: "Failed to simulate rule",
        error,
      }),
      { status: 500 }
    );
  }
}
