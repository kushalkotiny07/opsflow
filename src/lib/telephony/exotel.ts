/**
 * Exotel click-to-call.
 *
 * Flow: Exotel dials the AGENT's phone (`from`) first; when they answer it
 * bridges to the target (`to`). The number the target sees is the Exotel
 * virtual `CallerId`. All calls are recorded and status updates are posted back
 * to /api/exotel/callback.
 *
 * Credentials come only from the environment — never hard-code them.
 */
import prisma from "@/lib/db/client";
import { CallSource, CallStatus } from "@prisma/client";

/** Normalise an Indian mobile to E.164 (+91XXXXXXXXXX). Returns null if it
 *  can't be made into a plausible number. */
export function normalizeMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 10 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return null;
}

export interface InitiateCallParams {
  from: string;          // the agent's own phone (Exotel dials this first)
  to: string;            // the person being called
  toName?: string | null;
  userId?: number | null;
  storeId?: number | null;
  taskId?: number | null;
  triggeredFrom?: string | null;
}

export interface InitiateCallResult {
  success: boolean;
  callLogId?: number;
  sid?: string;
  error?: string;
}

export async function initiateExotelCall(params: InitiateCallParams): Promise<InitiateCallResult> {
  const EXOTEL_SID = process.env.EXOTEL_SESSION_ID;
  const EXOTEL_USERNAME = process.env.EXOTEL_USERNAME;
  const EXOTEL_PASSWORD = process.env.EXOTEL_PASSWORD;
  const EXOTEL_CALLER_ID = process.env.EXOTEL_CALLER_ID;
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || process.env.BASE_URL;
  const EXOTEL_API_BASE_URL = process.env.NEXT_PUBLIC_EXOTEL_API_BASE_URL || "https://twilix.exotel.in";

  if (!EXOTEL_SID || !EXOTEL_USERNAME || !EXOTEL_PASSWORD || !EXOTEL_CALLER_ID) {
    return { success: false, error: "Calling is not configured (missing Exotel env vars)." };
  }
  if (!APP_URL) {
    return { success: false, error: "Calling is not configured (missing app URL for the status callback)." };
  }

  const normalizedFrom = normalizeMobile(params.from);
  const normalizedTo = normalizeMobile(params.to);
  if (!normalizedFrom) return { success: false, error: "Your phone number is missing or invalid — set it in your profile." };
  if (!normalizedTo) return { success: false, error: "The number to call is missing or invalid." };

  // Record the attempt up front so we always have a row to reconcile against
  // the status callback, even if the API call itself fails.
  const callLog = await prisma.callLog.create({
    data: {
      source: CallSource.EXOTEL,
      status: CallStatus.INITIATED,
      sourceMobile: normalizedFrom,
      targetMobile: normalizedTo,
      targetUserName: params.toName ?? null,
      userId: params.userId ?? null,
      storeId: params.storeId ?? null,
      taskId: params.taskId ?? null,
      triggeredFrom: params.triggeredFrom ?? null,
    },
  });

  try {
    const formData = new URLSearchParams();
    formData.append("From", normalizedFrom);
    formData.append("To", normalizedTo);
    formData.append("CallerId", EXOTEL_CALLER_ID);
    formData.append("Record", "true");
    formData.append("StatusCallback", `${APP_URL}/api/exotel/callback`);
    formData.append("StatusCallbackContentType", "application/json");
    formData.append("StatusCallbackEvents[0]", "terminal");
    formData.append("StatusCallbackEvents[1]", "answered");
    formData.append("CustomField", String(callLog.id));

    const authHeader = Buffer.from(`${EXOTEL_USERNAME}:${EXOTEL_PASSWORD}`).toString("base64");
    const apiUrl = `${EXOTEL_API_BASE_URL}/v1/Accounts/${EXOTEL_SID}/Calls/connect.json`;

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      await prisma.callLog.update({
        where: { id: callLog.id },
        data: { status: CallStatus.FAILED, errorMessage: `Exotel ${res.status}: ${text.slice(0, 500)}` },
      });
      return { success: false, callLogId: callLog.id, error: `Call failed (Exotel ${res.status}).` };
    }

    // Pull the CallSid out of the JSON response so the callback can be matched
    // by sid too, not just CustomField.
    let sid: string | undefined;
    try {
      const json = JSON.parse(text);
      sid = json?.Call?.Sid ?? json?.Sid ?? undefined;
    } catch { /* non-JSON body — CustomField still links the callback */ }

    if (sid) {
      await prisma.callLog.update({ where: { id: callLog.id }, data: { sid } });
    }
    return { success: true, callLogId: callLog.id, sid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.callLog.update({
      where: { id: callLog.id },
      data: { status: CallStatus.FAILED, errorMessage: message.slice(0, 500) },
    }).catch(() => {});
    return { success: false, callLogId: callLog.id, error: "Could not reach the calling provider." };
  }
}
