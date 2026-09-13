"use client";

import { useCallback, useEffect, useState } from "react";

type Rule = {
  id: string; name: string; isActive: boolean; anchor: "ORDER" | "APPOINTMENT";
  action: "SEND_REMINDER" | "ESCALATE"; offsetMinutes: number; priority: number;
  recipient: "LAB" | "MANAGER"; templateKey: string; templateName?: string | null;
  sendCondition?: SendCondition; totalMessagesSent?: number;
};
type Template = { key: string; name: string; isActive: boolean };
type SendCondition = { workflowStatusIn?: string[]; requireAppointment?: boolean; minMinutesSinceLastMessage?: number; skipWithinMinutesOfAppointment?: number };
type Tab = "trigger" | "basics" | "message";

type Draft = {
  name: string; anchor: Rule["anchor"]; action: Rule["action"]; offsetMinutes: string; priority: string;
  recipient: Rule["recipient"]; templateKey: string; workflowStatusIn: string[]; requireAppointment: boolean;
  minMinutesSinceLastMessage: string; skipWithinMinutesOfAppointment: string;
};

const EMPTY_DRAFT: Draft = { name: "", anchor: "ORDER", action: "SEND_REMINDER", offsetMinutes: "60", priority: "3", recipient: "LAB", templateKey: "", workflowStatusIn: [], requireAppointment: false, minMinutesSinceLastMessage: "", skipWithinMinutesOfAppointment: "" };
const WORKFLOW_STATUSES = ["WAITING_FOR_LAB_CONFIRMATION", "ESCALATED", "LAB_ACCEPTED", "LAB_RESCHEDULE_REQUESTED", "LAB_REJECTED"];
const inputClass = "w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500";

function Field({ label, children, required = false }: { label: string; children: React.ReactNode; required?: boolean }) {
  return <label className="block"><span className="block text-xs text-zinc-400 mb-1.5 font-medium">{label} {required && <span className="text-red-400">*</span>}</span>{children}</label>;
}
function offsetLabel(anchor: Rule["anchor"], value: number) {
  const amount = Math.abs(value); const unit = amount >= 60 ? `${Math.round(amount / 60)}h` : `${amount}m`;
  return anchor === "APPOINTMENT" ? `${value <= 0 ? `${unit} before` : `${unit} after`} appointment` : `${unit} after order detected`;
}

export function ProviderCommunicationRulesPanel() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [tab, setTab] = useState<Tab>("trigger");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesResponse, templatesResponse] = await Promise.all([fetch("/api/provider-communication-rules"), fetch("/api/non-api-labs/templates")]);
      const [rulesData, templatesData] = await Promise.all([rulesResponse.json(), templatesResponse.json()]);
      if (!rulesResponse.ok) throw new Error(rulesData.error ?? "Could not load provider rules");
      setRules(rulesData.rules ?? []); setTemplates((templatesData.templates ?? []).filter((item: Template) => item.isActive));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load provider rules"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function openCreate() { setEditing(null); setDraft({ ...EMPTY_DRAFT, templateKey: templates[0]?.key ?? "" }); setTab("trigger"); setError(null); setConfirmDelete(false); setOpen(true); }
  function openEdit(rule: Rule) {
    const condition = rule.sendCondition ?? {};
    setEditing(rule); setDraft({ ...EMPTY_DRAFT, name: rule.name, anchor: rule.anchor, action: rule.action, offsetMinutes: String(rule.offsetMinutes), priority: String(rule.priority), recipient: rule.recipient, templateKey: rule.templateKey, workflowStatusIn: condition.workflowStatusIn ?? [], requireAppointment: condition.requireAppointment ?? false, minMinutesSinceLastMessage: condition.minMinutesSinceLastMessage === undefined ? "" : String(condition.minMinutesSinceLastMessage), skipWithinMinutesOfAppointment: condition.skipWithinMinutesOfAppointment === undefined ? "" : String(condition.skipWithinMinutesOfAppointment) });
    setTab("trigger"); setError(null); setConfirmDelete(false); setOpen(true);
  }
  function toggleStatus(status: string) { setDraft((current) => ({ ...current, workflowStatusIn: current.workflowStatusIn.includes(status) ? current.workflowStatusIn.filter((item) => item !== status) : [...current.workflowStatusIn, status] })); }

  async function save(isDraft = false) {
    if (!draft.name.trim()) { setError("Rule name is required."); setTab("basics"); return; }
    if (!draft.templateKey) { setError("Choose a message template."); setTab("message"); return; }
    setSaving(true); setError(null);
    const sendCondition: SendCondition = {
      ...(draft.workflowStatusIn.length ? { workflowStatusIn: draft.workflowStatusIn } : {}),
      ...(draft.requireAppointment ? { requireAppointment: true } : {}),
      ...(draft.minMinutesSinceLastMessage ? { minMinutesSinceLastMessage: Number(draft.minMinutesSinceLastMessage) } : {}),
      ...(draft.skipWithinMinutesOfAppointment ? { skipWithinMinutesOfAppointment: Number(draft.skipWithinMinutesOfAppointment) } : {}),
    };
    const payload = { name: draft.name, anchor: draft.anchor, action: draft.action, offsetMinutes: Number(draft.offsetMinutes), priority: Number(draft.priority), recipient: draft.recipient, templateKey: draft.templateKey, allowedLabIds: [], allowedOrderTypes: [], sendCondition, isDraft };
    const response = await fetch(editing ? `/api/provider-communication-rules/${editing.id}` : "/api/provider-communication-rules", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({})); setSaving(false);
    if (!response.ok) { setError(data.error ?? "Could not save rule"); return; }
    setOpen(false); await load();
  }
  async function toggle(rule: Rule) { await fetch(`/api/provider-communication-rules/${rule.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !rule.isActive }) }); await load(); }
  async function remove() { if (!editing) return; setSaving(true); await fetch(`/api/provider-communication-rules/${editing.id}`, { method: "DELETE" }); setSaving(false); setOpen(false); await load(); }

  const triggerReady = draft.offsetMinutes !== "";
  const activeCount = rules.filter((rule) => rule.isActive).length;
  const tabs: Array<{ key: Tab; label: string }> = [{ key: "trigger", label: "Trigger" }, { key: "basics", label: "Basics" }, { key: "message", label: "Message" }];

  return <section className="mt-6 rounded-xl border border-zinc-800 overflow-hidden">
    <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3"><div><div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Provider communication rules</div><div className="mt-0.5 text-xs text-zinc-500">{activeCount} of {rules.length} global rules active - applied to every provider lab</div></div><div className="flex gap-2"><button onClick={() => void load()} className="px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-xs text-zinc-400 hover:text-zinc-200">↻ Refresh</button><button onClick={openCreate} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg">＋ New Rule</button></div></div>
    {loading ? <div className="p-10 text-center text-sm text-zinc-500">Loading communication rules...</div> : rules.length === 0 ? <div className="flex flex-col items-center justify-center py-20 text-center"><div className="text-3xl text-zinc-800 mb-3">⚙</div><p className="text-sm text-zinc-600 font-medium">No provider rules yet</p><button onClick={openCreate} className="mt-3 text-xs text-blue-400 hover:text-blue-300">Create your first rule →</button></div> : <div className="space-y-2 p-3">{rules.map((rule) => <div key={rule.id} className={`flex items-center gap-3 bg-zinc-900 border rounded-xl px-4 py-3 ${rule.isActive ? "border-zinc-700" : "border-zinc-800 opacity-60"}`}><button onClick={() => void toggle(rule)} className={`relative shrink-0 w-9 h-5 rounded-full ${rule.isActive ? "bg-blue-600" : "bg-zinc-700"}`} title={rule.isActive ? "Disable" : "Enable"}><span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${rule.isActive ? "translate-x-4" : "translate-x-0.5"}`} /></button><div className="flex-1 min-w-0"><div className="flex items-center gap-2 flex-wrap"><span className="text-xs font-medium text-zinc-200">{rule.name}</span><span className="text-[10px] text-blue-300 bg-blue-600/10 border border-blue-700/40 px-1.5 py-0.5 rounded-full">All provider labs</span></div><div className="mt-1 text-[11px] text-zinc-500">{offsetLabel(rule.anchor, rule.offsetMinutes)} · {rule.action === "ESCALATE" ? "Escalation" : "Reminder"} · P{rule.priority} · {rule.totalMessagesSent ?? 0} sent</div></div><button onClick={() => openEdit(rule)} className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800" title="Edit rule">✎</button><button onClick={() => { openEdit(rule); setConfirmDelete(true); }} className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-zinc-800" title="Delete rule">⌫</button></div>)}</div>}
    {error && !open && <div className="border-t border-rose-900/50 bg-rose-950/20 px-4 py-2 text-xs text-rose-300">{error}</div>}
    {open && <div className="fixed inset-0 z-50 flex justify-end"><div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)} /><div className="relative w-full max-w-lg bg-zinc-900 border-l border-zinc-800 h-full flex flex-col shadow-2xl overflow-hidden"><div className="px-6 pt-5 pb-0 border-b border-zinc-800"><div className="flex items-center justify-between mb-4"><div><h2 className="text-sm font-semibold text-white">{editing ? "Edit Provider Rule" : "Create Provider Rule"}</h2>{editing && <p className="text-[10px] text-zinc-600 mt-0.5 font-mono">{editing.id}</p>}</div><button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800">×</button></div><div className="flex gap-0">{tabs.map((item) => { const locked = item.key !== "trigger" && !triggerReady; return <button key={item.key} type="button" disabled={locked} onClick={() => !locked && setTab(item.key)} className={`px-5 py-2 text-xs font-medium border-b-2 ${tab === item.key ? "border-blue-500 text-blue-400" : locked ? "border-transparent text-zinc-700 cursor-not-allowed" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>{item.label}{locked && <span className="ml-1">🔒</span>}</button>; })}</div></div><form id="provider-rule-form" onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex-1 overflow-y-auto"><div className="px-6 py-5 space-y-5">{tab === "trigger" && <><div className="flex items-start gap-3 px-3 py-3 bg-blue-600/10 border border-blue-700/30 rounded-lg"><span className="text-blue-400">ⓘ</span><p className="text-[11px] text-blue-300 leading-relaxed">Start by defining when this global rule should contact every provider lab.</p></div><Field label="Clock anchor" required><select value={draft.anchor} onChange={(event) => setDraft({ ...draft, anchor: event.target.value as Rule["anchor"] })} className={inputClass}><option value="ORDER">Order clock - after order is detected</option><option value="APPOINTMENT">Appointment clock - relative to appointment</option></select></Field><Field label="Action" required><select value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value as Rule["action"] })} className={inputClass}><option value="SEND_REMINDER">Send provider reminder</option><option value="ESCALATE">Escalate provider communication</option></select></Field><Field label="Timing condition" required><input type="number" value={draft.offsetMinutes} onChange={(event) => setDraft({ ...draft, offsetMinutes: event.target.value })} className={inputClass} /><p className="mt-1.5 text-[10px] text-zinc-500">{draft.anchor === "APPOINTMENT" ? "Use zero or a negative value: -120 means two hours before appointment." : "Use a positive value: 60 means one hour after order detection."}</p></Field><div className="border-t border-zinc-800 pt-4"><div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Send only when</div><div className="space-y-2">{WORKFLOW_STATUSES.map((status) => <label key={status} className="flex items-center gap-2 text-xs text-zinc-400"><input type="checkbox" checked={draft.workflowStatusIn.includes(status)} onChange={() => toggleStatus(status)} className="accent-blue-500" />{status}</label>)}<label className="flex items-center gap-2 text-xs text-zinc-400"><input type="checkbox" checked={draft.requireAppointment} onChange={(event) => setDraft({ ...draft, requireAppointment: event.target.checked })} className="accent-blue-500" />Only orders with an appointment</label></div></div></>}{tab === "basics" && <><Field label="Rule name" required><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Urgent provider confirmation" className={inputClass} /></Field><Field label="Priority" required><select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })} className={inputClass}><option value="0">P0 - Immediate</option><option value="1">P1 - Critical</option><option value="2">P2 - High</option><option value="3">P3 - Normal</option><option value="4">P4 - Low</option></select></Field><Field label="Recipient" required><select value={draft.recipient} onChange={(event) => setDraft({ ...draft, recipient: event.target.value as Rule["recipient"] })} className={inputClass}><option value="LAB">Provider lab</option><option value="MANAGER">Lab manager</option></select></Field><div className="border-t border-zinc-800 pt-4"><div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Additional timing controls</div><div className="grid grid-cols-2 gap-3"><Field label="Minimum gap (minutes)"><input type="number" min="0" value={draft.minMinutesSinceLastMessage} onChange={(event) => setDraft({ ...draft, minMinutesSinceLastMessage: event.target.value })} placeholder="No minimum" className={inputClass} /></Field><Field label="Skip before appointment"><input type="number" min="0" value={draft.skipWithinMinutesOfAppointment} onChange={(event) => setDraft({ ...draft, skipWithinMinutesOfAppointment: event.target.value })} placeholder="No skip window" className={inputClass} /></Field></div></div></>}{tab === "message" && <><Field label="Message template" required><select value={draft.templateKey} onChange={(event) => setDraft({ ...draft, templateKey: event.target.value })} className={inputClass}><option value="">— Select a message template —</option>{templates.map((template) => <option key={template.key} value={template.key}>{template.name}</option>)}</select></Field><div className="rounded-lg bg-zinc-800/50 border border-zinc-700 p-3 text-[11px] text-zinc-400 leading-5">The selected template is rendered with order, appointment, lab, and secure action-link variables before WhatsApp queues the message.</div></>}</div></form><div className="px-6 py-4 border-t border-zinc-800 flex items-center gap-2">{editing && <div className="mr-auto">{confirmDelete ? <div className="flex items-center gap-2"><button type="button" onClick={() => void remove()} disabled={saving} className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg">Confirm Delete</button><button type="button" onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button></div> : <button type="button" onClick={() => setConfirmDelete(true)} className="text-xs text-zinc-600 hover:text-red-400">Delete Rule</button>}</div>}{error && <p className="text-xs text-red-400 flex-1">{error}</p>}<button type="button" onClick={() => setOpen(false)} className="px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button><button type="button" onClick={() => setTab("trigger")} className="px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-300 text-xs font-medium rounded-lg">▶ Simulate</button>{!editing && <button type="button" onClick={() => void save(true)} disabled={saving} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg">Save as Draft</button>}<button type="submit" form="provider-rule-form" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg disabled:opacity-50">{saving ? "Saving..." : editing ? "Save Changes" : "Create Rule"}</button></div></div></div>}
  </section>;
}
