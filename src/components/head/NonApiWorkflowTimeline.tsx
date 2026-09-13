"use client";

import { useEffect, useState } from "react";

type TimelineEntry = {
  id: string;
  source: "event" | "audit";
  type: string;
  actorType?: string | null;
  at: string;
  payload?: Record<string, unknown> | null;
};

type WorkflowSummary = {
  id: string;
  orderId: number;
  labId: number;
  status: string;
  createdAt: string;
  confirmationDeadline: string;
  reminderDeadline: string;
  escalationDeadline: string;
  timeline: TimelineEntry[];
};

function timeLabel(value: string) {
  return new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export function NonApiWorkflowTimeline() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/non-api-labs/workflows")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Failed to load")))
      .then((data) => {
        if (!cancelled) {
          setWorkflows(data.workflows ?? []);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load workflow timeline");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Workflow timeline</div>
          <h2 className="mt-1 text-lg font-semibold text-zinc-100">Recent non-API lab flows</h2>
        </div>
      </div>

      {loading ? (
        <div className="p-6 text-sm text-zinc-500">Loading workflow history…</div>
      ) : error ? (
        <div className="p-6 text-sm text-red-400">{error}</div>
      ) : workflows.length === 0 ? (
        <div className="p-6 text-sm text-zinc-500">No recent lab confirmation workflows yet.</div>
      ) : (
        <div className="space-y-4 p-4">
          {workflows.map((workflow) => (
            <div key={workflow.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Order #{workflow.orderId}</div>
                  <div className="text-xs text-zinc-500">Lab #{workflow.labId} · {workflow.status}</div>
                </div>
                <div className="text-[11px] text-zinc-500">Started {timeLabel(workflow.createdAt)}</div>
              </div>

              <div className="mt-3 border-l border-zinc-800 pl-3">
                {workflow.timeline.length === 0 ? (
                  <div className="text-xs text-zinc-500">No events recorded yet.</div>
                ) : (
                  workflow.timeline.map((entry) => (
                    <div key={entry.id} className="mb-3 last:mb-0">
                      <div className="flex items-center gap-2 text-xs text-zinc-400">
                        <span className="inline-flex rounded-full border border-zinc-700 px-1.5 py-0.5 uppercase tracking-wide">{entry.source}</span>
                        <span className="font-medium text-zinc-200">{entry.type}</span>
                        {entry.actorType && <span>· {entry.actorType}</span>}
                        <span className="ml-auto">{timeLabel(entry.at)}</span>
                      </div>
                      {entry.payload && typeof entry.payload === "object" && Object.keys(entry.payload).length > 0 && (
                        <div className="mt-1 text-[11px] text-zinc-500">
                          {JSON.stringify(entry.payload).slice(0, 140)}{JSON.stringify(entry.payload).length > 140 ? "…" : ""}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
