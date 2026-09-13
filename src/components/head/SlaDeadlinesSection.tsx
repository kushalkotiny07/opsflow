"use client";

/**
 * Provider picker for the SLA deadlines panel.
 *
 * Deadlines are per provider, but the Lab Config screen above lists all of
 * them at once — so this carries its own selector rather than forcing the
 * operator to open a provider's edit dialog to reach its SLA rows.
 */

import { useEffect, useState } from "react";
import { SlaDeadlinesPanel } from "./SlaDeadlinesPanel";

type Lab = { labId: number; labName: string; isActive: boolean; integrationType: "API" | "NON_API" };

export function SlaDeadlinesSection() {
  const [labs, setLabs] = useState<Lab[]>([]);
  const [labId, setLabId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/non-api-labs")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const loaded: Lab[] = data.labs ?? [];
        setLabs(loaded);
        setLabId((current) => current ?? loaded.find((lab) => lab.isActive)?.labId ?? loaded[0]?.labId ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const lab = labs.find((item) => item.labId === labId) ?? null;
  if (!lab) return null;

  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-zinc-500">SLA deadlines for</label>
        <select
          value={labId ?? ""}
          onChange={(event) => setLabId(Number(event.target.value))}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
        >
          {labs.map((item) => (
            <option key={item.labId} value={item.labId}>
              {item.labName} ({item.integrationType})
            </option>
          ))}
        </select>
        <span className="text-[11px] text-zinc-600">
          Milestone chasing works the same for API and non-API providers.
        </span>
      </div>
      <SlaDeadlinesPanel key={lab.labId} labId={lab.labId} labName={lab.labName} />
    </div>
  );
}
