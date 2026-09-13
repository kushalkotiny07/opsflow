"use client";

/**
 * SLA breaches — the operational view of what the milestone engine is doing.
 *
 * Built around the one question an operator actually has: is anybody chasing
 * this, and is it getting through? So attempts and the last delivery status
 * sit together on the row rather than behind a click, and the only action is
 * "Stop sending" — for the case where it has already been handled by phone.
 *
 * Stop is deliberately not "resolve": the milestone is still outstanding, and
 * recording it as completed would put a falsehood in the ledger.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import OrderQuickView from "@/components/shared/OrderQuickView";

type Breach = {
  id: string;
  orderId: number;
  labId: number;
  labName: string;
  milestone: string;
  milestoneLabel: string;
  deadlineAt: string;
  firstBreachedAt: string;
  overdueMinutes: number;
  attemptsSent: number;
  nextAttemptAt: string | null;
  status: "ACTIVE" | "RESOLVED" | "CAPPED" | "CANCELLED";
  resolutionReason: string | null;
  lastSentAt: string | null;
  lastDeliveryStatus: string | null;
  lastDeliveryError: string | null;
};

type Settings = {
  slaBreachEnabled: boolean;
  slaBreachDryRun: boolean;
  perLabPerTickLimit: number;
};

/** Which of the three preconditions for a breach are actually met. */
type Readiness = {
  engineEnabled: boolean;
  dryRun: boolean;
  breachStepCount: number;
  enabledMilestoneCount: number;
};

const STATUS_STYLES: Record<Breach["status"], string> = {
  ACTIVE: "bg-rose-500/10 text-rose-300",
  RESOLVED: "bg-emerald-500/10 text-emerald-300",
  CAPPED: "bg-amber-500/10 text-amber-300",
  CANCELLED: "bg-zinc-800 text-zinc-400",
};

function overdue(minutes: number): string {
  const value = Math.max(0, minutes);
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function when(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "numeric", minute: "2-digit",
  });
}

export function SlaBreachList() {
  const [breaches, setBreaches] = useState<Breach[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [status, setStatus] = useState("");
  const [milestone, setMilestone] = useState("");
  const [labId, setLabId] = useState("");
  /** Order whose quick view is open. Same drawer Smart View uses. */
  const [openOrderId, setOpenOrderId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams();
    if (status) query.set("status", status);
    if (milestone) query.set("milestone", milestone);
    if (labId) query.set("labId", labId);
    const [breachRes, settingsRes] = await Promise.all([
      fetch(`/api/provider-comms/breaches?${query.toString()}`),
      fetch("/api/provider-comms/settings"),
    ]);
    const breachData = await breachRes.json().catch(() => ({}));
    const settingsData = await settingsRes.json().catch(() => ({}));
    if (!breachRes.ok) { setNotice({ tone: "err", text: breachData.error ?? "Could not load breaches" }); setLoading(false); return; }
    setBreaches(breachData.breaches ?? []);
    setReadiness(breachData.readiness ?? null);
    if (settingsRes.ok) setSettings(settingsData.settings ?? null);
    setLoading(false);
  }, [status, milestone, labId]);

  useEffect(() => { void load(); }, [load]);

  const labs = useMemo(() => {
    const seen = new Map<number, string>();
    for (const breach of breaches) seen.set(breach.labId, breach.labName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [breaches]);

  const milestones = useMemo(() => {
    const seen = new Map<string, string>();
    for (const breach of breaches) seen.set(breach.milestone, breach.milestoneLabel);
    return [...seen.entries()];
  }, [breaches]);

  const activeCount = breaches.filter((b) => b.status === "ACTIVE").length;

  async function updateSettings(patch: Partial<Settings>, okText: string) {
    setBusy(true); setNotice(null);
    const res = await fetch("/api/provider-comms/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      const details = data.details ? Object.values(data.details).join(" · ") : null;
      setNotice({ tone: "err", text: details || data.error || "Could not update the engine" });
      return;
    }
    setNotice({ tone: "ok", text: okText });
    await load();
  }

  async function stopSending(breach: Breach) {
    if (!window.confirm(`Stop sending for order #${breach.orderId} (${breach.milestoneLabel})?\n\nThe milestone stays outstanding — this only stops the messages.`)) return;
    setBusy(true); setNotice(null);
    const res = await fetch(`/api/provider-comms/breaches/${breach.id}/stop`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: data.error ?? "Could not stop this breach" }); return; }
    setNotice({ tone: "ok", text: "Stopped — no further messages for this breach" });
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs text-zinc-500 mb-1">Provider Communication</div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">SLA breaches</h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-2xl">
            Orders that missed a milestone deadline, and what the engine has sent the lab about it.
            Applies to every configured lab, API and non-API alike.
          </p>
        </div>
        {settings && (
          <div className="flex items-center gap-2 text-[11px]">
            <button
              onClick={() => void updateSettings(
                { slaBreachEnabled: !settings.slaBreachEnabled },
                settings.slaBreachEnabled ? "Engine stopped — no breaches will be detected or sent" : "Engine started",
              )}
              disabled={busy}
              title="Stops breach sending only. Sequence steps are unaffected."
              className={`rounded-full px-2.5 py-1 font-semibold transition-colors disabled:opacity-50 ${settings.slaBreachEnabled ? "bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
            >
              {settings.slaBreachEnabled ? "Engine on" : "Engine off"}
            </button>
            <button
              onClick={() => void updateSettings(
                { slaBreachDryRun: !settings.slaBreachDryRun },
                settings.slaBreachDryRun ? "Dry run off — messages will now reach providers" : "Dry run on — nothing will be queued",
              )}
              disabled={busy}
              title={settings.slaBreachDryRun
                ? "Messages are rendered and recorded, but nothing is queued to WhatsApp. Click to go live."
                : "Messages are queued to WhatsApp for real. Click to return to dry run."}
              className={`rounded-full px-2.5 py-1 font-semibold transition-colors disabled:opacity-50 ${settings.slaBreachDryRun ? "bg-amber-500/10 text-amber-300 hover:bg-amber-500/20" : "bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"}`}
            >
              {settings.slaBreachDryRun ? "Dry run" : "Live"}
            </button>
          </div>
        )}
      </div>

      {settings && !settings.slaBreachEnabled && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-400">
          The breach engine is switched off, so nothing is being detected or sent. Existing rows below are history.
          Sequence steps are unaffected by this switch.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {[
          { value: status, set: setStatus, label: "All statuses", options: ["ACTIVE", "RESOLVED", "CAPPED", "CANCELLED"].map((s) => [s, s.toLowerCase()] as const) },
          { value: milestone, set: setMilestone, label: "All milestones", options: milestones },
          { value: labId, set: setLabId, label: "All providers", options: labs.map(([id, name]) => [String(id), name] as const) },
        ].map((filter, index) => (
          <select
            key={index}
            value={filter.value}
            onChange={(event) => filter.set(event.target.value)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200"
          >
            <option value="">{filter.label}</option>
            {filter.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        ))}
        <span className="ml-auto text-xs text-zinc-500">
          {activeCount} active{breaches.length !== activeCount ? ` · ${breaches.length} shown` : ""}
        </span>
        {notice && <span className={`text-xs ${notice.tone === "ok" ? "text-emerald-400" : "text-rose-400"}`}>{notice.text}</span>}
      </div>

      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-sm text-zinc-500">Loading breaches…</div>
        ) : breaches.length === 0 ? (
          <div className="p-8">
            <p className="text-center text-sm text-zinc-400">No breaches recorded.</p>
            {readiness && (() => {
              // Three switches, all required. Naming the one that is off beats
              // "no data" — an operator should not have to go and check each
              // screen in turn to find out why nothing is happening.
              const steps = [
                {
                  done: readiness.breachStepCount > 0,
                  label: "A breach step on a provider's path",
                  detail: readiness.breachStepCount > 0
                    ? `${readiness.breachStepCount} step${readiness.breachStepCount === 1 ? "" : "s"} configured`
                    : "Add one under Templates → SLA breach",
                  href: "/head/non-api-labs/templates",
                },
                {
                  done: readiness.enabledMilestoneCount > 0,
                  label: "A milestone switched on for that provider",
                  detail: readiness.enabledMilestoneCount > 0
                    ? `${readiness.enabledMilestoneCount} milestone${readiness.enabledMilestoneCount === 1 ? "" : "s"} enabled`
                    : "Turn one on under Lab Config → SLA deadlines",
                  href: "/head/non-api-labs/lab-config",
                },
                {
                  done: readiness.engineEnabled,
                  label: "The engine switched on",
                  detail: readiness.engineEnabled
                    ? readiness.dryRun ? "Running in dry run" : "Running live"
                    : "Use the Engine off button above",
                  href: null,
                },
              ];
              const remaining = steps.filter((step) => !step.done).length;
              return (
                <div className="mx-auto mt-5 max-w-md">
                  <div className="mb-2 text-center text-xs text-zinc-500">
                    {remaining === 0
                      ? "Everything is on — breaches will appear within a minute of the next tick."
                      : `${remaining} thing${remaining === 1 ? "" : "s"} still to switch on:`}
                  </div>
                  <ol className="space-y-1.5">
                    {steps.map((step) => (
                      <li
                        key={step.label}
                        className={`flex items-start gap-2.5 rounded-lg border border-dashed px-3 py-2 text-xs ${step.done ? "border-zinc-800 text-zinc-500" : "border-zinc-700"}`}
                      >
                        <span className={step.done ? "text-emerald-400" : "text-amber-400"}>{step.done ? "✔" : "•"}</span>
                        <span className="flex-1">
                          <span className={step.done ? "text-zinc-500" : "text-zinc-200"}>{step.label}</span>
                          <span className="mt-0.5 block text-[11px] text-zinc-600">{step.detail}</span>
                        </span>
                        {!step.done && step.href && (
                          <a href={step.href} className="shrink-0 text-[11px] text-blue-400 hover:text-blue-300">Open →</a>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-950/70">
                <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
                  <th className="px-4 py-2.5">Order</th>
                  <th className="px-3 py-2.5">Provider</th>
                  <th className="px-3 py-2.5">Milestone</th>
                  <th className="px-3 py-2.5">Deadline</th>
                  <th className="px-3 py-2.5">Overdue</th>
                  <th className="px-3 py-2.5">Attempts</th>
                  <th className="px-3 py-2.5">Last delivery</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {breaches.map((breach) => (
                  <tr key={breach.id} className="border-b border-zinc-800/60 hover:bg-zinc-900/40">
                    <td className="px-4 py-3">
                      {/* Opens the same OrderQuickView drawer the task boards
                          use, rather than navigating to a filtered task list —
                          the question here is "what is going on with this
                          order", and leaving the page loses the breach list. */}
                      <button
                        onClick={() => setOpenOrderId(breach.orderId)}
                        className="font-mono text-xs text-blue-400 hover:text-blue-300 hover:underline"
                        title="View order details and its OpsFlow tasks"
                      >
                        #{breach.orderId}
                      </button>
                    </td>
                    <td className="px-3 py-3 text-zinc-300">{breach.labName}</td>
                    <td className="px-3 py-3 text-zinc-300">{breach.milestoneLabel}</td>
                    <td className="px-3 py-3 text-xs text-zinc-500">{when(breach.deadlineAt)}</td>
                    <td className={`px-3 py-3 text-xs ${breach.status === "ACTIVE" ? "text-rose-300" : "text-zinc-500"}`}>
                      {overdue(breach.overdueMinutes)}
                    </td>
                    <td className="px-3 py-3 text-xs text-zinc-400">
                      {breach.attemptsSent}
                      {breach.nextAttemptAt && (
                        <span className="text-zinc-600"> · next {when(breach.nextAttemptAt)}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {breach.lastDeliveryStatus ? (
                        <span
                          className={
                            breach.lastDeliveryStatus === "FAILED" ? "text-rose-400"
                              : breach.lastDeliveryStatus === "SENT" ? "text-emerald-400"
                              : breach.lastDeliveryStatus === "DRY_RUN" ? "text-amber-400"
                              : "text-zinc-400"
                          }
                          title={breach.lastDeliveryError ?? undefined}
                        >
                          {breach.lastDeliveryStatus}
                        </span>
                      ) : <span className="text-zinc-600">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[breach.status]}`}>
                        {breach.status}
                      </span>
                      {breach.resolutionReason && (
                        <div className="mt-0.5 text-[10px] text-zinc-600">{breach.resolutionReason.replaceAll("_", " ").toLowerCase()}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {breach.status === "ACTIVE" ? (
                        <button
                          onClick={() => stopSending(breach)}
                          disabled={busy}
                          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:text-rose-400 disabled:opacity-50"
                        >
                          Stop sending
                        </button>
                      ) : <span className="text-[11px] text-zinc-700">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openOrderId !== null && (
        <OrderQuickView orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
      )}
    </div>
  );
}
