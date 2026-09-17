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

type LabConfig = { isActive: boolean; integrationType: "API" | "NON_API"; waGroupJid: string | null; whatsappNumber: string | null };
type Lab = { labId: number; labName: string; configured: boolean; config: LabConfig | null };

/** Same priority as the table above: NON_API, then candidates, then API. */
function focusRank(lab: Lab) {
  if (lab.config?.integrationType === "API") return 2;
  if (lab.configured) return 0;
  return 1;
}

/**
 * Can a deadline set here actually reach this lab?
 *
 * Milestone rows may be stored for ANY lab id, but breach-engine only sends to
 * a lab whose config is active and has a WhatsApp target. Without this the
 * picker would happily let someone tune deadlines for a lab that can never be
 * messaged, and nothing would say why nothing happened.
 */
function canReceive(lab: Lab) {
  return !!lab.config?.isActive && !!(lab.config.waGroupJid || lab.config.whatsappNumber);
}

export function SlaDeadlinesSection() {
  const [labs, setLabs] = useState<Lab[]>([]);
  const [labId, setLabId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The full LabStack roster, not just configured labs — otherwise a lab the
    // operator can see in the table above is missing from this picker.
    void fetch("/api/non-api-labs/catalog")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const loaded: Lab[] = data.labs ?? [];
        setLabs(loaded);
        // Default to a lab that can actually be messaged.
        setLabId((current) =>
          current
          ?? loaded.find((l) => canReceive(l) && l.config?.integrationType === "NON_API")?.labId
          ?? loaded.find(canReceive)?.labId
          ?? loaded[0]?.labId
          ?? null);
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
          {[...labs].sort((a, b) => focusRank(a) - focusRank(b) || a.labName.localeCompare(b.labName)).map((item) => (
            <option key={item.labId} value={item.labId}>
              {item.labName}
              {item.config ? ` (${item.config.integrationType})` : ""}
              {!item.configured ? " — not configured" : !canReceive(item) ? " — paused" : ""}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-zinc-600">
          Milestone chasing works the same for API and non-API providers.
        </span>
      </div>
      {!canReceive(lab) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300/90">
          {lab.configured
            ? `${lab.labName} is paused or has no WhatsApp target, so these deadlines are saved but no breach message will be sent.`
            : `${lab.labName} has no provider configuration yet, so these deadlines are saved but no breach message will be sent. Configure it in the table above first.`}
        </div>
      )}
      <SlaDeadlinesPanel key={lab.labId} labId={lab.labId} labName={lab.labName} />
    </div>
  );
}
