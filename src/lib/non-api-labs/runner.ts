/**
 * Non-API lab communication tick.
 *
 * Runs every minute, independently of the 5-minute LabStack poll cycle.
 *
 * It used to be a step inside `runPollCycle`, which made the communication
 * clock a hostage of that cycle's pre-flight replica probe: the probe exists to
 * stop bulk `Order` scans wedging on an uninterruptible LWLock, and it aborts
 * the whole cycle when the replica is contended. That meant a sick replica
 * silenced every reminder and escalation — even though this runner only ever
 * issues primary-key lookups, which the probe's own notes record as staying
 * fast on exactly that kind of contended replica.
 *
 * The minute cadence also matters now that appointment-anchored rungs exist:
 * a T-10m reminder scheduled on a 5-minute grid can land up to five minutes
 * late, which is most of its usefulness gone.
 *
 * Three jobs share the tick: poll votes, the confirmation ladder, and — once
 * a day per lab — the provider digest. One loop and one lock rather than three
 * schedulers racing each other for the same provider's attention.
 *
 * Lock key 1001 is separate from the poller's 1000, so the two loops never
 * block each other.
 */
import { acquireLock, releaseLock, NON_API_LAB_LOCK_KEY } from "@/lib/engine/pollingLock";
import { processDueNonApiLabScheduledActions } from "./scheduler";
import { processPollVotes } from "./poll-votes";
import { runSlaBreachTick } from "@/lib/provider-comms/breach-engine";
import { runDailyDigestTick } from "@/lib/provider-comms/daily-digest";

const TICK_CRON = process.env.NON_API_LAB_TICK_CRON ?? "* * * * *";
// Short TTL: a tick is seconds of work, and a dead process should not hold the
// lock for long. Still comfortably longer than a slow batch.
const TICK_LOCK_TTL_MS = parseInt(process.env.NON_API_LAB_LOCK_TTL_MS ?? "120000", 10);

export async function runNonApiLabTick(): Promise<void> {
  const acquired = await acquireLock(NON_API_LAB_LOCK_KEY, TICK_LOCK_TTL_MS, "NonApiLabTick");
  if (!acquired) return;

  try {
    // Answers first. A provider who has already replied by poll should not be
    // chased by a reminder this same tick, and applying the vote closes the
    // workflow that the scheduler is about to look at.
    try {
      const votes = await processPollVotes();
      if (votes.applied || votes.reasonsAttached || votes.skipped || votes.failed) {
        console.log(
          `[PollVotes] applied=${votes.applied} reasons=${votes.reasonsAttached} ` +
          `skipped=${votes.skipped} failed=${votes.failed}`,
        );
      }
    } catch (error) {
      console.error("[PollVotes] Cycle error:", error);
    }

    const stats = await processDueNonApiLabScheduledActions();
    const touched =
      stats.processed || stats.suppressed || stats.deferred || stats.rescheduled ||
      stats.closed || stats.retried || stats.failed;
    if (touched) {
      console.log(
        `[NonApiLabTick] sent=${stats.processed} suppressed=${stats.suppressed} deferred=${stats.deferred} ` +
        `rescheduled=${stats.rescheduled} closed=${stats.closed} retried=${stats.retried} failed=${stats.failed}`,
      );
    }

    // SLA milestone breaches share this tick and its lock rather than adding a
    // second scheduler. Its own try/catch: a breach failure must not stop the
    // sequence steps above from being reported, and vice versa.
    try {
      const breach = await runSlaBreachTick();
      const breachTouched =
        breach.detected || breach.sent || breach.dryRun || breach.resolved ||
        breach.cancelled || breach.capped || breach.deferred || breach.failed;
      if (breachTouched) {
        console.log(
          `[SlaBreachTick] detected=${breach.detected} sent=${breach.sent} dryRun=${breach.dryRun} ` +
          `resolved=${breach.resolved} cancelled=${breach.cancelled} capped=${breach.capped} ` +
          `deferred=${breach.deferred} skipped=${breach.skipped} failed=${breach.failed}`,
        );
      }
    } catch (error) {
      console.error("[SlaBreachTick] Cycle error:", error);
    }
    // The daily digest shares this tick for the same reason the breach engine
    // does — one lock, one loop — but for a second reason of its own: a cron
    // pinned to 19:00 loses the whole digest if the process happens to be
    // restarting that minute, silently and until tomorrow. Asking "is the slot
    // open and unsent?" every minute simply catches up instead.
    try {
      const digest = await runDailyDigestTick();
      if (digest.queued || digest.failed) {
        console.log(
          `[ProviderDigest] queued=${digest.queued} empty=${digest.empty} ` +
          `skipped=${digest.skipped} failed=${digest.failed}`,
        );
      }
    } catch (error) {
      console.error("[ProviderDigest] Cycle error:", error);
    }
  } catch (error) {
    console.error("[NonApiLabTick] Cycle error:", error);
  } finally {
    await releaseLock(NON_API_LAB_LOCK_KEY, "NonApiLabTick");
  }
}

let scheduledTask: { stop: () => void } | null = null;

export async function startNonApiLabRunner(): Promise<void> {
  if (scheduledTask) {
    console.log("[NonApiLabTick] Already started.");
    return;
  }

  // Dynamic import with webpackIgnore: node-cron v4 reaches for node:crypto /
  // path / url, which this project's webpack config will not bundle.
  const cron = (await import(/* webpackIgnore: true */ "node-cron")).default;
  scheduledTask = cron.schedule(TICK_CRON, () => {
    runNonApiLabTick().catch((error) => console.error("[NonApiLabTick] Scheduled run error:", error));
  });
  console.log(`[NonApiLabTick] Started with cron expression: "${TICK_CRON}"`);
}

export function stopNonApiLabRunner(): void {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
  console.log("[NonApiLabTick] Stopped.");
}
