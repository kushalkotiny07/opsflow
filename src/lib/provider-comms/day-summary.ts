/**
 * "How much work does this lab have today, and tomorrow?" — counted once.
 *
 * Two features ask that question: the provider board an Ops head reads
 * (app/api/provider-comms/daily-board) and the digest the provider itself
 * receives over WhatsApp (./daily-digest). They must never disagree. A board
 * saying 14 while the message says 11 is worse than either being wrong on its
 * own, because it destroys trust in both — so the counting lives here, in one
 * query, rather than being written twice.
 *
 * Counted in SQL rather than by pulling every order across the wire: a busy
 * lab has hundreds a day, and the board refreshes every minute.
 *
 * "Today" and "tomorrow" are in the operating timezone, never UTC. A day that
 * rolls over at 05:30 local would be wrong for exactly the people using it.
 */
import { labstackWorkerQuery } from "@/lib/db/labstack";

/** Statuses that mean the order will never be fulfilled, or is already done. */
export const DEAD_STATUSES = ["CANCELED", "PATIENT_MISSED"];
export const DONE_STATUSES = ["REPORT_DELIVERED", "PARTIAL_DELIVERED"];

export const TIME_ZONE = () => process.env.TIMEZONE || "Asia/Kolkata";

export type DayCounts = {
  total: number;
  homeCollections: number;
  centreVisits: number;
  awaitingCollection: number;
  collected: number;
  reportPending: number;
  done: number;
  cancelled: number;
  firstAppointment: Date | null;
  nextAppointment: Date | null;
};

export type LabDays = { today: DayCounts; tomorrow: DayCounts };

type DayRow = DayCounts & { labId: number; day: string };

export const EMPTY_DAY: DayCounts = {
  total: 0, homeCollections: 0, centreVisits: 0, awaitingCollection: 0,
  collected: 0, reportPending: 0, done: 0, cancelled: 0,
  firstAppointment: null, nextAppointment: null,
};

/** `2026-09-17` in the operating timezone — the key both halves group on. */
export function localDayKey(at: Date, zone: string): string {
  return at.toLocaleDateString("en-CA", { timeZone: zone });
}

export function todayKey(zone: string): string {
  return localDayKey(new Date(), zone);
}

export function tomorrowKey(zone: string): string {
  return localDayKey(new Date(Date.now() + 86_400_000), zone);
}

/**
 * Today's and tomorrow's counts for each of `labIds`, keyed by lab id.
 *
 * Labs with no orders on either day are present in the map with two empty
 * days rather than missing from it, so callers never have to distinguish
 * "no orders" from "lab not found".
 */
export async function loadDaySummaries(labIds: number[], zone: string): Promise<Map<number, LabDays>> {
  const summaries = new Map<number, LabDays>(
    labIds.map((labId) => [labId, { today: { ...EMPTY_DAY }, tomorrow: { ...EMPTY_DAY } }]),
  );
  if (labIds.length === 0) return summaries;

  const rows = await labstackWorkerQuery<DayRow>(
    `
    WITH local AS (
      SELECT o.*,
             ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE $2)::date AS local_day
        FROM public."Order" o
       WHERE o."labId" = ANY($1::int[])
         AND o."appointmentTime" IS NOT NULL
    )
    SELECT "labId",
           local_day::text AS day,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE "orderType" = 'HOME_SAMPLE')::int  AS "homeCollections",
           COUNT(*) FILTER (WHERE "orderType" = 'CENTER_VISIT')::int AS "centreVisits",
           -- Not yet collected and still live: the work the provider owes us.
           COUNT(*) FILTER (
             WHERE "orderStatus" IN ('ORDER_SCHEDULED','RESCHEDULED','PHLEBO_ASSIGNED','PHLEBO_STARTED')
           )::int AS "awaitingCollection",
           COUNT(*) FILTER (WHERE "orderStatus" IN ('SAMPLE_COLLECTED','SAMPLE_DELIVERED'))::int AS collected,
           -- Collected or processed but no report yet — the TAT clock is running.
           COUNT(*) FILTER (
             WHERE "orderStatus" IN ('SAMPLE_COLLECTED','SAMPLE_DELIVERED','SAMPLE_PROCESSED')
           )::int AS "reportPending",
           -- ::text on the COLUMN, not just the parameter: orderStatus is a
           -- Postgres enum ("OrderStatus"), and enum = text has no operator.
           COUNT(*) FILTER (WHERE "orderStatus"::text = ANY($3::text[]))::int AS done,
           COUNT(*) FILTER (WHERE "orderStatus"::text = ANY($4::text[]))::int AS cancelled,
           MIN("appointmentTime") AS "firstAppointment",
           MIN("appointmentTime") FILTER (WHERE "appointmentTime" > now()) AS "nextAppointment"
      FROM local
     WHERE local_day IN (
             (now() AT TIME ZONE $2)::date,
             (now() AT TIME ZONE $2)::date + 1
           )
     GROUP BY "labId", local_day
    `,
    [labIds, zone, DONE_STATUSES, DEAD_STATUSES],
  );

  const today = todayKey(zone);
  for (const row of rows) {
    const entry = summaries.get(row.labId);
    if (!entry) continue;
    const counts: DayCounts = {
      total: row.total,
      homeCollections: row.homeCollections,
      centreVisits: row.centreVisits,
      awaitingCollection: row.awaitingCollection,
      collected: row.collected,
      reportPending: row.reportPending,
      done: row.done,
      cancelled: row.cancelled,
      firstAppointment: row.firstAppointment ? new Date(row.firstAppointment) : null,
      nextAppointment: row.nextAppointment ? new Date(row.nextAppointment) : null,
    };
    // The SQL already restricts to two days, so anything that is not today is
    // tomorrow — no second date comparison needed.
    if (row.day === today) entry.today = counts;
    else entry.tomorrow = counts;
  }

  return summaries;
}

export type ScheduledOrder = {
  orderId: number;
  /** The lab's OWN reference. What their staff search by, when it exists. */
  labOrderId: string | null;
  appointmentTime: Date;
  orderType: string;
  orderStatus: string;
  patientName: string | null;
  /** Short form — city, or the centre's name. */
  location: string | null;
  /**
   * The most precise location LabStack holds. Not a street address: the source
   * has no such column, only city + pincode on the order and the centre's name
   * and city. Composing them here keeps every caller from re-deciding which of
   * the four fields to trust for which order type.
   */
  address: string | null;
};

/** City + pincode for a home visit; the centre and its city for a centre visit. */
function composeAddress(row: {
  orderType: string; city: string | null; pincode: string | null;
  storeName: string | null; storeCity: string | null; userCity: string | null;
}): string | null {
  const parts = row.orderType === "CENTER_VISIT"
    ? [row.storeName, row.storeCity ?? row.city]
    // The order's own city beats the patient record's: a collection can be
    // booked to an address the patient does not live at.
    : [row.city ?? row.userCity, row.pincode];
  const address = parts.filter(Boolean).join(row.orderType === "CENTER_VISIT" ? ", " : " ").trim();
  return address || null;
}

/**
 * The actual appointments on one local day, earliest first.
 *
 * Counts tell a provider how busy tomorrow is; this tells them what to staff.
 * `limit` is a hard stop rather than a page: a WhatsApp message has no second
 * page, so the caller renders "…and N more" from the count instead.
 */
export async function loadDaySchedule(
  labId: number,
  zone: string,
  dayOffset: 0 | 1,
  limit: number,
): Promise<ScheduledOrder[]> {
  const rows = await labstackWorkerQuery<{
    id: number; labOrderId: string | null; appointmentTime: Date; orderType: string; orderStatus: string;
    patientName: string | null; city: string | null; pincode: string | null;
    storeName: string | null; storeCity: string | null; userCity: string | null;
  }>(
    `
    SELECT o.id, o."labOrderId", o."appointmentTime",
           o."orderType"::text   AS "orderType",
           o."orderStatus"::text AS "orderStatus",
           u.name AS "patientName",
           o.city, o.pincode,
           u.city AS "userCity",
           s."storeName", s.city AS "storeCity"
      FROM public."Order" o
      LEFT JOIN public."User"  u ON u.id = o."userId"
      LEFT JOIN public."Store" s ON s.id = o."storeId"
     WHERE o."labId" = $1
       AND o."appointmentTime" IS NOT NULL
       AND ("appointmentTime" AT TIME ZONE 'UTC' AT TIME ZONE $2)::date
           = (now() AT TIME ZONE $2)::date + $3::int
       -- A cancelled slot is not something to staff for.
       AND o."orderStatus"::text <> ALL($4::text[])
     ORDER BY o."appointmentTime" ASC
     LIMIT $5
    `,
    [labId, zone, dayOffset, DEAD_STATUSES, limit],
  );

  return rows.map((row) => ({
    orderId: row.id,
    labOrderId: row.labOrderId,
    appointmentTime: new Date(row.appointmentTime),
    orderType: row.orderType,
    orderStatus: row.orderStatus,
    patientName: row.patientName,
    location: row.city || row.userCity || row.storeName || null,
    address: composeAddress(row),
  }));
}
