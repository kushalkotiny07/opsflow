/**
 * POST /api/exotel/callback — Exotel call status webhook.
 *
 * Exotel posts here on the "answered" and "terminal" events (see the
 * StatusCallback set in exotel.ts). We reconcile the matching CallLog by the
 * CustomField (our callLog.id) first, falling back to the CallSid.
 *
 * No auth: it's an external webhook. It only updates a CallLog row by id/sid,
 * so there's no privileged action to abuse; unknown ids are ignored.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { CallStatus } from "@prisma/client";

// Exotel status string → our enum. Kept permissive; unknowns leave status as-is.
function mapStatus(raw: string | undefined | null): CallStatus | null {
  switch ((raw ?? "").toLowerCase()) {
    case "in-progress":
    case "answered":
      return CallStatus.ANSWERED;
    case "ringing":
      return CallStatus.RINGING;
    case "completed":
      return CallStatus.COMPLETED;
    case "failed":
      return CallStatus.FAILED;
    case "busy":
      return CallStatus.BUSY;
    case "no-answer":
      return CallStatus.NO_ANSWER;
    case "canceled":
    case "cancelled":
      return CallStatus.CANCELED;
    default:
      return null;
  }
}

export async function POST(request: NextRequest) {
  // Exotel may post JSON or form-encoded depending on config; accept both.
  let payload: Record<string, unknown> = {};
  const ctype = request.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("application/json")) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      form.forEach((v, k) => { payload[k] = typeof v === "string" ? v : String(v); });
    }
  } catch {
    // Always 200 to the webhook so Exotel doesn't retry-storm on a parse blip.
    return NextResponse.json({ ok: true });
  }

  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = payload[k];
      if (v != null && v !== "") return String(v);
    }
    return undefined;
  };

  const customField = get("CustomField", "custom_field");
  const sid = get("CallSid", "Sid", "call_sid");
  const status = mapStatus(get("Status", "CallStatus", "status"));
  const recordingUrl = get("RecordingUrl", "recording_url");
  const durationRaw = get("DialCallDuration", "ConversationDuration", "Duration", "duration");
  const durationSec = durationRaw ? parseInt(durationRaw, 10) : undefined;

  // Locate the call log: prefer our own CustomField id, else the CallSid.
  const callLogId = customField ? parseInt(customField, 10) : NaN;
  const where = !isNaN(callLogId) ? { id: callLogId } : sid ? { sid } : null;
  if (!where) return NextResponse.json({ ok: true });

  const data: Record<string, unknown> = {};
  if (status) data.status = status;
  if (sid) data.sid = sid;
  if (recordingUrl) data.recordingUrl = recordingUrl;
  if (durationSec != null && !isNaN(durationSec)) data.durationSec = durationSec;
  if (Object.keys(data).length === 0) return NextResponse.json({ ok: true });

  try {
    await prisma.callLog.updateMany({ where, data });
  } catch {
    // Swallow — never fail a provider webhook.
  }
  return NextResponse.json({ ok: true });
}
