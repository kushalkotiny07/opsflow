import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import prisma from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";

// GET /api/whatsapp/gateway — connection status + live QR (as a data URL)
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  // Agents may READ gateway status (for the online/dry-run pill); only the Lead
  // can connect / change it (POST stays OPS_HEAD-only below).
  if (!user || (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const gw = await prisma.waGateway.findUnique({ where: { id: "default" } });
  if (!gw) {
    return NextResponse.json({ status: "CONNECTING", online: false, connectedNumber: null, qrDataUrl: null, lastSeenAt: null });
  }
  // A heartbeat from the FUTURE means the gateway is writing timestamps in a
  // different zone (it used to write IST into a UTC column). Treat it as not
  // online rather than as freshly seen, so a stale process cannot read as live.
  const heartbeatAge = gw.lastSeenAt ? Date.now() - new Date(gw.lastSeenAt).getTime() : null;
  const online = heartbeatAge !== null && heartbeatAge >= 0 && heartbeatAge < 60_000;

  // WhatsApp rotates the QR roughly every 20 seconds and the gateway pushes
  // each one here. The row keeps the last value after the gateway stops, so
  // without a freshness check the console renders a long-dead QR that simply
  // fails when scanned — indistinguishable, to the person holding the phone,
  // from the feature being broken.
  const qrAge = gw.qrUpdatedAt ? Date.now() - new Date(gw.qrUpdatedAt).getTime() : null;
  const qrFresh = qrAge !== null && qrAge >= 0 && qrAge < 90_000;

  let qrDataUrl: string | null = null;
  if (gw.status === "QR" && gw.qr && qrFresh) {
    try { qrDataUrl = await QRCode.toDataURL(gw.qr, { width: 260, margin: 1 }); } catch { qrDataUrl = null; }
  }
  return NextResponse.json({
    status: gw.status,
    online,
    connectedNumber: gw.connectedNumber,
    lastSeenAt: gw.lastSeenAt,
    dryRun: gw.dryRun ?? null,
    qrDataUrl,
    // Is the gateway PROCESS alive at all?
    //
    // A heartbeat only starts once a session is linked, so during the scan
    // phase the only proof of life is a QR that keeps rotating. Reporting this
    // separately is what lets the UI say "the gateway is not running" instead
    // of "Generating QR…" forever — the latter blames a slow render for a
    // process that is not there, which is exactly how this was missed.
    gatewayLive: online || qrFresh,
  });
}

// POST /api/whatsapp/gateway — issue an admin command (RELINK | LOGOUT)
export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user || user.role !== UserRole.OPS_HEAD)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const command = String(body?.command || "").toUpperCase();
  if (!["RELINK", "LOGOUT", "BACKFILL"].includes(command))
    return NextResponse.json({ error: "command must be RELINK, LOGOUT or BACKFILL" }, { status: 400 });

  await prisma.waGateway.upsert({
    where: { id: "default" },
    create: { id: "default", status: "CONNECTING", command, commandRequestedAt: new Date() },
    update: { command, commandRequestedAt: new Date() },
  });
  return NextResponse.json({ ok: true, command });
}
