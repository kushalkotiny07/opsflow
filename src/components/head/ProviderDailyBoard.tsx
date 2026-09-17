"use client";

/**
 * Today and tomorrow, per provider.
 *
 * The question this answers is the one an Ops head starts the day with: for
 * each lab we talk to, how much work is coming, how much of it have they
 * confirmed, and what is already going wrong. PRD §31 and §41.
 *
 * Built around exceptions rather than totals. A row with 40 orders and nothing
 * outstanding needs no attention; a row with 3 orders and 3 unanswered
 * confirmations needs it now — so unanswered, unreachable and breached sort to
 * the top and are the only things that carry colour.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";


type Day = {
  total: number;
  homeCollections: number;
  centreVisits: number;
  awaitingCollection: number;
  collected: number;
  reportPending: number;
  done: number;
  cancelled: number;
  firstAppointment: string | null;
  nextAppointment: string | null;
};

type LabBoard = {
  labId: number;
  labName: string;
  integrationType: "API" | "NON_API";
  isActive: boolean;
  reachable: boolean;
  today: Day;
  tomorrow: Day;
  confirmation: { awaiting: number; accepted: number; rescheduleRequested: number; rejected: number; escalated: number };
  openBreaches: number;
};

function clock(iso: string | null, timeZone: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

/**
 * How loudly this row should ask for attention.
 *
 * Deliberately not "most orders first": volume is not a problem, an unanswered
 * provider is. A lab that cannot be reached at all outranks everything, because
 * every other number on its row is unactionable until that is fixed.
 */
function urgency(lab: LabBoard) {
  if (lab.isActive && !lab.reachable && lab.today.total > 0) return 3;
  if (lab.openBreaches > 0) return 2;
  if (lab.confirmation.awaiting > 0) return 1;
  return 0;
}

export function ProviderDailyBoard() {
  const [labs, setLabs] = useState<LabBoard[]>([]);
  const [timeZone, setTimeZone] = useState("Asia/Kolkata");
  const [dates, setDates] = useState<{ today: string; tomorrow: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/provider-comms/daily-board");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error ?? "Could not load the board"); return; }
      setLabs(data.labs ?? []);
      if (data.timeZone) setTimeZone(data.timeZone);
      if (data.today) setDates({ today: data.today, tomorrow: data.tomorrow });
      setError(null);
    } catch {
      setError("Could not load the board");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Orders move during the day; a board nobody refreshes is a board nobody trusts.
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading) return <div className="p-10 text-center text-sm text-zinc-500">Loading the provider board…</div>;
  if (error) return <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-300">{error}</div>;

  const sorted = [...labs].sort((a, b) =>
    urgency(b) - urgency(a)
    || b.today.total - a.today.total
    || a.labName.localeCompare(b.labName));

  const totals = labs.reduce((acc, lab) => ({
    today: acc.today + lab.today.total,
    tomorrow: acc.tomorrow + lab.tomorrow.total,
    awaiting: acc.awaiting + lab.confirmation.awaiting,
    breaches: acc.breaches + lab.openBreaches,
  }), { today: 0, tomorrow: 0, awaiting: 0, breaches: 0 });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 text-xs text-zinc-500">Provider communication</div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Today &amp; tomorrow</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            What each provider owes us today, and what is coming tomorrow. Refreshes every minute.
            {dates && <span className="text-zinc-500"> · {dates.today} → {dates.tomorrow} ({timeZone})</span>}
          </p>
        </div>
        <button onClick={load} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200">
          Refresh
        </button>
      </div>

      <div className="mb-5 grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <Metric label="Orders today" value={totals.today} />
        <Metric label="Orders tomorrow" value={totals.tomorrow} />
        <Metric label="Awaiting confirmation" value={totals.awaiting} tone={totals.awaiting ? "text-amber-400" : "text-zinc-100"} />
        <Metric label="Open SLA breaches" value={totals.breaches} tone={totals.breaches ? "text-red-400" : "text-zinc-100"} />
      </div>

      {labs.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 p-10 text-center text-sm text-zinc-400">
          No providers are configured yet. Add one under Lab Config.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-950/70">
              <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2.5">Provider</th>
                <th className="px-3 py-2.5">Today</th>
                <th className="px-3 py-2.5">Mix</th>
                <th className="px-3 py-2.5">Still to collect</th>
                <th className="px-3 py-2.5">Reports pending</th>
                <th className="px-3 py-2.5">First / next</th>
                <th className="px-3 py-2.5">Tomorrow</th>
                <th className="px-3 py-2.5">Needs attention</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((lab) => (
                <tr key={lab.labId} className={`border-b border-zinc-800/60 hover:bg-zinc-900/40 ${lab.isActive ? "" : "opacity-50"}`}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/head/non-api-labs/board/${lab.labId}`}
                      className="block"
                      title={`See ${lab.labName}'s orders for today and tomorrow`}
                    >
                      <div className="font-medium text-zinc-100 hover:text-blue-300">{lab.labName} →</div>
                      <div className="font-mono text-[11px] text-zinc-500">
                        Lab #{lab.labId} · {lab.integrationType}
                        {!lab.isActive && <span className="ml-1 text-zinc-600">· paused</span>}
                      </div>
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-lg font-semibold text-zinc-100">{lab.today.total}</span>
                    {lab.today.cancelled > 0 && <span className="ml-1 text-[11px] text-zinc-500">({lab.today.cancelled} cancelled)</span>}
                  </td>
                  <td className="px-3 py-3 text-xs text-zinc-400">
                    {lab.today.total === 0 ? "—" : (
                      <>
                        <div>{lab.today.homeCollections} home</div>
                        <div>{lab.today.centreVisits} centre</div>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={lab.today.awaitingCollection > 0 ? "text-zinc-100" : "text-zinc-600"}>
                      {lab.today.awaitingCollection}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className={lab.today.reportPending > 0 ? "text-zinc-100" : "text-zinc-600"}>
                      {lab.today.reportPending}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-zinc-400">
                    <div>{clock(lab.today.firstAppointment, timeZone)}</div>
                    <div className="text-zinc-500">next {clock(lab.today.nextAppointment, timeZone)}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={lab.tomorrow.total > 0 ? "text-zinc-100" : "text-zinc-600"}>{lab.tomorrow.total}</span>
                    {lab.tomorrow.total > 0 && (
                      <div className="text-[11px] text-zinc-500">from {clock(lab.tomorrow.firstAppointment, timeZone)}</div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-1 text-[11px]">
                      {/* Unreachable first: every other number is unactionable until it is fixed. */}
                      {lab.isActive && !lab.reachable && <Flag tone="red">No WhatsApp target</Flag>}
                      {lab.openBreaches > 0 && <Flag tone="red">{lab.openBreaches} SLA breach{lab.openBreaches > 1 ? "es" : ""}</Flag>}
                      {lab.confirmation.awaiting > 0 && <Flag tone="amber">{lab.confirmation.awaiting} unconfirmed</Flag>}
                      {lab.confirmation.escalated > 0 && <Flag tone="amber">{lab.confirmation.escalated} escalated</Flag>}
                      {lab.confirmation.rejected > 0 && <Flag tone="zinc">{lab.confirmation.rejected} rejected</Flag>}
                      {urgency(lab) === 0 && lab.today.total > 0 && <span className="text-emerald-400">On track</span>}
                      {lab.today.total === 0 && lab.tomorrow.total === 0 && <span className="text-zinc-600">No orders</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Flag({ tone, children }: { tone: "red" | "amber" | "zinc"; children: React.ReactNode }) {
  const colour = tone === "red" ? "text-red-400" : tone === "amber" ? "text-amber-400" : "text-zinc-400";
  return <span className={colour}>{children}</span>;
}

function Metric({ label, value, tone = "text-zinc-100" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
