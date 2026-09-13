/**
 * Cross-process mutex backed by taskos.polling_locks.
 *
 * Extracted from poller.ts so more than one scheduled loop can use it. The
 * history is worth keeping in view before "simplifying" this:
 *
 * - v1: a row with a 60s TTL. Cycles longer than 60s let a second cycle start
 *   in parallel; the TTL was a hint, not a mutex.
 * - v2 (attempted): pg_try_advisory_lock, session-scoped — but Prisma's
 *   connection pool means lock and unlock can land on different physical
 *   connections, leaving the lock held forever from the previous session's
 *   point of view. Pure-DB session locks need a single pinned connection.
 * - v3 (this): row-based TTL lock with an INSTANCE_ID ownership token. Only
 *   the instance that took the lock can release it, and the TTL is the safety
 *   net if a process dies mid-cycle.
 *
 * The atomicity lives in the `WHERE "lockedUntil" < now` clause of the
 * ON CONFLICT branch: the returned row count is the "did I get it" signal.
 *
 * `lockKey` is @unique but not the primary key, so new keys are free — no
 * migration needed to add a loop.
 */
import prisma from "@/lib/db/client";

/** Key 1000: the main 5-minute LabStack poll cycle. */
export const POLLING_LOCK_KEY = 1000;
/** Key 1001: the 1-minute non-API lab communication tick. */
export const NON_API_LAB_LOCK_KEY = 1001;

// Process-unique instance ID. Only needs uniqueness across concurrent
// processes, not cryptographic strength — which also avoids the `crypto`
// import dance with this project's webpack config.
function makeInstanceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const INSTANCE_ID = makeInstanceId();

export async function acquireLock(lockKey: number, ttlMs: number, label = "Lock"): Promise<boolean> {
  try {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + ttlMs);

    const result = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
      INSERT INTO taskos."polling_locks" ("lockKey", "lockedAt", "lockedUntil", "lockedBy")
      VALUES (${lockKey}, ${now}, ${lockUntil}, ${INSTANCE_ID})
      ON CONFLICT ("lockKey")
      DO UPDATE SET
        "lockedAt" = ${now},
        "lockedUntil" = ${lockUntil},
        "lockedBy" = ${INSTANCE_ID}
      WHERE "polling_locks"."lockedUntil" < ${now}
      RETURNING TRUE as "acquired";
    `;
    return result.length > 0;
  } catch (err) {
    console.error(`[${label}] Lock acquisition error:`, err);
    return false;
  }
}

export async function releaseLock(lockKey: number, label = "Lock"): Promise<void> {
  try {
    // Ownership-checked: never delete a row belonging to a different
    // (still-running) instance.
    await prisma.$executeRaw`
      DELETE FROM taskos."polling_locks"
      WHERE "lockKey" = ${lockKey}
        AND "lockedBy" = ${INSTANCE_ID}
    `;
  } catch (err) {
    console.error(`[${label}] Lock release error:`, err);
  }
}
