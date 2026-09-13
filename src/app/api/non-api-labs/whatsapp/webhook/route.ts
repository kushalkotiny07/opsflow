import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import prisma from "@/lib/db/client";
import { normalizeDeliveryStatus } from "@/lib/non-api-labs/delivery-events";
import type { LabOrderEventType } from "@prisma/client";

function firstDefined(...values: Array<string | null | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0) ?? null;
}

function hasValidWebhookSecret(request: NextRequest) {
  const expected = process.env.NON_API_WHATSAPP_WEBHOOK_SECRET;
  if (!expected) return false;
  const provided = request.headers.get("x-non-api-webhook-secret")
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export async function POST(request: NextRequest) {
  if (!hasValidWebhookSecret(request)) {
    return NextResponse.json({ ok: false, error: "Webhook authentication failed" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const rawStatus = firstDefined(
    typeof body?.status === "string" ? body.status : null,
    typeof body?.state === "string" ? body.state : null,
    typeof body?.event === "string" ? body.event : null,
  );
  const rawMessageId = firstDefined(
    typeof body?.waMsgId === "string" ? body.waMsgId : null,
    typeof body?.messageId === "string" ? body.messageId : null,
    typeof body?.outboundId === "string" ? body.outboundId : null,
    typeof body?.id === "string" ? body.id : null,
  );

  const nextStatus = normalizeDeliveryStatus(rawStatus);
  if (!rawMessageId || !nextStatus) {
    return NextResponse.json({ ok: true, matched: false, reason: "no-delivery-status" });
  }

  let communication = await prisma.labCommunication.findFirst({
    where: {
      OR: [
        { waOutboundId: rawMessageId },
        { providerMessageId: rawMessageId },
        { idempotencyKey: rawMessageId },
      ],
    },
    include: { workflow: true },
  });

  if (!communication) {
    const outbound = await prisma.waOutbound.findFirst({ where: { sentWaMsgId: rawMessageId }, select: { id: true } });
    if (outbound) {
      communication = await prisma.labCommunication.findFirst({ where: { waOutboundId: outbound.id }, include: { workflow: true } });
    }
  }

  if (!communication) {
    return NextResponse.json({ ok: true, matched: false, reason: "communication-not-found" });
  }

  const occurredAt = new Date();
  // Partial on purpose — QUEUED is a delivery status with no workflow event to
  // record — so it is typed as such rather than indexed blind.
  const eventTypeMap: Partial<Record<typeof nextStatus, LabOrderEventType>> = {
    SENT: "MESSAGE_SENT",
    DELIVERED: "MESSAGE_DELIVERED",
    READ: "MESSAGE_READ",
    FAILED: "WORKFLOW_CANCELLED",
    SUPPRESSED: "REMINDER_SUPPRESSED",
    ACTION_TAKEN: "LAB_ACCEPTED",
  };

  const updateData: Record<string, Date | string | null> = {
    status: nextStatus,
  };

  if (nextStatus === "SENT") updateData.sentAt = occurredAt;
  if (nextStatus === "DELIVERED") updateData.deliveredAt = occurredAt;
  if (nextStatus === "READ") updateData.readAt = occurredAt;
  if (nextStatus === "FAILED") updateData.failedAt = occurredAt;
  if (nextStatus === "SUPPRESSED") updateData.suppressedAt = occurredAt;

  // SLA_BREACH alerts carry no workflow — they are sent to API labs too, which
  // never run the confirmation workflow. Their delivery status is still
  // recorded on the communication; what is skipped is the per-workflow
  // timeline and audit trail, which have no workflow to attach to.
  const workflowId = communication.workflowId;

  await prisma.$transaction(async (tx) => {
    await tx.labCommunication.update({
      where: { id: communication.id },
      data: updateData,
    });

    if (!workflowId) return;

    await tx.labCommunicationOrderEvent.create({
      data: {
        workflowId,
        type: eventTypeMap[nextStatus] ?? "MESSAGE_SENT",
        actorType: "SYSTEM",
        payload: {
          deliveryStatus: nextStatus,
          messageId: rawMessageId,
          communicationId: communication.id,
          rawStatus,
        },
      },
    });

    await tx.labCommunicationAuditLog.create({
      data: {
        workflowId,
        action: `MESSAGE_${nextStatus}`,
        actorType: "SYSTEM",
        metadata: {
          communicationId: communication.id,
          messageId: rawMessageId,
          rawStatus,
        },
      },
    });
  });

  return NextResponse.json({ ok: true, matched: true, workflowId: communication.workflowId, status: nextStatus });
}
