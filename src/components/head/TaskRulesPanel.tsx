"use client";

import { useState, useEffect, useCallback } from "react";
import PriorityBadge from "@/components/shared/PriorityBadge";
import ChecklistEditor from "@/components/task-rules/ChecklistEditor";

interface MetadataCondition {
  fieldPath: string;
  operator: string;
  value?: any;
  offsetMinutes?: number;
}

interface TriggerCondition {
  statusIn: string[];
  minutesSinceCreated?: number;
  minutesSinceStatusUpdated?: number;
  minutesBeforeAppointment?: number;
  minutesAfterAppointment?: number;
  requiresNoPreviousTaskOfType?: boolean;
  metadataConditions?: MetadataCondition[];
}

interface SkillTag {
  id: number;
  name: string;
  label: string;
}

interface EscalationChain {
  id: number;
  name: string;
}

interface DataSource {
  id: string;
  sourceId: string;
  displayName: string;
  tableReference: string;
  typeFieldName: string;
  statusFieldName: string;
  isActive: boolean;
  pollingIntervalMinutes: number;
}

interface SourceScope {
  id: number;
  dataSourceId: string;
  dataSource: { id: string; displayName: string; sourceId: string };
  allowedTypes: string[];
  allowedStatuses: string[];
  assignmentStrategy: string;
}

interface TaskRule {
  id: string;
  name: string;
  dataSourceId: string;
  dataSource: { id: string; sourceId: string; displayName: string } | null;
  allowedTypes: string[];
  allowedStatuses: string[];
  pollingIntervalMinutes: number;
  priority: string;
  slaMinutes: number;
  isActive: boolean;
  titleTemplate: string;
  assignmentStrategy: string;
  requiredSkills: SkillTag[];
  escalationChain: { id: number; name: string } | null;
  totalTasksCreated: number;
  tasksLast24h: number;
  triggerCondition: TriggerCondition;
  // Optional — present on rules saved after the /api/task-rules selects
  // started returning the taskType id. Used by the Checklist tab to
  // address the underlying ChecklistTemplate set.
  taskType?: { id: number; name: string; label: string } | null;
}

const PRIORITIES = ["URGENT", "HIGH", "MEDIUM", "LOW"] as const;

const ORDER_TYPE_COLORS: Record<string, string> = {
  HOME_SAMPLE: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  CENTER_VISIT: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  INJECTION: "text-teal-400 bg-teal-500/10 border-teal-500/20",
};

const PRIORITY_COLORS: Record<string, string> = {
  URGENT: "text-red-300 bg-red-500/10 border-red-500/20",
  HIGH: "text-orange-300 bg-orange-500/10 border-orange-500/20",
  MEDIUM: "text-amber-300 bg-amber-500/10 border-amber-500/20",
  LOW: "text-zinc-400 bg-zinc-800 border-zinc-700",
};

const METADATA_OPERATORS = [
  "exists", "not_exists", "equals", "not_equals", "contains",
  "starts_with", "ends_with", ">", ">=", "<", "<="
];

function fmtSla(mins: number): string {
  if (mins < 60) return `${mins}m`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// W4.3 — compact rendering of a sample value inside the autocomplete dropdown.
// Browsers truncate <option> labels; keep them short and readable.
function formatSampleForOption(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

function fmtOffset(mins: number): string {
  if (mins < 60) return `${mins} min`;
  if (mins % 60 === 0) return `${mins / 60} hr`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// W4.3 — observed metadata keys (from /api/data-sources/[id]/metadata-keys).
// Drives the autocomplete on the Field Path input so authors can't typo a
// field that doesn't exist on the source.
interface SourceKey {
  path: string;
  type: "string" | "number" | "boolean" | "timestamp" | "object" | "array" | "null";
  sampleValue: unknown;
  observedIn: number;
}

// Title-template variables the engine always resolves (taskCreator passes these
// named fields for every source). storeName/labName/phleboName are meaningful
// only for the Order source, so they're offered only there.
const UNIVERSAL_TITLE_VARS = ["patientName", "orderId", "appointmentTime"];
const ORDER_ONLY_TITLE_VARS = ["storeName", "labName", "phleboName"];

/** public."Order" | public.Order | "Order" → Order */
function bareTableOf(tableReference?: string | null): string | null {
  if (!tableReference) return null;
  return tableReference.replace(/^.*\./, "").replace(/^"(.+)"$/, "$1");
}

/**
 * The template variables to offer for the selected source. Universal fields
 * plus (for the Order table) the order-only fields, then the source's own
 * columns observed via metadata-keys — so the hint matches the data source
 * instead of always showing Lab-Order fields. taskCreator spreads the entity's
 * fields into the title context, so these source columns actually resolve.
 */
function titleVarsForSource(
  selectedSource: { tableReference: string } | null,
  sourceKeys: SourceKey[],
): string[] {
  const table = bareTableOf(selectedSource?.tableReference);
  // Order table: show the curated Order vars (its raw columns aren't carried
  // into the title context, so only the named fields resolve).
  if (table === "Order") return [...UNIVERSAL_TITLE_VARS, ...ORDER_ONLY_TITLE_VARS];
  // Unknown source (still loading, or none picked): the safe cross-source set
  // only — never assume Lab Orders and show store/lab/phlebo for, say, an
  // Appointments rule mid-load.
  if (!table) return [...UNIVERSAL_TITLE_VARS];

  // Non-Order sources: universal fields + the source's own top-level columns.
  // taskCreator spreads the entity's raw row into the title context, so these
  // resolve. Simple identifiers only ({{key}} can't address dot-paths); skip
  // ones already listed and noisy foreign-key columns that never title well.
  const vars = [...UNIVERSAL_TITLE_VARS];
  const simpleIdent = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  for (const k of sourceKeys) {
    if (!simpleIdent.test(k.path)) continue;
    if (vars.includes(k.path)) continue;
    if (/(^|_)id$/i.test(k.path)) continue; // id / user_id / slot_id …
    vars.push(k.path);
  }
  return vars;
}

function TriggerBuilder({
  value = { ...EMPTY_TRIGGER },
  onChange,
  metadataFields = [],
  orderStatuses = [],
  sourceKeys = [],
}: {
  value?: TriggerCondition;
  onChange: (v: TriggerCondition) => void;
  metadataFields?: any[];
  orderStatuses?: string[];
  sourceKeys?: SourceKey[];
}) {
  const [showMetadata, setShowMetadata] = useState(false);

  function toggleStatus(s: string) {
    const set = new Set(value?.statusIn ?? []);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    onChange({ ...value, statusIn: Array.from(set) });
  }

  function setNum(field: keyof TriggerCondition, raw: string) {
    const n = parseInt(raw, 10);
    const next = { ...value };
    if (!raw || isNaN(n)) {
      delete next[field];
    } else {
      (next as Record<string, unknown>)[field] = n;
    }
    onChange(next);
  }

  function clearNum(field: keyof TriggerCondition) {
    const next = { ...value };
    delete next[field];
    onChange(next);
  }

  function addMetadataCondition() {
    const conditions = value.metadataConditions || [];
    onChange({
      ...value,
      metadataConditions: [...conditions, { fieldPath: "", operator: "exists" }],
    });
  }

  function removeMetadataCondition(index: number) {
    const conditions = (value.metadataConditions || []).filter((_, i) => i !== index);
    onChange({ ...value, metadataConditions: conditions });
  }

  function updateMetadataCondition(index: number, updates: Partial<MetadataCondition>) {
    const conditions = [...(value.metadataConditions || [])];
    conditions[index] = { ...conditions[index], ...updates };
    onChange({ ...value, metadataConditions: conditions });
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">
          Fire when order status is
          <span className="text-red-400 ml-0.5">*</span>
        </label>
        <p className="text-[10px] text-zinc-600 mb-2">
          Select one or more labstack order statuses that will trigger this rule.
        </p>
        <div className="flex flex-wrap gap-2">
          {(orderStatuses.length > 0 ? orderStatuses : []).map((s) => {
            const active = value?.statusIn?.includes(s) ?? false;
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={`text-[11px] font-mono px-2.5 py-1 rounded-full border transition-all ${
                  active
                    ? "bg-blue-600/25 border-blue-500/50 text-blue-300"
                    : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                }`}
              >
                {active && <span className="mr-1">✓</span>}
                {s}
              </button>
            );
          })}
        </div>
        {value?.statusIn?.length === 0 && (
          <p className="text-[10px] text-red-400 mt-1.5">At least one status is required.</p>
        )}
      </div>

      <div>
        <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">
          Timing Conditions
        </label>
        <p className="text-[10px] text-zinc-600 mb-3">
          Add one or more time thresholds. The rule fires when ALL enabled conditions are met simultaneously.
        </p>

        <div className="space-y-3">
          <TimingRow
            label="Minutes since order was created"
            hint="e.g. 60 → fire when the order is at least 60 min old"
            value={value.minutesSinceCreated}
            onChange={(v) => v === undefined ? clearNum("minutesSinceCreated") : setNum("minutesSinceCreated", String(v))}
          />

          <TimingRow
            label="Minutes since order status last changed"
            hint="e.g. 120 → fire when order has been in the same status for 2h"
            value={value.minutesSinceStatusUpdated}
            onChange={(v) => v === undefined ? clearNum("minutesSinceStatusUpdated") : setNum("minutesSinceStatusUpdated", String(v))}
          />

          <TimingRow
            label="Minutes before appointment time"
            hint="e.g. 30 → fire when appointment is ≤ 30 min away"
            value={value.minutesBeforeAppointment}
            onChange={(v) => v === undefined ? clearNum("minutesBeforeAppointment") : setNum("minutesBeforeAppointment", String(v))}
          />

          <TimingRow
            label="Minutes after appointment time"
            hint="e.g. 15 → fire when appointment was 15+ min ago"
            value={value.minutesAfterAppointment}
            onChange={(v) => v === undefined ? clearNum("minutesAfterAppointment") : setNum("minutesAfterAppointment", String(v))}
          />
        </div>
      </div>

      <div className="border-t border-zinc-700 pt-5">
        <button
          type="button"
          onClick={() => setShowMetadata(!showMetadata)}
          className="text-xs font-medium text-blue-400 hover:text-blue-300 flex items-center gap-1"
        >
          {showMetadata ? "▼" : "▶"} Metadata Conditions (Advanced)
        </button>

        {showMetadata && (
          <div className="mt-4 space-y-3">
            {(value.metadataConditions || []).map((cond, idx) => (
              <div key={idx} className="p-3 bg-zinc-800 border border-zinc-700 rounded-lg space-y-2">
                <div className="grid grid-cols-4 gap-2">
                  <div>
                    {/* W4.3 — autocomplete from observed source keys. The <datalist>
                       gives the input native combobox behaviour (free-text + dropdown
                       suggestions); a green check appears when the typed path matches
                       an observed key. Catches typos that previously silently no-op'd. */}
                    {(() => {
                      const matched = sourceKeys.find((k) => k.path === cond.fieldPath);
                      return (
                        <>
                          <label className="text-[10px] text-zinc-400 mb-1 flex items-center justify-between">
                            <span>Field Path</span>
                            {cond.fieldPath && (
                              matched
                                ? <span className="text-emerald-400 normal-case">✓ {matched.type}</span>
                                : <span className="text-amber-400 normal-case" title="Field not observed in recent orders">⚠ not seen</span>
                            )}
                          </label>
                          <input
                            type="text"
                            list={`mdkeys-${idx}`}
                            value={cond.fieldPath}
                            onChange={(e) => updateMetadataCondition(idx, { fieldPath: e.target.value })}
                            placeholder={sourceKeys.length > 0 ? "Pick or type a path…" : "e.g., patient.age"}
                            className="w-full px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          {sourceKeys.length > 0 && (
                            <datalist id={`mdkeys-${idx}`}>
                              {sourceKeys.map((k) => (
                                <option key={k.path} value={k.path}>
                                  {`${k.type} · seen ${k.observedIn}× · e.g. ${formatSampleForOption(k.sampleValue)}`}
                                </option>
                              ))}
                            </datalist>
                          )}
                          {matched?.sampleValue !== undefined && matched?.sampleValue !== null && (
                            <div className="text-[9px] text-zinc-600 mt-0.5 truncate" title={String(matched.sampleValue)}>
                              e.g. {formatSampleForOption(matched.sampleValue)}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-400 block mb-1">Operator</label>
                    <select
                      value={cond.operator}
                      onChange={(e) => updateMetadataCondition(idx, { operator: e.target.value })}
                      className="w-full px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {METADATA_OPERATORS.map((op) => (
                        <option key={op} value={op}>{op.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-400 block mb-1">Value</label>
                    <input
                      type="text"
                      value={cond.value ?? ""}
                      onChange={(e) => updateMetadataCondition(idx, { value: e.target.value })}
                      placeholder="Value"
                      className="w-full px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex items-end gap-1">
                    <button
                      type="button"
                      onClick={() => removeMetadataCondition(idx)}
                      className="px-2 py-1.5 text-zinc-600 hover:text-red-400 text-xs flex-1"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {[">", ">=", "<", "<="].includes(cond.operator) && (
                  <div>
                    <label className="text-[10px] text-zinc-400 block mb-1">Offset Minutes (optional)</label>
                    <input
                      type="number"
                      value={cond.offsetMinutes ?? ""}
                      onChange={(e) => updateMetadataCondition(idx, { offsetMinutes: e.target.value ? parseInt(e.target.value) : undefined })}
                      placeholder="e.g., 30"
                      className="w-full px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={addMetadataCondition}
              className="text-xs text-blue-400 hover:text-blue-300 py-1 flex items-center gap-1"
            >
              + Add metadata condition
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-zinc-700 pt-5">
        <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">
          Deduplication
        </label>
        <label className="flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={value.requiresNoPreviousTaskOfType === true}
            onChange={(e) =>
              onChange({
                ...value,
                requiresNoPreviousTaskOfType: e.target.checked ? true : undefined,
              })
            }
            className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-blue-500 cursor-pointer"
          />
          <div>
            <div className="text-sm text-zinc-300 font-medium group-hover:text-white transition-colors">
              Block if a previous open task of this type exists
            </div>
            <div className="text-[10px] text-zinc-600 mt-0.5">
              Prevents duplicate tasks of the same type for the same order. Recommended for most rules.
            </div>
          </div>
        </label>
      </div>

      <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg px-3 py-2.5">
        <div className="text-[10px] text-zinc-500 mb-1 font-semibold uppercase tracking-wider">Trigger summary</div>
        <p className="text-xs text-zinc-300 leading-relaxed">
          Fire when order status is{" "}
          <span className="font-mono text-blue-300">
            {(value?.statusIn?.length ?? 0) > 0 ? value?.statusIn?.join(" or ") : "—"}
          </span>
          {value.minutesSinceCreated !== undefined && (
            <>, order is at least <span className="font-mono text-amber-300">{fmtOffset(value.minutesSinceCreated)}</span> old</>
          )}
          {value.minutesSinceStatusUpdated !== undefined && (
            <>, status unchanged for <span className="font-mono text-amber-300">{fmtOffset(value.minutesSinceStatusUpdated)}</span></>
          )}
          {value.minutesBeforeAppointment !== undefined && (
            <>, appointment is within <span className="font-mono text-amber-300">{fmtOffset(value.minutesBeforeAppointment)}</span></>
          )}
          {value.minutesAfterAppointment !== undefined && (
            <>, appointment was <span className="font-mono text-amber-300">{fmtOffset(value.minutesAfterAppointment)}</span> ago or more</>
          )}
          {(value?.metadataConditions || []).length > 0 && (
            <>, and <span className="font-mono text-amber-300">{(value?.metadataConditions || []).length} metadata condition(s)</span></>
          )}
          {value.requiresNoPreviousTaskOfType && (
            <>, and no open task of this type exists</>
          )}
          .
        </p>
      </div>
    </div>
  );
}

function TimingRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const enabled = value !== undefined;
  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
      enabled ? "bg-zinc-800 border-zinc-600" : "bg-zinc-900 border-zinc-800"
    }`}>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onChange(e.target.checked ? 30 : undefined)}
        className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-blue-500 cursor-pointer shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className={`text-xs font-medium mb-0.5 transition-colors ${enabled ? "text-zinc-200" : "text-zinc-500"}`}>
          {label}
        </div>
        <div className="text-[10px] text-zinc-600">{hint}</div>
      </div>
      {enabled && (
        <div className="flex items-center gap-1.5 shrink-0">
          <input
            type="number"
            min={0}
            value={value}
            onChange={(e) => onChange(parseInt(e.target.value) || 0)}
            className="w-20 px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded-lg text-xs text-white text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-[10px] text-zinc-500">min</span>
        </div>
      )}
    </div>
  );
}

const EMPTY_TRIGGER: TriggerCondition = {
  statusIn: [],
  requiresNoPreviousTaskOfType: true,
  metadataConditions: [],
};

// W5.2 — RuleDrawer reports a "Simulate" click back to the panel which
// owns the modal state. Lifting the modal up means the simulator survives
// closing the drawer (so authors can reference it while making edits).
interface RuleDrawerProps_OnSimulate { onSimulate?: (req: SimRequest) => void }
interface RuleDrawerProps {
  rule: TaskRule | null;
  allTags: SkillTag[];
  chains: EscalationChain[];
  metadataFields: any[];
  orderStatuses: string[];
  onClose: () => void;
  onSaved: () => void;
  onSimulate?: (req: SimRequest) => void;
}

// W4.2 — descriptions surface what each strategy actually does so authors
// don't have to guess. The engine uses these names verbatim (see
// pickAssignee in lib/engine/taskCreator.ts).
const ASSIGNMENT_STRATEGIES = [
  { value: "default",        label: "Default (Least Loaded + Round Robin)",
    description: "Pick the agent with the fewest open tasks; if tied, rotate." },
  { value: "least_loaded",   label: "Least Loaded",
    description: "Same as Default — pick the agent with the fewest open tasks." },
  { value: "round_robin",    label: "Round Robin",
    description: "Rotate evenly across all eligible agents, ignoring current load." },
  { value: "store_affinity", label: "Store Affinity",
    description: "Prefer agents assigned to the order's store; least-loaded among them." },
  { value: "skill_based",    label: "Skill Based",
    description: "Prefer agents matching the most required skills; least-loaded among them." },
];

function RuleDrawer({ rule, allTags, chains, metadataFields, orderStatuses, onClose, onSaved, onSimulate }: RuleDrawerProps) {
  const isCreate = rule === null;

  const [form, setForm] = useState({
    name: rule?.name ?? "",
    titleTemplate: rule?.titleTemplate ?? "{{patientName}} — ",
    slaMinutes: rule?.slaMinutes ?? 30,
    priority: rule?.priority ?? "HIGH",
    pollingIntervalMinutes: rule?.pollingIntervalMinutes ?? 15,
    escalationChainId: rule?.escalationChain?.id ? String(rule.escalationChain.id) : "",
  });
  const [trigger, setTrigger] = useState<TriggerCondition>(
    rule?.triggerCondition ?? { ...EMPTY_TRIGGER }
  );
  const [skillIds, setSkillIds] = useState<Set<number>>(
    new Set(rule?.requiredSkills.map((s) => s.id) ?? [])
  );

  // Data source state
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [dataSourceId, setDataSourceId] = useState<string>(rule?.dataSourceId ?? "");
  const [selectedSource, setSelectedSource] = useState<DataSource | null>(null);
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [availableStatuses, setAvailableStatuses] = useState<string[]>([]);
  const [loadingEnums, setLoadingEnums] = useState(false);
  // W4.3 — observed metadata keys from the chosen source (last 25 rows).
  const [sourceKeys, setSourceKeys] = useState<SourceKey[]>([]);
  const [allowedTypes, setAllowedTypes] = useState<string[]>(rule?.allowedTypes ?? []);
  const [allowedStatuses, setAllowedStatuses] = useState<string[]>(rule?.allowedStatuses ?? []);
  const [assignmentStrategy, setAssignmentStrategy] = useState<string>(rule?.assignmentStrategy ?? "default");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<"source" | "trigger" | "basics" | "assignment" | "checklist">("source");

  // Load data sources immediately on mount
  useEffect(() => {
    setLoadingSources(true);
    fetch("/api/data-sources")
      .then((r) => r.ok ? r.json() : { dataSources: [] })
      .then((d) => {
        const active: DataSource[] = (d.dataSources ?? []).filter((s: DataSource) => s.isActive);
        setDataSources(active);
        // Pre-select existing source if editing
        if (dataSourceId) {
          const found = active.find((s) => s.id === dataSourceId) ?? null;
          setSelectedSource(found);
        }
      })
      .finally(() => setLoadingSources(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load entity types & statuses when source is selected
  useEffect(() => {
    if (!selectedSource) {
      setAvailableTypes([]);
      setAvailableStatuses([]);
      setSourceKeys([]);
      return;
    }
    // Strip schema prefix (public."Table" → "Table") then strip surrounding quotes ("Table" → Table)
    const table = selectedSource.tableReference.replace(/^.*\./, "").replace(/^"(.+)"$/, "$1");
    setLoadingEnums(true);
    Promise.all([
      fetch(`/api/data-sources/column-enums?table=${encodeURIComponent(table)}&column=${encodeURIComponent(selectedSource.typeFieldName)}`).then((r) => r.ok ? r.json() : { values: [] }),
      fetch(`/api/data-sources/column-enums?table=${encodeURIComponent(table)}&column=${encodeURIComponent(selectedSource.statusFieldName)}`).then((r) => r.ok ? r.json() : { values: [] }),
      // W4.3 — observed metadata-key autocomplete data
      fetch(`/api/data-sources/${selectedSource.id}/metadata-keys?sample=25`).then((r) => r.ok ? r.json() : { keys: [] }),
    ]).then(([typeData, statusData, keysData]) => {
      setAvailableTypes(typeData.values ?? []);
      setAvailableStatuses(statusData.values ?? []);
      setSourceKeys(keysData.keys ?? []);
    }).finally(() => setLoadingEnums(false));
  }, [selectedSource]);

  function toggleSkill(id: number) {
    const next = new Set(skillIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSkillIds(next);
  }

  function toggleType(type: string) {
    setAllowedTypes((prev) => prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]);
  }

  function toggleStatus(status: string) {
    setAllowedStatuses((prev) => prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]);
  }

  function handleSourceSelect(id: string) {
    setDataSourceId(id);
    const src = dataSources.find((s) => s.id === id) ?? null;
    setSelectedSource(src);
    setAllowedTypes([]);
    setAllowedStatuses([]);
  }

  async function submit(e: React.FormEvent, opts?: { asDraft?: boolean }) {
    e.preventDefault();
    setError("");

    // Validate source is selected (must be first — every other field's
    // validity depends on it)
    if (!dataSourceId) {
      setError("Please select a data source first.");
      setActiveTab("source");
      return;
    }

    // Drafts skip the "must have at least one status" requirement so the
    // author can save partial work and come back to it. The API still
    // requires statusIn on save (to keep the data shape valid) — for drafts
    // we send a placeholder that the engine won't match (empty array isn't
    // allowed by the schema).
    const isDraft = opts?.asDraft === true;
    if (!isDraft) {
      if (!(trigger?.statusIn?.length ?? 0)) {
        setError("Select at least one status in the Trigger tab.");
        setActiveTab("trigger");
        return;
      }
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        titleTemplate: form.titleTemplate,
        slaMinutes: Number(form.slaMinutes),
        priority: form.priority,
        // pollingIntervalMinutes intentionally omitted on save — it lives on
        // the data source. Kept in form state for display only.
        triggerCondition: trigger?.statusIn?.length ? trigger : { ...trigger, statusIn: ["__DRAFT__"] },
        escalationChainId: form.escalationChainId ? Number(form.escalationChainId) : null,
        skillTagIds: Array.from(skillIds),
        dataSourceId: dataSourceId || null,
        allowedTypes,
        allowedStatuses,
        assignmentStrategy,
        isDraft,
      };

      const url = isCreate ? "/api/task-rules" : `/api/task-rules/${rule!.id}`;
      const method = isCreate ? "POST" : "PATCH";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        // zod gives us per-field reasons — show the first one if available
        const r = data.details?.reason ? ` (${data.details.field}: ${data.details.reason})` : "";
        setError((data.error ?? "Save failed") + r);
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule() {
    if (!rule) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/task-rules/${rule.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Delete failed"); setConfirmDelete(false); return; }
      onSaved();
      onClose();
    } finally {
      setDeleting(false);
    }
  }

  // Remove tasks this rule created by mistake — archives them (recoverable) and
  // cancels the open ones, so they leave every board and free the dedup slot
  // for a corrected rule to re-create the right tasks.
  async function purgeTasks() {
    if (!rule) return;
    setPurging(true);
    setError("");
    try {
      const countRes = await fetch(`/api/task-rules/${rule.id}/purge-tasks`);
      const counts = await countRes.json().catch(() => ({ open: 0, total: 0 }));
      const open: number = counts.open ?? 0;
      const total: number = counts.total ?? 0;
      if (total === 0) { window.alert("This rule has no tasks to remove."); return; }
      const ok = window.confirm(
        `Remove all ${total} task${total === 1 ? "" : "s"} created by "${rule.name}"?\n\n` +
        `${open} open ${open === 1 ? "task" : "tasks"} will be cancelled, and all ${total} archived ` +
        `(recoverable from the Archived Tasks board). The corrected rule can re-create tasks on the next cycle.`,
      );
      if (!ok) return;
      const res = await fetch(`/api/task-rules/${rule.id}/purge-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "Failed to remove tasks"); return; }
      onSaved();
      window.alert(`Removed ${data.removed ?? 0} task${data.removed === 1 ? "" : "s"}.`);
    } finally {
      setPurging(false);
    }
  }

  const TABS = [
    { key: "source",      label: "Data Source" },
    { key: "trigger",     label: "Trigger" },
    { key: "basics",      label: "Basics" },
    { key: "assignment",  label: "Assignment" },
    { key: "checklist",   label: "Checklist" },
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-zinc-900 border-l border-zinc-800 h-full flex flex-col shadow-2xl overflow-hidden">
        <div className="px-6 pt-5 pb-0 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white">
                {isCreate ? "Create Task Rule" : "Edit Task Rule"}
              </h2>
              {!isCreate && (
                <p className="text-[10px] text-zinc-600 mt-0.5 font-mono">{rule!.id}</p>
              )}
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex gap-0">
            {TABS.map((tab) => {
              // W3.1: Trigger / Basics / Assignment are useless until a Source
              // is picked (statuses+types come from the source). Disable the
              // tab buttons rather than showing a low-fidelity dead-end.
              const isLocked = tab.key !== "source" && !dataSourceId;
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => !isLocked && setActiveTab(tab.key)}
                  disabled={isLocked}
                  title={isLocked ? "Pick a data source first" : undefined}
                  className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                    isActive
                      ? "border-blue-500 text-blue-400"
                      : isLocked
                        ? "border-transparent text-zinc-700 cursor-not-allowed"
                        : "border-transparent text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {tab.label}
                  {isLocked && (
                    <svg className="ml-1 w-3 h-3 inline-block align-middle" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  )}
                  {tab.key === "source" && !dataSourceId && !isLocked && (
                    <span className="ml-1 w-1.5 h-1.5 rounded-full bg-red-500 inline-block align-middle" title="Required" />
                  )}
                  {tab.key === "source" && dataSourceId && (
                    <span className="ml-1 w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block align-middle" />
                  )}
                  {tab.key === "trigger" && !isLocked && trigger?.statusIn?.length === 0 && (
                    <span className="ml-1 w-1.5 h-1.5 rounded-full bg-amber-500 inline-block align-middle" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <form id="rule-form" onSubmit={submit} className="flex-1 overflow-y-auto">
          <div className="px-6 py-5">
            {activeTab === "basics" && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5 font-medium">
                    Rule Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    required
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. HSC: Confirm Sample Collected"
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5 font-medium">
                    Polling Interval
                  </label>
                  {/*
                    W3.3 — The polling cadence is a property of the data source,
                    not the rule. Showing the source's value as read-only here
                    so authors aren't misled into thinking the rule overrides it.
                  */}
                  <div className="px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-400 flex items-center justify-between">
                    <span>
                      Every <span className="text-zinc-200 font-medium">{selectedSource?.pollingIntervalMinutes ?? "—"} min</span>
                    </span>
                    <span className="text-[10px] text-zinc-600">
                      governed by data source
                    </span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5 font-medium">
                    Task Title Template <span className="text-red-400">*</span>
                  </label>
                  <input
                    required
                    type="text"
                    value={form.titleTemplate}
                    onChange={(e) => setForm({ ...form, titleTemplate: e.target.value })}
                    placeholder="e.g. {{patientName}} — Confirm Sample Collected"
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-[10px] text-zinc-600 mt-1">
                    Available variables{selectedSource ? ` (${selectedSource.displayName})` : ""}:{" "}
                    {titleVarsForSource(selectedSource, sourceKeys).map((name) => {
                      const v = `{{${name}}}`;
                      return (
                        <code
                          key={name}
                          onClick={() => setForm({ ...form, titleTemplate: form.titleTemplate + v })}
                          className="cursor-pointer text-zinc-400 hover:text-blue-400 mr-1 transition-colors"
                          title="Click to insert"
                        >
                          {v}
                        </code>
                      );
                    })}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1.5 font-medium">
                      Priority <span className="text-red-400">*</span>
                    </label>
                    <select
                      value={form.priority}
                      onChange={(e) => setForm({ ...form, priority: e.target.value })}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1.5 font-medium">
                      SLA (minutes) <span className="text-red-400">*</span>
                    </label>
                    <div className="relative">
                      <input
                        required
                        type="number"
                        min={1}
                        value={form.slaMinutes}
                        onChange={(e) => setForm({ ...form, slaMinutes: parseInt(e.target.value) || 30 })}
                        className="w-full px-3 py-2 pr-16 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 font-mono">
                        = {fmtSla(form.slaMinutes)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "trigger" && (
              <>
                {!dataSourceId && (
                  <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                    <svg className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <p className="text-xs text-amber-400">
                      Select a data source first — the status list will be loaded from your source's schema.
                    </p>
                  </div>
                )}
                <TriggerBuilder
                  value={trigger}
                  onChange={setTrigger}
                  metadataFields={metadataFields}
                  sourceKeys={sourceKeys}
                  orderStatuses={availableStatuses.length > 0 ? availableStatuses : orderStatuses}
                />
              </>
            )}

            {activeTab === "assignment" && (
              <div className="space-y-6">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">
                    Assignment Strategy
                  </label>
                  <p className="text-[10px] text-zinc-600 mb-3">
                    How tasks created by this rule are distributed among eligible agents.
                  </p>
                  <select
                    value={assignmentStrategy}
                    onChange={(e) => setAssignmentStrategy(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {ASSIGNMENT_STRATEGIES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-zinc-500 mt-2 italic">
                    {ASSIGNMENT_STRATEGIES.find((s) => s.value === assignmentStrategy)?.description}
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">
                    Required Skills
                  </label>
                  <p className="text-[10px] text-zinc-600 mb-3">
                    Only agents with ALL selected skills will be considered for assignment.
                  </p>
                  {allTags.length === 0 ? (
                    <p className="text-xs text-zinc-600">No skill tags defined. Create them in the Team section.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allTags.map((tag) => {
                        const has = skillIds.has(tag.id);
                        return (
                          <button
                            key={tag.id}
                            type="button"
                            onClick={() => toggleSkill(tag.id)}
                            className={`text-xs px-3 py-1.5 rounded-full border transition-colors font-medium ${
                              has
                                ? "bg-blue-600/20 border-blue-500/40 text-blue-300 hover:bg-red-500/20 hover:border-red-500/40 hover:text-red-300"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                          >
                            {has ? "✓ " : "+ "}{tag.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">
                    Escalation Chain
                  </label>
                  <p className="text-[10px] text-zinc-600 mb-3">
                    When a task from this rule breaches SLA, which chain should fire?
                  </p>
                  <select
                    value={form.escalationChainId}
                    onChange={(e) => setForm({ ...form, escalationChainId: e.target.value })}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">— No escalation chain —</option>
                    {chains.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  {chains.length === 0 && (
                    <p className="text-[10px] text-zinc-600 mt-1.5">No chains defined. Create them in the Escalations section.</p>
                  )}
                </div>
              </div>
            )}

            {activeTab === "checklist" && (
              <div className="space-y-3">
                {isCreate ? (
                  <div className="px-3 py-3 bg-amber-600/10 border border-amber-700/30 rounded-lg">
                    <p className="text-[11px] text-amber-300 leading-relaxed">
                      Save the rule first. Once it has a task type assigned, the
                      checklist editor will appear here.
                    </p>
                  </div>
                ) : rule?.id && rule?.taskType?.id ? (
                  /* Checklist is scoped to THIS rule (rows keyed by taskRuleId),
                     seeded from the task-type default on first edit — so editing
                     one rule never mutates another that shares the task type. */
                  <ChecklistEditor ruleId={rule.id} />
                ) : (
                  <div className="px-3 py-3 bg-zinc-800/40 border border-zinc-700 rounded-lg">
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      No task type associated with this rule yet — checklist
                      editing isn&apos;t available. Save the rule with a task
                      type to enable this tab.
                    </p>
                  </div>
                )}
              </div>
            )}

            {activeTab === "source" && (
              <div className="space-y-5">
                {/* Step instruction */}
                <div className="flex items-start gap-3 px-3 py-3 bg-blue-600/10 border border-blue-700/30 rounded-lg">
                  <svg className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-[11px] text-blue-300 leading-relaxed">
                    Start by picking the data source this rule monitors. The entity types and statuses below are loaded directly from that source's schema.
                  </p>
                </div>

                {/* Data source picker */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">
                    Data Source <span className="text-red-400 normal-case font-normal ml-1">required</span>
                  </label>
                  {loadingSources ? (
                    <div className="text-zinc-500 text-xs py-2">Loading sources…</div>
                  ) : dataSources.length === 0 ? (
                    <div className="px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-400">
                      No active data sources found. Register one in the Data Sources panel first.
                    </div>
                  ) : (
                    <select
                      value={dataSourceId}
                      onChange={(e) => handleSourceSelect(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="">— Select a data source —</option>
                      {dataSources.map((s) => (
                        <option key={s.id} value={s.id}>{s.displayName} ({s.sourceId})</option>
                      ))}
                    </select>
                  )}

                  {selectedSource && (
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500">
                      <span>Table: <code className="bg-zinc-800 px-1 rounded text-zinc-400">{selectedSource.tableReference}</code></span>
                      <span>Type field: <code className="bg-zinc-800 px-1 rounded text-zinc-400">{selectedSource.typeFieldName}</code></span>
                      <span>Status field: <code className="bg-zinc-800 px-1 rounded text-zinc-400">{selectedSource.statusFieldName}</code></span>
                    </div>
                  )}
                </div>

                {selectedSource && (
                  <>
                    {/* Entity type filter */}
                    <div>
                      <label className="block text-xs font-semibold text-zinc-400 mb-1 uppercase tracking-wider">
                        Filter by Entity Type
                      </label>
                      <p className="text-[10px] text-zinc-600 mb-2">Only process entities of these types. Leave empty to match all.</p>
                      {loadingEnums ? (
                        <div className="text-zinc-500 text-xs">Loading…</div>
                      ) : availableTypes.length === 0 ? (
                        <div className="text-zinc-600 text-xs italic">No enum values found — all types will match</div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {availableTypes.map((type) => (
                            <button
                              key={type}
                              type="button"
                              onClick={() => toggleType(type)}
                              className={`text-xs px-3 py-1.5 rounded-full border transition-colors font-medium ${
                                allowedTypes.includes(type)
                                  ? "bg-blue-600/25 border-blue-500/50 text-blue-300"
                                  : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-blue-500/40 hover:text-zinc-300"
                              }`}
                            >
                              {allowedTypes.includes(type) && <span className="mr-1">✓</span>}
                              {type}
                            </button>
                          ))}
                        </div>
                      )}
                      {allowedTypes.length === 0 && availableTypes.length > 0 && (
                        <p className="text-[10px] text-zinc-500 mt-1.5">All entity types will be evaluated</p>
                      )}
                    </div>

                    {/* Next step nudge */}
                    <div className="pt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => setActiveTab("trigger")}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded-lg transition-colors"
                      >
                        Next: Configure Trigger
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </form>

        <div className="px-6 py-4 border-t border-zinc-800 flex items-center gap-2">
          {!isCreate && (
            <div className="mr-auto flex items-center gap-2">
              {!confirmDelete ? (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Delete Rule
                  </button>
                  <button
                    type="button"
                    onClick={purgeTasks}
                    disabled={purging}
                    title="Archive every task this rule created (open ones are cancelled). Recoverable from Archived Tasks."
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-600 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20 7L9.5 17.5 4 12" opacity="0" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M9 8V6a2 2 0 012-2h2a2 2 0 012 2v2m-7 4l6 6m0-6l-6 6" />
                    </svg>
                    {purging ? "Removing…" : "Clear tasks"}
                  </button>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <button onClick={deleteRule} disabled={deleting} className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors">
                    {deleting ? "Deleting..." : "Confirm Delete"}
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className="text-xs text-zinc-500 hover:text-zinc-300 px-2 transition-colors">Cancel</button>
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400 flex-1">{error}</p>
          )}

          <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
            Cancel
          </button>

          {/*
            W5.2 — Simulate. Sends the current form state (unsaved) to the
            simulator so authors can verify a change before clicking Save.
            For an EXISTING rule, sends the saved ruleId so dedup info is
            included in the simulation.
          */}
          {onSimulate && (
            <button
              type="button"
              onClick={() => {
                if (!isCreate && rule) {
                  onSimulate({ ruleId: rule.id, limit: 100 });
                  return;
                }
                if (!dataSourceId || !(trigger?.statusIn?.length)) {
                  setError("Pick a data source and at least one status to simulate.");
                  return;
                }
                onSimulate({
                  rule: {
                    dataSourceId,
                    allowedTypes,
                    allowedStatuses,
                    triggerType: "TIME",
                    triggerCondition: trigger,
                    titleTemplate: form.titleTemplate || "{{patientName}} — {{orderId}}",
                  },
                  limit: 100,
                });
              }}
              disabled={saving || !dataSourceId}
              title={!dataSourceId ? "Pick a data source first" : "Dry-run against last 100 orders — no tasks created"}
              className="px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-300 text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              ▶ Simulate
            </button>
          )}

          {/*
            W3.2 — Save-as-Draft. The rule lands inactive (won't fire) but
            persisted, so authors can step away and resume. The API skips
            the per-source status-validation for drafts so partial work
            (no source-specific status picked yet) can still save.
          */}
          {isCreate && (
            <button
              type="button"
              onClick={(e) => submit(e as unknown as React.FormEvent, { asDraft: true })}
              disabled={saving || !dataSourceId}
              title={!dataSourceId ? "Pick a data source first" : "Save inactive draft — won't fire until activated"}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save as Draft"}
            </button>
          )}
          <button
            type="submit"
            form="rule-form"
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : isCreate ? "Create Rule" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TriggerSummary({ cond }: { cond: TriggerCondition }) {
  const parts: string[] = [];
  if ((cond?.statusIn?.length ?? 0) > 0) parts.push(`Status: ${cond?.statusIn?.join(" | ")}`);
  if (cond?.minutesSinceCreated !== undefined) parts.push(`Order age ≥ ${fmtOffset(cond.minutesSinceCreated)}`);
  if (cond?.minutesSinceStatusUpdated !== undefined) parts.push(`Status unchanged ≥ ${fmtOffset(cond.minutesSinceStatusUpdated)}`);
  if (cond?.minutesBeforeAppointment !== undefined) parts.push(`Appt within ${fmtOffset(cond.minutesBeforeAppointment)}`);
  if (cond?.minutesAfterAppointment !== undefined) parts.push(`${fmtOffset(cond.minutesAfterAppointment)} post-appt`);
  if (cond?.requiresNoPreviousTaskOfType) parts.push("No duplicate");
  if ((cond?.metadataConditions || []).length > 0) parts.push(`${(cond?.metadataConditions || []).length} metadata condition(s)`);

  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map((p) => (
        <span key={p} className="text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-400 px-2 py-0.5 rounded font-mono">
          {p}
        </span>
      ))}
    </div>
  );
}

export default function TaskRulesPanel() {
  const [rules, setRules] = useState<TaskRule[]>([]);
  const [allTags, setAllTags] = useState<SkillTag[]>([]);
  const [chains, setChains] = useState<EscalationChain[]>([]);
  const [metadataFields, setMetadataFields] = useState<any[]>([]);
  const [orderStatuses, setOrderStatuses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [drawerRule, setDrawerRule] = useState<TaskRule | "create" | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // W5.2 — simulator modal target. Either a saved ruleId or an inline rule body.
  const [simulatorRequest, setSimulatorRequest] = useState<SimRequest | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, tagsRes, chainsRes, fieldsRes, orderStatusesRes] = await Promise.all([
        fetch("/api/task-rules"),
        fetch("/api/skill-tags"),
        fetch("/api/escalations"),
        fetch("/api/task-rules/metadata-fields"),
        fetch("/api/order-statuses"),
      ]);

      // Check response status
      if (!rulesRes.ok) {
        const err = await rulesRes.json();
        console.error("Failed to fetch task rules - Status:", rulesRes.status, "Error:", err);
        setRules([]);
      } else {
        const rulesData = await rulesRes.json();
        console.log("Task rules response:", rulesData);
        const fetchedRules = (rulesData.rules ?? rulesData ?? []) as TaskRule[];
        setRules(fetchedRules);
      }

      if (tagsRes.ok) {
        const tagsData = await tagsRes.json();
        setAllTags(tagsData.tags ?? []);
      }

      if (chainsRes.ok) {
        const chainsData = await chainsRes.json();
        setChains(chainsData.chains ?? []);
      }

      if (fieldsRes.ok) {
        const fieldsData = await fieldsRes.json();
        setMetadataFields(fieldsData.fields ?? []);
      }

      if (orderStatusesRes.ok) {
        const orderStatusesData = await orderStatusesRes.json();
        setOrderStatuses(orderStatusesData.statuses ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function toggleActive(rule: TaskRule) {
    setSaving(rule.id);
    try {
      const res = await fetch(`/api/task-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (!res.ok) return;
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, isActive: !r.isActive } : r));

      // Disabling stops NEW task creation but leaves already-open tasks in the
      // queue. If the rule still owns open tasks, offer to close them so they
      // leave Smart View immediately (see POST /close-open-tasks).
      const data = await res.json().catch(() => ({}));
      const openTaskCount: number = data?.openTaskCount ?? 0;
      if (!rule.isActive) return; // we just ENABLED it — nothing to close
      if (openTaskCount > 0 &&
          window.confirm(
            `Rule disabled. It still has ${openTaskCount} open task${openTaskCount === 1 ? "" : "s"}.\n\n` +
            `Close ${openTaskCount === 1 ? "it" : "them"} now? They'll be cancelled and leave Smart View. ` +
            `(Re-enabling the rule will re-create them if the source still matches.)`,
          )) {
        const closeRes = await fetch(`/api/task-rules/${rule.id}/close-open-tasks`, { method: "POST" });
        const closeData = await closeRes.json().catch(() => ({}));
        if (closeRes.ok) {
          fetchAll(); // refresh 24h/total counts on the row
          window.alert(`Closed ${closeData?.closed ?? 0} open task${closeData?.closed === 1 ? "" : "s"}.`);
        } else {
          window.alert("Couldn't close the open tasks — please try again.");
        }
      }
    } finally {
      setSaving(null);
    }
  }

  const activeCount = rules.filter((r) => r.isActive).length;
  // Group rules by data source display name
  const grouped = rules.reduce((acc, r) => {
    const groupKey = r.dataSource?.displayName ?? r.dataSourceId ?? "Unknown Source";
    acc[groupKey] = acc[groupKey] ?? [];
    acc[groupKey].push(r);
    return acc;
  }, {} as Record<string, TaskRule[]>);

  const drawerRuleObj = drawerRule === "create" ? null : drawerRule;

  return (
    <div className="space-y-6 px-6 py-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-white">Task Rules</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            {activeCount} of {rules.length} rules active — controls what tasks the engine auto-creates
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAll}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
          <button
            onClick={() => setDrawerRule("create")}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Rule
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <svg className="w-10 h-10 text-zinc-800 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          </svg>
          <p className="text-sm text-zinc-600 font-medium">No task rules yet</p>
          <button
            onClick={() => setDrawerRule("create")}
            className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Create your first rule →
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([sourceLabel, typeRules]) => (
            <div key={sourceLabel}>
              <div className="flex items-center gap-2 mb-3">
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold border text-blue-300 bg-blue-600/10 border-blue-700/40">
                  {sourceLabel}
                </span>
                <span className="text-xs text-zinc-600">{typeRules.length} rules</span>
              </div>

              <div className="space-y-2">
                {typeRules.map((rule) => {
                  const isSaving = saving === rule.id;
                  const isExpanded = expandedId === rule.id;

                  return (
                    <div
                      key={rule.id}
                      className={`bg-zinc-900 border rounded-xl overflow-hidden transition-all ${
                        rule.isActive ? "border-zinc-700" : "border-zinc-800 opacity-60"
                      }`}
                    >
                      <div className="px-4 py-3.5 flex items-center gap-3">
                        <button
                          onClick={() => toggleActive(rule)}
                          disabled={isSaving}
                          className={`relative shrink-0 w-9 h-5 rounded-full transition-colors focus:outline-none ${
                            rule.isActive ? "bg-blue-600" : "bg-zinc-700"
                          } ${isSaving ? "opacity-50" : ""}`}
                          title={rule.isActive ? "Disable" : "Enable"}
                        >
                          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                            rule.isActive ? "translate-x-4" : "translate-x-0.5"
                          }`} />
                        </button>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-medium text-zinc-200">{rule.name}</span>
                            {rule.dataSource && (
                              <span className="text-[10px] text-emerald-400 bg-emerald-900/20 border border-emerald-700/30 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                                </svg>
                                {rule.dataSource.displayName}
                              </span>
                            )}
                          </div>
                        </div>

                        <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${PRIORITY_COLORS[rule.priority] ?? ""}`}>
                          {rule.priority}
                        </span>

                        <span className="shrink-0 text-xs text-zinc-500 font-mono w-10 text-right">
                          {fmtSla(rule.slaMinutes)}
                        </span>

                        <button
                          onClick={() => setDrawerRule(rule)}
                          className="shrink-0 p-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                          title="Edit rule"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>

                        {/* W4.1 — Clone rule. Lands as inactive copy; opens edit drawer for review. */}
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            const res = await fetch(`/api/task-rules/${rule.id}/clone`, { method: "POST" });
                            const data = await res.json();
                            if (!res.ok) { alert(data.error ?? "Clone failed"); return; }
                            await fetchAll();
                            // Open the new clone in the drawer so author can tweak immediately
                            setDrawerRule(data.rule);
                          }}
                          className="shrink-0 p-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                          title="Clone rule"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>

                        {/* W5.2 — Simulate the saved rule against the last 100 orders. */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSimulatorRequest({ ruleId: rule.id, limit: 100 });
                          }}
                          className="shrink-0 p-1.5 rounded-lg text-zinc-600 hover:text-blue-300 hover:bg-zinc-800 transition-colors"
                          title="Simulate — dry-run against recent orders"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </button>

                        <div className="flex items-center gap-2.5 shrink-0 pl-2 border-l border-zinc-800">
                          <div className="text-center">
                            <div className="text-xs font-semibold text-zinc-300">{rule.tasksLast24h}</div>
                            <div className="text-[9px] text-zinc-600">24h</div>
                          </div>
                          <div className="text-center">
                            <div className="text-xs font-semibold text-zinc-500">{rule.totalTasksCreated}</div>
                            <div className="text-[9px] text-zinc-600">total</div>
                          </div>
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : rule.id)}
                            className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
                          >
                            <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-zinc-800 px-4 py-3 bg-zinc-900/50 space-y-3">
                          {/* Data source info */}
                          {rule.dataSource && (
                            <div className="flex flex-wrap gap-1.5">
                              <span className="flex items-center gap-1 text-[10px] bg-emerald-900/30 border border-emerald-700/40 text-emerald-400 px-2 py-0.5 rounded-full">
                                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                                </svg>
                                {rule.dataSource.displayName}
                                {rule.allowedTypes.length > 0 && (
                                  <span className="text-emerald-600">· {rule.allowedTypes.join(", ")}</span>
                                )}
                                {rule.allowedStatuses.length > 0 && (
                                  <span className="text-emerald-600">· {rule.allowedStatuses.join(", ")}</span>
                                )}
                              </span>
                            </div>
                          )}
                          <div>
                            <div className="text-[10px] text-zinc-600 mb-2 font-semibold uppercase tracking-wider">Trigger Conditions</div>
                            <TriggerSummary cond={rule.triggerCondition} />
                          </div>

                          {/* W5.1 — Rule metrics. Sits above Recent fires so the
                              author sees aggregate health before drilling into examples. */}
                          <RuleMetricsPanel ruleId={rule.id} />

                          {/* W3.4 — Recent fires: last 10 tasks this rule created. Lazy fetch on expand. */}
                          <div>
                            <div className="text-[10px] text-zinc-600 mb-2 font-semibold uppercase tracking-wider flex items-center justify-between">
                              <span>Recent fires</span>
                              <span className="text-zinc-700 normal-case font-normal">last 10</span>
                            </div>
                            <RecentFiresPanel ruleId={rule.id} />
                          </div>

                          <div className="flex items-start gap-6 text-xs">
                            <div>
                              <div className="text-[10px] text-zinc-600 mb-1 font-semibold uppercase tracking-wider">Skills</div>
                              {rule.requiredSkills.length === 0 ? (
                                <span className="text-zinc-600">Any agent</span>
                              ) : (
                                <div className="flex flex-wrap gap-1">
                                  {rule.requiredSkills.map((s) => (
                                    <span key={s.name} className="text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded">{s.label}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div>
                              <div className="text-[10px] text-zinc-600 mb-1 font-semibold uppercase tracking-wider">Escalation</div>
                              <span className="text-zinc-400">
                                {rule.escalationChain?.name ?? <span className="text-zinc-600">None</span>}
                              </span>
                            </div>
                            <div className="ml-auto">
                              <div className="text-[10px] text-zinc-600 mb-1 font-semibold uppercase tracking-wider">Title Template</div>
                              <code className="text-[10px] text-zinc-400 font-mono">{rule.titleTemplate}</code>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {drawerRule !== null && (
        <RuleDrawer
          rule={drawerRuleObj}
          allTags={allTags}
          chains={chains}
          metadataFields={metadataFields}
          orderStatuses={orderStatuses}
          onClose={() => setDrawerRule(null)}
          onSaved={fetchAll}
          onSimulate={(req) => setSimulatorRequest(req)}
        />
      )}

      {/* W5.2 — simulator modal */}
      {simulatorRequest && (
        <SimulatorModal request={simulatorRequest} onClose={() => setSimulatorRequest(null)} />
      )}
    </div>
  );
}

// ── Recent fires panel (W3.4) ────────────────────────────────────────────────
// Lazily fetches /api/task-rules/{id}/recent-fires when the user expands a
// rule card, so the rule list never pays for it on first paint.
function RecentFiresPanel({ ruleId }: { ruleId: string }) {
  const [fires, setFires] = useState<Array<{
    taskId: number;
    entityId: number;
    title: string;
    status: string;
    createdAt: string;
    isArchived: boolean;
    assignedToName: string | null;
  }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/task-rules/${ruleId}/recent-fires?limit=10`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((d) => { if (!cancelled) setFires(d.fires ?? []); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ruleId]);

  if (loading) {
    return (
      <div className="text-[11px] text-zinc-600 italic">Loading recent fires…</div>
    );
  }
  if (error) {
    return <div className="text-[11px] text-red-400">Failed to load: {error}</div>;
  }
  if (!fires || fires.length === 0) {
    return <div className="text-[11px] text-zinc-600">No tasks created yet.</div>;
  }

  return (
    <div className="space-y-1">
      {fires.map((f) => (
        <div key={f.taskId} className="flex items-center gap-2 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors">
          <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${statusDot(f.status)}`} title={f.status} />
          <span className="font-mono text-[10px] text-zinc-600 shrink-0">#{f.entityId}</span>
          <span className="truncate">{f.title}</span>
          <span className="ml-auto shrink-0 text-[10px] text-zinc-600">{relativeTime(f.createdAt)}</span>
          {f.assignedToName && (
            <span className="shrink-0 text-[10px] text-zinc-500">→ {f.assignedToName}</span>
          )}
          {f.isArchived && (
            <span className="shrink-0 text-[9px] text-zinc-700">archived</span>
          )}
        </div>
      ))}
    </div>
  );
}

function statusDot(status: string): string {
  switch (status) {
    case "COMPLETED": return "bg-emerald-500";
    case "ASSIGNED":
    case "IN_PROGRESS": return "bg-blue-500";
    case "BLOCKED":
    case "BREACHED": return "bg-red-500";
    case "CANCELLED": return "bg-zinc-600";
    default: return "bg-zinc-500";
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Rule metrics panel (W5.1) ───────────────────────────────────────────────
// Per-rule operational stats. Fetches /api/task-rules/{id}/metrics?range=7d
// when the user expands the card. Surfaces:
//   - completion / cancellation / breach rates (cancellation == false-positive proxy)
//   - average minutes-to-complete
//   - a tiny sparkline of fires-per-day so the author can see "is this rule
//     trending up or down" at a glance.
function RuleMetricsPanel({ ruleId }: { ruleId: string }) {
  const [range, setRange] = useState<"24h" | "7d" | "30d">("7d");
  const [data, setData] = useState<{
    totals: { fires: number; completed: number; cancelled: number; breached: number; active: number };
    ratios: { completionRate: number; cancelRate: number; breachRate: number };
    avgMinutesToComplete: number | null;
    firesByDay: Array<{ day: string; count: number }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/task-rules/${ruleId}/metrics?range=${range}`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ruleId, range]);

  return (
    <div>
      <div className="text-[10px] text-zinc-600 mb-2 font-semibold uppercase tracking-wider flex items-center justify-between">
        <span>Metrics</span>
        <div className="flex gap-1 normal-case font-normal">
          {(["24h", "7d", "30d"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                range === r ? "bg-blue-600/30 text-blue-300" : "text-zinc-600 hover:text-zinc-400"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-[11px] text-zinc-600 italic">Loading metrics…</div>
      ) : error ? (
        <div className="text-[11px] text-red-400">Failed to load: {error}</div>
      ) : !data || data.totals.fires === 0 ? (
        <div className="text-[11px] text-zinc-600">No fires in the last {range}.</div>
      ) : (
        <div className="space-y-2">
          {/* Totals + ratio chips */}
          <div className="grid grid-cols-5 gap-2 text-[10px]">
            <Stat label="Fires"     value={data.totals.fires}     />
            <Stat label="Done"      value={data.totals.completed} hint={`${data.ratios.completionRate}%`} valueClass="text-emerald-400" />
            <Stat label="Cancelled" value={data.totals.cancelled} hint={`${data.ratios.cancelRate}%`}     valueClass={data.ratios.cancelRate > 20 ? "text-amber-400" : "text-zinc-400"} title={data.ratios.cancelRate > 20 ? "False-positive rate is high — consider tightening the trigger" : undefined} />
            <Stat label="Breached"  value={data.totals.breached}  hint={`${data.ratios.breachRate}%`}     valueClass={data.totals.breached > 0 ? "text-red-400" : "text-zinc-400"} />
            <Stat label="Open"      value={data.totals.active}    valueClass="text-blue-400" />
          </div>

          <div className="flex items-center gap-3 text-[10px] text-zinc-500">
            {data.avgMinutesToComplete != null && (
              <span>Avg time to complete: <span className="text-zinc-300">{fmtAvgMins(data.avgMinutesToComplete)}</span></span>
            )}
          </div>

          {/* Sparkline — bars normalised to the largest day's count */}
          {data.firesByDay.length > 1 && (
            <div className="pt-1">
              <div className="text-[9px] text-zinc-700 mb-1 uppercase tracking-wider">Fires per day</div>
              <div className="flex items-end gap-0.5 h-8">
                {(() => {
                  const max = Math.max(...data.firesByDay.map((d) => d.count));
                  return data.firesByDay.map((d) => (
                    <div
                      key={d.day}
                      className="flex-1 bg-blue-500/40 hover:bg-blue-500/70 transition-colors rounded-t"
                      style={{ height: max > 0 ? `${(d.count / max) * 100}%` : "0%", minHeight: "2px" }}
                      title={`${d.day}: ${d.count}`}
                    />
                  ));
                })()}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint, valueClass = "text-zinc-300", title }: {
  label: string;
  value: number;
  hint?: string;
  valueClass?: string;
  title?: string;
}) {
  return (
    <div className="bg-zinc-800/40 rounded px-2 py-1.5" title={title}>
      <div className={`text-xs font-semibold ${valueClass}`}>{value}</div>
      <div className="text-[9px] text-zinc-600 leading-tight">
        {label}{hint && <span className="ml-1 text-zinc-700">{hint}</span>}
      </div>
    </div>
  );
}

function fmtAvgMins(mins: number): string {
  if (mins < 60) return `${mins.toFixed(1)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - h * 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ── Simulator Modal (W5.2) ───────────────────────────────────────────────────
// "Run this rule against the last N orders, show me which would fire and why."
// Accepts either a saved ruleId OR an inline rule body so authors can simulate
// edits before clicking Save.
type SimResult = {
  entityId: number;
  orderType: string;
  orderStatus: string;
  appointmentTime: string | null;
  patientName: string | null;
  storeName: string | null;
  wouldFire: boolean;
  wouldDedup: boolean;
  renderedTitle?: string;
  reason?: string;
  failedCheck?: string;
};

type SimRequest =
  | { ruleId: string; limit: number }
  | { rule: {
      dataSourceId: string;
      allowedTypes: string[];
      allowedStatuses: string[];
      triggerType: "TIME" | "STATUS";
      triggerCondition: TriggerCondition;
      titleTemplate: string;
    }; limit: number };

function SimulatorModal({
  request,
  onClose,
}: {
  request: SimRequest;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    ruleName: string;
    summary: {
      sampled: number;
      availableOrders: number;
      wouldFire: number;
      wouldDedup: number;
      wouldNotFire: number;
      failedChecks: Record<string, number>;
    };
    results: SimResult[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "fire" | "skip" | "dedup">("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/task-rules/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    })
      .then(async (r) => {
        // Safe-parse — when the server times out or 502s, the response
        // is an HTML error page and r.json() throws "Unexpected token <"
        // which leaks into the dialog as a useless error. Try JSON; fall
        // back to a status-based message so the user sees something
        // actionable like "503 — Labstack temporarily unavailable".
        const text = await r.text();
        let body: { error?: string; details?: { reason?: string }; [k: string]: unknown } | null = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* HTML or empty */ }
        if (!r.ok) {
          const msg =
            body?.details?.reason ||
            body?.error ||
            (r.status === 503
              ? "Source database is temporarily unavailable — try again in a moment"
              : `Server error (${r.status})`);
          throw new Error(msg);
        }
        if (!body) throw new Error("Simulator returned a non-JSON response");
        return body;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [JSON.stringify(request)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = data?.results.filter((r) => {
    if (filter === "all") return true;
    if (filter === "fire") return r.wouldFire;
    if (filter === "dedup") return r.wouldDedup;
    if (filter === "skip") return !r.wouldFire && !r.wouldDedup;
    return true;
  }) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="w-full max-w-5xl max-h-[90vh] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700">
          <div>
            <h3 className="text-sm font-semibold text-white">Rule Simulator</h3>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              Dry-run the rule against recent orders — no tasks are created.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-zinc-400 gap-3">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Simulating against orders…</span>
            </div>
          ) : error ? (
            <div className="px-5 py-8">
              <div className="text-sm text-red-400 mb-2">Simulation failed</div>
              <code className="text-[11px] text-zinc-500 break-all">{error}</code>
            </div>
          ) : !data ? (
            <div className="px-5 py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <div className="p-5 space-y-4">
              {/* Summary chips */}
              <div className="grid grid-cols-4 gap-2">
                <SummaryStat label="Sampled" value={data.summary.sampled} sub={`of ${data.summary.availableOrders} available`} />
                <SummaryStat label="Would Fire" value={data.summary.wouldFire} valueClass="text-emerald-400" />
                <SummaryStat label="Would Dedup" value={data.summary.wouldDedup} valueClass="text-amber-400" sub="already has open task" />
                <SummaryStat label="Would Skip" value={data.summary.wouldNotFire} valueClass="text-zinc-400" />
              </div>

              {/* Failed-check breakdown */}
              {Object.values(data.summary.failedChecks).some((n) => n > 0) && (
                <div className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg p-3">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">Why orders didn't match</div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(data.summary.failedChecks)
                      .filter(([, n]) => n > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([check, n]) => (
                        <span key={check} className="text-[11px] px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300">
                          {check}: <strong>{n}</strong>
                        </span>
                      ))}
                  </div>
                </div>
              )}

              {/* Filter tabs */}
              <div className="flex items-center gap-2 border-b border-zinc-800">
                {([
                  ["all",   `All (${data.results.length})`],
                  ["fire",  `Would Fire (${data.summary.wouldFire})`],
                  ["dedup", `Dedup (${data.summary.wouldDedup})`],
                  ["skip",  `Skip (${data.summary.wouldNotFire})`],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                      filter === key
                        ? "border-blue-500 text-blue-400"
                        : "border-transparent text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Results table */}
              {filtered.length === 0 ? (
                <div className="text-center py-8 text-sm text-zinc-500">No orders in this bucket.</div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    <tr>
                      <th className="text-left px-2 py-1.5 w-16"></th>
                      <th className="text-left px-2 py-1.5">Order</th>
                      <th className="text-left px-2 py-1.5">Type</th>
                      <th className="text-left px-2 py-1.5">Status</th>
                      <th className="text-left px-2 py-1.5">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.entityId} className="border-t border-zinc-800/60 hover:bg-zinc-800/40">
                        <td className="px-2 py-2">
                          {r.wouldFire ? (
                            <span className="inline-block px-1.5 py-0.5 text-[9px] rounded bg-emerald-500/20 text-emerald-400 border border-emerald-700/50">FIRE</span>
                          ) : r.wouldDedup ? (
                            <span className="inline-block px-1.5 py-0.5 text-[9px] rounded bg-amber-500/20 text-amber-400 border border-amber-700/50">DEDUP</span>
                          ) : (
                            <span className="inline-block px-1.5 py-0.5 text-[9px] rounded bg-zinc-700 text-zinc-400">SKIP</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-zinc-300">
                          <div className="font-mono">#{r.entityId}</div>
                          {r.patientName && <div className="text-zinc-500 text-[10px]">{r.patientName}</div>}
                        </td>
                        <td className="px-2 py-2 text-zinc-400">{r.orderType}</td>
                        <td className="px-2 py-2 text-zinc-400">{r.orderStatus}</td>
                        <td className="px-2 py-2 text-zinc-400">
                          {r.wouldFire && r.renderedTitle && (
                            <div className="text-zinc-300 truncate max-w-md" title={r.renderedTitle}>
                              → {r.renderedTitle}
                            </div>
                          )}
                          {r.wouldDedup && (
                            <div className="text-amber-400/80 text-[10px]">
                              already has an open task for this rule
                            </div>
                          )}
                          {r.reason && (
                            <div className="text-zinc-500 text-[10px]">
                              {r.failedCheck && <span className="text-zinc-600 mr-1">[{r.failedCheck}]</span>}
                              {r.reason}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {data && (
          <div className="px-5 py-2 border-t border-zinc-800 text-[10px] text-zinc-600">
            {data.ruleName} · simulator does not create tasks · pickAssignee not run
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryStat({ label, value, valueClass = "text-zinc-200", sub }: {
  label: string;
  value: number;
  valueClass?: string;
  sub?: string;
}) {
  return (
    <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-3 py-2">
      <div className={`text-lg font-semibold ${valueClass}`}>{value}</div>
      <div className="text-[10px] text-zinc-500 leading-tight">{label}</div>
      {sub && <div className="text-[9px] text-zinc-600 mt-0.5">{sub}</div>}
    </div>
  );
}
