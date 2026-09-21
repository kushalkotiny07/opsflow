"use client";

/**
 * Read-only render of a task's checklist — its steps (done/not), each step's
 * guidance + script, and the task-level "next step" chosen by whether the
 * required items are complete. Used inside the head entity drawers
 * (OrderQuickView / AppointmentQuickView) where checklists belong to the tasks
 * but the head observes rather than completes them (agents tick them off in
 * their own task drawer).
 */

export interface ChecklistViewItem {
  id: number;
  stepOrder: number;
  stepText: string;
  isRequired: boolean;
  isDone: boolean;
  guidance?: string | null;
  script?: string | null;
}

interface Props {
  items: ChecklistViewItem[];
  metadata?: Record<string, unknown> | null;
}

export default function TaskChecklistView({ items, metadata }: Props) {
  if (!items || items.length === 0) return null;

  const done = items.filter((i) => i.isDone).length;
  const requiredDone = items.every((i) => !i.isRequired || i.isDone);
  const ns = (metadata?.nextStep ?? null) as { complete?: string | null; incomplete?: string | null } | null;
  const nextStep = ns ? (requiredDone ? ns.complete : ns.incomplete) : null;

  return (
    <div className="mt-2.5 border-t border-zinc-700/60 pt-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Checklist</span>
        <span className="text-[10px] text-zinc-500">{done}/{items.length}</span>
      </div>
      <div className="space-y-2">
        {items.map((it) => (
          <div key={it.id} className="text-xs">
            <div className="flex items-start gap-2">
              <span className={`mt-0.5 shrink-0 ${it.isDone ? "text-emerald-500" : "text-zinc-600"}`}>
                {it.isDone ? "✓" : "○"}
              </span>
              <span className={it.isDone ? "text-zinc-500 line-through" : "text-zinc-200"}>
                {it.stepText}
                {it.isRequired && !it.isDone && <span className="ml-1.5 text-[10px] text-red-400 font-medium">required</span>}
              </span>
            </div>
            {(it.guidance || it.script) && (
              <div className="ml-5 mt-1 space-y-1">
                {it.guidance && (
                  <div className="text-[11px] leading-relaxed text-zinc-400">
                    <span className="text-zinc-600">Guidance: </span>
                    <span className="whitespace-pre-wrap">{it.guidance}</span>
                  </div>
                )}
                {it.script && (
                  <div className="text-[11px] leading-relaxed text-zinc-300 bg-zinc-900/70 border-l-2 border-blue-700/50 rounded-r px-2 py-1">
                    <span className="text-zinc-500 block text-[10px] uppercase tracking-wider mb-0.5">Script</span>
                    <span className="whitespace-pre-wrap italic">{it.script}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {nextStep && (
        <div className={`rounded-lg border px-2.5 py-2 ${requiredDone ? "border-emerald-700/40 bg-emerald-500/5" : "border-amber-700/40 bg-amber-500/5"}`}>
          <div className={`text-[10px] uppercase tracking-wider mb-0.5 ${requiredDone ? "text-emerald-400" : "text-amber-400"}`}>
            Next step {requiredDone ? "· complete" : "· incomplete"}
          </div>
          <div className="text-[11px] text-zinc-200 leading-relaxed whitespace-pre-wrap">{nextStep}</div>
        </div>
      )}
    </div>
  );
}
