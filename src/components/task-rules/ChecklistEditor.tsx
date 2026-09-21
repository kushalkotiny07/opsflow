"use client";

/**
 * ChecklistEditor — manages a task type's checklist template inside the
 * RuleForm "Checklist" tab. Add, remove, reorder, toggle required, and give
 * each step agent guidance (what to do) + a script (what to say).
 *
 * A checklist belongs to the TaskType, not the rule. Multiple rules can share
 * a task type, and editing here affects every rule that uses it (surfaced via
 * the activeRuleCount pill). Existing in-flight tasks are NOT updated — the
 * template only applies to tasks created after the save.
 *
 * Beyond the steps, the task type carries "next step" guidance shown in the
 * task drawer once the agent knows whether the checklist is complete.
 */
import { useState, useEffect, useCallback } from "react";

interface ChecklistItem {
  id?: number;
  stepText: string;
  isRequired: boolean;
  stepOrder: number;
  guidance?: string | null;
  script?: string | null;
}

interface ChecklistEditorProps {
  // The checklist is scoped to the RULE (not the shared task type), so editing
  // one rule never changes another. Null for an unsaved rule.
  ruleId: string | null;
}

export default function ChecklistEditor({ ruleId }: ChecklistEditorProps) {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [taskTypeLabel, setTaskTypeLabel] = useState<string>("");
  const [usingDefaults, setUsingDefaults] = useState<boolean>(false);
  const [nextStepComplete, setNextStepComplete] = useState<string>("");
  const [nextStepIncomplete, setNextStepIncomplete] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!ruleId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/task-rules/${ruleId}/checklist`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems((data.items ?? []) as ChecklistItem[]);
      setTaskTypeLabel(data.taskType?.label ?? data.taskType?.name ?? "");
      setUsingDefaults(!!data.usingDefaults);
      setNextStepComplete(data.nextStepComplete ?? "");
      setNextStepIncomplete(data.nextStepIncomplete ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load checklist");
    } finally {
      setLoading(false);
    }
  }, [ruleId]);

  useEffect(() => { load(); }, [load]);

  const addItem = () => {
    setItems((xs) => [...xs, { stepText: "", isRequired: true, stepOrder: xs.length, guidance: "", script: "" }]);
  };
  const removeItem = (idx: number) => {
    setItems((xs) => xs.filter((_, i) => i !== idx).map((it, i) => ({ ...it, stepOrder: i })));
  };
  const patch = (idx: number, p: Partial<ChecklistItem>) => {
    setItems((xs) => xs.map((it, i) => (i === idx ? { ...it, ...p } : it)));
  };
  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[idx], next[target]] = [next[target], next[idx]];
    setItems(next.map((it, i) => ({ ...it, stepOrder: i })));
  };

  const save = async () => {
    if (!ruleId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/task-rules/${ruleId}/checklist`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((it, i) => ({
            stepText: it.stepText,
            isRequired: it.isRequired,
            stepOrder: i,
            guidance: it.guidance ?? "",
            script: it.script ?? "",
          })),
          nextStepComplete,
          nextStepIncomplete,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setItems(data.items ?? []);
      setUsingDefaults(!!data.usingDefaults);
      setNextStepComplete(data.nextStepComplete ?? "");
      setNextStepIncomplete(data.nextStepIncomplete ?? "");
      setSavedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!ruleId) {
    return (
      <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-200 mb-2">Checklist</h3>
        <p className="text-xs text-zinc-500">
          Save the rule first — then its checklist can be edited here. This
          checklist is specific to this rule.
        </p>
      </div>
    );
  }

  const taField =
    "w-full px-2 py-1.5 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-600 resize-y";

  return (
    <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Checklist</h3>
          <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
            Specific to <span className="font-medium text-zinc-300">this rule</span>
            {taskTypeLabel ? <> (task type <span className="text-zinc-400">{taskTypeLabel}</span>)</> : null}.
            Each step can carry guidance + a script the agent sees in the task.
            Editing here affects only this rule&apos;s new tasks.
          </p>
        </div>
        {usingDefaults && (
          <span className="px-2 py-1 text-[10px] rounded bg-blue-500/10 text-blue-300 border border-blue-700/30 shrink-0">
            showing task-type defaults · saving makes a rule copy
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-xs text-zinc-500">Loading…</div>
      ) : (
        <>
          <div className="space-y-3">
            {items.length === 0 && (
              <div className="text-xs text-zinc-500 italic py-3">
                No checklist steps yet. Click &quot;Add step&quot; to start.
              </div>
            )}
            {items.map((it, idx) => (
              <div key={idx} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="flex flex-col">
                    <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0}
                      className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-30 leading-none" title="Move up">▲</button>
                    <button type="button" onClick={() => move(idx, 1)} disabled={idx === items.length - 1}
                      className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-30 leading-none" title="Move down">▼</button>
                  </div>
                  <span className="text-[10px] text-zinc-600 w-5">{idx + 1}.</span>
                  <input
                    type="text"
                    value={it.stepText}
                    onChange={(e) => patch(idx, { stepText: e.target.value })}
                    placeholder="e.g. Call patient to confirm appointment time"
                    className="flex-1 px-2 py-1.5 bg-zinc-950 border border-zinc-700 rounded text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-600"
                  />
                  <label className="flex items-center gap-1 text-[10px] text-zinc-400 shrink-0">
                    <input type="checkbox" checked={it.isRequired} onChange={() => patch(idx, { isRequired: !it.isRequired })} className="accent-blue-600" />
                    required
                  </label>
                  <button type="button" onClick={() => removeItem(idx)} className="text-xs text-red-400 hover:text-red-300 shrink-0" title="Remove">✕</button>
                </div>
                <div className="pl-9 grid grid-cols-1 gap-2">
                  <div>
                    <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Guidance — what to do</div>
                    <textarea rows={2} value={it.guidance ?? ""} onChange={(e) => patch(idx, { guidance: e.target.value })}
                      placeholder="Steps the agent should take for this item…" className={taField} />
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Script — what to say</div>
                    <textarea rows={2} value={it.script ?? ""} onChange={(e) => patch(idx, { script: e.target.value })}
                      placeholder={"e.g. “Hi, this is LabStack calling to confirm your appointment on…”"} className={taField} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Task-level next-step guidance */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 space-y-2">
            <div className="text-[11px] font-medium text-zinc-300">Next step</div>
            <p className="text-[10px] text-zinc-600 leading-relaxed -mt-1">
              Shown in the task drawer depending on whether the required checklist items are done.
            </p>
            <div>
              <div className="text-[10px] text-emerald-500 uppercase tracking-wider mb-1">If checklist complete</div>
              <textarea rows={2} value={nextStepComplete} onChange={(e) => setNextStepComplete(e.target.value)}
                placeholder="e.g. Mark the task done and hand off to the lab." className={taField} />
            </div>
            <div>
              <div className="text-[10px] text-amber-500 uppercase tracking-wider mb-1">If not complete</div>
              <textarea rows={2} value={nextStepIncomplete} onChange={(e) => setNextStepIncomplete(e.target.value)}
                placeholder="e.g. Keep chasing; if unreachable after 3 tries, escalate." className={taField} />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
            <button type="button" onClick={addItem} className="px-3 py-1.5 text-xs bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700">
              + Add step
            </button>
            <div className="flex items-center gap-3">
              {savedAt && !error && (<span className="text-[10px] text-emerald-400">Saved {savedAt.toLocaleTimeString()}</span>)}
              {error && (<span className="text-[10px] text-red-400">{error}</span>)}
              <button type="button" onClick={save} disabled={saving || items.some((it) => !it.stepText.trim())}
                className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500">
                {saving ? "Saving…" : "Save checklist"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
