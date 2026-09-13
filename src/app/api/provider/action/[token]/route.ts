import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";

async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const actions = new Set(["ACCEPT", "RESCHEDULE", "REJECT"] as const);
type ProviderAction = "ACCEPT" | "RESCHEDULE" | "REJECT";

function resultFor(action: ProviderAction) {
  if (action === "ACCEPT") return { status: "LAB_ACCEPTED" as const, event: "LAB_ACCEPTED" as const, message: "Order accepted" };
  if (action === "RESCHEDULE") return { status: "LAB_RESCHEDULE_REQUESTED" as const, event: "LAB_RESCHEDULE_REQUESTED" as const, message: "Reschedule request sent" };
  return { status: "LAB_REJECTED" as const, event: "LAB_REJECTED" as const, message: "Order marked as unable to fulfil" };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const requestId = newRequestId();
  try {
    const { token } = await params;
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return NextResponse.json({ error: "Invalid action link", code: "INVALID_TOKEN", requestId }, { status: 400 });
    }
    const contentType = request.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await request.json().catch(() => ({}))
      : Object.fromEntries((await request.formData()).entries());
    const action = body.action as ProviderAction;
    if (!actions.has(action)) {
      return NextResponse.json({ error: "Choose accept, reschedule, or reject", code: "VALIDATION_ERROR", requestId }, { status: 400 });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    const proposedAppointmentTime = typeof body.proposedAppointmentTime === "string"
      ? body.proposedAppointmentTime.trim().slice(0, 100)
      : "";

    const tokenHash = await sha256(token);
    const now = new Date();
    const result = resultFor(action);
    await prisma.$transaction(async (tx) => {
      const actionToken = await tx.labProviderActionToken.findUnique({
        where: { tokenHash },
        include: { workflow: true },
      });
      if (!actionToken || actionToken.action !== action) throw new Error("INVALID_ACTION_LINK");
      if (actionToken.usedAt || actionToken.expiresAt <= now) throw new Error("EXPIRED_ACTION_LINK");
      if (["CANCELLED", "COMPLETED", "LAB_REJECTED"].includes(actionToken.workflow.status)) throw new Error("WORKFLOW_CLOSED");

      await tx.labProviderActionToken.update({ where: { id: actionToken.id }, data: { usedAt: now } });
      await tx.labCommunicationWorkflow.update({
        where: { id: actionToken.workflowId },
        data: {
          status: result.status,
          acceptedAt: action === "ACCEPT" ? now : undefined,
          rescheduleRequestedAt: action === "RESCHEDULE" ? now : undefined,
          rejectedAt: action === "REJECT" ? now : undefined,
          rejectionReason: action === "REJECT" ? (reason || "No reason provided") : undefined,
        },
      });
      await tx.labCommunication.updateMany({
        where: { workflowId: actionToken.workflowId, status: { in: ["QUEUED", "SENT", "DELIVERED", "READ"] } },
        data: { status: "ACTION_TAKEN", actionTakenAt: now },
      });
      await tx.labCommunicationOrderEvent.create({
        data: {
          workflowId: actionToken.workflowId,
          type: result.event,
          actorType: "LAB",
          payload: { action, tokenId: actionToken.id, reason: reason || null, proposedAppointmentTime: proposedAppointmentTime || null },
        },
      });
      await tx.labCommunicationAuditLog.create({
        data: {
          workflowId: actionToken.workflowId,
          action: `LAB_${action}`,
          actorType: "LAB",
          requestId,
          metadata: { tokenId: actionToken.id, reason: reason || null, proposedAppointmentTime: proposedAppointmentTime || null },
        },
      });
    });

    if (!contentType.includes("application/json")) {
      return NextResponse.redirect(new URL(`/provider/action/${token}?result=success`, request.url), 303);
    }
    return NextResponse.json({ ok: true, message: result.message, requestId });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_ACTION_LINK") {
      return NextResponse.json({ error: "This action does not belong to this link", code: "INVALID_TOKEN", requestId }, { status: 404 });
    }
    if (error instanceof Error && ["EXPIRED_ACTION_LINK", "WORKFLOW_CLOSED"].includes(error.message)) {
      return NextResponse.json({ error: "This action link has expired or was already used", code: "ACTION_UNAVAILABLE", requestId }, { status: 409 });
    }
    return NextResponse.json(logAndBuildErrorBody({ requestId, scope: "ProviderActionAPI.POST", code: "ACTION_ERROR", userMessage: "Could not record this lab action", error }), { status: 500 });
  }
}
