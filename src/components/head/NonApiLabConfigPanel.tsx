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
  dailyDigestEnabled: boolean;
  dailyDigestHour: number;
  dailyDigestMinute: number;
  dailyDigestSkipWhenEmpty: boolean;
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
  dailyDigestEnabled: boolean;
  /** "HH:MM" — one <input type="time">, split into hour/minute on save. */
  dailyDigestAt: string;
  dailyDigestSkipWhenEmpty: boolean;
};

const EMPTY_DRAFT: Draft = {
  labId: "", labName: "", integrationType: "NON_API", waGroupJid: "", whatsappNumber: "", isActive: true,
  confirmationSlaMinutes: "60", reminderSlaMinutes: "180", escalationSlaMinutes: "300",
  initialTemplateKey: "NON_API_NEW_ORDER", reminderTemplateKey: "NON_API_REMINDER", escalationTemplateKey: "NON_API_ESCALATION",
  appointmentTemplateKey: "NON_API_APPOINTMENT_REMINDER", appointmentRemindersEnabled: true, quietWindowMinutes: "10",
  slaBreachAlertsEnabled: true, slaBreachMaxPerOrder: "2",
  dailyDigestEnabled: false, dailyDigestAt: "19:00", dailyDigestSkipWhenEmpty: true,
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
    dailyDigestEnabled: lab.dailyDigestEnabled ?? false,
    dailyDigestAt: `${String(lab.dailyDigestHour ?? 19).padStart(2, "0")}:${String(lab.dailyDigestMinute ?? 0).padStart(2, "0")}`,
    dailyDigestSkipWhenEmpty: lab.dailyDigestSkipWhenEmpty ?? true,
  };
}

async function requestLabs() {
  // The catalogue, not the configured list: every lab LabStack knows about,
  // so a lab nobody has configured yet is visible instead of absent.
  const response = await fetch("/api/non-api-labs/catalog");
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

/** One lab as LabStack knows it, plus our config for it when there is one. */
type CatalogRow = {
  labId: number;
  labName: string;
  city: string | null;
  sourceActive: boolean;
  openOrders: number;
  configured: boolean;
  orphaned?: boolean;
  config: LabConfig | null;
  /** Best guess at this lab's WhatsApp group, or null when nothing is convincing. */
  suggestedGroup: { jid: string; subject: string; score: number } | null;
  /** The stored jid matches no group the gateway has ever seen — almost always a typo. */
  unknownGroup?: boolean;
};

/** A WhatsApp group the gateway can actually see. */
type WaGroupOption = { jid: string; subject: string; sendEnabled: boolean; active: boolean; labId: number | null };

/** A lab is only "on" when it is configured AND switched on. */
const isLive = (row: CatalogRow) => !!row.config?.isActive;

/**
 * Ordering, by how much attention the lab deserves right now.
 *
 * NON_API labs are the focus: they are the ones running the confirmation
 * ladder, so they lead. An unconfigured lab comes next — it is a candidate,
 * and configuring one defaults it to NON_API. API labs sort last: they already
 * receive orders over the API and only ever get breach alerts, so there is far
 * less to tune and they would otherwise push the interesting rows down.
 */
function focusRank(row: CatalogRow) {
  if (row.config?.integrationType === "API") return 2;
  if (row.configured) return 0;
  return 1;
}

/** Name, id or city — whichever the person happens to remember. */
function matches(row: CatalogRow, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.labName.toLowerCase().includes(q)
    || String(row.labId) === q
    || (row.city ?? "").toLowerCase().includes(q);
}

export function NonApiLabConfigPanel() {
  const [labs, setLabs] = useState<CatalogRow[]>([]);
  const [groups, setGroups] = useState<WaGroupOption[]>([]);
  const [query, setQuery] = useState("");
  // Off by default: hiding rows by default is how a lab goes unnoticed. The
  // sort already puts NON_API first; this is for when you want only them.
  const [nonApiOnly, setNonApiOnly] = useState(false);
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
      if (response.ok) { setLabs(data.labs ?? []); setGroups(data.groups ?? []); }
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
      if (response.ok) { setLabs(data.labs ?? []); setGroups(data.groups ?? []); }
      else setError(data.error ?? "Could not load lab configuration");
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { setError("Could not load lab configuration"); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  /**
   * Open the editor for a lab from the catalogue.
   *
   * There is no "add" path any more. A lab that has never been configured is
   * still a real lab in LabStack, so its id and name are taken from there and
   * only the parts OpsFlow owns are editable.
   */
  function editLab(row: CatalogRow) {
    setEditingLabId(row.configured ? row.labId : null);
    setDraft(row.config
      ? toDraft(row.config)
      : {
          ...EMPTY_DRAFT,
          labId: String(row.labId),
          labName: row.labName,
          // Prefilled from the gateway's own group list, so the commonest case
          // needs no typing at all.
          waGroupJid: row.suggestedGroup?.jid ?? "",
        });
    setError(null);
    setOpen(true);
  }

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  // NON_API first, then unconfigured candidates, then API. Within a group the
  // live ones lead, so an active lab never hides below a paused one.
  const visible = labs
    .filter((row) => matches(row, query))
    .filter((row) => !nonApiOnly || row.config?.integrationType !== "API")
    .sort((a, b) =>
      focusRank(a) - focusRank(b)
      || Number(isLive(b)) - Number(isLive(a))
      || a.labName.localeCompare(b.labName));

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
      dailyDigestEnabled: draft.dailyDigestEnabled,
      // A blank time input must not save as 00:00 — that would move the digest
      // to midnight without anyone asking for it.
      dailyDigestHour: Number((draft.dailyDigestAt || "19:00").split(":")[0]),
      dailyDigestMinute: Number((draft.dailyDigestAt || "19:00").split(":")[1]),
      dailyDigestSkipWhenEmpty: draft.dailyDigestSkipWhenEmpty,
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

  /**
   * Flip a lab on or off.
   *
   * An unconfigured lab cannot simply be switched on: the validator requires a
   * WhatsApp group or number before a config can exist at all, and a lab that
   * is "active" with nowhere to send would fail silently every tick. So the
   * switch opens the editor instead of pretending to work.
   */
  /**
   * Set how a lab receives orders, straight from the table.
   *
   * The same choice lives in the edit dialog, but classifying a dozen labs one
   * modal at a time is the slow way round — and this is the field that decides
   * whether a lab gets the confirmation ladder at all, so it earns a place in
   * the row.
   *
   * PUT merges over the stored config and re-validates, so switching to
   * NON_API on a lab with no WhatsApp target is rejected by the same rule that
   * governs the dialog rather than by a second copy of it here.
   */
  async function setIntegration(row: CatalogRow, integrationType: "API" | "NON_API") {
    if (!row.configured || !row.config) {
      editLab(row);
      return;
    }
    if (row.config.integrationType === integrationType) return;

    const previous = row.config.integrationType;
    setLabs((current) => current.map((item) =>
      item.labId === row.labId && item.config ? { ...item, config: { ...item.config, integrationType } } : item));

    const response = await fetch(`/api/non-api-labs/${row.labId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ integrationType }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setLabs((current) => current.map((item) =>
        item.labId === row.labId && item.config ? { ...item, config: { ...item.config, integrationType: previous } } : item));
      const details = data.details ? Object.values(data.details).join(" · ") : null;
      return flash(details || data.error || "Could not change how this lab receives orders");
    }
    flash(integrationType === "NON_API"
      ? `${row.labName} now gets the confirmation ladder`
      : `${row.labName} set to API — breach alerts only`);
  }

  async function toggleActive(row: CatalogRow) {
    if (!row.configured || !row.config) {
      flash("Add a WhatsApp target first");
      editLab(row);
      return;
    }
    const next = !row.config.isActive;
    // Optimistic: the switch should move under the finger, not after a round trip.
    setLabs((current) => current.map((item) =>
      item.labId === row.labId && item.config ? { ...item, config: { ...item.config, isActive: next } } : item));

    const response = await fetch(`/api/non-api-labs/${row.labId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: next }),
    });
    if (!response.ok) {
      setLabs((current) => current.map((item) =>
        item.labId === row.labId && item.config ? { ...item, config: { ...item.config, isActive: !next } } : item));
      return flash("Could not update lab status");
    }
    flash(next ? `${row.labName} is now active` : `${row.labName} paused`);
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="text-xs text-zinc-500 mb-1">Settings / Integrations</div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Provider communication</h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-2xl">Configure how OpsFlow talks to external labs over WhatsApp. Every lab can be told when one of its orders breaches an SLA; labs that are not API-integrated also get the order confirmation workflow. LabStack remains the source of truth for orders and lab records.</p>
        </div>
        {/* No "add lab" button: the roster is whatever LabStack has. */}
        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNonApiOnly((v) => !v)}
            aria-pressed={nonApiOnly}
            title="API labs only ever get breach alerts — hide them to focus on the confirmation ladder"
            className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${
              nonApiOnly
                ? "border-blue-500 bg-blue-500/10 text-blue-300"
                : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Non-API only
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search labs…"
            className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-5 max-md:grid-cols-2">
        <Metric label="Labs in LabStack" value={labs.length} />
        {/* The number that matters: labs running the confirmation ladder. */}
        <Metric
          label="Non-API configured"
          value={labs.filter((lab) => lab.config?.integrationType === "NON_API").length}
        />
        <Metric
          label="Non-API active"
          value={labs.filter((lab) => lab.config?.integrationType === "NON_API" && isLive(lab)).length}
          tone="text-emerald-400"
        />
        <Metric
          label="Not configured"
          value={labs.filter((lab) => !lab.configured).length}
          tone={labs.some((lab) => !lab.configured) ? "text-amber-400" : "text-zinc-100"}
        />
      </div>

      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Lab communication policy</div>
          <span className="text-xs text-zinc-500 ml-auto">Breach alerts apply to every active lab. The confirmation workflow runs for NON_API labs only.</span>
        </div>
        {loading ? <div className="p-10 text-center text-sm text-zinc-500">Loading labs from LabStack…</div> : visible.length === 0 ? (
          <div className="p-10 text-center"><p className="text-sm text-zinc-400">{query ? `No lab matches “${query}”.` : "LabStack returned no labs."}</p></div>
        ) : <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="bg-zinc-950/70"><tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
            <th className="px-4 py-2.5">Lab</th>
            <th className="px-3 py-2.5">Open orders</th>
            <th className="px-3 py-2.5">Receives orders</th>
            <th className="px-3 py-2.5">WhatsApp target</th>
            <th className="px-3 py-2.5">Automation</th>
            <th className="px-3 py-2.5">Active</th>
            <th className="px-4 py-2.5 text-right">Config</th>
          </tr></thead>
          <tbody>{visible.map((row) => {
            const cfg = row.config;
            // API labs stay visible but recede: nothing here is tunable for
            // them beyond breach alerts, so they should not compete for the eye.
            const isApi = cfg?.integrationType === "API";
            return (
            <tr key={row.labId} className={`border-b border-zinc-800/60 hover:bg-zinc-900/40 ${isApi ? "opacity-60" : ""}`}>
              <td className="px-4 py-3">
                <div className="font-medium text-zinc-100">
                  {row.labName}
                  {cfg?.integrationType === "NON_API" && (
                    <span className="ml-2 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300 align-middle">NON-API</span>
                  )}
                </div>
                <div className="font-mono text-[11px] text-zinc-500">
                  Lab #{row.labId}{row.city ? ` · ${row.city}` : ""}
                  {row.orphaned && <span className="ml-1 text-amber-400">· not in LabStack</span>}
                  {!row.sourceActive && !row.orphaned && <span className="ml-1 text-zinc-600">· inactive upstream</span>}
                </div>
              </td>
              <td className="px-3 py-3 text-zinc-300">{row.openOrders}</td>
              <td className="px-3 py-3">
                <IntegrationPicker
                  value={cfg?.integrationType ?? null}
                  onPick={(next) => setIntegration(row, next)}
                  labName={row.labName}
                />
              </td>
              <td className="px-3 py-3">
                {cfg?.waGroupJid ? <><div className={`text-xs ${row.unknownGroup ? "text-amber-400" : "text-zinc-300"}`}>{row.unknownGroup ? "⚠ Unknown group" : "Group"}</div><div className="font-mono text-[11px] text-zinc-500 break-all">{groups.find((g) => g.jid === cfg.waGroupJid)?.subject ?? cfg.waGroupJid}</div></>
                  : cfg?.whatsappNumber ? <><div className="text-zinc-300 text-xs">Direct</div><div className="font-mono text-[11px] text-zinc-500">{cfg.whatsappNumber}</div></>
                  : <span className="text-xs text-amber-400">Not set</span>}
              </td>
              <td className="px-3 py-3 text-xs">
                {!cfg ? <span className="text-zinc-600">Not configured</span> : (
                  <div className="flex flex-col gap-1">
                    <span className={cfg.slaBreachAlertsEnabled ? "text-emerald-400" : "text-zinc-600"}>
                      {cfg.slaBreachAlertsEnabled ? `Breach alerts · max ${cfg.slaBreachMaxPerOrder}/order` : "No breach alerts"}
                    </span>
                    {cfg.integrationType === "NON_API"
                      ? <span className="text-zinc-400">Confirm · {cfg.confirmationSlaMinutes}m / {cfg.reminderSlaMinutes}m / {cfg.escalationSlaMinutes}m</span>
                      : <span className="text-zinc-600">No confirmation workflow</span>}
                    <span className={cfg.dailyDigestEnabled ? "text-emerald-400" : "text-zinc-600"}>
                      {cfg.dailyDigestEnabled
                        ? `Daily summary · ${String(cfg.dailyDigestHour).padStart(2, "0")}:${String(cfg.dailyDigestMinute).padStart(2, "0")}`
                        : "No daily summary"}
                    </span>
                  </div>
                )}
              </td>
              <td className="px-3 py-3"><Toggle on={isLive(row)} disabled={!row.configured} onClick={() => toggleActive(row)} label={row.labName} /></td>
              <td className="px-4 py-3 text-right">
                <button onClick={() => editLab(row)} className="text-xs font-medium text-blue-400 hover:text-blue-300">
                  {row.configured ? "Edit" : "Configure"}
                </button>
              </td>
            </tr>);
          })}</tbody>
        </table></div>}
      </div>

      {open && <div className="fixed inset-0 z-50 bg-black/65 p-4 overflow-y-auto"><div className="max-w-xl mx-auto my-8 rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl"><form onSubmit={save}><div className="px-5 py-4 border-b border-zinc-800 flex justify-between items-center"><div><h2 className="font-semibold text-zinc-100">{editingLabId ? "Edit lab" : "Configure a lab"}</h2><p className="text-xs text-zinc-500 mt-0.5">This never modifies LabStack&apos;s source lab record.</p></div><button type="button" onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-200">✕</button></div><div className="p-5 space-y-4"><div className="grid grid-cols-3 gap-3"><Field label="Lab ID"><input disabled type="number" value={draft.labId} className={inputClass} /></Field><div className="col-span-2"><Field label="Lab name"><input disabled value={draft.labName} className={inputClass} /></Field></div></div><p className="text-[11px] text-zinc-500 -mt-1">Both come from LabStack and are read-only here. Everything below is OpsFlow&apos;s own configuration.</p><div>
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
              </div><Field label="WhatsApp group"><select value={draft.waGroupJid} onChange={(e) => update("waGroupJid", e.target.value)} className={inputClass}>
                <option value="">— no group —</option>
                {!!draft.waGroupJid && !groups.some((g) => g.jid === draft.waGroupJid) && (
                  <option value={draft.waGroupJid}>⚠ {draft.waGroupJid} — not a group the gateway can see</option>
                )}
                {groups.map((g) => (
                  <option key={g.jid} value={g.jid}>
                    {g.subject || g.jid}{g.sendEnabled ? "" : " — sending off"}
                  </option>
                ))}
              </select></Field><p className="text-[11px] text-zinc-500 -mt-2">Picked from the {groups.length} groups the gateway can actually see, so the id is never typed. A group still needs sending switched on under Settings &rarr; WhatsApp before anything leaves.</p><p className="text-[11px] text-zinc-500 -mt-2">The provider&apos;s ops group, so a reply is visible to their whole desk. Required for API labs too — that is where breach alerts go. Sending stays off until the group is enabled under Settings → WhatsApp.</p><Field label="Lab WhatsApp number (fallback, used only without a group)"><input value={draft.whatsappNumber} onChange={(e) => update("whatsappNumber", e.target.value)} placeholder="+9198…" className={inputClass} /></Field><div className={draft.integrationType === "API" ? "opacity-40" : undefined}><div className="text-xs font-medium text-zinc-300 mb-2">Confirmation workflow {draft.integrationType === "API" && <span className="font-normal text-zinc-500">— not used: this lab receives orders through the API</span>}</div><div className="text-[11px] text-zinc-500 mb-2">SLA (minutes)</div><div className="grid grid-cols-3 gap-3"><Field label="Confirm"><input required type="number" min="1" value={draft.confirmationSlaMinutes} onChange={(e) => update("confirmationSlaMinutes", e.target.value)} className={inputClass} /></Field><Field label="Reminder"><input required type="number" min="1" value={draft.reminderSlaMinutes} onChange={(e) => update("reminderSlaMinutes", e.target.value)} className={inputClass} /></Field><Field label="Escalate"><input required type="number" min="1" value={draft.escalationSlaMinutes} onChange={(e) => update("escalationSlaMinutes", e.target.value)} className={inputClass} /></Field></div><p className="text-[11px] text-zinc-500 mt-1.5">Must progress from confirmation → reminder → escalation. No reminder is ever scheduled after the appointment.</p></div><div className={draft.integrationType === "API" ? "opacity-40" : undefined}><div className="text-xs font-medium text-zinc-300 mb-2">Appointment clock</div><label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={draft.appointmentRemindersEnabled} onChange={(e) => update("appointmentRemindersEnabled", e.target.checked)} className="accent-blue-500" /> Chase unconfirmed orders as the appointment approaches (T‑24h, T‑2h, T‑30m, T‑10m)</label><div className="mt-3 max-w-[12rem]"><Field label="Quiet window (minutes)"><input required type="number" min="0" max="240" value={draft.quietWindowMinutes} onChange={(e) => update("quietWindowMinutes", e.target.value)} className={inputClass} /></Field></div><p className="text-[11px] text-zinc-500 mt-1.5">Minimum gap between two confirmation messages about one order, across both clocks. Only a T‑10m reminder may break it. Breach alerts use the per-order cap below instead.</p></div><div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="text-xs font-medium text-zinc-300 mb-2">SLA breach alerts <span className="font-normal text-emerald-400/80">— applies to every lab</span></div>
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input type="checkbox" checked={draft.slaBreachAlertsEnabled} onChange={(e) => update("slaBreachAlertsEnabled", e.target.checked)} className="accent-blue-500" />
                  Message this lab when one of its orders breaches an OpsFlow SLA
                </label>
                <div className="mt-3 max-w-[12rem]">
                  <Field label="Max alerts per order"><input required type="number" min="1" max="20" value={draft.slaBreachMaxPerOrder} onChange={(e) => update("slaBreachMaxPerOrder", e.target.value)} className={inputClass} /></Field>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1.5">One order can breach several task rules in a row. Further breaches are still recorded — this only caps how many reach the provider.</p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="text-xs font-medium text-zinc-300 mb-2">Daily summary <span className="font-normal text-zinc-500">— one message a day</span></div>
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input type="checkbox" checked={draft.dailyDigestEnabled} onChange={(e) => update("dailyDigestEnabled", e.target.checked)} className="accent-blue-500" />
                  Send this lab a wrap-up of today and a preview of tomorrow
                </label>
                <div className="mt-3 max-w-[10rem]">
                  <Field label="Send at (local time)">
                    <input required type="time" value={draft.dailyDigestAt} onChange={(e) => update("dailyDigestAt", e.target.value)} className={inputClass} />
                  </Field>
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
                  <input type="checkbox" checked={draft.dailyDigestSkipWhenEmpty} onChange={(e) => update("dailyDigestSkipWhenEmpty", e.target.checked)} className="accent-blue-500" />
                  Stay quiet on days with no orders
                </label>
                <p className="text-[11px] text-zinc-500 mt-1.5">
                  Counts for today, then tomorrow&apos;s appointment list — the same numbers as the provider board, from the same query. Evening suits it: today is settled and tomorrow is still changeable. Wording lives in the <span className="text-zinc-400">Daily summary</span> template.
                </p>
              </div><label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={draft.isActive} onChange={(e) => update("isActive", e.target.checked)} className="accent-blue-500" /> Enable automation for this lab</label>{error && <div className="rounded-md bg-rose-500/10 text-rose-300 text-sm px-3 py-2">{error}</div>}</div><div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button><button disabled={saving} className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold text-sm px-4 py-2">{saving ? "Saving…" : "Save configuration"}</button></div></form></div></div>}
      {toast && <div className="fixed z-[60] left-1/2 bottom-6 -translate-x-1/2 rounded-lg bg-zinc-100 text-zinc-950 px-4 py-2 text-sm font-medium shadow-lg">{toast}</div>}
    </div>
  );
}

/**
 * How a lab receives orders, as a two-way choice in the row.
 *
 * This is the field that decides whether a lab gets the confirmation ladder,
 * so it is worth setting without opening a dialog. An unconfigured lab shows
 * "Set up" instead: there is no config to PATCH yet, and one cannot be created
 * without a WhatsApp target, so the click hands over to the editor.
 */
function IntegrationPicker({
  value,
  onPick,
  labName,
}: {
  value: "API" | "NON_API" | null;
  onPick: (next: "API" | "NON_API") => void;
  labName: string;
}) {
  if (!value) {
    return (
      <button
        type="button"
        onClick={() => onPick("NON_API")}
        className="rounded border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 hover:border-blue-500 hover:text-blue-300"
      >
        Set up
      </button>
    );
  }
  const options = [
    { key: "NON_API" as const, label: "WhatsApp", hint: `${labName} gets the confirmation ladder and breach alerts` },
    { key: "API" as const, label: "API", hint: `${labName} already receives orders over the API — breach alerts only` },
  ];
  return (
    <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden" role="group" aria-label={`How ${labName} receives orders`}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          title={option.hint}
          aria-pressed={value === option.key}
          onClick={() => onPick(option.key)}
          className={`px-2 py-1 text-[11px] font-medium transition ${
            value === option.key
              ? option.key === "NON_API"
                ? "bg-blue-500/15 text-blue-300"
                : "bg-zinc-700/60 text-zinc-200"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Active switch.
 *
 * Disabled until the lab is configured, because a lab with no WhatsApp target
 * cannot be activated — the config validator rejects it. Clicking the disabled
 * switch still opens the editor rather than doing nothing, which is why the
 * wrapper stays clickable and only the visual reads as inert.
 */
function Toggle({ on, disabled, onClick, label }: { on: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${on ? "Deactivate" : "Activate"} ${label}`}
      title={disabled ? "Configure a WhatsApp target first" : on ? "Active — click to pause" : "Paused — click to activate"}
      onClick={onClick}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
        on ? "bg-emerald-500" : disabled ? "bg-zinc-800" : "bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${on ? "translate-x-[1.15rem]" : "translate-x-1"} ${disabled ? "opacity-50" : ""}`}
      />
    </button>
  );
}

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 disabled:opacity-50";
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="block text-xs text-zinc-400 mb-1">{label}</span>{children}</label>; }
function Metric({ label, value, tone = "text-zinc-100" }: { label: string; value: number; tone?: string }) { return <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3"><div className="text-xs text-zinc-500">{label}</div><div className={`text-2xl font-semibold mt-1 ${tone}`}>{value}</div></div>; }
