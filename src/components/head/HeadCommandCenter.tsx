"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import SlaCountdown from "@/components/shared/SlaCountdown";
import PriorityBadge from "@/components/shared/PriorityBadge";
import StatusBadge from "@/components/shared/StatusBadge";
import CreateTaskModal from "@/components/head/CreateTaskModal";

/**
 * IST-anchored "today" key — used to drive drill-in links to All Tasks for
 * the "Done Today" / "Breached Today" tiles. Matches /api/dashboard's
 * IST anchoring so the filtered table shows the same set the tile counts.
 */
function todayISTKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

interface Stats {
  activeOrders: number;
  openTasks: number;
  breachedTasks: number;
  warningTasks: number;                   // total within 30 min Near-SLA horizon
  warningCriticalTasks: number;           // subset within 10 min — rendered as "X critical"
  slaHealthPercent: number;
  unassignedTasks: number;
  oldestUnassignedMin: number | null;     // age of oldest CREATED + null-assignee; leading indicator vs the snapshot count
  completedToday: number;
  completedPrior: number;                 // same window, one window earlier — for delta render
  breachedToday: number;
  breachedPrior: number;                  // same as above for breach trend
}

interface RiskItem {
  taskId: number;
  title: string;
  priority: string;
  status: string;
  entityId: number;
  orderType: string;
  storeId: number | null;
  slaDeadline: string;
  slaBreachedAt: string | null;
  assignedTo: { id: number; name: string } | null;
  metadata: Record<string, unknown>;
  minutesRemaining: number;
}

interface TeamMember {
  userId: number;
  name: string;
  role: string;
  rosterStatus: string;
  openTasks: number;
  maxTasks: number;
  storeIds: number[];
}

interface Alert {
  id: number;
  // The DB column / Prisma field is `alertType`. Tolerate `type` as a legacy
  // alias in case any older response shape is in flight after a deploy.
  alertType?: string;
  type?: string;
  message: string;
  createdAt: string;
  task: { id: number; title: string; entityId: number } | null;
}

function alertTypeOf(a: Alert): string {
  return a.alertType ?? a.type ?? "UNKNOWN";
}

interface SourceStat {
  sourceId: string;
  displayName: string;
  openTasks: number;
}

interface NonApiWorkflowStats {
  waitingForLabConfirmation: number;
  accepted: number;
  rescheduleRequested: number;
  rejected: number;
  escalated: number;
  pendingReminderActions: number;
  pendingEscalationActions: number;
}

interface DashboardData {
  stats: Stats;
  sourceStats: SourceStat[];
  riskItems: RiskItem[];
  team: TeamMember[];
  recentAlerts: Alert[];
  lastPollAt: string | null;
  nonApiWorkflowStats?: NonApiWorkflowStats;
}

/**
 * Plays a short two-tone beep via Web Audio. No asset to ship, runs only
 * after a user gesture-triggered audio enable (browsers gate audio
 * autoplay; the toggle button itself counts as the gesture). Fails
 * silently if AudioContext isn't available (older browsers / SSR path).
 */
function playBreachBeep() {
  try {
    const Ctx = (window.AudioContext ||
      // @ts-expect-error — webkit prefix on older Safari
      window.webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tones = [880, 660]; // descending two-tone, alarm-like
    const duration = 0.18;
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0, ctx.currentTime + i * duration);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + i * duration + 0.02);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + i * duration + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * duration);
      osc.stop(ctx.currentTime + i * duration + duration);
    });
    // Tear down the context after the beeps finish.
    setTimeout(() => ctx.close().catch(() => undefined), 1000);
  } catch {
    // No-op — audio is best-effort.
  }
}

const ALERT_TYPE_COLORS: Record<string, string> = {
  SLA_BREACH: "text-red-400",
  SLA_BREACHED: "text-red-400",
  SLA_WARNING: "text-amber-400",
  UNASSIGNED_TASK: "text-blue-400",
  ESCALATION: "text-purple-400",
};

/**
 * SourceHealthCard — replaces the prior "source chips" strip with a card
 * that surfaces per-source open-task counts AND the cycle-level health
 * signals the audit (feature 08) flagged: last poll, success rate over
 * the last hour, tasks created last hour. Calls /api/sources/health.
 */
interface SourceHealth {
  cycle: {
    lastPollAt: string | null;
    cyclesInLastHour: number;
    successCount: number;
    successRate: number | null;
    health: "green" | "amber" | "red";
  };
  sources: Array<{
    id: string;
    sourceId: string;
    displayName: string;
    openTasks: number;
    tasksLastHour: number;
  }>;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

function SourceHealthCard({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<SourceHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sources/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (!data) return null;

  const { cycle, sources } = data;
  const healthCls =
    cycle.health === "green" ? "bg-emerald-400" :
    cycle.health === "amber" ? "bg-amber-400" :
    "bg-red-400";
  const healthLabel =
    cycle.health === "green" ? "healthy" :
    cycle.health === "amber" ? "degraded" :
    "unhealthy";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
      {/* Cycle header — global health for the polling cycle. */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Sources</span>
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${healthCls}`} />
          <span className="text-xs text-zinc-300 font-medium capitalize">{healthLabel}</span>
        </span>
        <span className="text-xs text-zinc-500">Last poll {formatRelativeTime(cycle.lastPollAt)}</span>
        {cycle.successRate !== null && (
          <span className="text-xs text-zinc-500">
            {cycle.successCount}/{cycle.cyclesInLastHour} cycles ok
          </span>
        )}
      </div>

      {/* Per-source rows — open tasks + last-hour fire count. */}
      {sources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {sources.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-1.5"
            >
              <svg className="w-3 h-3 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
              </svg>
              <span className="text-xs text-zinc-300">{s.displayName}</span>
              <span className={`text-xs font-semibold ${s.openTasks > 0 ? "text-blue-400" : "text-zinc-600"}`}>
                {s.openTasks} open
              </span>
              <span className="text-[10px] text-zinc-500">·</span>
              <span className="text-[10px] text-zinc-500">
                {s.tasksLastHour > 0 ? `+${s.tasksLastHour} last hour` : "no new tasks"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricChip({ label, value, tone }: { label: string; value: number; tone: "blue" | "green" | "amber" | "red" | "purple" }) {
  const colorMap: Record<typeof tone, string> = {
    blue: "text-blue-400",
    green: "text-green-400",
    amber: "text-amber-400",
    red: "text-red-400",
    purple: "text-purple-400",
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${colorMap[tone]}`}>{value}</div>
    </div>
  );
}

/**
 * RosterGlanceTile — single-row breakdown of the team's current
 * rosterStatus values. Buckets match computeRosterStatus's output enum:
 * ACTIVE / ON_LEAVE / SICK / OFF. Renders compactly so it fits between
 * the KPI strip and the source chips without adding vertical weight.
 */
function RosterGlanceTile({ team }: { team: TeamMember[] }) {
  const counts = useMemo(() => {
    const acc = { ACTIVE: 0, ON_LEAVE: 0, SICK: 0, OFF: 0 } as Record<string, number>;
    for (const m of team) {
      const key = (m.rosterStatus in acc) ? m.rosterStatus : "OFF";
      acc[key]++;
    }
    return acc;
  }, [team]);

  const buckets: Array<{ label: string; key: string; cls: string; dot: string }> = [
    { label: "Active",   key: "ACTIVE",   cls: "text-emerald-400", dot: "bg-emerald-400" },
    { label: "On Leave", key: "ON_LEAVE", cls: "text-amber-400",   dot: "bg-amber-400" },
    { label: "Sick",     key: "SICK",     cls: "text-pink-400",    dot: "bg-pink-400" },
    { label: "Off",      key: "OFF",      cls: "text-zinc-500",    dot: "bg-zinc-600" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-4 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2.5">
      <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Roster</span>
      {buckets.map(b => (
        <div key={b.key} className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`} />
          <span className="text-xs text-zinc-400">{b.label}</span>
          <span className={`text-xs font-semibold ${b.cls}`}>{counts[b.key]}</span>
        </div>
      ))}
      <span className="ml-auto text-[10px] text-zinc-600">{team.length} total</span>
    </div>
  );
}

export default function HeadCommandCenter() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<number>>(new Set());
  const [showCreateModal, setShowCreateModal] = useState(false);
  // W4 — date range toggle. "today" matches the prior behaviour (the
  // server defaults to today when no `range` is passed), so users who
  // never touch the control see the same dashboard as before.
  const [range, setRange] = useState<"today" | "shift" | "week">("today");
  // W5 — audio alert on new BREACHED. Persisted in localStorage so the
  // preference survives reloads. Defaults to OFF — head explicitly opts
  // in via the bell button so we never beep without consent.
  const [audioEnabled, setAudioEnabled] = useState(false);
  // Set of alert IDs we've already seen. Initialised from the FIRST
  // fetch (so we don't beep for every alert that already existed when
  // the page loaded — only new arrivals trigger sound).
  const seenAlertIdsRef = useRef<Set<number> | null>(null);

  // Restore the audioEnabled preference. Run once on mount.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("opsflow.cc.audioEnabled");
      if (saved === "true") setAudioEnabled(true);
    } catch {
      // localStorage unavailable (SSR / private mode) — default OFF stays.
    }
  }, []);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard?range=${range}`);
      if (!res.ok) {
        console.error(`[Dashboard] HTTP ${res.status}:`, res.statusText);
        setLoading(false);
        return;
      }
      const json = await res.json();

      // W5 — detect new BREACHED alerts since the last fetch.
      // First fetch initialises the seen set (no beep for pre-existing
      // alerts). Subsequent fetches diff and beep on any newly-arrived
      // SLA_BREACHED entries.
      const incoming: Alert[] = json.recentAlerts ?? [];
      const incomingIds = new Set(incoming.map((a) => a.id));
      if (seenAlertIdsRef.current === null) {
        seenAlertIdsRef.current = incomingIds;
      } else {
        const seen = seenAlertIdsRef.current;
        const newBreaches = incoming.filter(
          (a) => !seen.has(a.id) && /BREACH/.test(alertTypeOf(a))
        );
        if (newBreaches.length > 0 && audioEnabled) {
          playBreachBeep();
          // Best-effort browser notification — silently no-ops if the
          // user never granted permission.
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              new Notification(
                newBreaches.length === 1
                  ? "SLA breached"
                  : `${newBreaches.length} new SLA breaches`,
                {
                  body: newBreaches[0].message,
                  tag: "opsflow-breach",
                }
              );
            } catch { /* ignore */ }
          }
        }
        seenAlertIdsRef.current = incomingIds;
      }

      setData(json);
    } catch (error) {
      console.error("[Dashboard] Error:", error);
    } finally {
      setLoading(false);
    }
  }, [range, audioEnabled]);

  // Toggle audio + persist + (on enable) request browser notification permission.
  const toggleAudio = useCallback(() => {
    setAudioEnabled((prev) => {
      const next = !prev;
      try { localStorage.setItem("opsflow.cc.audioEnabled", String(next)); } catch { /* ignore */ }
      // Test-fire the beep on enable so the user knows the volume + that
      // it's wired up. The user gesture also unlocks the AudioContext
      // for browsers that gate autoplay behind a click.
      if (next) {
        playBreachBeep();
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission().catch(() => undefined);
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [refreshKey, fetchDashboard]);

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => setRefreshKey((k) => k + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  async function dismissAlert(id: number) {
    setDismissedAlerts((prev) => new Set([...prev, id]));
    await fetch("/api/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => {});
  }

  async function assignTask(taskId: number, userId: number) {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedToId: userId }),
    });
    setRefreshKey((k) => k + 1);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Failed to load dashboard
      </div>
    );
  }

  const { stats, sourceStats = [], riskItems, team, recentAlerts, lastPollAt, nonApiWorkflowStats } = data;
  const visibleAlerts = recentAlerts.filter((a) => !dismissedAlerts.has(a.id));

  return (
    <div className="h-full overflow-y-auto bg-zinc-950">
      {/* Top bar */}
      <div className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-white">Command Center</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Last synced: {lastPollAt ? new Date(lastPollAt).toLocaleTimeString("en-IN") : "—"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs text-white font-medium transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Create Task
          </button>
          {/* W5 — Audio alert toggle. Beeps + (if permission granted)
              fires a desktop notification on new BREACHED alerts. */}
          <button
            onClick={toggleAudio}
            title={audioEnabled ? "Audio alerts on — click to silence" : "Audio alerts off — click to enable"}
            className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs transition-colors ${
              audioEnabled
                ? "bg-amber-500/10 border-amber-500/40 text-amber-300 hover:bg-amber-500/15"
                : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
            }`}
          >
            {audioEnabled ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
            )}
            {audioEnabled ? "Alerts on" : "Alerts off"}
          </button>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      <div className="px-6 py-5 space-y-6">
        {/* ── W4 Date range toggle — affects the "Done" + "Breached"
             tiles' counts AND labels. Defaults to "today" (existing
             behaviour). */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Range</span>
          <div className="inline-flex rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
            {(["today", "shift", "week"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1 text-xs rounded-md capitalize transition-colors ${
                  range === r
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {r === "today" ? "Today" : r === "shift" ? "This Shift" : "This Week"}
              </button>
            ))}
          </div>
        </div>

        {/* ── Trends entry-point. Command Center auto-refreshes every 60s
            and surfaces snapshot counts — great for firefighting, useless
            for "are we drifting?" That question lives in /head/analytics
            (Cohorts, Trends, Breakdown, Agent Performance) but has zero
            entry point from here. This banner makes the link discoverable
            without taking the focus off the dashboard. */}
        <Link
          href="/head/analytics"
          className="mb-3 flex items-center justify-between px-4 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/60 hover:border-zinc-700 transition-colors group"
        >
          <div className="flex items-center gap-3">
            <span className="text-base">📈</span>
            <div>
              <div className="text-sm font-medium text-zinc-200">Trends &amp; analytics</div>
              <div className="text-xs text-zinc-500">7-day SLA health, agent performance, breakdown by rule</div>
            </div>
          </div>
          <span className="text-xs text-zinc-500 group-hover:text-zinc-300 transition-colors">View →</span>
        </Link>

        {/* ── Stats bar — each tile drills into /head/tasks pre-filtered.
            "Active Orders" + "SLA Health" stay non-interactive (one is a
            labstack count without a tasks-side equivalent, the other is a
            derived %). Today-anchored tiles use IST `dateFrom` so the
            drill-in matches what the tile counted. */}
        <div className="grid grid-cols-4 xl:grid-cols-8 gap-3">
          {(() => {
            const today = todayISTKey();
            // Suffix to apply to range-bound tiles + drill-in dateFrom.
            // For "today" we keep the original label "Done Today" /
            // "Breached Today" so the visual stays familiar; "shift" /
            // "week" relabel explicitly.
            const rangeSuffix = range === "today" ? "Today" : range === "shift" ? "This Shift" : "This Week";
            // For drill-in: today uses today, shift uses today (best
            // single-date approx — "since 09:00" can't be expressed in
            // dateFrom alone), week uses today (same caveat). Day-level
            // drill-in is the closest /head/tasks supports.
            const drillFrom = today;
            // Build the prior-window comparison string used on Done/Breached
            // tiles. "+4 vs last week" green for done; red for breach delta.
            // Suppressed when both current and prior are zero (avoids a
            // confusing "0 vs 0" sub-label on a quiet day).
            const fmtDelta = (cur: number, prior: number): { text: string; tone: "good" | "bad" | "neutral" } | null => {
              if (cur === 0 && prior === 0) return null;
              const diff = cur - prior;
              if (diff === 0) return { text: `same as last week`, tone: "neutral" };
              const sign = diff > 0 ? "+" : "";
              return { text: `${sign}${diff} vs last week`, tone: diff > 0 ? "bad" : "good" };
            };
            const breachedDelta  = fmtDelta(stats.breachedToday, stats.breachedPrior);
            // Higher Done is good, so flip the tone semantics.
            const doneDelta      = (() => {
              const d = fmtDelta(stats.completedToday, stats.completedPrior);
              if (!d || d.tone === "neutral") return d;
              return { text: d.text, tone: d.tone === "bad" ? "good" : "bad" } as { text: string; tone: "good" | "bad" | "neutral" };
            })();
            const subCls = (tone?: "good" | "bad" | "neutral") =>
              tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-zinc-500";

            const tiles: Array<{
              label: string;
              value: number | string;
              cls: string;
              href?: string;
              sub?: { text: string; tone?: "good" | "bad" | "neutral" };
            }> = [
              { label: "Active Orders", value: stats.activeOrders, cls: "text-white" },
              { label: "Open Tasks", value: stats.openTasks, cls: "text-white",
                href: "/head/tasks?status=CREATED,ASSIGNED,IN_PROGRESS,BLOCKED" },
              { label: "Breached", value: stats.breachedTasks,
                cls: stats.breachedTasks > 0 ? "text-red-400" : "text-white",
                href: "/head/tasks?status=BREACHED" },
              { label: "Near SLA", value: stats.warningTasks,
                cls: stats.warningTasks > 0 ? "text-amber-400" : "text-white",
                href: "/head/tasks?slaRiskOnly=true",
                // Surface the critical (≤10 min) subset of the 30-min Near
                // SLA total. Previously the warning threshold WAS 10 min —
                // now broadened to 30 for an actionable horizon, with
                // critical called out so urgency isn't lost.
                sub: stats.warningCriticalTasks > 0
                  ? { text: `${stats.warningCriticalTasks} critical (<10m)`, tone: "bad" }
                  : { text: "within 30 min", tone: "neutral" } },
              { label: "Unassigned", value: stats.unassignedTasks,
                cls: stats.unassignedTasks > 0 ? "text-blue-400" : "text-white",
                // CREATED + no assignee is the dashboard's definition of
                // "Unassigned"; the table view doesn't have a dedicated
                // unassigned filter so we narrow to status=CREATED — the
                // closest single-filter approximation.
                href: "/head/tasks?status=CREATED",
                // Age of the oldest unassigned task — a leading indicator
                // the count alone hides. 90 sec vs 90 min is the difference
                // between "fine" and "about to breach in 30 min".
                sub: stats.oldestUnassignedMin != null && stats.unassignedTasks > 0
                  ? {
                      text: `oldest ${stats.oldestUnassignedMin}m`,
                      tone: stats.oldestUnassignedMin >= 30 ? "bad" : stats.oldestUnassignedMin >= 10 ? "neutral" : "good",
                    }
                  : undefined },
              { label: "SLA Health",
                value: `${stats.slaHealthPercent}%`,
                cls: stats.slaHealthPercent >= 90 ? "text-green-400" : stats.slaHealthPercent >= 70 ? "text-amber-400" : "text-red-400" },
              { label: `Done ${rangeSuffix}`, value: stats.completedToday, cls: "text-green-400",
                href: `/head/tasks?status=COMPLETED&dateFrom=${drillFrom}&dateTo=${drillFrom}`,
                sub: doneDelta ?? undefined },
              { label: `Breached ${rangeSuffix}`, value: stats.breachedToday,
                cls: stats.breachedToday > 0 ? "text-red-400" : "text-zinc-400",
                href: `/head/tasks?status=BREACHED&dateFrom=${drillFrom}&dateTo=${drillFrom}`,
                sub: breachedDelta ?? undefined },
            ];
            return tiles.map(({ label, value, cls, href, sub }) => {
              const inner = (
                <>
                  <div className="text-xs text-zinc-500 mb-1">{label}</div>
                  <div className={`text-2xl font-bold ${cls}`}>{value}</div>
                  {sub && (
                    <div className={`text-[10px] mt-1 ${subCls(sub.tone)}`}>{sub.text}</div>
                  )}
                </>
              );
              if (href) {
                return (
                  <Link
                    key={label}
                    href={href}
                    className="block bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 hover:border-zinc-700 hover:bg-zinc-800/40 transition-colors"
                  >
                    {inner}
                  </Link>
                );
              }
              return (
                <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                  {inner}
                </div>
              );
            });
          })()}
        </div>

        {/* ── Roster glance — bucket counts of the team's current
             rosterStatus. Reads team[] already in the dashboard payload
             (post-W1 fix), no extra API. */}
        {team.length > 0 && (
          <RosterGlanceTile team={team} />
        )}

        {/* ── Source health card (W3) — replaces the prior plain
             source-chips strip. Adds cycle health + tasks-last-hour. */}
        <SourceHealthCard refreshKey={refreshKey} />

        {nonApiWorkflowStats && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">Non-API Labs</div>
                <div className="text-sm font-medium text-zinc-200">Lab confirmation queue</div>
              </div>
              <span className="text-xs text-zinc-500">{nonApiWorkflowStats.waitingForLabConfirmation} awaiting response</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <MetricChip label="Waiting" value={nonApiWorkflowStats.waitingForLabConfirmation} tone="blue" />
              <MetricChip label="Accepted" value={nonApiWorkflowStats.accepted} tone="green" />
              <MetricChip label="Reschedule" value={nonApiWorkflowStats.rescheduleRequested} tone="amber" />
              <MetricChip label="Rejected" value={nonApiWorkflowStats.rejected} tone="red" />
              <MetricChip label="Escalated" value={nonApiWorkflowStats.escalated} tone="purple" />
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-zinc-500">
              <span className="rounded-full border border-zinc-700 bg-zinc-950/60 px-2 py-1">{nonApiWorkflowStats.pendingReminderActions} reminder due</span>
              <span className="rounded-full border border-zinc-700 bg-zinc-950/60 px-2 py-1">{nonApiWorkflowStats.pendingEscalationActions} escalation due</span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-5">
          {/* ── Risk Zone ── */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white">Risk Zone</h2>
              <span className="text-xs text-zinc-500">{riskItems.length} items</span>
            </div>

            {riskItems.length === 0 ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center">
                <div className="w-8 h-8 rounded-full bg-green-500/15 flex items-center justify-center mx-auto mb-2">
                  <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm text-zinc-400 font-medium">All clear</p>
                <p className="text-xs text-zinc-600 mt-0.5">No tasks at risk right now</p>
              </div>
            ) : (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-4 py-2.5">Task</th>
                      <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Status</th>
                      <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">SLA</th>
                      <th className="text-left text-[10px] font-semibold text-zinc-500 uppercase px-3 py-2.5">Assigned</th>
                      <th className="px-3 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {riskItems.map((item) => (
                      <tr key={item.taskId} className="hover:bg-zinc-800/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-zinc-100 leading-snug line-clamp-1 mb-0.5">
                            {item.title}
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <PriorityBadge priority={item.priority} />
                            <span className="text-[10px] text-zinc-600">#{item.entityId}</span>
                            {item.orderType && item.orderType !== "MANUAL" && (
                              <span className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded font-mono">
                                {item.orderType.replace(/_/g, " ")}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <StatusBadge status={item.status} />
                        </td>
                        <td className="px-3 py-3">
                          <SlaCountdown deadline={item.slaDeadline} compact />
                        </td>
                        <td className="px-3 py-3">
                          {item.assignedTo ? (
                            <span className="text-xs text-zinc-300">{item.assignedTo.name}</span>
                          ) : (
                            <span className="text-xs text-zinc-600 italic">Unassigned</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {!item.assignedTo && team.filter((m) => m.rosterStatus !== "OFF").length > 0 && (
                            <select
                              className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              defaultValue=""
                              onChange={(e) => {
                                if (e.target.value) assignTask(item.taskId, parseInt(e.target.value, 10));
                              }}
                            >
                              <option value="" disabled>Assign →</option>
                              {team
                                .filter((m) => m.rosterStatus !== "OFF" && m.openTasks < m.maxTasks)
                                .map((m) => (
                                  <option key={m.userId} value={m.userId}>
                                    {m.name} ({m.openTasks} open)
                                  </option>
                                ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Right column: Alerts + Team ── */}
          <div className="space-y-5">
            {/* Alerts */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Live Alerts</h2>
                {visibleAlerts.length > 0 && (
                  <span className="text-[10px] bg-red-500/20 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded font-medium">
                    {visibleAlerts.length}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                {visibleAlerts.length === 0 ? (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center">
                    <p className="text-xs text-zinc-600">No active alerts</p>
                  </div>
                ) : (
                  visibleAlerts.slice(0, 8).map((alert) => {
                    const t = alertTypeOf(alert);
                    return (
                    <div
                      key={alert.id}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 flex items-start justify-between gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className={`text-xs font-medium ${ALERT_TYPE_COLORS[t] ?? "text-zinc-400"}`}>
                            {t.replace(/_/g, " ")}
                          </p>
                          {alert.task && (
                            <span className="text-[10px] text-zinc-600 font-mono">
                              #{alert.task.entityId}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{alert.message}</p>
                        {alert.task && (
                          <p className="text-[10px] text-zinc-600 mt-0.5 truncate">{alert.task.title}</p>
                        )}
                        <p className="text-[10px] text-zinc-700 mt-0.5">
                          {new Date(alert.createdAt).toLocaleTimeString("en-IN")}
                        </p>
                      </div>
                      <button
                        onClick={() => dismissAlert(alert.id)}
                        className="shrink-0 text-zinc-600 hover:text-zinc-400 transition-colors mt-0.5"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Team panel */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Team Status</h2>
                <span className="text-xs text-zinc-500">
                  {team.filter((m) => m.rosterStatus !== "OFF").length} active
                </span>
              </div>

              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                {team.length === 0 ? (
                  <div className="p-4 text-center text-xs text-zinc-600">No team members</div>
                ) : (
                  <div className="divide-y divide-zinc-800/60">
                    {team.map((member) => {
                      const loadPct = member.maxTasks > 0 ? (member.openTasks / member.maxTasks) * 100 : 0;
                      const isActive = member.rosterStatus !== "OFF";
                      return (
                        <div key={member.userId} className="px-4 py-3">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-green-500" : "bg-zinc-600"}`} />
                              <span className="text-xs font-medium text-zinc-200">{member.name}</span>
                            </div>
                            <span className={`text-[10px] font-medium ${
                              loadPct >= 80 ? "text-red-400" : loadPct >= 60 ? "text-amber-400" : "text-zinc-400"
                            }`}>
                              {member.openTasks}/{member.maxTasks}
                            </span>
                          </div>
                          <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                loadPct >= 80 ? "bg-red-500" : loadPct >= 60 ? "bg-amber-500" : "bg-green-500"
                              }`}
                              style={{ width: `${Math.min(100, loadPct)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Create Task Modal */}
      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
