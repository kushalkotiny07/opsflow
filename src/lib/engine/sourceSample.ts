/**
 * Source-scoped sampling for the rule simulator.
 *
 * The legacy simulator only ever sampled the Order table (fetchAllActiveOrders),
 * so an Appointments/PharmaOrder rule was dry-run against ORDER rows and every
 * row failed the allowedTypes/status gate for the wrong reason. This samples
 * recent rows from the *rule's own* data source and maps them into the same
 * RawOrder-shaped object `evaluateTrigger` consumes, so a non-Order rule
 * simulates against its real entities.
 *
 * It reads directly from the source's tableReference (validated at
 * registration) — the same approach as the data-source Preview endpoint —
 * rather than the source's queryTemplate, because templates vary (some have no
 * $1/$2 placeholders) and a "recent rows" sample is what a dry-run wants.
 */

import labstack from "@/lib/db/labstack";
import { Prisma, type PrismaClient } from "@prisma/client";
import { bareTableName, isValidTableReference } from "@/lib/validation/data-sources";
import type { RawOrder } from "@/lib/engine/labstack";

export interface SampleSourceConfig {
  tableReference: string;
  primaryKeyField: string;
  typeFieldName: string;
  statusFieldName: string;
  metadataFieldMapping: Record<string, string> | null;
}

/** First column name present on the table from a preference list, else null. */
function pick(cols: Set<string>, ...candidates: string[]): string | null {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

function asDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  // RawOrder types these as Date; an invalid/absent value becomes an
  // Invalid Date, which the evaluator's asValidDate() guards treat as "absent".
  return new Date(NaN);
}

/**
 * Fetch up to `cap` recent rows from the source table (bounded to rows touched
 * since `since` when the table has a recency column) and map each to a
 * RawOrder-shaped object. `metadata` is the raw row, so metadata-condition
 * checks resolve by column name.
 */
export async function fetchSourceSample(
  source: SampleSourceConfig,
  since: Date,
  cap: number,
  // Which labstack pool to read from. Defaults to the API pool (used by the
  // simulator, an API request). The poller passes labstackWorker so its bulk
  // reads don't contend with live API traffic.
  client: Pick<PrismaClient, "$queryRaw"> = labstack,
): Promise<RawOrder[]> {
  if (!isValidTableReference(source.tableReference)) return [];
  const bareTable = bareTableName(source.tableReference);

  const columns = await client.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${bareTable}
  `);
  const cols = new Set(columns.map((c) => c.column_name));
  if (cols.size === 0) return [];

  // Recency column for ordering + the "touched since" bound (mirrors the Order
  // path's 7-day window). Fall back to the primary key when absent.
  const recencyCol = pick(cols, "updatedAt", "updated_at", "statusUpdatedAt", "createdAt", "created_at");
  const orderCol = recencyCol ?? (cols.has(source.primaryKeyField) ? source.primaryKeyField : null);

  const orderClause = orderCol
    ? Prisma.sql`ORDER BY ${Prisma.raw(`"${orderCol}"`)} DESC NULLS LAST`
    : Prisma.empty;

  const fetch = (bounded: boolean) => {
    const whereClause = bounded && recencyCol
      ? Prisma.sql`WHERE ${Prisma.raw(`"${recencyCol}"`)} >= ${since}`
      : Prisma.empty;
    return client.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT * FROM ${Prisma.raw(source.tableReference)}
      ${whereClause}
      ${orderClause}
      LIMIT ${cap}
    `);
  };

  // Prefer entities touched within the window (mirrors the Order path). If the
  // source is low-volume or its replica lags so the window is empty, fall back
  // to the most-recent rows regardless of age — a dry-run is useless with zero
  // rows, and the author still sees real entities to reason about.
  let rows = await fetch(true);
  if (rows.length === 0 && recencyCol) rows = await fetch(false);

  const map = source.metadataFieldMapping ?? {};
  const fromMap = (row: Record<string, unknown>, outName: string): unknown =>
    map[outName] != null ? row[map[outName]] : undefined;

  // Resolve patient names via the labstack User table when the source rows
  // carry a user reference (Order uses userId, Appointment uses user_id). The
  // name is a join, not a column, so a plain SELECT * can't surface it — this
  // one extra bulk lookup keeps task titles / the board from showing a blank
  // patient. Best-effort: absent column or User row leaves patientName empty.
  const userCol = pick(cols, "userId", "user_id");
  const userNameById = new Map<number, string>();
  if (userCol) {
    const uids = Array.from(
      new Set(rows.map((r) => Number(r[userCol])).filter((n) => Number.isFinite(n))),
    );
    if (uids.length > 0) {
      const users = await client.$queryRaw<Array<{ id: number; name: string | null }>>(
        Prisma.sql`SELECT id, name FROM public."User" WHERE id IN (${Prisma.join(uids)})`,
      );
      for (const u of users) if (u.name) userNameById.set(Number(u.id), u.name);
    }
  }

  const createdCol = pick(cols, "createdAt", "created_at");
  const updatedCol = pick(cols, "updatedAt", "updated_at", "statusUpdatedAt");
  const apptCol = (map["appointmentTime"] && cols.has(map["appointmentTime"]))
    ? map["appointmentTime"]
    : pick(cols, "appointmentTime", "appointmentDate", "scheduledAt", "slotTime");
  const idNum = (v: unknown): number => {
    const n = typeof v === "bigint" ? Number(v) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const str = (v: unknown): string => (v == null ? "" : String(v));

  const entityType = bareTable.toUpperCase();

  return rows.map((row): RawOrder => ({
    id: idNum(row[source.primaryKeyField]),
    orderType: str(row[source.typeFieldName] ?? "UNKNOWN"),
    orderStatus: str(row[source.statusFieldName] ?? "UNKNOWN"),
    appointmentTime: apptCol ? asDate(row[apptCol]) : new Date(NaN),
    storeId: null,
    labId: null,
    userId: 0,
    createdAt: createdCol ? asDate(row[createdCol]) : new Date(NaN),
    updatedAt: updatedCol ? asDate(row[updatedCol]) : new Date(NaN),
    statusUpdatedAt: updatedCol ? asDate(row[updatedCol]) : new Date(NaN),
    internalNotes: str(row["internalNotes"]),
    notes: str(row["notes"]),
    phleboName: str(fromMap(row, "phleboName")),
    phleboNumber: str(fromMap(row, "phleboNumber")),
    patientName: str(
      fromMap(row, "patientName") ??
        row["patientName"] ??
        (userCol ? userNameById.get(Number(row[userCol])) : undefined),
    ),
    labName: (fromMap(row, "labName") ?? row["labName"] ?? null) as string | null,
    storeName: (fromMap(row, "storeName") ?? row["storeName"] ?? null) as string | null,
    // The evaluator reads metadata conditions by field name; expose the raw row.
    metadata: row,
    entityType,
  }));
}
