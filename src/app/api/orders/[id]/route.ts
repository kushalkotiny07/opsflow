/**
 * GET /api/orders/:id — fetch a single order from labstack for the quick-view panel.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import labstack, { labstackOr } from "@/lib/db/labstack";

interface RawOrderDetail {
  id: number;
  orderType: string;
  orderStatus: string;
  appointmentTime: Date;
  storeId: number | null;
  labId: number | null;
  userId: number;
  createdAt: Date;
  updatedAt: Date;
  statusUpdatedAt: Date;
  internalNotes: string | null;
  notes: string | null;
  phleboName: string | null;
  phleboNumber: string | null;
  patientName: string;
  labName: string | null;
  storeName: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (isNaN(orderId)) return NextResponse.json({ error: "Invalid order ID" }, { status: 400 });

  // ── No timezone cast — labstack stores naive UTC ─────────────────────
  // Labstack columns are TIMESTAMP WITHOUT TIME ZONE but the values themselves
  // are UTC instants (verified empirically — see labstack.ts). pg reads them
  // back as the correct UTC moment; applying `AT TIME ZONE 'Asia/Kolkata'`
  // would double-shift by 5h30 and the drawer would show wall-clock times
  // 5h30 earlier than the task row (which goes through the cast-free engine
  // fetcher). Mirrors the engine's labstack.ts query exactly.
  // labstackOr — drawer fetches degrade to 503 if labstack is stuck,
  // rather than holding the request open until the user gives up.
  const rows = await labstackOr(labstack.$queryRawUnsafe<RawOrderDetail[]>(`
    SELECT
      o.id,
      o."orderType",
      o."orderStatus",
      o."appointmentTime",
      o."storeId",
      o."labId",
      o."userId",
      o."createdAt",
      o."updatedAt",
      o."statusUpdatedAt",
      o."internalNotes",
      o.notes,
      o."phleboName",
      o."phleboNumber",
      u.name               AS "patientName",
      l."labName"          AS "labName",
      s."storeName"        AS "storeName"
    FROM public."Order" o
    JOIN public."User" u ON u.id = o."userId"
    LEFT JOIN public."Lab" l ON l.id = o."labId"
    LEFT JOIN public."Store" s ON s.id = o."storeId"
    WHERE o.id = $1
    LIMIT 1
  `, orderId), null);

  if (rows === null) {
    return NextResponse.json(
      { error: "Labstack temporarily unavailable", code: "LABSTACK_TIMEOUT" },
      { status: 503 },
    );
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const order = rows[0];

  // Fetch OpsFlow tasks for anything keyed by this numeric id. The click
  // handlers in the task boards don't disambiguate entityType — they pass
  // `task.entityId` straight through — so a row whose entityType is
  // APPOINTMENTS at the same numeric id as an ORDER will land in this same
  // drawer. Filtering strictly by entityType="ORDER" hid those tasks and
  // produced an empty "OPSFLOW TASKS (0)" list even when the user clicked
  // a task to open the panel. Showing the entityType in the row keeps the
  // UI honest about what each task is bound to.
  // Use explicit `select` (not `include`) — `tasks.sourceEntityId` is a
  // BIGINT column, and Prisma returns BIGINT as a JS BigInt, which
  // JSON.stringify refuses to serialise. The drawer doesn't need that
  // field; selecting only the columns the panel renders avoids the
  // 500 entirely without a custom replacer.
  const tasks = await prisma.task.findMany({
    where: { entityId: orderId },
    select: {
      id: true,
      title: true,
      entityType: true,
      status: true,
      priority: true,
      slaDeadline: true,
      // Both are declared on the drawer's OrderTask type and completedAt is
      // rendered ("Done HH:MM"), but neither was selected — so a completed
      // task silently showed no completion time.
      slaBreachedAt: true,
      completedAt: true,
      createdAt: true,
      assignedTo: { select: { id: true, name: true } },
      taskType: { select: { label: true } },
    },
    orderBy: [
      // ORDER tasks first (the drawer's primary subject), then anything else.
      { entityType: "asc" },
      { createdAt: "desc" },
    ],
  });

  // Milestone SLA breaches for this order — what the provider was chased
  // about, and whether it got through. Keyed on the order alone, so it is
  // present for API labs too (they have no communication workflow).
  const breachRows = await prisma.slaBreachEvent.findMany({
    where: { orderId },
    orderBy: { firstBreachedAt: "desc" },
    include: { sends: { orderBy: { attemptNo: "desc" }, take: 1 } },
  });
  const breachOutboundIds = breachRows
    .map((row) => row.sends[0]?.waOutboundId)
    .filter((value): value is string => !!value);
  const breachDelivery = new Map(
    (breachOutboundIds.length
      ? await prisma.waOutbound.findMany({ where: { id: { in: breachOutboundIds } }, select: { id: true, status: true } })
      : []
    ).map((row) => [row.id, row.status]),
  );

  const slaBreaches = breachRows.map((row) => {
    const latest = row.sends[0] ?? null;
    return {
      id: row.id,
      milestone: row.milestone,
      deadlineAt: row.deadlineAt,
      // Frozen at resolution rather than counted to now — a breach that
      // closed yesterday is not still getting later.
      overdueMinutes: Math.round(
        ((row.resolvedAt?.getTime() ?? Date.now()) - row.deadlineAt.getTime()) / 60_000,
      ),
      attemptsSent: row.attemptsSent,
      nextAttemptAt: row.nextAttemptAt,
      status: row.status,
      resolutionReason: row.resolutionReason,
      lastDeliveryStatus: latest?.dryRun
        ? "DRY_RUN"
        : latest?.waOutboundId
          ? breachDelivery.get(latest.waOutboundId) ?? null
          : null,
    };
  });

  return NextResponse.json({ order, tasks, slaBreaches });
}
