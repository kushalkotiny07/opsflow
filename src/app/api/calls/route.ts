/**
 * POST /api/calls — place a click-to-call from OpsFlow.
 *
 * Exotel dials the CALLER (the logged-in ops user's phone) first, then bridges
 * to `to`. So the caller must have a phone number on their profile.
 *
 * body: { to: string, toName?: string, taskId?: number, storeId?: number,
 *         triggeredFrom?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import prisma from "@/lib/db/client";
import { UserRole } from "@prisma/client";
import { initiateExotelCall } from "@/lib/telephony/exotel";

export async function POST(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const to = String(body?.to ?? "").trim();
  if (!to) return NextResponse.json({ error: "A number to call is required." }, { status: 400 });

  // The caller is the logged-in user; Exotel rings their phone first.
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { phone: true } });
  if (!me?.phone) {
    return NextResponse.json(
      { error: "Add your phone number in your profile before placing calls." },
      { status: 400 },
    );
  }

  const result = await initiateExotelCall({
    from: me.phone,
    to,
    toName: body?.toName ?? null,
    userId: user.id,
    storeId: typeof body?.storeId === "number" ? body.storeId : null,
    taskId: typeof body?.taskId === "number" ? body.taskId : null,
    triggeredFrom: body?.triggeredFrom ?? null,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "Call failed." }, { status: 502 });
  }
  return NextResponse.json({ ok: true, callLogId: result.callLogId, sid: result.sid });
}
