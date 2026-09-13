/**
 * "Is this message still worth sending?" — asked of LabStack, not of ourselves.
 *
 * Before this existed, suppression consulted only OpsFlow's own workflow
 * status. That is blind to everything that happens on the LabStack side after
 * the workflow started. The worst case is cancellation: `fetchAllActiveOrders`
 * filters out CANCELED, so a cancelled order simply stops appearing in the
 * poll while its PENDING reminders survive untouched and fire on schedule.
 * Nothing in OpsFlow ever learned the patient cancelled.
 *
 * Pure on purpose: the caller does the I/O and the writes.
 */

/** LabStack statuses that mean the order will never be fulfilled. */
const ABANDONED_STATUSES = new Set(["CANCELED"]);

/** LabStack statuses that mean the order is already finished. */
const FINISHED_STATUSES = new Set(["REPORT_DELIVERED", "PATIENT_MISSED"]);

export type SourceOrderState = {
  orderStatus: string;
  appointmentTime: Date | null;
};

export type SourceVerdict =
  /** Source agrees the order is live and unchanged — go ahead. */
  | { kind: "SEND" }
  /** Order is dead or done. Suppress this action and close the workflow. */
  | { kind: "CLOSE"; workflowStatus: "CANCELLED" | "COMPLETED"; reason: string }
  /** Appointment moved. Re-derive the appointment rungs; send nothing now. */
  | { kind: "RESCHEDULE"; appointmentTime: Date | null; reason: string };

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

/**
 * @param snapshot  current LabStack state, or `undefined` when the id returned
 *                  no row at all (hard-deleted upstream).
 * @param knownAppointmentTime  what the workflow currently believes.
 *
 * A failed/timed-out read must NOT reach this function. "Unknown" is not a
 * verdict — the caller retries instead, because treating an unreachable
 * replica as a cancellation would suppress real reminders.
 */
export function classifySourceOrder(
  snapshot: SourceOrderState | undefined,
  knownAppointmentTime: Date | null,
): SourceVerdict {
  if (!snapshot) {
    return {
      kind: "CLOSE",
      workflowStatus: "CANCELLED",
      reason: "Order no longer exists in LabStack",
    };
  }

  if (ABANDONED_STATUSES.has(snapshot.orderStatus)) {
    return {
      kind: "CLOSE",
      workflowStatus: "CANCELLED",
      reason: `Order was cancelled in LabStack (${snapshot.orderStatus})`,
    };
  }

  if (FINISHED_STATUSES.has(snapshot.orderStatus)) {
    return {
      kind: "CLOSE",
      workflowStatus: "COMPLETED",
      reason: `Order is already closed in LabStack (${snapshot.orderStatus})`,
    };
  }

  if (!sameInstant(snapshot.appointmentTime, knownAppointmentTime)) {
    return {
      kind: "RESCHEDULE",
      appointmentTime: snapshot.appointmentTime,
      reason: "Appointment time changed in LabStack",
    };
  }

  return { kind: "SEND" };
}
