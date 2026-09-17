/**
 * GET /api/provider-comms/daily-board/[labId] — the orders behind one row.
 *
 * The board answers "how much and how bad"; this answers "which ones". Loaded
 * only when a row is opened, because a busy lab has hundreds of orders a day
 * and nobody wants them all on screen by default.
 *
 * Joins what LabStack knows about the order to what OpsFlow knows about the
 * conversation, so a row reads as one story: this patient, at this time, and
 * whether the provider has actually said yes.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { labstackWorkerQuery } from "@/lib/db/labstack";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

const TIME_ZONE = () => process.env.TIMEZONE || "Asia/Kolkata";
/** A lab could have hundreds in a day; the board is for triage, not browsing. */
const MAX_ROWS = 200;

type SourceOrder = {
  id: number;
  labOrderId: string | null;
  orderType: string;
  orderStatus: string;
  appointmentTime: Date;
  patientName: string | null;
  city: string | null;
  storeName: string | null;
  day: string;
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ labId: string }> }) {
  const requestId = newRequestId();
  try {
    const user = await getSessionFromRequest(request);
    if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT)) {
      return NextResponse.json({ error: "Unauthorized", code: "FORBIDDEN", requestId }, { status: 403 });
    }

    const labId = Number((await params).labId);
    if (!Number.isInteger(labId) || labId < 1) {
      return NextResponse.json({ error: "Invalid lab id", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    }

    // The page is reached directly by URL, so it has to be able to describe the
    // lab itself rather than relying on the board having been loaded first.
    const config = await prisma.nonApiLabConfig.findUnique({ where: { labId } });
    if (!config) {
      return NextResponse.json({ error: "No such provider", code: "NOT_FOUND", requestId }, { status: 404 });
    }

    const zone = TIME_ZONE();
    const orders = await labstackWorkerQuery<SourceOrder>(
      `
      WITH local AS (
        SELECT o.id, o."labOrderId", o."orderType"::text AS "orderType",
               o."orderStatus"::text AS "orderStatus", o."appointmentTime",
               u.name AS "patientName", u.city,
               s."storeName",
               ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE $2)::date AS local_day
          FROM public."Order" o
          LEFT JOIN public."User"  u ON u.id = o."userId"
          LEFT JOIN public."Store" s ON s.id = o."storeId"
         WHERE o."labId" = $1
           AND o."appointmentTime" IS NOT NULL
      )
      SELECT id, "labOrderId", "orderType", "orderStatus", "appointmentTime",
             "patientName", city, "storeName", local_day::text AS day
        FROM local
       WHERE local_day IN (
               (now() AT TIME ZONE $2)::date,
               (now() AT TIME ZONE $2)::date + 1
             )
       ORDER BY "appointmentTime" ASC
       LIMIT ${MAX_ROWS}
      `,
      [labId, zone],
    );

    // What the provider has actually told us about each of these orders.
    const workflows = orders.length
      ? await prisma.labCommunicationWorkflow.findMany({
          where: { orderId: { in: orders.map((order) => order.id) } },
          select: { orderId: true, status: true, acceptedAt: true, rejectedAt: true, rejectionReason: true },
        })
      : [];
    const byOrder = new Map(workflows.map((workflow) => [workflow.orderId, workflow]));

    const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: zone });

    return NextResponse.json({
      labId,
      lab: {
        labId: config.labId,
        labName: config.labName,
        integrationType: config.integrationType,
        isActive: config.isActive,
        reachable: !!(config.waGroupJid || config.whatsappNumber),
        waGroupJid: config.waGroupJid,
        confirmationSlaMinutes: config.confirmationSlaMinutes,
        reminderSlaMinutes: config.reminderSlaMinutes,
        escalationSlaMinutes: config.escalationSlaMinutes,
      },
      timeZone: zone,
      orders: orders.map((order) => {
        const workflow = byOrder.get(order.id) ?? null;
        return {
          orderId: order.id,
          labOrderId: order.labOrderId,
          orderType: order.orderType,
          orderStatus: order.orderStatus,
          appointmentTime: order.appointmentTime ? new Date(order.appointmentTime).toISOString() : null,
          patientName: order.patientName,
          location: order.city || order.storeName || null,
          when: order.day === todayKey ? "today" : "tomorrow",
          // null means we have never opened a conversation about this order —
          // which for a lab that should be chased is itself the finding.
          confirmation: workflow?.status ?? null,
          rejectionReason: workflow?.rejectionReason ?? null,
        };
      }),
      truncated: orders.length === MAX_ROWS,
    });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId, scope: "ProviderCommsBoardDetailAPI.GET", code: "FETCH_ERROR",
        userMessage: "Failed to load orders for this provider", error,
      }),
      { status: 500 },
    );
  }
}
