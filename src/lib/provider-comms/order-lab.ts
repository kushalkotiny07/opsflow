/**
 * Which lab does an order belong to?
 *
 * Tasks carry `entityId` (the LabStack order id) and a `metadata.labName`, but
 * not a labId — and a name is not an identifier: provider configs are keyed by
 * `labId`, and two labs in the source share a display name often enough that
 * matching on it would address the wrong provider.
 *
 * So the id is read from the source. This is a single batched query per SLA
 * watcher run rather than one per breached task, and it is wrapped in
 * `labstackOr` so a source outage degrades to "no breach alerts this run"
 * instead of stalling the watcher that still has to mark the tasks.
 */
import { labstackOr, labstackWorkerQuery } from "@/lib/db/labstack";

/** orderId → labId, omitting orders the source does not have or that have no lab. */
export async function resolveLabIdsForOrders(orderIds: number[]): Promise<Map<number, number>> {
  const unique = [...new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (unique.length === 0) return new Map();

  const rows = await labstackOr<Array<{ id: number; labId: number | null }>>(
    labstackWorkerQuery<{ id: number; labId: number | null }>(
      `SELECT id, "labId" FROM public."Order" WHERE id = ANY($1::int[])`,
      [unique],
    ),
    [],
    undefined,
    { breakerKey: "worker" },
  );

  const byOrder = new Map<number, number>();
  for (const row of rows) {
    if (typeof row.labId === "number") byOrder.set(Number(row.id), Number(row.labId));
  }
  return byOrder;
}
