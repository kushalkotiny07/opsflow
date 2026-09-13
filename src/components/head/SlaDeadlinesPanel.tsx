"use client";

/**
 * SLA deadlines — one row per milestone, per provider.
 *
 * Three things this screen has to make obvious, because getting any of them
 * wrong is how a provider ends up either spammed or silently unchased:
 *
 *   1. WHICH CLOCK. The anchor is shown as a sentence ("60m after the order
 *      was created", "60m before the appointment"), not as two dropdowns the
 *      reader has to assemble in their head. Offsets are signed and always
 *      carry a unit.
 *
 *   2. INHERITED OR OVERRIDDEN. A lab row replaces the global default
 *      wholesale, so the row says which it is and offers a one-click reset.
 *
 *   3. WHETHER IT CAN ACTUALLY FIRE. An enabled milestone with no breach step
 *      on the provider's path sends nothing. Rather than leave that to be
 *      discovered, the row says so and links to where the step is added.
 */

import { useCallback, useEffect, useState } from "react";

type Anchor = "ORDER_CREATED" | "APPOINTMENT_TIME" | "PREV_MILESTONE_COMPLETED";

type Config = {
  milestone: string;
  anchor: Anchor;
  offsetMinutes: number;
  enabled: boolean;
  repeatIntervalMinutes: number;
  maxAttempts: number;
  ignoreQuietHours: boolean;
  inherited: boolean;
};

type Row = {
  milestone: string;
  label: string;
  hasBreachStep: boolean;
  config: Config | null;
};

const ANCHOR_LABELS: Record<Anchor, string> = {
  ORDER_CREATED: "the order was created",
  APPOINTMENT_TIME: "the appointment",
  PREV_MILESTONE_COMPLETED: "the previous milestone",
};

/** "60m after the order was created" / "60m before the appointment". */
function describe(config: Config): string {
  const magnitude = Math.abs(config.offsetMinutes);
  const unit = magnitude < 60
    ? `${magnitude}m`
    : magnitude % 60 === 0 ? `${magnitude / 60}h` : `${Math.floor(magnitude / 60)}h ${magnitude % 60}m`;
  const direction = config.offsetMinutes < 0 ? "before" : "after";
  return `${unit} ${direction} ${ANCHOR_LABELS[config.anchor]}`;
}

const inputClass =
  "w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500";

export function SlaDeadlinesPanel({ labId, labName }: { labId: number; labName: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/provider-comms/sla-config?labId=${labId}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNotice({ tone: "err", text: data.error ?? "Could not load SLA deadlines" }); setLoading(false); return; }
    setRows(data.milestones ?? []);
    setLoading(false);
  }, [labId]);

  useEffect(() => { void load(); }, [load]);

  async function save(config: Config) {
    setBusy(true); setNotice(null);
    const res = await fetch("/api/provider-comms/sla-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labId, ...config }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      const details = data.details ? Object.values(data.details).join(" · ") : null;
      setNotice({ tone: "err", text: details || data.error || "Could not save" });
      return;
    }
    setEditing(null); setDraft(null);
    setNotice({ tone: "ok", text: "SLA deadline saved" });
    await load();
  }

  async function resetToDefault(milestone: string) {
    setBusy(true); setNotice(null);
    const res = await fetch(`/api/provider-comms/sla-config?labId=${labId}&milestone=${milestone}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: "Could not reset to the default" }); return; }
    setNotice({ tone: "ok", text: "Reset — this milestone follows the global default again" });
    await load();
  }

  if (loading) {
    return <div className="rounded-xl border border-zinc-800 p-6 text-sm text-zinc-500">Loading SLA deadlines…</div>;
  }

  return (
    <div className="rounded-xl border border-zinc-800">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">SLA deadlines</div>
        <div className="text-xs text-zinc-500">
          When {labName} is chased for a missed milestone. Every milestone ships off.
        </div>
        {notice && <span className={`ml-auto text-xs ${notice.tone === "ok" ? "text-emerald-400" : "text-rose-400"}`}>{notice.text}</span>}
      </div>

      <div className="divide-y divide-zinc-800/60">
        {rows.map((row) => {
          const config = row.config;
          const isEditing = editing === row.milestone;
          return (
            <div key={row.milestone} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-zinc-200">{row.label}</span>

                {config?.enabled
                  ? <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">on</span>
                  : <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-zinc-500">off</span>}

                {config?.inherited && (
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400" title="Following the global default">
                    default
                  </span>
                )}

                {config?.enabled && !row.hasBreachStep && (
                  <span
                    className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300"
                    title="Nothing will be sent until a breach step for this milestone exists on the provider's path"
                  >
                    no breach step
                  </span>
                )}

                {config && !isEditing && (
                  <span className="text-xs text-zinc-500">
                    {describe(config)} · every {config.repeatIntervalMinutes}m · max {config.maxAttempts}
                    {config.ignoreQuietHours ? " · ignores quiet hours" : ""}
                  </span>
                )}

                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {config && !isEditing && (
                    <>
                      <button
                        onClick={() => void save({ ...config, enabled: !config.enabled })}
                        disabled={busy}
                        className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                      >
                        {config.enabled ? "Turn off" : "Turn on"}
                      </button>
                      <button
                        onClick={() => { setEditing(row.milestone); setDraft({ ...config }); setNotice(null); }}
                        disabled={busy}
                        className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                      >
                        Edit
                      </button>
                      {!config.inherited && (
                        <button
                          onClick={() => void resetToDefault(row.milestone)}
                          disabled={busy}
                          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                          title="Drop this provider's override and follow the global default"
                        >
                          Reset to default
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {isEditing && draft && (
                <div className="mt-3 rounded-lg border border-dashed border-blue-500/50 bg-blue-500/5 p-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="block">
                      <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">Measured from</span>
                      <select
                        value={draft.anchor}
                        onChange={(event) => setDraft({ ...draft, anchor: event.target.value as Anchor })}
                        className={inputClass}
                      >
                        <option value="ORDER_CREATED">Order created</option>
                        <option value="APPOINTMENT_TIME">Appointment time</option>
                        <option value="PREV_MILESTONE_COMPLETED">Previous milestone</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
                        Offset (minutes{draft.anchor === "APPOINTMENT_TIME" ? ", negative = before" : ""})
                      </span>
                      <input
                        type="number"
                        value={draft.offsetMinutes}
                        onChange={(event) => setDraft({ ...draft, offsetMinutes: Number(event.target.value) })}
                        className={inputClass}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">Repeat every (minutes)</span>
                      <input
                        type="number" min={5} max={1440}
                        value={draft.repeatIntervalMinutes}
                        onChange={(event) => setDraft({ ...draft, repeatIntervalMinutes: Number(event.target.value) })}
                        className={inputClass}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">Max attempts</span>
                      <input
                        type="number" min={1} max={10}
                        value={draft.maxAttempts}
                        onChange={(event) => setDraft({ ...draft, maxAttempts: Number(event.target.value) })}
                        className={inputClass}
                      />
                    </label>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={draft.ignoreQuietHours}
                        onChange={(event) => setDraft({ ...draft, ignoreQuietHours: event.target.checked })}
                        className="accent-blue-500"
                      />
                      Send even during quiet hours
                    </label>
                    <span className="text-[11px] text-zinc-500">{describe(draft)}</span>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        onClick={() => { setEditing(null); setDraft(null); }}
                        className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-100"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => void save(draft)}
                        disabled={busy}
                        className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                      >
                        {busy ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="border-t border-zinc-800 px-4 py-2.5 text-[11px] leading-4 text-zinc-600">
        A milestone only sends when it is on, the provider&apos;s path has a breach step for it, and the engine
        is switched on under SLA Breaches. Deadlines are computed per order from the anchor above.
      </p>
    </div>
  );
}
