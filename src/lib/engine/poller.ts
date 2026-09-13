/**
 * OpsFlow Polling Engine
 * ──────────────────────
 * Runs on a cron schedule (default every 5 minutes).
 * 1. Fetches all active orders from labstack public schema
 * 2. Loads active TaskRules from taskos schema
 * 3. Evaluates trigger conditions → creates Tasks
 * 4. Runs SLA watcher (breach detection + warnings)
 * 5. Writes a PollingLog entry with run stats
 *
 * Start it once via startPoller() from the app server entry point.
 */
// node-cron imported dynamically below — webpackIgnore prevents webpack
// from bundling its ESM files which use node:crypto/path/url.
import prisma from "@/lib/db/client";
import { probeLabstackHealthy } from "@/lib/db/labstack";
import { fetchAllActiveOrders, fetchActiveOrdersByStatus } from "./labstack";
import { evaluateAndCreateTasks, loadActiveRules, RuleCycleStats } from "./taskCreator";
import { runSourceHealthWatcher } from "./sourceHealthWatcher";
import { runSlaWatcher } from "./slaWatcher";
import { sendDailySummary } from "./dailySummary";
import { runTaskRetirer, RetirementStats } from "./taskRetirer";
import { startDetectedNonApiLabWorkflows } from "@/lib/non-api-labs/workflow";
import { acquireLock, releaseLock, POLLING_LOCK_KEY } from "./pollingLock";

const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS ?? "300000", 10);
const CRON_EXPRESSION = intervalToCron(POLLING_INTERVAL_MS);

// W2.4 — Polling lock with ownership token + tunable TTL. The implementation
// (and the history of why it is a row lock rather than a pg advisory lock)
// now lives in ./pollingLock so the non-API lab tick can share it under its
// own key.
const POLLING_LOCK_TTL_MS = parseInt(process.env.POLLING_LOCK_TTL_MS ?? "600000", 10); // 10 min default

const acquirePollingLock = () => acquireLock(POLLING_LOCK_KEY, POLLING_LOCK_TTL_MS, "Poller");
const releasePollingLock = () => releaseLock(POLLING_LOCK_KEY, "Poller");

// ── W2.2: Polling checkpoint ────────────────────────────────────────────────
// Stores the last `updatedAt` we successfully consumed from a source so the
// next cycle can ask labstack for "orders changed since X" instead of refetching
// the entire active-order universe. One row per logical source.
const SOURCE_KEY_LABSTACK_ORDER = "labstack:Order";
// 5-minute back-overlap absorbs labstack's clock skew + the lag between
// labstack's COMMIT and our SELECT. Cheaper to re-fetch a few rows than to
// miss a status change.
const CHECKPOINT_BACKLAP_MS = 5 * 60_000;

async function readCheckpoint(sourceKey: string): Promise<Date | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ lastSeenAt: Date }>>`
      SELECT "lastSeenAt" FROM taskos.engine_checkpoints
      WHERE "sourceKey" = ${sourceKey}
    `;
    return rows[0]?.lastSeenAt ?? null;
  } catch (err) {
    console.error("[Poller] readCheckpoint error:", err);
    return null;
  }
}

async function writeCheckpoint(sourceKey: string, seenAt: Date): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO taskos.engine_checkpoints ("sourceKey", "lastSeenAt", "updatedAt")
      VALUES (${sourceKey}, ${seenAt}, NOW())
      ON CONFLICT ("sourceKey")
      DO UPDATE SET "lastSeenAt" = ${seenAt}, "updatedAt" = NOW()
    `;
  } catch (err) {
    console.error("[Poller] writeCheckpoint error:", err);
  }
}

// ── Core poll cycle ───────────────────────────────────────────────────────────

export async function runPollCycle(): Promise<void> {
  // C1.2: Use database lock instead of in-memory flag
  const lockAcquired = await acquirePollingLock();
  if (!lockAcquired) {
    console.log("[Poller] Another process holds the lock, skipping.");
    return;
  }

  const startedAt = new Date();
  let status: "SUCCESS" | "ERROR" = "SUCCESS";
  let errorMessage: string | null = null;
  let ordersFound = 0;
  let tasksCreated = 0;
  let perRule: RuleCycleStats[] = [];
  let tasksRetired = 0;
  let retirementPerRule: RetirementStats[] = [];
  let skippedPreflight = false;

  try {
    console.log(`[Poller] Cycle started at ${startedAt.toISOString()}`);

    // 0. Pre-flight replica-health probe (Track B guard for the MultiXact
    //    SLRU incident). A contended replica answers point lookups but hangs
    //    FOREVER on the bulk Order scans below — and the hang is an
    //    uninterruptible LWLock wait, so statement_timeout / pg_cancel can't
    //    rescue it. Once issued, such a scan becomes a zombie that holds this
    //    cycle's lock until the replica is restarted. So we probe with a tiny
    //    bounded read first and SKIP the entire cycle (no incremental fetch,
    //    no second-pass, no retirer, no SLA/health watchers — all of which
    //    touch labstack) if the replica looks sick. The probe feeds the
    //    circuit breaker, so repeated skips short-circuit cheaply.
    const replicaHealthy = await probeLabstackHealthy();
    if (!replicaHealthy) {
      skippedPreflight = true;
      status = "ERROR";
      errorMessage =
        "Skipped: labstack pre-flight probe failed — replica contended or unreachable. " +
        "Not issuing bulk scans (they would wedge on an uninterruptible LWLock).";
      console.warn(`[Poller] ${errorMessage}`);
      // finally{} writes the PollingLog (with skippedPreflight) and releases
      // the lock. Returning here guarantees zero bulk labstack traffic.
      return;
    }

    // 1. Fetch orders from labstack — with a checkpoint cursor (W2.2).
    // We grab the last successful cycle's seen-time and ask only for orders
    // touched since. First cycle (no checkpoint row) falls back to the
    // unbounded fetch. Heuristic 5-minute back-overlap absorbs clock skew
    // between OpsFlow and labstack — small re-fetch < missed orders.
    const checkpoint = await readCheckpoint(SOURCE_KEY_LABSTACK_ORDER);
    const since = checkpoint
      ? new Date(checkpoint.getTime() - CHECKPOINT_BACKLAP_MS)
      : null;
    const orders = await fetchAllActiveOrders(since);
    ordersFound = orders.length;
    console.log(`[Poller] ${ordersFound} active orders fetched from labstack${since ? ` since ${since.toISOString()}` : " (full scan)"}`);

    // 1b. Non-API lab communication workflows. This observes the same source
    // orders as task creation but owns all state in taskos; the helper's
    // unique(orderId) boundary makes replays from the checkpoint overlap safe.
    // A failure here is isolated so API-integrated orders and the established
    // task engine preserve their existing behavior.
    try {
      const nonApi = await startDetectedNonApiLabWorkflows(orders);
      if (nonApi.started || nonApi.failed) {
        console.log(`[Poller] Non-API workflows: started=${nonApi.started}, existing=${nonApi.existing}, skipped=${nonApi.skipped}, failed=${nonApi.failed}`);
      }
    } catch (nonApiError) {
      console.error("[Poller] Non-API workflow trigger failed (non-fatal):", nonApiError);
    }

    // 1c. (Moved) Due reminder/escalation jobs used to run here. They now have
    // their own 1-minute cron in lib/non-api-labs/runner.ts under lock key
    // 1001. Running them here made the communication clock a hostage of the
    // pre-flight probe below: a replica too contended for bulk scans silenced
    // every reminder and escalation, even though the runner only needs
    // primary-key lookups, which stay fast on a contended replica. The
    // workflow starter above stays put — it genuinely consumes the bulk fetch.

    // 2. Load active rules
    const rules = await loadActiveRules();
    console.log(`[Poller] ${rules.length} active task rules loaded`);

    // 3. Evaluate rules → create tasks
    if (orders.length > 0 && rules.length > 0) {
      const result = await evaluateAndCreateTasks(orders, rules);
      tasksCreated = result.created;
      perRule = result.perRule;
      console.log(`[Poller] Tasks created: ${result.created}, skipped: ${result.skipped}`);
    }

    // 3b. Second-pass full scan for TIME-triggered rules with staleness
    //     conditions (minutesSinceStatusUpdated / minutesSinceCreated).
    //
    // The incremental fetch above only sees orders touched since the
    // checkpoint. Stale-status rules (e.g. R5: "sample collected ≥45 min
    // ago") fire on orders that, by definition, haven't been touched —
    // their statusUpdatedAt is older than the checkpoint cursor and they
    // never re-enter the incremental window. Without this pass, those
    // rules only fire the one time an order's status transitions (when
    // the touch puts it in-window), and never again if that first cycle
    // missed it for any reason.
    //
    // Strategy: collect statuses from rules with staleness conditions,
    // fetch all active orders in those statuses (no checkpoint), then
    // re-run evaluateAndCreateTasks. Dedup in taskCreator skips orders
    // that already have an open task for the rule, so this is cheap on
    // steady state and only does real work when there's drift.
    if (rules.length > 0) {
      const stalenessStatuses = new Set<string>();
      for (const r of rules) {
        if (r.triggerType !== "TIME") continue;
        const c = (r.triggerCondition ?? {}) as Record<string, unknown>;
        const hasStaleness =
          typeof c.minutesSinceStatusUpdated === "number" ||
          typeof c.minutesSinceCreated === "number";
        if (!hasStaleness) continue;
        if (Array.isArray(c.statusIn)) {
          for (const s of c.statusIn) {
            if (typeof s === "string") stalenessStatuses.add(s);
          }
        }
      }

      if (stalenessStatuses.size > 0) {
        const statusList = Array.from(stalenessStatuses);
        const incrementalIds = new Set(orders.map((o) => o.id));
        const fullScanOrders = await fetchActiveOrdersByStatus(statusList);
        // Skip orders already processed in the incremental pass — they
        // went through evaluateAndCreateTasks once already this cycle.
        const newOrders = fullScanOrders.filter((o) => !incrementalIds.has(o.id));
        console.log(
          `[Poller] Second-pass: ${fullScanOrders.length} orders in stale-trigger statuses [${statusList.join(",")}], ` +
          `${newOrders.length} not seen in incremental pass`
        );

        if (newOrders.length > 0) {
          const result2 = await evaluateAndCreateTasks(newOrders, rules);
          tasksCreated += result2.created;
          // Merge perRule counters: same rule ids on both runs, so add.
          const byId = new Map(perRule.map((s) => [s.ruleId, s]));
          for (const s2 of result2.perRule) {
            const existing = byId.get(s2.ruleId);
            if (existing) {
              existing.fired += s2.fired;
              existing.skippedDedup += s2.skippedDedup;
              existing.skippedTrigger += s2.skippedTrigger;
              existing.skippedTypeFilter += s2.skippedTypeFilter;
              existing.failedAssignment += s2.failedAssignment;
              existing.failedCreate += s2.failedCreate;
            } else {
              byId.set(s2.ruleId, s2);
            }
          }
          perRule = Array.from(byId.values());
          console.log(`[Poller] Second-pass tasks created: ${result2.created}, skipped: ${result2.skipped}`);
        }
      }
    }

    // W3 — archive duplicate removed. `archiveOldTasks` runs nightly via
    // archiveScheduler.ts; the per-cycle copy was an O(N) duplicate.

    // 3c. Task auto-retirement — close tasks whose source order has
    // advanced past the rule's statusIn. Without this, Stuck tab fills
    // with phantom tasks for completed work. Wrapped in try so a failure
    // here doesn't mark the whole cycle as ERROR (creation already
    // succeeded; retirement is housekeeping).
    try {
      const retire = await runTaskRetirer();
      tasksRetired = retire.totalRetired;
      retirementPerRule = retire.perRule;
      if (tasksRetired > 0) {
        console.log(
          `[Poller] Retired ${tasksRetired} stale tasks: ` +
          retire.perRule.map((r) => `${r.ruleName}=${r.retired}`).join(", ")
        );
      }
    } catch (retireErr) {
      console.error("[Poller] Task retirer failed (non-fatal):", retireErr);
    }

    // 4. SLA watcher
    await runSlaWatcher();
    console.log("[Poller] SLA watcher completed");

    // 5. Source-health watcher — emits/resolves SOURCE_HEALTH alerts based on
    // recent polling activity. Wrapped in try so a failure here doesn't mark
    // the whole cycle as ERROR (the polling work has already succeeded).
    try {
      await runSourceHealthWatcher();
    } catch (healthErr) {
      console.error("[Poller] Source-health watcher failed (non-fatal):", healthErr);
    }

    // 6. Persist the checkpoint so the NEXT cycle can fetch incrementally.
    // We anchor on `startedAt` (not "now") so anything labstack updates while
    // this cycle was running still gets seen by the next one — the back-lap
    // window in readCheckpoint then provides additional cushion.
    await writeCheckpoint(SOURCE_KEY_LABSTACK_ORDER, startedAt);
  } catch (err) {
    status = "ERROR";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[Poller] Cycle error:", errorMessage);
  } finally {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    try {
      await prisma.pollingLog.create({
        data: {
          startedAt,
          finishedAt,
          durationMs,
          ordersFound,
          tasksCreated,
          status,
          errorMessage,
          // W4 — per-rule fire breakdown so operators can answer "did rule
          // X fire?" from the dashboard rather than grep. Empty array on
          // ERROR cycles is fine; the row's `status` makes the failure
          // explicit independently. tasksRetired surfaces auto-close
          // activity from the task retirer (step 3c) — visible on the
          // dashboard's "last cycle" widget.
          metadata:
            perRule.length > 0 || tasksRetired > 0 || skippedPreflight
              ? { perRule, tasksRetired, retirementPerRule, skippedPreflight }
              : undefined,
        },
      });
    } catch (logErr) {
      console.error("[Poller] Failed to write PollingLog:", logErr);
    }

    // Mirror to the per-source DataSourcePollingLog so the Data Sources
    // UI (which reads this table, not the legacy PollingLog) shows poll
    // history + "last poll" timestamp.
    //
    // The legacy poller is hard-coded to labstack orders, so look up
    // the DataSource by its sourceId="orders" registration. If the row
    // doesn't exist (source was never registered), silently skip — the
    // legacy PollingLog above still captures the cycle for other surfaces.
    try {
      const ordersSource = await prisma.dataSource.findUnique({
        where: { sourceId: "orders" },
        select: { id: true },
      });
      if (ordersSource) {
        await prisma.dataSourcePollingLog.create({
          data: {
            dataSourceId: ordersSource.id,
            pollStartedAt: startedAt,
            pollCompletedAt: finishedAt,
            durationMs,
            entitiesFound: ordersFound,
            entitiesProcessed: ordersFound,
            tasksCreated,
            tasksFailed: 0,
            status,
            errorMessage,
          },
        });
      }
    } catch (mirrorErr) {
      // Non-fatal: legacy PollingLog above is the source-of-truth for
      // engine-side code. The mirror is just for UI consistency.
      console.error("[Poller] Failed to mirror DataSourcePollingLog:", mirrorErr);
    }

    // Always release lock
    await releasePollingLock();
    console.log(`[Poller] Cycle finished in ${durationMs}ms — status: ${status}`);
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scheduledTask: any | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dailySummaryTask: any | null = null;

export async function startPoller(): Promise<void> {
  if (scheduledTask) {
    console.log("[Poller] Already started.");
    return;
  }

  console.log(`[Poller] Starting with cron expression: "${CRON_EXPRESSION}" (~${POLLING_INTERVAL_MS / 60000} min)`);

  const cron = (await import(/* webpackIgnore: true */ "node-cron")).default;

  // NOTE: Immediate startup run intentionally removed — it fired on every
  // hot-reload in dev, hammering the DB. The cron schedule handles the first
  // run at the next interval tick.

  scheduledTask = cron.schedule(CRON_EXPRESSION, () => {
    runPollCycle().catch((e) => console.error("[Poller] Scheduled run error:", e));
  });

  // Daily summary at 20:30 IST = 15:00 UTC (cron: "0 15 * * *")
  const summaryCron = process.env.DAILY_SUMMARY_CRON ?? "0 15 * * *";
  dailySummaryTask = cron.schedule(summaryCron, () => {
    sendDailySummary().catch((e) => console.error("[DailySummary] Error:", e));
  });
  console.log(`[Poller] Daily summary cron scheduled: "${summaryCron}"`);
}

export function stopPoller(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (dailySummaryTask) {
    dailySummaryTask.stop();
    dailySummaryTask = null;
  }
  console.log("[Poller] Stopped.");
}

// ── Utility: convert interval ms → cron expression ────────────────────────────

function intervalToCron(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));

  if (minutes < 60) {
    // e.g. "*/5 * * * *"
    return `*/${minutes} * * * *`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `0 */${hours} * * *`;
  }

  return "0 */6 * * *"; // fallback: every 6h
}
