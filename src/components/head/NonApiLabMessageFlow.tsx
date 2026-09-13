"use client";

/**
 * Provider message flow — a wireframe builder for what a lab gets, and when.
 *
 * Replaces the old template editor, which asked an operator to hand-type
 * `{{mustache}}` into a bare textarea (with a single-line input for a
 * multi-line body), and kept the follow-up path in a disconnected grid of
 * three dropdowns per lab. You could not see the sequence, could not see the
 * message, and only learned that `{{accept_url}}` was mandatory when the save
 * failed.
 *
 * Three ideas hold this together:
 *
 *   1. THE PATH IS THE PAGE. A lab's sequence is a column of steps —
 *      "order arrives" → "no reply after 60m" → "escalate at 300m" — and each
 *      step names the message it sends. Adding a follow-up is a button on the
 *      path, not a rule authored elsewhere.
 *
 *   2. MESSAGES ARE BLOCKS. The body is edited as heading / field / action /
 *      text rows (lib/non-api-labs/blocks.ts), so variables are picked, never
 *      spelled. Blocks are a view over the same stored text, and "Edit as
 *      text" drops to the raw body at any point without losing work.
 *
 *   3. THE CONTRACT IS VISIBLE. Each template key requires certain variables;
 *      the API now sends that contract, so the builder can say what is still
 *      missing while you write instead of after you save.
 *
 * One behaviour is called out in the UI rather than hidden: an authored rule
 * REPLACES the built-in ladder for the labs it covers (see workflow.ts —
 * `scopedRules.length > 0 ? ruleActions : buildLadder(...)`). So the first
 * custom follow-up mirrors the current ladder into rules before appending,
 * otherwise adding one step would silently delete six.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BLOCK_LABELS,
  type Block,
  type BlockKind,
  fromBody,
  moveBlock,
  newBlock,
  renderPreview,
  toBody,
  variablesIn,
} from "@/lib/non-api-labs/blocks";

type Template = {
  key: string;
  name: string;
  body: string;
  isActive: boolean;
  allowedVariables: string[];
  requiredVariables: string[];
};

type LabConfig = {
  labId: number;
  labName: string;
  isActive: boolean;
  waGroupJid: string | null;
  whatsappNumber: string | null;
  confirmationSlaMinutes: number;
  reminderSlaMinutes: number;
  escalationSlaMinutes: number;
  appointmentRemindersEnabled: boolean;
  initialTemplateKey: string;
  reminderTemplateKey: string;
  escalationTemplateKey: string;
  appointmentTemplateKey: string;
  slaBreachTemplateKey: string;
};

type Rule = {
  id: string;
  name: string;
  isActive: boolean;
  anchor: "ORDER" | "APPOINTMENT";
  action: "SEND_REMINDER" | "ESCALATE";
  offsetMinutes: number;
  priority: number;
  templateKey: string;
  recipient: string;
  allowedLabIds: number[];
  triggerKind: "RELATIVE_DELAY" | "SLA_BREACH";
  slaMilestone: string | null;
  repeatIntervalMinutes: number | null;
  maxAttempts: number | null;
};

const MILESTONES: Array<{ value: string; label: string }> = [
  { value: "ORDER_CONFIRMED", label: "Order confirmed" },
  { value: "PHLEBO_ASSIGNED", label: "Phlebotomist assigned" },
  { value: "SAMPLE_COLLECTED", label: "Sample collected" },
  { value: "SAMPLE_DELIVERED", label: "Sample delivered to lab" },
  { value: "REPORT_UPLOADED", label: "Report uploaded" },
];

const milestoneLabel = (value: string | null) =>
  MILESTONES.find((m) => m.value === value)?.label ?? value ?? "a milestone";

/** One row on the path. Either a built-in ladder rung or an authored rule. */
type Step = {
  id: string;
  origin: "ladder" | "rule" | "breach";
  /** Breach steps only. */
  milestone?: string | null;
  repeatIntervalMinutes?: number | null;
  maxAttempts?: number | null;
  ruleId?: string;
  when: string;
  detail: string;
  templateKey: string;
  /** Which config field this step's template is stored in (ladder steps only). */
  configField?: keyof Pick<LabConfig, "initialTemplateKey" | "reminderTemplateKey" | "escalationTemplateKey" | "appointmentTemplateKey">;
  action: "SEND" | "ESCALATE";
};

const inputClass =
  "w-full rounded border border-dashed border-zinc-600 bg-zinc-900/60 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500";

function minutes(value: number): string {
  const abs = Math.abs(value);
  if (abs < 60) return `${abs}m`;
  if (abs % 60 === 0) return `${abs / 60}h`;
  return `${Math.floor(abs / 60)}h ${abs % 60}m`;
}

function scopedToLab(rule: Rule, labId: number): boolean {
  return rule.allowedLabIds.length === 0 || rule.allowedLabIds.includes(labId);
}

export function NonApiLabMessageFlow() {
  const [labs, setLabs] = useState<LabConfig[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [labId, setLabId] = useState<number | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawBody, setRawBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // ── message library (add / rename / delete a template) ────────────────
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const load = useCallback(async () => {
    const [templateRes, labRes, ruleRes] = await Promise.all([
      fetch("/api/non-api-labs/templates"),
      fetch("/api/non-api-labs"),
      fetch("/api/provider-communication-rules"),
    ]);
    const templateData = await templateRes.json().catch(() => ({}));
    const labData = await labRes.json().catch(() => ({}));
    const ruleData = await ruleRes.json().catch(() => ({}));
    if (!templateRes.ok) { setNotice({ tone: "err", text: templateData.error ?? "Could not load messages" }); return; }
    setTemplates(templateData.templates ?? []);
    const loadedLabs: LabConfig[] = labData.labs ?? [];
    setLabs(loadedLabs);
    setRules(ruleData.rules ?? []);
    setLabId((current) => current ?? loadedLabs.find((lab) => lab.isActive)?.labId ?? loadedLabs[0]?.labId ?? null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const lab = labs.find((item) => item.labId === labId) ?? null;
  const scopedRules = useMemo(
    () => (lab ? rules.filter((rule) => scopedToLab(rule, lab.labId)) : []),
    [rules, lab],
  );
  // The engine loads rules with `where: { isActive: true }` (rule-store.ts) and
  // only then decides "rules replace the ladder". A paused rule therefore
  // changes nothing at runtime — counting it here would show a custom path
  // while the built-in ladder is what actually runs.
  // Sequence steps and breach watchers are separated before anything else
  // reads them. A breach step is conditional — it can fire at any point in an
  // order's life — so it takes no part in sequence ordering, and above all it
  // must not count towards `onAuthoredPath`: the engine swaps the built-in
  // ladder for authored rules the moment one exists, and counting a breach
  // step here would make adding one appear to delete the whole sequence.
  const sequenceRules = useMemo(
    () => scopedRules.filter((rule) => rule.triggerKind !== "SLA_BREACH"),
    [scopedRules],
  );
  const breachRules = useMemo(
    () => scopedRules.filter((rule) => rule.triggerKind === "SLA_BREACH"),
    [scopedRules],
  );
  const labRules = useMemo(() => sequenceRules.filter((rule) => rule.isActive), [sequenceRules]);
  const pausedRules = useMemo(() => sequenceRules.filter((rule) => !rule.isActive), [sequenceRules]);
  const onAuthoredPath = labRules.length > 0;

  async function addBreachStep() {
    if (!lab) return;
    const taken = new Set(breachRules.map((rule) => rule.slaMilestone));
    const next = MILESTONES.find((m) => !taken.has(m.value));
    if (!next) { setNotice({ tone: "err", text: "Every milestone already has a breach step" }); return; }

    setBusy(true); setNotice(null);
    const res = await fetch("/api/provider-communication-rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${lab.labName} · ${next.label} SLA`,
        // A breach step's timing comes from the milestone config, so its own
        // anchor/offset are inert — the API exempts breach steps from the
        // anchor/offset agreement check for exactly this reason.
        anchor: "ORDER", action: "SEND_REMINDER", offsetMinutes: 0, priority: 2,
        templateKey: "PROVIDER_SLA_MILESTONE", recipient: "LAB",
        allowedLabIds: [lab.labId], allowedOrderTypes: [], sendCondition: {},
        triggerKind: "SLA_BREACH", slaMilestone: next.value,
        // Saved paused, like a new follow-up: adding a watcher should not
        // start messaging a provider the moment it is created.
        isDraft: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      const details = data.details ? Object.values(data.details).join(" · ") : null;
      setNotice({ tone: "err", text: details || data.error || "Could not add the breach step" });
      return;
    }
    setNotice({ tone: "ok", text: `${next.label} breach step added (paused)` });
    await load();
  }

  async function patchStep(ruleId: string, body: Record<string, unknown>, okText: string) {
    setBusy(true); setNotice(null);
    const res = await fetch(`/api/provider-communication-rules/${ruleId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      const details = data.details ? Object.values(data.details).join(" · ") : null;
      setNotice({ tone: "err", text: details || data.error || "Could not update this step" });
      return;
    }
    setNotice({ tone: "ok", text: okText });
    await load();
  }

  /** Breach steps, shown as their own group on the path. */
  const breachSteps: Step[] = useMemo(
    () => breachRules.map((rule) => ({
      id: `breach:${rule.id}`,
      origin: "breach" as const,
      ruleId: rule.id,
      when: `when ${milestoneLabel(rule.slaMilestone)} SLA breaches`,
      detail: rule.allowedLabIds.length === 0 ? `${rule.name} · applies to every provider` : rule.name,
      templateKey: rule.templateKey,
      milestone: rule.slaMilestone,
      repeatIntervalMinutes: rule.repeatIntervalMinutes,
      maxAttempts: rule.maxAttempts,
      action: "SEND" as const,
    })),
    [breachRules],
  );

  /** The path: authored rules when they exist, otherwise the built-in ladder. */
  const steps: Step[] = useMemo(() => {
    if (!lab) return [];
    if (onAuthoredPath) {
      return [...labRules]
        .sort((a, b) => (a.anchor === b.anchor ? a.offsetMinutes - b.offsetMinutes : a.anchor === "ORDER" ? -1 : 1))
        .map((rule) => ({
          id: `rule:${rule.id}`,
          origin: "rule" as const,
          ruleId: rule.id,
          when: rule.anchor === "ORDER" ? `${minutes(rule.offsetMinutes)} after the order` : `${minutes(rule.offsetMinutes)} before the appointment`,
          detail: rule.allowedLabIds.length === 0 ? `${rule.name} · applies to every provider` : rule.name,
          templateKey: rule.templateKey,
          action: rule.action === "ESCALATE" ? "ESCALATE" : "SEND",
        }));
    }
    const ladder: Step[] = [
      { id: "ladder:initial", origin: "ladder", when: "when the order arrives", detail: "First message to the provider", templateKey: lab.initialTemplateKey, configField: "initialTemplateKey", action: "SEND" },
      { id: "ladder:confirm", origin: "ladder", when: `${minutes(lab.confirmationSlaMinutes)} after the order`, detail: "No confirmation yet — chase", templateKey: lab.reminderTemplateKey, configField: "reminderTemplateKey", action: "SEND" },
      { id: "ladder:remind", origin: "ladder", when: `${minutes(lab.reminderSlaMinutes)} after the order`, detail: "Still nothing — chase again", templateKey: lab.reminderTemplateKey, configField: "reminderTemplateKey", action: "SEND" },
      { id: "ladder:escalate", origin: "ladder", when: `${minutes(lab.escalationSlaMinutes)} after the order`, detail: "Escalate", templateKey: lab.escalationTemplateKey, configField: "escalationTemplateKey", action: "ESCALATE" },
    ];
    if (lab.appointmentRemindersEnabled) {
      ladder.push({ id: "ladder:appointment", origin: "ladder", when: "24h / 2h / 30m / 10m before the appointment", detail: "Appointment run-up (4 messages)", templateKey: lab.appointmentTemplateKey, configField: "appointmentTemplateKey", action: "SEND" });
    }
    return ladder;
  }, [lab, labRules, onAuthoredPath]);

  const allSteps = useMemo(() => [...steps, ...breachSteps], [steps, breachSteps]);
  const step = allSteps.find((item) => item.id === stepId) ?? steps[0] ?? null;
  const template = templates.find((item) => item.key === step?.templateKey) ?? null;

  // Load the selected step's message into the canvas. Guarded on `dirty` so a
  // re-render never discards edits in progress.
  useEffect(() => {
    if (!template || dirty) return;
    setBlocks(fromBody(template.body));
    setRawBody(template.body);
  }, [template, dirty]);

  useEffect(() => { if (step && step.id !== stepId) setStepId(step.id); }, [step, stepId]);

  const body = rawMode ? rawBody : toBody(blocks);
  const used = variablesIn(fromBody(body));
  const missing = (template?.requiredVariables ?? []).filter((variable) => !used.includes(variable));
  const unknown = used.filter((variable) => template && !template.allowedVariables.includes(variable));

  function edit(next: Block[]) { setBlocks(next); setDirty(true); }

  async function saveMessage() {
    if (!template) return;
    setBusy(true); setNotice(null);
    const res = await fetch(`/api/non-api-labs/templates/${template.key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: template.name, body, isActive: template.isActive }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: data.error ?? "Could not save the message" }); return; }
    setTemplates((current) => current.map((item) => (item.key === data.template.key ? { ...item, ...data.template } : item)));
    setDirty(false);
    setNotice({ tone: "ok", text: "Message saved" });
  }

  /** Point the current step at a different template key. Returns whether it worked. */
  async function assignTemplateToStep(nextKey: string): Promise<boolean> {
    if (!lab || !step) return false;
    const res = step.origin === "ladder" && step.configField
      ? await fetch(`/api/non-api-labs/${lab.labId}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...lab, [step.configField]: nextKey }),
        })
      : await fetch(`/api/provider-communication-rules/${step.ruleId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateKey: nextKey }),
        });
    if (!res.ok) return false;
    setDirty(false);
    await load();
    return true;
  }

  async function pickTemplateForStep(nextKey: string) {
    setBusy(true); setNotice(null);
    const ok = await assignTemplateToStep(nextKey);
    setBusy(false);
    if (!ok) setNotice({ tone: "err", text: "Could not change the message for this step" });
  }

  /** Every lab/rule slot currently pointing at a template key — informational
   * only; the server has the final say (the delete endpoint also checks
   * slaBreachTemplateKey, which isn't fetched by every caller of this file). */
  function usedBy(key: string): string[] {
    const uses: string[] = [];
    for (const l of labs) {
      if (l.initialTemplateKey === key) uses.push(`${l.labName} · new order`);
      if (l.reminderTemplateKey === key) uses.push(`${l.labName} · reminder`);
      if (l.escalationTemplateKey === key) uses.push(`${l.labName} · escalation`);
      if (l.appointmentTemplateKey === key) uses.push(`${l.labName} · appointment`);
      if (l.slaBreachTemplateKey === key) uses.push(`${l.labName} · SLA breach`);
    }
    for (const r of rules) {
      if (r.templateKey === key) uses.push(`rule "${r.name}"`);
    }
    return uses;
  }

  const isCustomTemplate = (key: string) => key.startsWith("NON_API_CUSTOM_");

  /** Library-level create — adds to the set of messages without assigning it
   * anywhere. Assignment is a separate, deliberate act via the per-step
   * picker: auto-assigning here was tried first and it is why delete never
   * worked — whatever you had just created was always "in use by" the very
   * step you created it for. */
  async function createMessage() {
    const name = draftName.trim();
    if (!name) return;
    setBusy(true); setNotice(null);
    const res = await fetch("/api/non-api-labs/templates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, body: "Order ID: {{order_id}}" }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: data.error ?? "Could not create the message" }); return; }
    setTemplates((current) => [...current, data.template]);
    setCreating(false); setDraftName("");
    setNotice({ tone: "ok", text: `"${name}" added — pick it from any step's message dropdown to use it` });
    await load();
  }

  async function renameMessage(key: string) {
    const value = renameValue.trim();
    const row = templates.find((item) => item.key === key);
    if (!row) { setRenamingKey(null); return; }
    if (!value || value === row.name) { setRenamingKey(null); return; }
    setBusy(true); setNotice(null);
    // Sent with the row's OWN stored body, not the editor's live draft — a
    // rename from the library must not silently rewrite whatever a DIFFERENT
    // step happens to have open on the right.
    const res = await fetch(`/api/non-api-labs/templates/${key}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: value, body: row.body, isActive: row.isActive }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: data.error ?? "Could not rename the message" }); return; }
    setTemplates((current) => current.map((item) => (item.key === key ? { ...item, ...data.template } : item)));
    setRenamingKey(null);
    setNotice({ tone: "ok", text: "Message renamed" });
  }

  /** The paired action to a shipped template's disabled Delete button: this
   * is the "instead" the server's error message points to. */
  async function toggleMessageActive(key: string) {
    const row = templates.find((item) => item.key === key);
    if (!row) return;
    setBusy(true); setNotice(null);
    const res = await fetch(`/api/non-api-labs/templates/${key}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: row.name, body: row.body, isActive: !row.isActive }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: data.error ?? "Could not update the message" }); return; }
    setTemplates((current) => current.map((item) => (item.key === key ? { ...item, ...data.template } : item)));
    setNotice({ tone: "ok", text: data.template.isActive ? "Message resumed" : "Message paused — it will no longer be sent" });
  }

  async function deleteMessage(key: string) {
    const row = templates.find((item) => item.key === key);
    if (!row) return;
    if (!window.confirm(`Delete "${row.name}"? This can't be undone.`)) return;
    setBusy(true); setNotice(null);
    const res = await fetch(`/api/non-api-labs/templates/${key}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: data.error ?? "Could not delete the message" }); return; }
    setTemplates((current) => current.filter((item) => item.key !== key));
    setNotice({ tone: "ok", text: "Message deleted" });
  }

  /**
   * Add a follow-up. The first one converts the lab from the built-in ladder
   * to an authored path, mirroring every current rung first — otherwise the
   * engine's "rules replace the ladder" behaviour would drop the rest.
   */
  async function addFollowUp() {
    if (!lab) return;
    const lastOrderOffset = Math.max(
      lab.escalationSlaMinutes,
      ...labRules.filter((r) => r.anchor === "ORDER").map((r) => r.offsetMinutes),
    );
    const offsetMinutes = lastOrderOffset + 60;

    setBusy(true); setNotice(null);
    try {
      if (!onAuthoredPath) {
        const mirrored: Array<{ label: string; offsetMinutes: number; action: "SEND_REMINDER" | "ESCALATE"; templateKey: string; anchor: "ORDER" | "APPOINTMENT"; priority: number }> = [
          { label: "confirmation chase", offsetMinutes: lab.confirmationSlaMinutes, action: "SEND_REMINDER", templateKey: lab.reminderTemplateKey, anchor: "ORDER", priority: 4 },
          { label: "second chase", offsetMinutes: lab.reminderSlaMinutes, action: "SEND_REMINDER", templateKey: lab.reminderTemplateKey, anchor: "ORDER", priority: 3 },
          { label: "escalation", offsetMinutes: lab.escalationSlaMinutes, action: "ESCALATE", templateKey: lab.escalationTemplateKey, anchor: "ORDER", priority: 1 },
        ];
        if (lab.appointmentRemindersEnabled) {
          for (const [label, offset, priority] of [["appointment T-24h", -1440, 4], ["appointment T-2h", -120, 2], ["appointment T-30m", -30, 1], ["appointment T-10m", -10, 0]] as const) {
            mirrored.push({ label, offsetMinutes: offset, action: "SEND_REMINDER", templateKey: lab.appointmentTemplateKey, anchor: "APPOINTMENT", priority });
          }
        }
        for (const rung of mirrored) {
          const res = await fetch("/api/provider-communication-rules", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: `${lab.labName} · ${rung.label}`,
              anchor: rung.anchor, action: rung.action, offsetMinutes: rung.offsetMinutes,
              priority: rung.priority, templateKey: rung.templateKey, recipient: "LAB",
              allowedLabIds: [lab.labId], allowedOrderTypes: [], sendCondition: {},
            }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error ?? "Could not mirror the built-in path");
          }
        }
      }

      const res = await fetch("/api/provider-communication-rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${lab.labName} · follow-up at ${minutes(offsetMinutes)}`,
          anchor: "ORDER", action: "SEND_REMINDER", offsetMinutes,
          priority: 3, templateKey: lab.reminderTemplateKey, recipient: "LAB",
          allowedLabIds: [lab.labId], allowedOrderTypes: [], sendCondition: {},
          // Saved paused: a new rung should not start messaging a provider
          // the moment it is added.
          isDraft: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not add the follow-up");
      }
      setNotice({ tone: "ok", text: onAuthoredPath ? "Follow-up added (paused)" : "Path converted to custom steps; follow-up added (paused)" });
      await load();
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not add the follow-up" });
    } finally {
      setBusy(false);
    }
  }

  async function setStepTiming(nextOffset: number) {
    if (!step?.ruleId) return;
    setBusy(true);
    const res = await fetch(`/api/provider-communication-rules/${step.ruleId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offsetMinutes: nextOffset }),
    });
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: "Could not change the timing" }); return; }
    await load();
  }

  async function toggleStep() {
    if (!step?.ruleId) return;
    const rule = labRules.find((r) => r.id === step.ruleId);
    if (!rule) return;
    setBusy(true);
    const res = await fetch(`/api/provider-communication-rules/${rule.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !rule.isActive }),
    });
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: "Could not pause this step" }); return; }
    await load();
  }

  async function removeStep() {
    if (!step?.ruleId) return;
    setBusy(true);
    const res = await fetch(`/api/provider-communication-rules/${step.ruleId}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { setNotice({ tone: "err", text: "Could not remove this step" }); return; }
    setStepId(null);
    await load();
  }

  const target = lab?.waGroupJid ? `group ${lab.waGroupJid}` : lab?.whatsappNumber ? `direct ${lab.whatsappNumber}` : "no target configured";

  return (
    <div className="mt-6 space-y-4">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-3 flex flex-wrap items-center gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Message flow</div>
          <div className="text-xs text-zinc-500 mt-0.5">What this provider is sent, and when. Blocks build the message; the path sets the sequence.</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-zinc-500">Provider</label>
          <select
            value={labId ?? ""}
            onChange={(event) => { setLabId(Number(event.target.value)); setStepId(null); setDirty(false); }}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
          >
            {labs.map((item) => <option key={item.labId} value={item.labId}>{item.labName}</option>)}
          </select>
        </div>
      </div>

      {/* ── message library ───────────────────────────────────────────── */}
      <div className="rounded-xl border border-zinc-800">
        <button
          onClick={() => setLibraryOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left"
        >
          <span className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Message library</span>
          <span className="text-[11px] text-zinc-600">{templates.length} message{templates.length === 1 ? "" : "s"}</span>
          <span className="ml-auto text-xs text-zinc-500">{libraryOpen ? "▾ hide" : "▸ add, rename, or delete a message"}</span>
        </button>

        {libraryOpen && (
          <div className="border-t border-zinc-800 p-4 space-y-3">
            <p className="text-[11px] text-zinc-600 max-w-2xl">
              Every message any provider can be sent, in one place. Creating one here just adds it to the set —
              assign it to a step from that step&apos;s message dropdown when you&apos;re ready to use it.
              A message can only be deleted once nothing points at it any more.
            </p>

            {creating ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-blue-500/60 bg-blue-500/5 px-3 py-2">
                <input
                  autoFocus
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void createMessage(); if (event.key === "Escape") { setCreating(false); setDraftName(""); } }}
                  placeholder="e.g. Phlebo running late"
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500"
                />
                <button onClick={createMessage} disabled={busy || !draftName.trim()} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50">Create</button>
                <button onClick={() => { setCreating(false); setDraftName(""); }} className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-100">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                disabled={busy}
                className="w-full rounded-lg border border-dashed border-zinc-600 px-3 py-2 text-xs text-zinc-400 hover:border-blue-500 hover:text-blue-300 disabled:opacity-50"
              >
                + New message
              </button>
            )}

            <div className="space-y-1.5">
              {templates.map((item) => {
                const custom = isCustomTemplate(item.key);
                const uses = usedBy(item.key);
                const canDelete = custom && uses.length === 0;
                const deleteTitle = !custom
                  ? "Built-in message — pause it instead of deleting"
                  : uses.length > 0
                    ? `Still used by: ${uses.join(", ")}`
                    : undefined;
                return (
                  <div key={item.key} className={`rounded-lg border border-dashed px-3 py-2 ${item.isActive ? "border-zinc-700" : "border-zinc-800 opacity-60"}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      {renamingKey === item.key ? (
                        <>
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onKeyDown={(event) => { if (event.key === "Enter") void renameMessage(item.key); if (event.key === "Escape") setRenamingKey(null); }}
                            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-blue-500"
                          />
                          <button onClick={() => renameMessage(item.key)} disabled={busy} className="rounded bg-blue-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-blue-500">Save</button>
                          <button onClick={() => setRenamingKey(null)} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100">Cancel</button>
                        </>
                      ) : (
                        <>
                          <span className="text-sm font-medium text-zinc-200">{item.name}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${custom ? "bg-blue-500/10 text-blue-300" : "bg-zinc-800 text-zinc-400"}`}>
                            {custom ? "custom" : "built-in"}
                          </span>
                          {!item.isActive && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">paused</span>}
                          <span className="text-[11px] text-zinc-600">
                            {uses.length === 0 ? "unused" : `used by ${uses.length} step${uses.length === 1 ? "" : "s"}`}
                          </span>
                          <div className="ml-auto flex shrink-0 items-center gap-1">
                            <button
                              onClick={() => { setRenamingKey(item.key); setRenameValue(item.name); }}
                              disabled={busy}
                              className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100"
                            >
                              Rename
                            </button>
                            <button
                              onClick={() => toggleMessageActive(item.key)}
                              disabled={busy}
                              className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100"
                            >
                              {item.isActive ? "Pause" : "Resume"}
                            </button>
                            <button
                              onClick={() => deleteMessage(item.key)}
                              disabled={busy || !canDelete}
                              title={deleteTitle}
                              className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 enabled:hover:text-rose-400 disabled:opacity-40"
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    {uses.length > 0 && renamingKey !== item.key && (
                      <div className="mt-1 pl-0.5 text-[10px] text-zinc-600">{uses.join(" · ")}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {!lab ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-10 text-center text-sm text-zinc-500">
          Configure a provider under Lab Config to build its message flow.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          {/* ── the path ─────────────────────────────────────────────────── */}
          <div className="rounded-xl border border-zinc-800 p-3">
            <div className="flex items-baseline justify-between mb-1">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Sequence</div>
              <span className={`text-[10px] rounded-full px-2 py-0.5 ${onAuthoredPath ? "bg-blue-500/10 text-blue-300" : "bg-zinc-800 text-zinc-400"}`}>
                {onAuthoredPath ? "custom" : "built-in"}
              </span>
            </div>
            <div className="text-[11px] text-zinc-600 mb-3 break-all">→ {target}</div>

            <ol className="space-y-0">
              {steps.map((item, index) => {
                const active = item.id === step?.id;
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => { setStepId(item.id); setDirty(false); setRawMode(false); }}
                      className={`w-full text-left rounded-lg border border-dashed px-3 py-2.5 transition-colors ${active ? "border-blue-500 bg-blue-500/5" : "border-zinc-700 hover:border-zinc-500"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${active ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400"}`}>{index + 1}</span>
                        <span className="text-xs font-medium text-zinc-200">{item.when}</span>
                        {item.action === "ESCALATE" && <span className="ml-auto text-[10px] text-amber-400">escalate</span>}
                      </div>
                      <div className="mt-1 pl-7 text-[11px] text-zinc-500">{item.detail}</div>
                      <div className="mt-0.5 pl-7 text-[11px] text-zinc-400">
                        ▸ {templates.find((t) => t.key === item.templateKey)?.name ?? item.templateKey}
                      </div>
                    </button>
                    {index < steps.length - 1 && <div className="ml-[1.35rem] h-3 w-px bg-zinc-700" />}
                  </li>
                );
              })}
            </ol>

            <button
              onClick={addFollowUp}
              disabled={busy}
              className="mt-3 w-full rounded-lg border border-dashed border-zinc-600 px-3 py-2 text-xs text-zinc-400 hover:border-blue-500 hover:text-blue-300 disabled:opacity-50"
            >
              + Add follow-up
            </button>
            {!onAuthoredPath && (
              <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                Adding one converts this provider to a custom path: the built-in steps above are copied first, so nothing is lost.
              </p>
            )}

            {/* ── SLA breach watchers ──────────────────────────────────── */}
            <div className="mt-5 border-t border-zinc-800 pt-4">
              <div className="flex items-baseline justify-between mb-1">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">SLA breach</div>
                <span className="text-[10px] text-zinc-600">{breachSteps.length} watcher{breachSteps.length === 1 ? "" : "s"}</span>
              </div>
              <p className="mb-3 text-[10px] leading-4 text-zinc-600">
                Fires whenever a milestone deadline passes, at any point in the order. Not part of the sequence above.
              </p>

              <div className="space-y-1.5">
                {breachSteps.map((item) => {
                  const rule = breachRules.find((r) => r.id === item.ruleId);
                  const active = item.id === step?.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => { setStepId(item.id); setDirty(false); setRawMode(false); }}
                      className={`w-full rounded-lg border border-dashed px-3 py-2.5 text-left transition-colors ${active ? "border-blue-500 bg-blue-500/5" : "border-zinc-700 hover:border-zinc-500"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] ${active ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400"}`}>!</span>
                        <span className="text-xs font-medium text-zinc-200">{milestoneLabel(item.milestone ?? null)}</span>
                        {rule && !rule.isActive && <span className="ml-auto text-[10px] text-amber-400">paused</span>}
                      </div>
                      <div className="mt-1 pl-7 text-[11px] text-zinc-500">
                        {item.repeatIntervalMinutes || item.maxAttempts
                          ? `every ${item.repeatIntervalMinutes ?? "—"}m · max ${item.maxAttempts ?? "—"} attempts`
                          : "cadence from Lab Config"}
                      </div>
                      <div className="mt-0.5 pl-7 text-[11px] text-zinc-400">
                        ▸ {templates.find((t) => t.key === item.templateKey)?.name ?? item.templateKey}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                onClick={addBreachStep}
                disabled={busy}
                className="mt-3 w-full rounded-lg border border-dashed border-zinc-600 px-3 py-2 text-xs text-zinc-400 hover:border-blue-500 hover:text-blue-300 disabled:opacity-50"
              >
                + Add breach step
              </button>
              <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                A watcher only sends once its milestone is switched on under Lab Config.
              </p>
            </div>

            {pausedRules.length > 0 && (
              <div className="mt-4 border-t border-zinc-800 pt-3">
                <div className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-600">Paused · not running</div>
                {pausedRules.map((rule) => (
                  <div key={rule.id} className="mb-1 flex items-center gap-2 rounded border border-dashed border-zinc-800 px-2 py-1.5">
                    <span className="truncate text-[11px] text-zinc-500">{rule.name}</span>
                    <button
                      onClick={async () => {
                        setBusy(true);
                        const res = await fetch(`/api/provider-communication-rules/${rule.id}`, {
                          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: true }),
                        });
                        setBusy(false);
                        if (!res.ok) { setNotice({ tone: "err", text: "Could not resume that step" }); return; }
                        await load();
                      }}
                      disabled={busy}
                      className="ml-auto shrink-0 text-[11px] text-zinc-500 hover:text-blue-300"
                    >
                      Resume
                    </button>
                  </div>
                ))}
                <p className="mt-1 text-[10px] leading-4 text-zinc-600">
                  Resuming any of these switches this provider off the built-in path.
                </p>
              </div>
            )}
          </div>

          {/* ── the message ──────────────────────────────────────────────── */}
          <div className="rounded-xl border border-zinc-800">
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">
                  {step?.origin === "breach"
                    ? "Message for this breach"
                    : `Message for step ${steps.findIndex((s) => s.id === step?.id) + 1}`}
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">{step?.when}</div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {step?.origin === "breach" && step.ruleId && (
                  <select
                    value={step.milestone ?? ""}
                    onChange={(event) => void patchStep(step.ruleId!, { slaMilestone: event.target.value }, "Milestone changed")}
                    disabled={busy}
                    className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200"
                    title="Which milestone this watcher fires on"
                  >
                    {MILESTONES.map((milestone) => (
                      <option key={milestone.value} value={milestone.value}>{milestone.label}</option>
                    ))}
                  </select>
                )}
                <select
                  value={step?.templateKey ?? ""}
                  onChange={(event) => void pickTemplateForStep(event.target.value)}
                  disabled={busy}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200"
                >
                  {templates.map((item) => (
                    // Disabled rather than silently failing: the API refuses to
                    // point a step at an inactive message, and an option that
                    // looks identical to the others but does nothing when
                    // clicked reads as a broken dropdown.
                    <option key={item.key} value={item.key} disabled={!item.isActive}>
                      {item.name}{item.isActive ? "" : " — paused"}
                    </option>
                  ))}
                </select>
                {template && !template.isActive && (
                  <button
                    onClick={() => void toggleMessageActive(template.key)}
                    disabled={busy}
                    title="This step points at a paused message, so it will never send. Resume it."
                    className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    Paused — resume
                  </button>
                )}
                <button
                  onClick={() => { setRawMode((current) => !current); if (!rawMode) setRawBody(toBody(blocks)); else { setBlocks(fromBody(rawBody)); } setDirty(true); }}
                  className="rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-100"
                >
                  {rawMode ? "Use blocks" : "Edit as text"}
                </button>
              </div>
            </div>

            <div className="grid gap-4 p-4 lg:grid-cols-[1fr_260px]">
              {/* blocks / raw */}
              <div>
                {rawMode ? (
                  <textarea
                    value={rawBody}
                    onChange={(event) => { setRawBody(event.target.value); setDirty(true); }}
                    rows={16}
                    className="w-full rounded border border-dashed border-zinc-600 bg-zinc-900/60 px-3 py-2 font-mono text-xs leading-6 text-zinc-100 outline-none focus:border-blue-500"
                  />
                ) : (
                  <div className="space-y-1.5">
                    {blocks.map((block, index) => (
                      <div key={block.id} className="group rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          <span className="w-[4.5rem] shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">{BLOCK_LABELS[block.kind]}</span>

                          {block.kind === "spacer" && <span className="flex-1 border-t border-dashed border-zinc-700" />}

                          {block.kind === "heading" && (
                            <input
                              value={block.text}
                              onChange={(event) => edit(blocks.map((b, i) => (i === index ? { ...b, text: event.target.value } as Block : b)))}
                              className={`${inputClass} font-semibold`}
                            />
                          )}

                          {block.kind === "text" && (
                            // A textarea, not an input: prose lines run long and
                            // an input hides everything past its width.
                            <textarea
                              value={block.text}
                              rows={Math.min(4, Math.ceil(block.text.length / 60) || 1)}
                              onChange={(event) => edit(blocks.map((b, i) => (i === index ? { ...b, text: event.target.value.replace(/\n/g, " ") } as Block : b)))}
                              className={`${inputClass} resize-none leading-5`}
                            />
                          )}

                          {(block.kind === "field" || block.kind === "action") && (
                            <>
                              <input
                                value={block.label}
                                onChange={(event) => edit(blocks.map((b, i) => (i === index ? { ...b, label: event.target.value } as Block : b)))}
                                className={`${inputClass} max-w-[10rem]`}
                              />
                              <select
                                value={block.variable}
                                onChange={(event) => edit(blocks.map((b, i) => (i === index ? { ...b, variable: event.target.value } as Block : b)))}
                                className="rounded border border-dashed border-zinc-600 bg-zinc-900/60 px-2 py-1.5 font-mono text-xs text-blue-300"
                              >
                                {(template?.allowedVariables ?? []).map((variable) => <option key={variable} value={variable}>{variable}</option>)}
                              </select>
                            </>
                          )}

                          <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button onClick={() => edit(moveBlock(blocks, index, -1))} className="px-1 text-zinc-500 hover:text-zinc-200" title="Move up">↑</button>
                            <button onClick={() => edit(moveBlock(blocks, index, 1))} className="px-1 text-zinc-500 hover:text-zinc-200" title="Move down">↓</button>
                            <button onClick={() => edit(blocks.filter((_, i) => i !== index))} className="px-1 text-zinc-500 hover:text-rose-400" title="Remove">✕</button>
                          </div>
                        </div>
                      </div>
                    ))}

                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-600">Add</span>
                      {(Object.keys(BLOCK_LABELS) as BlockKind[]).map((kind) => (
                        <button
                          key={kind}
                          onClick={() => edit([...blocks, newBlock(kind)])}
                          className="rounded border border-dashed border-zinc-600 px-2 py-1 text-[11px] text-zinc-400 hover:border-blue-500 hover:text-blue-300"
                        >
                          + {BLOCK_LABELS[kind]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* preview + contract */}
              <div className="space-y-3">
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-600">Preview · sample data</div>
                  <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-2">
                    <div className="rounded-lg rounded-tl-sm bg-emerald-900/20 px-3 py-2 text-[11px] leading-5 text-zinc-200 whitespace-pre-wrap break-words">
                      {renderPreview(body) || <span className="text-zinc-600">Empty message</span>}
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-dashed border-zinc-700 p-2.5 text-[11px]">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">Required by this message</div>
                  {(template?.requiredVariables ?? []).length === 0 ? (
                    <div className="text-zinc-500">Nothing mandatory.</div>
                  ) : (
                    <ul className="space-y-0.5 font-mono">
                      {template!.requiredVariables.map((variable) => (
                        <li key={variable} className={used.includes(variable) ? "text-emerald-400" : "text-amber-400"}>
                          {used.includes(variable) ? "✔" : "•"} {variable}
                        </li>
                      ))}
                    </ul>
                  )}
                  {unknown.length > 0 && (
                    <div className="mt-2 text-rose-400">Not available here: {unknown.join(", ")}</div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-3">
              {step?.origin === "breach" && step.ruleId && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[11px] text-zinc-500">Repeat every</label>
                  <input
                    type="number" min={5} max={1440}
                    defaultValue={step.repeatIntervalMinutes ?? ""}
                    placeholder="default"
                    onBlur={(event) => {
                      const raw = event.target.value.trim();
                      const next = raw === "" ? null : Number(raw);
                      if (next !== null && !Number.isInteger(next)) return;
                      if (next === (step.repeatIntervalMinutes ?? null)) return;
                      void patchStep(step.ruleId!, { repeatIntervalMinutes: next }, "Cadence updated");
                    }}
                    className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  />
                  <span className="text-[11px] text-zinc-600">min · max</span>
                  <input
                    type="number" min={1} max={10}
                    defaultValue={step.maxAttempts ?? ""}
                    placeholder="default"
                    onBlur={(event) => {
                      const raw = event.target.value.trim();
                      const next = raw === "" ? null : Number(raw);
                      if (next !== null && !Number.isInteger(next)) return;
                      if (next === (step.maxAttempts ?? null)) return;
                      void patchStep(step.ruleId!, { maxAttempts: next }, "Attempt cap updated");
                    }}
                    className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  />
                  <span className="text-[11px] text-zinc-600">attempts</span>
                  <button
                    onClick={() => {
                      const rule = breachRules.find((r) => r.id === step.ruleId);
                      void patchStep(step.ruleId!, { isActive: !rule?.isActive }, rule?.isActive ? "Watcher paused" : "Watcher resumed");
                    }}
                    disabled={busy}
                    className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100"
                  >
                    {breachRules.find((r) => r.id === step.ruleId)?.isActive ? "Pause step" : "Resume step"}
                  </button>
                  <button onClick={removeStep} disabled={busy} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 hover:text-rose-400">Remove step</button>
                  <span className="text-[10px] text-zinc-600">blank = use Lab Config</span>
                </div>
              )}
              {step?.origin === "rule" && (
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-zinc-500">Send at</label>
                  <input
                    type="number"
                    defaultValue={labRules.find((r) => r.id === step.ruleId)?.offsetMinutes ?? 0}
                    onBlur={(event) => { const next = Number(event.target.value); if (Number.isInteger(next)) void setStepTiming(next); }}
                    className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  />
                  <span className="text-[11px] text-zinc-600">min</span>
                  <button onClick={toggleStep} disabled={busy} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100">
                    {labRules.find((r) => r.id === step.ruleId)?.isActive ? "Pause step" : "Resume step"}
                  </button>
                  <button onClick={removeStep} disabled={busy} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 hover:text-rose-400">Remove step</button>
                </div>
              )}
              {notice && <span className={`text-xs ${notice.tone === "ok" ? "text-emerald-400" : "text-rose-400"}`}>{notice.text}</span>}
              <button
                onClick={saveMessage}
                disabled={busy || !dirty || missing.length > 0 || unknown.length > 0}
                title={missing.length > 0 ? `Still needs: ${missing.join(", ")}` : undefined}
                className="ml-auto rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? "Saving…" : missing.length > 0 ? `Needs ${missing.length} more` : "Save message"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
