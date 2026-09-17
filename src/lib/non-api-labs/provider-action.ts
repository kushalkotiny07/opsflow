/**
 * Applying a provider's answer to a confirmation request.
 *
 * There are two ways an answer arrives and they must land identically:
 *   • a tokenized link  — /api/provider/action/[token], one-shot, per-action
 *   • a WhatsApp poll   — the provider taps an option in their own group
 *
 * The link flow owned this transaction inline, which made the poll flow a
 * choice between importing a route handler or re-implementing the state
 * machine. Both are bad, so the transaction lives here and each caller does
 * only its own authentication: the route verifies a token hash, the tick
 * verifies the vote came from a poll the gateway itself sent.
 *
 * Deliberately NOT exported as an HTTP endpoint for the gateway to call. The
 * gateway records a vote in `wa_polls` and the every-minute tick applies it, so
 * a vote survives the app being restarted.
 */
import type { Prisma, LabProviderActionType } from "@prisma/client";
import prisma from "@/lib/db/client";

export type ProviderActionSource = "TOKEN" | "POLL";

export type ApplyProviderActionInput = {
  workflowId: string;
  action: LabProviderActionType;
  /** Free text the provider gave. Polls carry none at vote time; it arrives later. */
  reason?: string | null;
  proposedAppointmentTime?: string | null;
  source: ProviderActionSource;
  /** Whatever identifies the actor for the audit trail — token id, or voter jid. */
  actorRef?: string | null;
  requestId?: string | null;
};

/** Workflow states past the point where a provider answer still means anything. */
const CLOSED_STATUSES = ["CANCELLED", "COMPLETED", "LAB_REJECTED"] as const;

export class WorkflowClosedError extends Error {
  constructor() {
    super("WORKFLOW_CLOSED");
    this.name = "WorkflowClosedError";
  }
}

function resultFor(action: LabProviderActionType) {
  if (action === "ACCEPT") {
    return { status: "LAB_ACCEPTED" as const, event: "LAB_ACCEPTED" as const, message: "Order accepted" };
  }
  if (action === "RESCHEDULE") {
    return {
      status: "LAB_RESCHEDULE_REQUESTED" as const,
      event: "LAB_RESCHEDULE_REQUESTED" as const,
      message: "Reschedule request sent",
    };
  }
  return { status: "LAB_REJECTED" as const, event: "LAB_REJECTED" as const, message: "Order marked as unable to fulfil" };
}

/**
 * Record the answer against the workflow, inside one transaction.
 *
 * `tx` lets a caller that already holds a transaction — the token route, which
 * must burn the token in the same breath — reuse it rather than nest.
 *
 * Throws WorkflowClosedError when the workflow has already finished; callers
 * decide whether that is a 409 or a vote to discard.
 */
export async function applyProviderAction(
  input: ApplyProviderActionInput,
  tx?: Prisma.TransactionClient,
) {
  const run = async (db: Prisma.TransactionClient) => {
    const workflow = await db.labCommunicationWorkflow.findUnique({
      where: { id: input.workflowId },
      select: { id: true, status: true },
    });
    if (!workflow) throw new WorkflowClosedError();
    if ((CLOSED_STATUSES as readonly string[]).includes(workflow.status)) throw new WorkflowClosedError();

    const now = new Date();
    const result = resultFor(input.action);
    const reason = input.reason?.trim().slice(0, 500) || null;
    const proposed = input.proposedAppointmentTime?.trim().slice(0, 100) || null;

    await db.labCommunicationWorkflow.update({
      where: { id: input.workflowId },
      data: {
        status: result.status,
        acceptedAt: input.action === "ACCEPT" ? now : undefined,
        rescheduleRequestedAt: input.action === "RESCHEDULE" ? now : undefined,
        rejectedAt: input.action === "REJECT" ? now : undefined,
        // A poll vote has no reason yet — leave the column alone rather than
        // writing "No reason provided" over something a follow-up will supply.
        rejectionReason:
          input.action === "REJECT" ? (reason ?? (input.source === "TOKEN" ? "No reason provided" : undefined)) : undefined,
      },
    });

    // Everything still in flight for this order has been answered.
    await db.labCommunication.updateMany({
      where: { workflowId: input.workflowId, status: { in: ["QUEUED", "SENT", "DELIVERED", "READ"] } },
      data: { status: "ACTION_TAKEN", actionTakenAt: now },
    });

    // Nothing further should chase a provider who has already answered.
    await db.labScheduledAction.updateMany({
      where: { workflowId: input.workflowId, status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "SUPPRESSED", completedAt: now, cancelledAt: now, lastError: `Provider answered (${input.action})` },
    });

    await db.labCommunicationOrderEvent.create({
      data: {
        workflowId: input.workflowId,
        type: result.event,
        actorType: "LAB",
        payload: {
          action: input.action,
          source: input.source,
          actorRef: input.actorRef ?? null,
          reason,
          proposedAppointmentTime: proposed,
        },
      },
    });

    await db.labCommunicationAuditLog.create({
      data: {
        workflowId: input.workflowId,
        action: `LAB_${input.action}`,
        actorType: "LAB",
        requestId: input.requestId ?? null,
        metadata: {
          source: input.source,
          actorRef: input.actorRef ?? null,
          reason,
          proposedAppointmentTime: proposed,
        },
      },
    });

    return result;
  };

  return tx ? run(tx) : prisma.$transaction((t) => run(t));
}

/**
 * Attach a reason that arrived after the vote.
 *
 * Only meaningful for REJECT (rejectionReason is the column that exists); a
 * RESCHEDULE follow-up is still recorded as an event so the desk can read what
 * the provider proposed.
 */
export async function attachProviderReason(input: {
  workflowId: string;
  /** null for an informational answer: record the words, move no state. */
  action: LabProviderActionType | null;
  reason: string;
  actorRef?: string | null;
}) {
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) return;

  await prisma.$transaction(async (tx) => {
    if (input.action === "REJECT") {
      await tx.labCommunicationWorkflow.update({
        where: { id: input.workflowId },
        data: { rejectionReason: reason },
      });
    }
    await tx.labCommunicationOrderEvent.create({
      data: {
        workflowId: input.workflowId,
        // PROVIDER_NOTE for an informational answer — calling it LAB_REJECTED
        // would put a rejection on an order nobody rejected.
        type: input.action === null ? "PROVIDER_NOTE"
          : input.action === "REJECT" ? "LAB_REJECTED"
          : "LAB_RESCHEDULE_REQUESTED",
        actorType: "LAB",
        payload: { action: input.action, source: "POLL", followUp: true, reason, actorRef: input.actorRef ?? null },
      },
    });
  });
}
