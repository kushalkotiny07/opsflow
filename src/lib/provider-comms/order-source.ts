/**
 * Reading orders for the breach engine.
 *
 * Two queries, because detection and resolution want opposite things:
 *
 *   Detection  only live orders are candidates for a NEW breach.
 *   Resolution an EXISTING breach must be resolvable precisely when the order
 *              has gone terminal — cancelled, patient missed, or finished. If
 *              this used the detection query, a cancelled order would simply
 *              vanish from the result set and its breach would keep messaging
 *              the lab forever. So resolution fetches by id, whatever state
 *              the order is in, and treats "no row" as its own outcome.
 *
 * This reads the LabStack replica only, through the existing read-only
 * accessor, and never writes to it.
 */
import { labstackWorkerQuery } from "@/lib/db/labstack";
import type { MilestoneOrder } from "./milestones";

/** Everything the engine needs about one order, plus what the message renders. */
export interface BreachOrder extends MilestoneOrder {
  labId: number;
  orderType: string;
  patientName: string | null;
  labName: string | null;
  storeName: string | null;
  packageName: string | null;
}

type OrderRow = {
  id: number;
  labId: number | null;
  orderType: string;
  orderStatus: string;
  appointmentTime: Date | null;
  createdAt: Date;
  statusUpdatedAt: Date | null;
  sampleCollectedAt: Date | null;
  reportDeliveredAt: Date | null;
  patientName: string | null;
  labName: string | null;
  storeName: string | null;
  packageName: string | null;
};

const SELECT_COLUMNS = `
      o.id,
      o."labId",
      o."orderType"::text        AS "orderType",
      o."orderStatus"::text      AS "orderStatus",
      o."appointmentTime",
      o."createdAt",
      o."statusUpdatedAt",
      o."sampleCollectedAt",
      o."reportDeliveredAt",
      u.name                     AS "patientName",
      l."labName"                AS "labName",
      s."storeName"              AS "storeName",
      o."packageName"            AS "packageName"`;

const JOINS = `
    FROM public."Order" o
    JOIN public."User" u ON u.id = o."userId"
    LEFT JOIN public."Lab" l ON l.id = o."labId"
    LEFT JOIN public."Store" s ON s.id = o."storeId"`;

function toBreachOrder(row: OrderRow): BreachOrder {
  return {
    id: Number(row.id),
    labId: Number(row.labId),
    orderType: row.orderType,
    orderStatus: row.orderStatus,
    appointmentTime: row.appointmentTime,
    createdAt: row.createdAt,
    statusUpdatedAt: row.statusUpdatedAt,
    sampleCollectedAt: row.sampleCollectedAt,
    reportDeliveredAt: row.reportDeliveredAt,
    patientName: row.patientName,
    labName: row.labName,
    storeName: row.storeName,
    packageName: row.packageName,
  };
}

/**
 * Candidate orders for NEW breaches: live orders belonging to the given labs.
 *
 * Bounded to a window around the appointment for the same reason the poller
 * is — an unbounded scan of `public."Order"` is what wedges the replica. The
 * window is wider than the poller's here because a REPORT_UPLOADED deadline
 * can legitimately fall a day or more after the appointment.
 */
export async function loadCandidateOrders(
  labIds: number[],
  opts: { lookbackDays?: number; lookaheadDays?: number } = {},
): Promise<BreachOrder[]> {
  if (labIds.length === 0) return [];
  const lookback = opts.lookbackDays ?? 14;
  const lookahead = opts.lookaheadDays ?? 10;
  const rows = await labstackWorkerQuery<OrderRow>(
    `SELECT ${SELECT_COLUMNS}
     ${JOINS}
    WHERE o."labId" = ANY($1::int[])
      AND o."orderStatus" NOT IN ('CANCELED', 'PATIENT_MISSED', 'REPORT_DELIVERED')
      AND (
        o."appointmentTime" IS NULL
        OR (o."appointmentTime" >= NOW() - INTERVAL '${lookback} days'
            AND o."appointmentTime" <  NOW() + INTERVAL '${lookahead} days')
      )
    ORDER BY o."createdAt" ASC`,
    [labIds],
  );
  return rows.map(toBreachOrder).filter((order) => Number.isInteger(order.labId));
}

/**
 * Orders behind existing breach events, in ANY state — including cancelled
 * and completed, which is the entire point. An id with no row back means the
 * order was hard-deleted upstream; the caller cancels that event rather than
 * guessing.
 */
export async function loadOrdersByIds(orderIds: number[]): Promise<Map<number, BreachOrder>> {
  const unique = [...new Set(orderIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) return new Map();
  const rows = await labstackWorkerQuery<OrderRow>(
    `SELECT ${SELECT_COLUMNS} ${JOINS} WHERE o.id = ANY($1::int[])`,
    [unique],
  );
  return new Map(rows.map(toBreachOrder).filter((o) => Number.isInteger(o.labId)).map((o) => [o.id, o]));
}
