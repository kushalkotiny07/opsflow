"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type LabConfig = {
  labId: number;
  labName: string;
  integrationType: "API" | "NON_API";
  waGroupJid: string | null;
  whatsappNumber: string | null;
  managerName: string | null;
  managerWhatsapp: string | null;
  isActive: boolean;
  confirmationSlaMinutes: number;
  reminderSlaMinutes: number;
  escalationSlaMinutes: number;
  initialTemplateKey: string;
  reminderTemplateKey: string;
  escalationTemplateKey: string;
  appointmentTemplateKey: string;
  appointmentRemindersEnabled: boolean;
  quietWindowMinutes: number;
  slaBreachAlertsEnabled: boolean;
  slaBreachMaxPerOrder: number;
};

type Draft = {
  labId: string;
  labName: string;
  integrationType: "API" | "NON_API";
  waGroupJid: string;
  whatsappNumber: string;
  isActive: boolean;
  confirmationSlaMinutes: string;
  reminderSlaMinutes: string;
  escalationSlaMinutes: string;
  initialTemplateKey: string;
  reminderTemplateKey: string;
  escalationTemplateKey: string;
  appointmentTemplateKey: string;
  appointmentRemindersEnabled: boolean;
  quietWindowMinutes: string;
  slaBreachAlertsEnabled: boolean;
  slaBreachMaxPerOrder: string;
};

const EMPTY_DRAFT: Draft = {
  labId: "", labName: "", integrationType: "NON_API", waGroupJid: "", whatsappNumber: "", isActive: true,
  confirmationSlaMinutes: "60", reminderSlaMinutes: "180", escalationSlaMinutes: "300",
  initialTemplateKey: "NON_API_NEW_ORDER", reminderTemplateKey: "NON_API_REMINDER", escalationTemplateKey: "NON_API_ESCALATION",
  appointmentTemplateKey: "NON_API_APPOINTMENT_REMINDER", appointmentRemindersEnabled: true, quietWindowMinutes: "10",
  slaBreachAlertsEnabled: true, slaBreachMaxPerOrder: "2",
};

const TEMPLATE_OPTIONS = [
  { key: "NON_API_NEW_ORDER", label: "New order" },
  { key: "NON_API_REMINDER", label: "Reminder" },
  { key: "NON_API_ESCALATION", label: "Escalation" },
  { key: "NON_API_APPOINTMENT_REMINDER", label: "Appointment reminder" },
];

function toDraft(lab: LabConfig): Draft {
  return {
    labId: String(lab.labId), labName: lab.labName, integrationType: lab.integrationType ?? "NON_API",
    waGroupJid: lab.waGroupJid ?? "",
    whatsappNumber: lab.whatsappNumber ?? "", isActive: lab.isActive,
    confirmationSlaMinutes: String(lab.confirmationSlaMinutes), reminderSlaMinutes: String(lab.reminderSlaMinutes), escalationSlaMinutes: String(lab.escalationSlaMinutes),
    initialTemplateKey: lab.initialTemplateKey, reminderTemplateKey: lab.reminderTemplateKey, escalationTemplateKey: lab.escalationTemplateKey,
    appointmentTemplateKey: lab.appointmentTemplateKey ?? "NON_API_APPOINTMENT_REMINDER",
    appointmentRemindersEnabled: lab.appointmentRemindersEnabled ?? true,
    quietWindowMinutes: String(lab.quietWindowMinutes ?? 10),
    slaBreachAlertsEnabled: lab.slaBreachAlertsEnabled ?? true,
    slaBreachMaxPerOrder: String(lab.slaBreachMaxPerOrder ?? 2),
  };
}

async function requestLabs() {
  const response = await fetch("/api/non-api-labs");
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export function NonApiLabConfigPanel() {
  const [labs, setLabs] = useState<LabConfig[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingLabId, setEditingLabId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2400); };
  const load = useCallback(async () => {
    try {
      const { response, data } = await requestLabs();
      if (response.ok) setLabs(data.labs ?? []);
      else setError(data.error ?? "Could not load lab configuration");
    } catch {
      setError("Could not load lab configuration");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void requestLabs().then(({ response, data }) => {
      if (cancelled) return;
      if (response.ok) setLabs(data.labs ?? []);
      else setError(data.error ?? "Could not load lab configuration");
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { setError("Could not load lab configuration"); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  function addLab() {
    setEditingLabId(null); setDraft(EMPTY_DRAFT); setError(null); setOpen(true);
  }

  function editLab(lab: LabConfig) {
    setEditingLabId(lab.labId); setDraft(toDraft(lab)); setError(null); setOpen(true);
  }

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    const payload = {
      labId: Number(draft.labId), labName: draft.labName, integrationType: draft.integrationType,
      waGroupJid: draft.waGroupJid || null, whatsappNumber: draft.whatsappNumber || null,
      isActive: draft.isActive,
      confirmationSlaMinutes: Number(draft.confirmationSlaMinutes), reminderSlaMinutes: Number(draft.reminderSlaMinutes), escalationSlaMinutes: Number(draft.escalationSlaMinutes),
      initialTemplateKey: draft.initialTemplateKey, reminderTemplateKey: draft.reminderTemplateKey, escalationTemplateKey: draft.escalationTemplateKey,
      appointmentTemplateKey: draft.appointmentTemplateKey,
      appointmentRemindersEnabled: draft.appointmentRemindersEnabled,
      quietWindowMinutes: Number(draft.quietWindowMinutes),
      slaBreachAlertsEnabled: draft.slaBreachAlertsEnabled,
      slaBreachMaxPerOrder: Number(draft.slaBreachMaxPerOrder),
    };
    const response = await fetch(editingLabId ? `/api/non-api-labs/${editingLabId}` : "/api/non-api-labs", {
      method: editingLabId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) {
      const details = data.details ? Object.values(data.details).join(" · ") : null;
      setError(details || data.error || "Could not save configuration");
      return;
    }
    setOpen(false); flash(editingLabId ? "Provider configuration updated" : "Provider configured"); load();
  }

  async function toggleActive(lab: LabConfig) {
    const response = await fetch(`/api/non-api-labs/${lab.labId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !lab.isActive }),
    });
    if (!response.ok) return flash("Could not update lab status");
    setLabs((current) => current.map((item) => item.labId === lab.labId ? { ...item, isActive: !item.isActive } : item));
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="text-xs text-zinc-500 mb-1">Settings / Integrations</div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Provider communication</h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-2xl">Configure how OpsFlow talks to external labs over WhatsApp. Every lab can be told when one of its orders breaches an SLA; labs that are not API-integrated also get the order confirmation workflow. LabStack remains the source of truth for orders and lab records.</p>
        </div>
        <button onClick={addLab} className="shrink-0 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2">+ Configure lab</button>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-5 max-md:grid-cols-2">
        <Metric label="Configured labs" value={labs.length} />
        <Metric label="Active automation" value={labs.filter((lab) => lab.isActive).length} tone="text-emerald-400" />
        <Metric label="Breach alerts on" value={labs.filter((lab) => lab.isActive && lab.slaBreachAlertsEnabled).length} tone="text-emerald-400" />
        <Metric label="Missing WhatsApp target" value={labs.filter((lab) => !lab.waGroupJid && !lab.whatsappNumber).length} tone={labs.some((lab) => !lab.waGroupJid && !lab.whatsappNumber) ? "text-amber-400" : "text-zinc-100"} />
      </div>

      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Lab communication policy</div>
          <span className="text-xs text-zinc-500 ml-auto">Breach alerts apply to every active lab. The confirmation workflow runs for NON_API labs only.</span>
        </div>
        {loading ? <div className="p-10 text-center text-sm text-zinc-500">Loading lab configuration…</div> : labs.length === 0 ? (
          <div className="p-10 text-center"><p className="text-sm text-zinc-400">No provider configurations yet.</p><button onClick={addLab} className="mt-3 text-sm text-blue-400 hover:text-blue-300">Configure the first provider</button></div>
        ) : <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="bg-zinc-950/70"><tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800"><th className="px-4 py-2.5">Lab</th><th className="px-3 py-2.5">WhatsApp target</th><th className="px-3 py-2.5">Sends</th><th className="px-3 py-2.5">Automation</th><th className="px-4 py-2.5 text-right">Actions</th></tr></thead>
          <tbody>{labs.map((lab) => <tr key={lab.labId} className="border-b border-zinc-800/60 hover:bg-zinc-900/40"><td className="px-4 py-3"><div className="font-medium text-zinc-100">{lab.labName}</div><div className="font-mono text-[11px] text-zinc-500">Lab #{lab.labId} · {lab.integrationType}</div></td><td className="px-3 py-3">{lab.waGroupJid ? <><div className="text-zinc-300">Group</div><div className="font-mono text-[11px] text-zinc-500 break-all">{lab.waGroupJid}</div></> : lab.whatsappNumber ? <><div className="text-zinc-300">Direct</div><div className="font-mono text-[11px] text-zinc-500">{lab.whatsappNumber}</div></> : <span className="text-amber-400">Missing</span>}</td><td className="px-3 py-3 text-xs"><div className="flex flex-col gap-1"><span className={lab.slaBreachAlertsEnabled ? "text-emerald-400" : "text-zinc-600"}>{lab.slaBreachAlertsEnabled ? `SLA breach alerts · max ${lab.slaBreachMaxPerOrder}/order` : "No breach alerts"}</span>{lab.integrationType === "NON_API" ? <span className="text-zinc-400">Confirmation · {lab.confirmationSlaMinutes}m / {lab.reminderSlaMinutes}m / {lab.escalationSlaMinutes}m</span> : <span className="text-zinc-600">No confirmation workflow (API lab)</span>}</div></td><td className="px-3 py-3"><button onClick={() => toggleActive(lab)} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${lab.isActive ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-800 text-zinc-500"}`}>{lab.isActive ? "Active" : "Paused"}</button></td><td className="px-4 py-3 text-right"><button onClick={() => editLab(lab)} className="text-xs text-blue-400 hover:text-blue-300 font-medium">Edit</button></td></tr>)}</tbody>
        </table></div>}
      </div>

      {open && <div className="fixed inset-0 z-50 bg-black/65 p-4 overflow-y-auto"><div className="max-w-xl mx-auto my-8 rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl"><form onSubmit={save}><div className="px-5 py-4 border-b border-zinc-800 flex justify-between items-center"><div><h2 className="font-semibold text-zinc-100">{editingLabId ? "Edit lab" : "Configure a lab"}</h2><p className="text-xs text-zinc-500 mt-0.5">This never modifies LabStack&apos;s source lab record.</p></div><button type="button" onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-200">✕</button></div><div className="p-5 space-y-4"><div className="grid grid-cols-3 gap-3"><Field label="Lab ID"><input required disabled={editingLabId !== null} type="number" min="1" value={draft.labId} onChange={(e) => update("labId", e.target.value)} className={inputClass} /></Field><div className="col-span-2"><Field label="Lab name"><input required value={draft.labName} onChange={(e) => update("labName", e.target.value)} className={inputClass} /></Field></div></div><div>
                <div className="text-xs font-medium text-zinc-300 mb-2">How does this lab receive orders?</div>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { value: "NON_API", title: "Over WhatsApp", detail: "Gets the confirmation workflow and breach alerts." },
                    { value: "API", title: "Through the API", detail: "Breach alerts only — it already has the order." },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => update("integrationType", option.value)}
                      className={`rounded-lg border px-3 py-2.5 text-left transition ${draft.integrationType === option.value ? "border-blue-500 bg-blue-500/10" : "border-zinc-700 hover:border-zinc-600"}`}
                    >
                      <div className={`text-sm font-medium ${draft.integrationType === option.value ? "text-blue-300" : "text-zinc-200"}`}>{option.title}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">{option.detail}</div>
                    </button>
                  ))}
                </div>
              </div><Field label="WhatsApp group id"><input value={draft.waGroupJid} onChange={(e) => update("waGroupJid", e.target.value)} placeholder="120363000000000000@g.us" className={inputClass} /></Field><p className="text-[11px] text-zinc-500 -mt-2">The provider&apos;s ops group, so a reply is visible to their whole desk. Required for API labs too — that is where breach alerts go. Sending stays off until the group is enabled under Settings → WhatsApp.</p><Field label="Lab WhatsApp number (fallback, used only without a group)"><input value={draft.whatsappNumber} onChange={(e) => update("whatsappNumber", e.target.value)} placeholder="+9198…" className={inputClass} /></Field><div className={draft.integrationType === "API" ? "opacity-40" : undefined}><div className="text-xs font-medium text-zinc-300 mb-2">Confirmation workflow {draft.integrationType === "API" && <span className="font-normal text-zinc-500">— not used: this lab receives orders through the API</span>}</div><div className="text-[11px] text-zinc-500 mb-2">SLA (minutes)</div><div className="grid grid-cols-3 gap-3"><Field label="Confirm"><input required type="number" min="1" value={draft.confirmationSlaMinutes} onChange={(e) => update("confirmationSlaMinutes", e.target.value)} className={inputClass} /></Field><Field label="Reminder"><input required type="number" min="1" value={draft.reminderSlaMinutes} onChange={(e) => update("reminderSlaMinutes", e.target.value)} className={inputClass} /></Field><Field label="Escalate"><input required type="number" min="1" value={draft.escalationSlaMinutes} onChange={(e) => update("escalationSlaMinutes", e.target.value)} className={inputClass} /></Field></div><p className="text-[11px] text-zinc-500 mt-1.5">Must progress from confirmation → reminder → escalation. No reminder is ever scheduled after the appointment.</p></div><div className={draft.integrationType === "API" ? "opacity-40" : undefined}><div className="text-xs font-medium text-zinc-300 mb-2">Appointment clock</div><label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={draft.appointmentRemindersEnabled} onChange={(e) => update("appointmentRemindersEnabled", e.target.checked)} className="accent-blue-500" /> Chase unconfirmed orders as the appointment approaches (T‑24h, T‑2h, T‑30m, T‑10m)</label><div className="mt-3 max-w-[12rem]"><Field label="Quiet window (minutes)"><input required type="number" min="0" max="240" value={draft.quietWindowMinutes} onChange={(e) => update("quietWindowMinutes", e.target.value)} className={inputClass} /></Field></div><p className="text-[11px] text-zinc-500 mt-1.5">Minimum gap between two confirmation messages about one order, across both clocks. Only a T‑10m reminder may break it. Breach alerts use the per-order cap below instead.</p></div><div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="text-xs font-medium text-zinc-300 mb-2">SLA breach alerts <span className="font-normal text-emerald-400/80">— applies to every lab</span></div>
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input type="checkbox" checked={draft.slaBreachAlertsEnabled} onChange={(e) => update("slaBreachAlertsEnabled", e.target.checked)} className="accent-blue-500" />
                  Message this lab when one of its orders breaches an OpsFlow SLA
                </label>
                <div className="mt-3 max-w-[12rem]">
                  <Field label="Max alerts per order"><input required type="number" min="1" max="20" value={draft.slaBreachMaxPerOrder} onChange={(e) => update("slaBreachMaxPerOrder", e.target.value)} className={inputClass} /></Field>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1.5">One order can breach several task rules in a row. Further breaches are still recorded — this only caps how many reach the provider.</p>
              </div><label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={draft.isActive} onChange={(e) => update("isActive", e.target.checked)} className="accent-blue-500" /> Enable automation for this lab</label>{error && <div className="rounded-md bg-rose-500/10 text-rose-300 text-sm px-3 py-2">{error}</div>}</div><div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button><button disabled={saving} className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold text-sm px-4 py-2">{saving ? "Saving…" : "Save configuration"}</button></div></form></div></div>}
      {toast && <div className="fixed z-[60] left-1/2 bottom-6 -translate-x-1/2 rounded-lg bg-zinc-100 text-zinc-950 px-4 py-2 text-sm font-medium shadow-lg">{toast}</div>}
    </div>
  );
}

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 disabled:opacity-50";
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="block text-xs text-zinc-400 mb-1">{label}</span>{children}</label>; }
function Metric({ label, value, tone = "text-zinc-100" }: { label: string; value: number; tone?: string }) { return <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3"><div className="text-xs text-zinc-500">{label}</div><div className={`text-2xl font-semibold mt-1 ${tone}`}>{value}</div></div>; }
