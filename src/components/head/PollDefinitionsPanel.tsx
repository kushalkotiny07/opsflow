"use client";

/**
 * Editing the polls providers answer.
 *
 * Two things are edited together on purpose: the option a provider taps and the
 * reply they get for tapping it. They were previously in different places —
 * options hardcoded in the app, replies in the message templates — which made
 * it impossible to see what a provider actually experiences without reading
 * both. Here one row is one round trip: "they tap this, we say that."
 */

import { useCallback, useEffect, useState } from "react";

type PollOption = { label: string; action: "ACCEPT" | "RESCHEDULE" | "REJECT" | null; ack: string };
type PollDefinition = { key: string; name: string; question: string; isActive: boolean; options: PollOption[] };

const ACTION_CHOICES: { value: PollOption["action"]; label: string; hint: string }[] = [
  { value: null, label: "Just record it", hint: "Informational — the answer is logged, the order does not move" },
  { value: "ACCEPT", label: "Accept order", hint: "Marks the order accepted and stops all chasing" },
  { value: "RESCHEDULE", label: "Reschedule", hint: "Marks a reschedule requested and asks for a new time" },
  { value: "REJECT", label: "Cannot fulfil", hint: "Marks the order rejected so it can be reassigned" },
];

export function PollDefinitionsPanel() {
  const [polls, setPolls] = useState<PollDefinition[]>([]);
  const [draft, setDraft] = useState<PollDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2400); };

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/poll-definitions");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error ?? "Could not load polls"); return; }
      setPolls(data.polls ?? []);
      setDraft((current) => current ?? data.polls?.[0] ?? null);
    } catch {
      setError("Could not load polls");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function updateOption(index: number, patch: Partial<PollOption>) {
    setDraft((current) => current && ({
      ...current,
      options: current.options.map((option, i) => i === index ? { ...option, ...patch } : option),
    }));
  }

  async function save() {
    if (!draft) return;
    setSaving(true); setError(null);
    const response = await fetch("/api/poll-definitions", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
    });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) {
      setError(data.details ? Object.values(data.details).join(" · ") : (data.error ?? "Could not save"));
      return;
    }
    flash("Poll saved — it applies to the next message sent");
    setPolls((current) => current.map((poll) => poll.key === data.poll.key ? data.poll : poll));
    setDraft(data.poll);
  }

  if (loading) return <div className="p-10 text-center text-sm text-zinc-500">Loading polls…</div>;

  return (
    <div className="mt-8">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-zinc-100">Provider polls</h2>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          What a provider is asked, and what they hear back. A poll rides with every confirmation
          message and every SLA breach — editing one here changes the next message sent, with no
          deploy. Answered polls keep the wording they were sent with.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {polls.map((poll) => (
          <button
            key={poll.key}
            onClick={() => { setDraft(poll); setError(null); }}
            className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
              draft?.key === poll.key ? "border-blue-500 bg-blue-500/10 text-blue-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <div className="font-medium">{poll.name}</div>
            <div className="font-mono text-[10px] text-zinc-500">
              {poll.key}{poll.isActive ? "" : " · off"}
            </div>
          </button>
        ))}
      </div>

      {draft && (
        <div className="rounded-xl border border-zinc-800 p-5">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">Question shown above the options</span>
            <input
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
            />
          </label>

          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
              className="accent-blue-500"
            />
            Send this poll
            <span className="text-[11px] text-zinc-500">— off means the message goes out as plain text</span>
          </label>

          <div className="mt-5 space-y-4">
            {draft.options.map((option, index) => (
              <div key={index} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-400">What they tap</span>
                    <input
                      value={option.label}
                      onChange={(e) => updateOption(index, { label: e.target.value })}
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-400">What it does to the order</span>
                    <select
                      value={option.action ?? ""}
                      onChange={(e) => updateOption(index, { action: (e.target.value || null) as PollOption["action"] })}
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                    >
                      {ACTION_CHOICES.map((choice) => (
                        <option key={String(choice.value)} value={choice.value ?? ""}>{choice.label}</option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[11px] text-zinc-500">
                      {ACTION_CHOICES.find((c) => c.value === option.action)?.hint}
                    </span>
                  </label>
                </div>
                <label className="mt-3 block">
                  <span className="mb-1 block text-xs text-zinc-400">What we reply when they tap it</span>
                  <textarea
                    value={option.ack}
                    onChange={(e) => updateOption(index, { ack: e.target.value })}
                    rows={4}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-[12px] text-zinc-100 outline-none focus:border-blue-500"
                  />
                  <span className="mt-1 block text-[11px] text-zinc-500">
                    Leave blank to stay silent. Available: {"{{order_id}} {{patient_name}} {{appointment_date}} {{appointment_time}} {{location}} {{tests}} {{lab_name}}"}
                  </span>
                </label>
              </div>
            ))}
          </div>

          {error && <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-300">{error}</div>}

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save poll"}
            </button>
            <button onClick={() => { setDraft(polls.find((p) => p.key === draft.key) ?? draft); setError(null); }} className="text-sm text-zinc-400 hover:text-zinc-200">
              Discard changes
            </button>
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 shadow-lg">{toast}</div>}
    </div>
  );
}
