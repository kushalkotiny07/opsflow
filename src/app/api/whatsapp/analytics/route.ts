import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole, Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

// GET /api/whatsapp/analytics — the CRM landing dashboard. Aggregates live from
// the taskos side (fast; no replica needed). Open cases = tickets not resolved.
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const OPEN = Prisma.sql`t.status <> 'RESOLVED'`;

  const [totals, byStatus, byIntent, byStore, byLab, ageBuckets, volume, briefs] = await Promise.all([
    prisma.$queryRaw<Array<{ open: bigint; resolved_today: bigint; listening: bigint; unread: bigint }>>`
      SELECT
        (SELECT count(*) FROM wa_tickets t WHERE ${OPEN}) AS open,
        (SELECT count(*) FROM wa_tickets t WHERE t.status='RESOLVED' AND t."resolvedAt" >= now() - interval '1 day') AS resolved_today,
        (SELECT count(*) FROM wa_groups WHERE active = true) AS listening,
        (SELECT count(*) FROM wa_groups g WHERE g.active = true AND EXISTS (
            SELECT 1 FROM wa_messages m WHERE m."groupId"=g.id AND m.ts > COALESCE(g."lastReadAt", 'epoch'))) AS unread`,
    prisma.$queryRaw<Array<{ status: string; n: bigint }>>`
      SELECT t.status::text AS status, count(*) AS n FROM wa_tickets t WHERE ${OPEN} GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<Array<{ intent: string | null; n: bigint }>>`
      SELECT t.intent AS intent, count(*) AS n FROM wa_tickets t WHERE ${OPEN} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    prisma.$queryRaw<Array<{ subject: string; n: bigint }>>`
      SELECT g.subject, count(*) AS n FROM wa_tickets t JOIN wa_groups g ON g.id=t."groupId"
      WHERE ${OPEN} AND g.role='SUPPORT' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    prisma.$queryRaw<Array<{ subject: string; n: bigint }>>`
      SELECT g.subject, count(*) AS n FROM wa_tickets t JOIN wa_groups g ON g.id=t."groupId"
      WHERE ${OPEN} AND g.role='PROVIDER' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    prisma.$queryRaw<Array<{ bucket: string; n: bigint }>>`
      SELECT CASE
        WHEN t."lastActivityAt" > now() - interval '1 hour' THEN '0-1h'
        WHEN t."lastActivityAt" > now() - interval '4 hours' THEN '1-4h'
        WHEN t."lastActivityAt" > now() - interval '24 hours' THEN '4-24h'
        ELSE '24h+' END AS bucket, count(*) AS n
      FROM wa_tickets t WHERE ${OPEN} GROUP BY 1`,
    prisma.$queryRaw<Array<{ d1: bigint; d7: bigint }>>`
      SELECT
        count(*) FILTER (WHERE ts > now() - interval '1 day') AS d1,
        count(*) FILTER (WHERE ts > now() - interval '7 days') AS d7
      FROM wa_messages`,
    prisma.$queryRaw<Array<{ total: bigint; resolved: bigint }>>`
      SELECT count(*) AS total, count(*) FILTER (WHERE resolved) AS resolved FROM wa_case_briefs`,
  ]);

  // Response & resolution health — channel-agnostic (native WhatsApp OR console).
  const resp = await prisma.$queryRaw<Array<{ open: bigint; responded: bigint; native: bigint; console: bigint; avg_first_min: number | null; stale: bigint; resolved_24h: bigint }>>`
    SELECT
      count(*) FILTER (WHERE status <> 'RESOLVED') AS open,
      count(*) FILTER (WHERE status <> 'RESOLVED' AND "firstResponseAt" IS NOT NULL) AS responded,
      count(*) FILTER (WHERE "respondedVia" = 'native') AS native,
      count(*) FILTER (WHERE "respondedVia" = 'console') AS console,
      avg(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt")) / 60)
        FILTER (WHERE "firstResponseAt" IS NOT NULL AND "createdAt" > now() - interval '7 days') AS avg_first_min,
      count(*) FILTER (WHERE status <> 'RESOLVED' AND "lastActivityAt" < now() - interval '24 hours') AS stale,
      count(*) FILTER (WHERE status = 'RESOLVED' AND "resolvedAt" > now() - interval '1 day') AS resolved_24h
    FROM wa_tickets`;

  // `t` alias is required: OPEN is `t.status <> 'RESOLVED'`, so an unaliased
  // FROM here made the whole endpoint 500 with 42P01 "missing FROM-clause
  // entry for table t" — independent of how much WhatsApp data exists.
  const origins = await prisma.$queryRaw<Array<{ origin: string; n: bigint }>>`
    SELECT t.origin, count(*) AS n FROM wa_tickets t WHERE ${OPEN} GROUP BY 1`;

  const n = (v: bigint | undefined) => Number(v || 0);
  const list = (rows: Array<{ n: bigint } & Record<string, unknown>>, key: string) =>
    rows.map((r) => ({ label: String(r[key] ?? "—"), n: n(r.n) }));

  return NextResponse.json({
    totals: {
      open: n(totals[0]?.open), resolvedToday: n(totals[0]?.resolved_today),
      listening: n(totals[0]?.listening), unread: n(totals[0]?.unread),
    },
    byStatus: list(byStatus, "status"),
    byIntent: list(byIntent, "intent"),
    byStore: list(byStore, "subject"),
    byLab: list(byLab, "subject"),
    ageBuckets: ["0-1h", "1-4h", "4-24h", "24h+"].map((b) => ({ label: b, n: n(ageBuckets.find((x) => x.bucket === b)?.n) })),
    volume: { d1: n(volume[0]?.d1), d7: n(volume[0]?.d7) },
    briefs: { total: n(briefs[0]?.total), resolved: n(briefs[0]?.resolved) },
    origins: {
      customer: n(origins.find((o) => o.origin === "CUSTOMER")?.n),
      provider: n(origins.find((o) => o.origin === "PROVIDER")?.n),
    },
    response: {
      open: n(resp[0]?.open),
      responded: n(resp[0]?.responded),
      respondedRate: n(resp[0]?.open) ? Math.round((n(resp[0]?.responded) / n(resp[0]?.open)) * 100) : 0,
      native: n(resp[0]?.native), console: n(resp[0]?.console),
      avgFirstMin: Math.round(Number(resp[0]?.avg_first_min || 0)),
      stale24h: n(resp[0]?.stale), resolved24h: n(resp[0]?.resolved_24h),
    },
  });
}
