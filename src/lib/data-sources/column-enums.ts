/**
 * Live column-enum introspection against the LABSTACK (source-of-truth) DB.
 *
 * A data source's status/type field is either a Postgres enum (USER-DEFINED)
 * or a plain text column. This helper returns the set of values the column can
 * actually hold:
 *
 *   - enum column  → the enum's labels, in declaration order
 *   - text/varchar → the DISTINCT observed values (capped)
 *
 * Extracted from src/app/api/data-sources/column-enums/route.ts so the rule
 * validator can reuse the exact same introspection the status dropdown uses.
 * That keeps "what the UI offers" and "what the server accepts" in lockstep.
 *
 * All reads go through `labstackOr`, so a wedged/absent replica degrades to an
 * empty result instead of throwing — callers decide how to treat "unknown".
 */

import labstack, { labstackOr } from "@/lib/db/labstack";
import { Prisma } from "@prisma/client";

const IDENT_RE = /^[a-zA-Z0-9_]+$/;

/** Strip surrounding double-quotes from a possibly-quoted identifier. */
export function cleanIdentifier(name: string): string {
  return name.replace(/^"(.+)"$/, "$1");
}

/** public."Order" | public.Order | "Order" | Order  →  Order */
export function tableNameFromReference(tableReference: string): string {
  return cleanIdentifier(tableReference.replace(/^.*\./, ""));
}

/**
 * Return the possible values for `column` on `table` (public schema), or an
 * empty array if the column can't be introspected (not found, replica down,
 * unsupported type). Never throws.
 */
export async function introspectColumnValues(table: string, column: string): Promise<string[]> {
  const tableClean = cleanIdentifier(table);
  const columnClean = cleanIdentifier(column);

  // Guard against injection: only bare identifiers reach the raw text queries.
  if (!IDENT_RE.test(tableClean) || !IDENT_RE.test(columnClean)) return [];

  const columnInfo = await labstackOr(
    labstack.$queryRaw<Array<{ data_type: string; udt_name: string; udt_schema: string }>>(
      Prisma.sql`
        SELECT data_type, udt_name, udt_schema
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${tableClean}
          AND column_name = ${columnClean}
        LIMIT 1
      `,
    ),
    [] as Array<{ data_type: string; udt_name: string; udt_schema: string }>,
  );

  if (columnInfo.length === 0) return [];
  const { data_type: dataType, udt_name: udtName, udt_schema: udtSchema } = columnInfo[0];

  // Enum column → labels in declaration order.
  if (dataType === "USER-DEFINED" && udtName) {
    const rows = await labstackOr(
      labstack.$queryRaw<Array<{ enumlabel: string }>>(
        Prisma.sql`
          SELECT enumlabel
          FROM pg_type
          JOIN pg_enum ON pg_type.oid = pg_enum.enumtypid
          WHERE pg_type.typname = ${udtName}
            AND pg_type.typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${udtSchema})
          ORDER BY pg_enum.enumsortorder
        `,
      ),
      [] as Array<{ enumlabel: string }>,
    );
    return rows.map((r) => r.enumlabel);
  }

  // Plain text/varchar → DISTINCT observed values (identifiers already validated).
  if (dataType === "character varying" || dataType === "text") {
    const rows = await labstackOr(
      labstack.$queryRawUnsafe<Array<{ val: string }>>(
        `SELECT DISTINCT "${columnClean}" AS val FROM "${tableClean}" WHERE "${columnClean}" IS NOT NULL ORDER BY "${columnClean}" LIMIT 100`,
      ),
      [] as Array<{ val: string }>,
    );
    return rows.map((r) => String(r.val)).filter(Boolean);
  }

  return [];
}
