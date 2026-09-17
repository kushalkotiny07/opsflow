/**
 * Turning WhatsApp poll votes into workflow state.
 *
 * The gateway can decrypt a vote but must not own the workflow state machine,
 * so it writes the vote to `wa_polls` and stops. This is the other side: the
 * every-minute tick drains VOTED rows and applies them exactly as a tokenized
 * link would, through the shared writer in ./provider-action.
 *
 * Doing it this way rather than having the gateway POST to an endpoint means a
 * vote cast while the app is restarting is applied a minute later instead of
 * being lost — providers answer once and do not get asked again.
 *
 * Two passes, because a poll tap carries no text:
 *   1. VOTED → apply the answer immediately, so reminders stop at once
 *   2. a reason that arrives afterwards → attach it to the same workflow
 */
import type { LabProviderActionType } from "@prisma/client";
import prisma from "@/lib/db/client";
import { applyProviderAction, attachProviderReason, WorkflowClosedError } from "./provider-action";
import { resolveLabTarget } from "./target";
import { renderLabTemplate } from "./templates";
import { parsePollOptions } from "./poll-definitions";
import { formatDate, formatTime } from "./scheduler";

/**
 * Today's wording for an option, used only when a sent poll carried none.
 *
 * Matched on label first — that is what the provider actually tapped — and on
 * action as a fallback, so a definition whose labels have since been reworded
 * can still answer an older poll.
 */
async function currentAckFor(label: string, action: LabProviderActionType | null): Promise<string | null> {
  const definitions = await prisma.waPollDefinition.findMany({ where: { isActive: true } });
  for (const definition of definitions) {
    const options = parsePollOptions(definition.options);
    const byLabel = options.find((option) => option.label === label && option.ack.trim());
    if (byLabel) return byLabel.ack;
  }
  if (!action) return null;
  for (const definition of definitions) {
    const options = parsePollOptions(definition.options);
    const byAction = options.find((option) => option.action === action && option.ack.trim());
    if (byAction) return byAction.ack;
  }
  return null;
}

/**
 * Answer the provider in their own group.
 *
 * Queued through wa_outbound rather than sent straight from the gateway, so it
 * inherits everything the ladder's own messages get: the per-group sendEnabled
 * guard, the signature, retries, and a row in lab_communications. The gateway
 * used to reply to REJECT/RESCHEDULE with a raw sendMessage, which had none of
 * those and left no trace that the provider had ever been asked.
 *
 * Best-effort on purpose: the vote is already applied by the time this runs,
 * and failing to send a courtesy reply must not roll that back or make the tick
 * retry a workflow transition.
 */
async function acknowledge(poll: {
  workflowId: string | null;
  votedAction: LabProviderActionType | null;
  votedLabel: string | null;
  options: unknown;
}) {
  if (!poll.workflowId) return;

  // The reply belongs to the OPTION the provider tapped, read from the copy
  // stored on this poll — not from a template chosen by action. That is what
  // lets two polls share an action and still say different things, and what
  // lets an informational option (action null) reply at all.
  const options = parsePollOptions(poll.options);
  const chosen = poll.votedLabel
    ? options.find((option) => option.label === poll.votedLabel)
    : options.find((option) => option.action === poll.votedAction);
  if (!chosen) return;

  // A poll sent before replies were configurable stored {label, action} only,
  // and those polls are still sitting in provider groups — indistinguishable
  // from new ones. Tapping one applied the vote and answered with silence,
  // which reads as the feature being broken. So when the snapshot carries no
  // reply, fall back to whatever the live definition says for that same option.
  //
  // This does not violate the snapshot rule: the ACTION still comes from the
  // stored copy, so the poll means exactly what it meant when it was sent. Only
  // the wording — which was never captured — is filled in from today's text.
  let ack = chosen.ack?.trim() ?? "";
  if (!ack) {
    ack = (await currentAckFor(chosen.label, chosen.action)) ?? "";
    if (!ack) return; // genuinely nothing to say
  }

  const workflow = await prisma.labCommunicationWorkflow.findUnique({
    where: { id: poll.workflowId },
    select: { orderId: true, labId: true, appointmentTime: true, orderSnapshot: true },
  });
  if (!workflow) return;

  const config = await prisma.nonApiLabConfig.findUnique({ where: { labId: workflow.labId } });
  if (!config || !config.isActive) return;

  const snapshot = (workflow.orderSnapshot ?? {}) as { patientName?: string; location?: string; tests?: string };
  const text = renderLabTemplate(ack, {
    order_id: String(workflow.orderId),
    lab_name: config.labName,
    patient_name: snapshot.patientName || "Patient",
    appointment_date: workflow.appointmentTime ? formatDate(workflow.appointmentTime) : "Scheduled appointment",
    appointment_time: workflow.appointmentTime ? formatTime(workflow.appointmentTime) : "scheduled time",
    location: snapshot.location || "Location shared in LabStack",
    tests: snapshot.tests || "Order details available in LabStack",
  });

  const target = await resolveLabTarget(config);
  await prisma.waOutbound.create({
    data: { targetJid: target.targetJid, text, groupId: target.groupId },
  });
}

export type PollVoteResult = {
  applied: number;
  reasonsAttached: number;
  skipped: number;
  failed: number;
};

const BATCH = 50;

export async function processPollVotes(): Promise<PollVoteResult> {
  const result: PollVoteResult = { applied: 0, reasonsAttached: 0, skipped: 0, failed: 0 };

  // ── 1. Votes waiting to be applied ──────────────────────────────────────
  // No votedAction filter: an informational option (an SLA breach answer, say)
  // has none, and it still deserves its reply. Such a vote moves no workflow.
  const votes = await prisma.waPoll.findMany({
    where: { status: "VOTED", workflowId: { not: null } },
    orderBy: { votedAt: "asc" },
    take: BATCH,
  });

  for (const poll of votes) {
    try {
      if (poll.votedAction) {
        await applyProviderAction({
          workflowId: poll.workflowId!,
          action: poll.votedAction,
          // Usually null at this point; present only if the provider typed their
          // reason before the tick ran.
          reason: poll.reason,
          source: "POLL",
          actorRef: poll.voterJid,
        });
      }
      await prisma.waPoll.update({
        where: { waMsgId: poll.waMsgId },
        data: {
          status: "APPLIED",
          reasonAppliedAt: poll.reason ? new Date() : null,
        },
      });

      // Tell the provider what their tap did. Outside the try that guards the
      // state change: the vote is already applied and durable, so a failure to
      // send the courtesy reply must not be retried as if the vote had failed.
      await acknowledge(poll).catch((error) =>
        console.error(`[PollVotes] acknowledgement for ${poll.waMsgId} failed:`, error instanceof Error ? error.message : error));

      result.applied += 1;
    } catch (error) {
      if (error instanceof WorkflowClosedError) {
        // The order was cancelled upstream, or somebody already answered by
        // link. The vote is not a failure — there is just nothing to change.
        await prisma.waPoll.update({
          where: { waMsgId: poll.waMsgId },
          data: { status: "APPLIED", awaitingReason: false },
        });
        result.skipped += 1;
        continue;
      }
      console.error(`[PollVotes] ${poll.waMsgId} failed:`, error instanceof Error ? error.message : error);
      result.failed += 1;
    }
  }

  // ── 2. Reasons that arrived after the vote was applied ──────────────────
  const lateReasons = await prisma.waPoll.findMany({
    where: {
      status: "APPLIED",
      reason: { not: null },
      reasonAppliedAt: null,
      workflowId: { not: null },
    },
    orderBy: { reasonAt: "asc" },
    take: BATCH,
  });

  for (const poll of lateReasons) {
    try {
      // An informational answer still records the provider's words against the
      // order, it just has no state change to hang them on.
      await attachProviderReason({
        workflowId: poll.workflowId!,
        action: poll.votedAction,
        reason: poll.reason!,
        actorRef: poll.voterJid,
      });
      await prisma.waPoll.update({
        where: { waMsgId: poll.waMsgId },
        data: { reasonAppliedAt: new Date() },
      });
      result.reasonsAttached += 1;
    } catch (error) {
      console.error(`[PollVotes] reason for ${poll.waMsgId} failed:`, error instanceof Error ? error.message : error);
      result.failed += 1;
    }
  }

  return result;
}
