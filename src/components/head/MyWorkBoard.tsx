"use client";

/**
 * MyWorkBoard — Phase 1 of the new task surface.
 *
 * Three tabs:
 *   Today    — sliding NOW (next 90 min) + LATER TODAY (hour-subdivided) + DONE
 *              + a conditional TONIGHT'S PREP section (appears after 4 PM IST)
 *   Tomorrow — early-morning callout (appts before 10 AM) + day summary
 *   Stuck    — flat list filterable by Age (today/yesterday/older) and Type
 *
 * Bucket assignment (today / tomorrow / stuck) is computed server-side and
 * arrives on each task as `viewBucket`. The sub-sections inside Today are
 * computed client-side so they react to clock ticks without re-hitting the API.
 *
 * Drawer: reuses OrderQuickView for Phase 1. Phase 3 introduces the abstract
 * task drawer that renders all order types from a single template.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatISTTimestamp, titleToIST } from "@/lib/utils/timezone";
import TaskDetailPanel from "@/components/agent/TaskDetailPanel";
import OrderQuickView from "@/components/shared/OrderQuickView";
import AppointmentQuickView from "@/components/shared/AppointmentQuickView";

// ─── Types ─────────────────────────────────────────────────────────────
interface Agent {
  id: number;
  name: string;
  role: string;
}

interface ChecklistItem {
  id: number;
  stepOrder: number;
  stepText: string;
  isRequired: boolean;
  isDone: boolean;
  doneAt: string | null;
}

interface Task {
  id: number;
  title: string;
  status: string;
  priority: string;
  orderType: string;
  // Source entity kind — "ORDER" (default/legacy), "APPOINTMENT", "PHARMAORDER"…
  // Gates order-only framing (phlebo prep) so non-Order tasks don't get
  // mislabelled "no phlebo yet".
  entityType?: string;
  entityId: number;
  storeId: number | null;
  appointmentTime: string | null;
  slaDeadline: string;
  slaBreachedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  snoozedUntil: string | null;
  metadata: Record<string, unknown>;
  assignedTo?: { id: number; name: string } | null;
  checklistItems: ChecklistItem[];
  taskType: { name: string; label: string };
  // Rule provenance — powers the workspace "Rule" filter. MANUAL tasks
  // carry the sentinel taskRuleId "MANUAL" (see /api/tasks POST).
  taskRuleId: string;
  taskRule?: { name?: string } | null;
  // Originating data source (flattened by /api/tasks) — powers the top-level
  // Data Source filter. Null for manual/anchor tasks.
  dataSource?: { id: string; sourceId: string; displayName: string } | null;
  // Computed by API:
  viewBucket: "today" | "tomorrow" | "stuck" | "future" | "done";
  urgencyBucket: number;
  slaStatus: "safe" | "warning" | "critical" | "breached";
  minutesRemaining: number;
}

// Subset of users a board page passes in — used to gate Lead-only UI
// (filter bar, reassign popover) and to scope row interactions.
interface CurrentUser {
  id: number;
  name: string;
  role: "OPS_HEAD" | "OPS_AGENT" | "STORE_ADMIN";
}

type Tab = "today" | "tomorrow" | "stuck";

// ─── Constants ─────────────────────────────────────────────────────────
const NOW_WINDOW_MIN = 90;
// Appointments up to this many minutes in the past still count as "NOW"
// (just slipped past, operator is likely on it). Anything older is OVERDUE.
const NOW_PAST_GRACE_MIN = 15;
const PREP_VISIBILITY_HOUR_IST = 16; // 4 PM IST — when tonight's prep becomes addressable
const EARLY_MORNING_CUTOFF_HOUR_IST = 10; // appts before 10 AM count as "early"
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ─── Entity-type pill ──────────────────────────────────────────────────
// Covers Order types plus the other data sources now surfaced on the board
// (Appointments: CENTER_VISIT / HOME_VISIT / ONLINE; PharmaOrder: PLACED-side
// types). Unknown types fall back to a titled label instead of a raw slice.
const TYPE_STYLES: Record<string, string> = {
  HOME_SAMPLE: "bg-blue-900/60 text-blue-300",
  CONSULTATION: "bg-purple-900/60 text-purple-300",
  PHARMACY: "bg-green-900/60 text-green-300",
  PHARMA: "bg-green-900/60 text-green-300",
  RADIOLOGY: "bg-violet-900/60 text-violet-300",
  MRI: "bg-violet-900/60 text-violet-300",
  INJECTION: "bg-pink-900/60 text-pink-300",
  MANUAL: "bg-zinc-800 text-zinc-300",
  // Appointment types
  CENTER_VISIT: "bg-teal-900/60 text-teal-300",
  HOME_VISIT: "bg-cyan-900/60 text-cyan-300",
  ONLINE: "bg-indigo-900/60 text-indigo-300",
};
const TYPE_LABEL: Record<string, string> = {
  HOME_SAMPLE: "HSC",
  CONSULTATION: "CONS",
  PHARMACY: "PHARMA",
  RADIOLOGY: "RAD",
  INJECTION: "INJ",
  MANUAL: "MANUAL",
  // Appointment types
  CENTER_VISIT: "CENTER",
  HOME_VISIT: "HOME",
  ONLINE: "ONLINE",
};
function typeStyle(orderType: string) {
  return TYPE_STYLES[orderType] ?? "bg-zinc-800 text-zinc-300";
}
function typeLabel(orderType: string) {
  if (TYPE_LABEL[orderType]) return TYPE_LABEL[orderType];
  // Unknown/other-source type: show the first token, spaces→nothing, cap at 8
  // chars so a pill stays compact but readable (e.g. "PARTIAL_DELIVERED"→"PARTIAL").
  return (orderType.split("_")[0] || orderType).slice(0, 8);
}

// ─── Time helpers ──────────────────────────────────────────────────────
function istHourOfDay(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();
}
function istMinutesSinceMidnight(d: Date): number {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function fmtHourHeader(hour24: number): string {
  const period = hour24 >= 12 ? "PM" : "AM";
  const h = ((hour24 + 11) % 12) + 1;
  return `${h} ${period}`;
}

// ─── Metadata accessors ───────────────────────────────────────────────
// Task.metadata carries an order snapshot written at creation time
// (storeName, phleboName, labName, patientName — see taskCreator). These
// power the store filter and the Stuck concentration callout without any
// extra fetch. Defensive: metadata can be null/partial on MANUAL tasks.
function metaStr(t: Task, key: string): string {
  const v = (t.metadata as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}
function storeNameOf(t: Task): string {
  return metaStr(t, "storeName") || (t.storeId != null ? `Store #${t.storeId}` : "");
}

// Phlebo assignment is an Order-collection concept (a phlebotomist visits to
// collect a sample). Appointment / other-source tasks have no phlebo, so the
// "no phlebo yet" prep framing must not apply to them. Treat a missing
// entityType as ORDER for legacy tasks created before entityType was stamped.
function hasPhleboWorkflow(t: Task): boolean {
  return (t.entityType ?? "ORDER") === "ORDER";
}

// ─── CSV export (client-side, mirrors the filtered view) ────────────────
// Excel-safe: UTF-8 BOM, CRLF rows, every cell quoted, and leading
// =/+/-/@ neutralised so a cell can't execute as a spreadsheet formula.
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}
function fmtIst(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "short",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
const SLA_LABEL: Record<Task["slaStatus"], string> = {
  breached: "Breached", critical: "Critical", warning: "Warning", safe: "In SLA",
};
function tasksToCsv(tasks: Task[]): string {
  const headers = [
    "Task ID", "Order ID", "Order Type", "Title", "Rule", "Patient", "Store",
    "Assignee", "Assigned", "Priority", "SLA Status", "Min Remaining",
    "SLA Deadline (IST)", "Breached At (IST)", "Appointment (IST)",
    "Status", "Bucket", "Created (IST)",
  ];
  const rows = tasks.map((t) => [
    t.id, t.entityId, t.orderType, t.title,
    t.taskRule?.name || t.taskRuleId,
    metaStr(t, "patientName"), storeNameOf(t),
    t.assignedTo?.name || "Unassigned", t.assignedTo ? "Yes" : "No",
    t.priority, SLA_LABEL[t.slaStatus], Math.round(t.minutesRemaining),
    fmtIst(t.slaDeadline), fmtIst(t.slaBreachedAt), fmtIst(t.appointmentTime),
    t.status, t.viewBucket, fmtIst(t.createdAt),
  ]);
  return "﻿" + [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Assignee chip ────────────────────────────────────────────────────
// Stable colour per name (hash → palette index) so the same agent reads as
// the same colour across rows without us hand-maintaining a map.
const AVATAR_PALETTE = [
  "bg-blue-700", "bg-purple-700", "bg-green-700", "bg-pink-700",
  "bg-orange-700", "bg-teal-700", "bg-indigo-700", "bg-rose-700",
];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function AssigneeChip({
  task,
  agents,
  onReassign,
  canReassign = true,
}: {
  task: Task;
  agents: Agent[];
  onReassign: (taskId: number, agentId: number | null) => void;
  // Agents can't reassign tasks — the chip becomes a read-only badge.
  canReassign?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Flip the menu upward when the chip sits low in the viewport, so the
  // agent list isn't clipped off the bottom of the panel.
  const [dropUp, setDropUp] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const toggleOpen = () => {
    if (!open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setAnchorRect(r);
      setDropUp(window.innerHeight - r.bottom < 320);
    }
    setOpen((v) => !v);
  };

  // Read-only mode for agents: render a static badge with no popover.
  if (!canReassign) {
    if (task.assignedTo) {
      return (
        <div className="flex items-center gap-1.5 px-1.5 py-0.5 shrink-0" title={task.assignedTo.name}>
          <span
            className={`w-5 h-5 rounded-full ${avatarColor(task.assignedTo.name)} flex items-center justify-center text-[9px] font-semibold text-white`}
          >
            {initials(task.assignedTo.name)}
          </span>
          <span className="text-xs text-zinc-300 max-w-[80px] truncate">{task.assignedTo.name}</span>
        </div>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded text-[11px] bg-yellow-900/40 text-yellow-300 border border-yellow-900/40 shrink-0">
        Unassigned
      </span>
    );
  }

  // Close popover on outside click (stops propagation to row's onClick too).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // Defer so the click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener("click", close), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", close);
    };
  }, [open]);

  const handlePick = async (agentId: number | null) => {
    setBusy(true);
    try {
      await onReassign(task.id, agentId);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div ref={anchorRef} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      {task.assignedTo ? (
        <button
          onClick={toggleOpen}
          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-zinc-700/50 transition-colors"
          title="Click to reassign"
        >
          <span
            className={`w-5 h-5 rounded-full ${avatarColor(task.assignedTo.name)} flex items-center justify-center text-[9px] font-semibold text-white`}
          >
            {initials(task.assignedTo.name)}
          </span>
          <span className="text-xs text-zinc-300 max-w-[80px] truncate">{task.assignedTo.name}</span>
        </button>
      ) : (
        <button
          onClick={toggleOpen}
          className="px-2 py-0.5 rounded text-[11px] bg-yellow-900/40 text-yellow-300 border border-yellow-900/40 hover:bg-yellow-900/60 transition-colors"
          title="Click to assign"
        >
          ⚠ Unassigned
        </button>
      )}

      {open && anchorRect && createPortal(
        // Rendered in a portal with fixed positioning so the menu escapes the
        // Focus/zone card's `overflow-hidden` (which used to clip it off the
        // bottom of the panel). Flips above the chip when it sits low.
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: Math.max(8, anchorRect.right - 224),
            ...(dropUp
              ? { bottom: window.innerHeight - anchorRect.top + 4 }
              : { top: anchorRect.bottom + 4 }),
          }}
          className="z-[100] w-56 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 max-h-72 overflow-y-auto"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
            {busy ? "Reassigning…" : task.assignedTo ? "Reassign to" : "Assign to"}
          </div>
          {agents.length === 0 ? (
            <div className="px-3 py-3 text-xs text-zinc-500 italic">No team members loaded.</div>
          ) : (
            agents.map((a) => (
              <button
                key={a.id}
                onClick={() => handlePick(a.id)}
                disabled={busy || a.id === task.assignedTo?.id}
                className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className={`w-5 h-5 rounded-full ${avatarColor(a.name)} flex items-center justify-center text-[9px] font-semibold text-white`}>
                  {initials(a.name)}
                </span>
                <span className="flex-1 truncate">{a.name}</span>
                {a.id === task.assignedTo?.id && <span className="text-[10px] text-zinc-500">current</span>}
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Row renderer ──────────────────────────────────────────────────────
function TaskRow({
  task,
  now,
  agents,
  onClick,
  onReassign,
  canReassign,
  rightBadge,
  onComplete,
}: {
  task: Task;
  now: Date;
  agents: Agent[];
  onClick: () => void;
  onReassign: (taskId: number, agentId: number | null) => void;
  canReassign: boolean;
  // Optional extra pill rendered next to SLA (used by Stuck view for age).
  rightBadge?: React.ReactNode;
  // Optional inline ✓ Done — passed by the Focus/Recover/Stuck zones where
  // the row is a checklist item to burn down, omitted where it's a preview.
  onComplete?: (taskId: number) => void;
}) {
  const appt = task.appointmentTime ? new Date(task.appointmentTime) : null;
  const diffMin = appt ? Math.round((appt.getTime() - now.getTime()) / 60_000) : null;

  // Friendlier delta formatting. Stuck-view tasks routinely show appts from
  // days/weeks ago; "14640m ago" forced operators to do mental math. Step
  // up through m → h → d → w / mo so anything older than ~1 hour reads as
  // a human duration. We keep the minute precision only inside the urgency
  // window (within 15 / 60 / 90 min) where it actually matters for triage.
  function formatDelta(minutes: number, future: boolean): string {
    const abs = Math.abs(minutes);
    let value: string;
    if (abs < 60) value = `${abs}m`;
    else if (abs < 60 * 24) value = `${Math.round(abs / 60)}h`;
    else if (abs < 60 * 24 * 7) value = `${Math.round(abs / (60 * 24))}d`;
    else if (abs < 60 * 24 * 30) value = `${Math.round(abs / (60 * 24 * 7))}w`;
    else value = `${Math.round(abs / (60 * 24 * 30))}mo`;
    return future ? `in ${value}` : `${value} ago`;
  }

  let timeColor = "text-zinc-300";
  let deltaText = "";
  let deltaColor = "text-zinc-500";
  if (diffMin !== null) {
    if (diffMin < -15) {
      timeColor = "text-zinc-600";
      deltaText = formatDelta(diffMin, false);
    } else if (diffMin <= 15) {
      timeColor = "text-red-400";
      deltaText = `in ${diffMin}m`;
      deltaColor = "text-red-400";
    } else if (diffMin <= 60) {
      timeColor = "text-orange-400";
      deltaText = `in ${diffMin}m`;
      deltaColor = "text-orange-400";
    } else if (diffMin <= 90) {
      timeColor = "text-yellow-400";
      deltaText = `in ${diffMin}m`;
      deltaColor = "text-yellow-500";
    } else {
      // > 90 min in the future — still soon enough to want a friendlier
      // label than "in 14400m" on tomorrow-or-later appts.
      deltaText = formatDelta(diffMin, true);
    }
  }

  // For appointments that aren't today, surface the date too — bare
  // "06:00 am" on a row whose appt was 10 days ago is misleading. We
  // detect "today IST" by IST day-key match (no timezone library needed).
  function istDayKey(d: Date): string {
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return `${ist.getUTCFullYear()}-${ist.getUTCMonth()}-${ist.getUTCDate()}`;
  }
  const apptLabel = appt
    ? (istDayKey(appt) === istDayKey(now)
        ? formatISTTimestamp(task.appointmentTime as string, { hour: "2-digit", minute: "2-digit" })
        : formatISTTimestamp(task.appointmentTime as string, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))
    : "—";

  return (
    <div
      className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 cursor-pointer hover:bg-zinc-800/40 transition-colors"
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div className="text-center w-16 shrink-0">
        <div className={`text-base font-semibold ${timeColor}`}>{apptLabel}</div>
        <div className={`text-[10px] ${deltaColor} uppercase tracking-wider`}>
          {deltaText || (appt ? "appt" : "no appt")}
        </div>
      </div>

      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider shrink-0 ${typeStyle(task.orderType)}`}>
        {typeLabel(task.orderType)}
      </span>

      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-zinc-100 truncate">{titleToIST(task.title)}</div>
        <div className="text-xs text-zinc-500 mt-0.5">#{task.entityId}</div>
      </div>

      {onComplete && task.status !== "COMPLETED" && task.status !== "CANCELLED" && (
        <button
          onClick={(e) => { e.stopPropagation(); onComplete(task.id); }}
          className="px-2 py-1 rounded text-[11px] font-medium border border-green-900 text-green-300 hover:bg-green-900/30 transition-colors shrink-0"
          title="Mark completed"
        >
          ✓ Done
        </button>
      )}

      <AssigneeChip task={task} agents={agents} onReassign={onReassign} canReassign={canReassign} />

      {rightBadge}

      {/* SLA / status pill — one urgency channel per row.
          Rules:
          - BLOCKED or snoozed → grey "Paused" chip. The breach-as-stick
            is the wrong signal when an agent is correctly waiting on an
            external party; rendering a red breach pill drives clear-not-
            resolve theatre.
          - Time block already coloured (appt within 90 min) → no SLA pill.
            The time block IS the urgency signal. A second red badge
            duplicates and dilutes it.
          - Otherwise → original SLA pill for breached/critical/warning. */}
      {(() => {
        const isSnoozed = task.snoozedUntil ? new Date(task.snoozedUntil) > now : false;
        const isPaused = task.status === "BLOCKED" || isSnoozed;
        if (isPaused) {
          return (
            <span className="px-2 py-0.5 rounded text-[11px] bg-zinc-800 text-zinc-400 shrink-0">
              {isSnoozed ? "Snoozed" : "Paused"}
            </span>
          );
        }
        // Suppress SLA pill when the time block is already telegraphing urgency
        // (red/orange/yellow time means the appointment is within 90 min).
        const timeBlockIsUrgent = appt && diffMin !== null && diffMin >= -15 && diffMin <= 90;
        if (timeBlockIsUrgent && task.slaStatus !== "breached") return null;
        if (task.slaStatus === "breached") {
          return <span className="px-2 py-0.5 rounded text-[11px] bg-red-900/60 text-red-300 shrink-0">SLA breached</span>;
        }
        if (task.slaStatus === "critical") {
          return <span className="px-2 py-0.5 rounded text-[11px] bg-orange-900/60 text-orange-300 shrink-0">SLA critical</span>;
        }
        if (task.slaStatus === "warning") {
          return <span className="px-2 py-0.5 rounded text-[11px] bg-yellow-900/40 text-yellow-300 shrink-0">SLA warning</span>;
        }
        return null;
      })()}

      <span className="text-zinc-600 text-xl shrink-0">›</span>
    </div>
  );
}

// (SectionCard removed — superseded by Zone, the Focus View chrome.)

// ─── Zone chrome ───────────────────────────────────────────────────────
// The Focus View demarcation system: four fixed zone colors, rendered as a
// 4px left rail. The rails are the only place these semantic colors appear
// at container level, so the zones do the wayfinding (design rev 2-4).
//   focus   blue   — act now (completable this moment)
//   risk    amber  — aging / at risk
//   recover red    — overdue debt
//   deep    darker red — escalation-old (Stuck's "older" band)
//   later   grey   — scheduled / waiting
//   cleared green  — done strips
const ZONE_RAIL: Record<string, string> = {
  focus: "border-l-blue-600 ring-1 ring-blue-900/40",
  risk: "border-l-amber-600",
  recover: "border-l-red-600",
  deep: "border-l-red-900",
  later: "border-l-zinc-600",
  cleared: "border-l-green-800",
};
const ZONE_TITLE: Record<string, string> = {
  focus: "text-blue-300", risk: "text-amber-300", recover: "text-red-300",
  deep: "text-red-400", later: "text-zinc-400", cleared: "text-green-300",
};

function Zone({ kind, title, subtitle, count, countClass, headerRight, children }: {
  kind: keyof typeof ZONE_RAIL;
  title: string;
  subtitle?: string;
  count?: React.ReactNode;
  countClass?: string;
  headerRight?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={`bg-zinc-900 border border-zinc-800 border-l-4 rounded-lg overflow-hidden ${ZONE_RAIL[kind]}`}>
      <div className={`px-5 py-3 flex items-center gap-3 ${children ? "border-b border-zinc-800" : ""}`}>
        <div className="min-w-0">
          <div className={`text-xs font-extrabold tracking-widest ${ZONE_TITLE[kind]}`}>{title}</div>
          {subtitle && <div className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</div>}
        </div>
        <div className="flex-1" />
        {headerRight}
        {count !== undefined && (
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${countClass ?? "bg-zinc-800 text-zinc-300"}`}>
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// "Assign all…" — one popover assigning every task in a pile/zone to the
// chosen agent via the bulk endpoint.
function BulkAssignButton({ taskIds, agents, onBulkReassign, label }: {
  taskIds: number[];
  agents: Agent[];
  onBulkReassign: (taskIds: number[], agentId: number) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const t = setTimeout(() => window.addEventListener("click", close), 0);
    return () => { clearTimeout(t); window.removeEventListener("click", close); };
  }, [open]);
  if (taskIds.length === 0) return null;
  return (
    <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 rounded text-[11px] border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
      >
        {label ?? `Assign all ${taskIds.length}…`}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 max-h-72 overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
            Assign {taskIds.length} task{taskIds.length !== 1 ? "s" : ""} to
          </div>
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => { onBulkReassign(taskIds, a.id); setOpen(false); }}
              className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-zinc-200 hover:bg-zinc-800"
            >
              <span className={`w-5 h-5 rounded-full ${avatarColor(a.name)} flex items-center justify-center text-[9px] font-semibold text-white`}>
                {initials(a.name)}
              </span>
              <span className="flex-1 truncate">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Today view: NOW / PREP / LATER / DONE ─────────────────────────────
function TodayView({ tasks, tomorrowTasks, now, agents, canReassign, onRowClick, onReassign, onComplete, onBulkReassign }: {
  tasks: Task[];
  tomorrowTasks: Task[];
  now: Date;
  agents: Agent[];
  canReassign: boolean;
  onRowClick: (task: Task) => void;
  onReassign: (taskId: number, agentId: number | null) => void;
  onComplete: (taskId: number) => void;
  onBulkReassign: (taskIds: number[], agentId: number) => void;
}) {
  const nowMinIST = istMinutesSinceMidnight(now);
  const windowEndMin = nowMinIST + NOW_WINDOW_MIN;

  // Bucket today's tasks by sub-section.
  //
  // The rule:
  //   - tasks WITH an appointmentTime → bucket by that time (NOW / LATER / DONE)
  //   - tasks WITHOUT appointmentTime → fall back to slaDeadline:
  //       SLA breached / due within 90 min → NOW (it's actually urgent)
  //       otherwise → LATER TODAY (don't dump unscheduled work into NOW just
  //       because we lack a time anchor)
  //
  // Earlier shipped behaviour put every no-appt task into NOW. Combined with
  // an engine bug that left appointmentTime null on every task, that meant
  // ALL tasks showed in NOW. Fixed defensively here so a missing field never
  // produces "everything is urgent" again.
  const overdueTasks: Task[] = [];
  const nowTasks: Task[] = [];
  const laterTasks: Task[] = [];
  const doneTasks: Task[] = [];

  // With day-based bucketing, Today holds the whole day — including
  // appointments that already passed. Split three ways so NOW means what
  // it says ("due in the next 90 min"):
  //   OVERDUE  appt earlier today, already past (beyond a 15-min grace)
  //   NOW      appt within [now − 15 min, now + 90 min]
  //   LATER    appt later today (> now + 90 min)
  const nowStartMin = nowMinIST - NOW_PAST_GRACE_MIN;

  for (const t of tasks) {
    if (t.viewBucket === "done") { doneTasks.push(t); continue; }
    const appt = t.appointmentTime ? new Date(t.appointmentTime) : null;

    if (!appt) {
      // No appointment time → bucket by SLA urgency.
      const sla = new Date(t.slaDeadline);
      const slaMinFromNow = (sla.getTime() - now.getTime()) / 60_000;
      if (slaMinFromNow < -NOW_PAST_GRACE_MIN) {
        overdueTasks.push(t);                      // SLA already blown past grace
      } else if (slaMinFromNow <= NOW_WINDOW_MIN) {
        nowTasks.push(t);                          // SLA imminent
      } else {
        laterTasks.push(t);                        // comfortable SLA → not urgent
      }
      continue;
    }

    const apptMin = istMinutesSinceMidnight(appt);
    if (apptMin < nowStartMin) {
      overdueTasks.push(t);                        // appointment already passed today
    } else if (apptMin <= windowEndMin) {
      nowTasks.push(t);                            // within next 90 min (+15 min grace)
    } else {
      laterTasks.push(t);                          // later today
    }
  }

  // Tonight's prep: tomorrow tasks with early-morning appts (before 10 AM IST)
  const showPrep = istHourOfDay(now) >= PREP_VISIBILITY_HOUR_IST;
  const prepTasks = showPrep
    ? tomorrowTasks.filter(t => {
        if (!t.appointmentTime) return false;
        const appt = new Date(t.appointmentTime);
        return istHourOfDay(appt) < EARLY_MORNING_CUTOFF_HOUR_IST;
      })
    : [];

  // Sort each bucket by appt time, falling back to slaDeadline when an appt
  // is missing (so no-appt tasks interleave by urgency rather than all
  // landing at the bottom).
  const sortAnchor = (t: Task) =>
    t.appointmentTime ? new Date(t.appointmentTime).getTime() : new Date(t.slaDeadline).getTime();
  const byTime = (a: Task, b: Task) => sortAnchor(a) - sortAnchor(b);
  overdueTasks.sort(byTime);
  nowTasks.sort(byTime);
  laterTasks.sort(byTime);
  doneTasks.sort(byTime);

  // Split Done into human-completed vs engine-auto-retired. The retirer
  // stamps metadata.autoRetiredByEngine=true when it closes a task because
  // the source order advanced past the rule's statusIn. Keeping them in
  // separate strips means the "Completed by team" count stays honest as a
  // measure of actual ops work, while the engine-retired pile is visible
  // (and collapsible) for auditability.
  const isAutoRetired = (t: Task) =>
    !!(t.metadata && (t.metadata as Record<string, unknown>).autoRetiredByEngine);
  const doneByTeam = doneTasks.filter((t) => !isAutoRetired(t));
  const doneByEngine = doneTasks.filter(isAutoRetired);

  // ── FOCUS — NEXT 5 (design rev 2) ──────────────────────────────────
  // The focus zone is NEVER empty while open work exists: scheduled
  // next-90-min items rank first, then it tops up with the oldest
  // recoveries. Completing one pulls the next in (the lists recompute
  // from task state). Each entry carries a "why" label so the ranking
  // is legible, not mysterious.
  const FOCUS_CAP = 5;
  const focusEntries: Array<{ task: Task; why: "scheduled now" | "oldest recovery" }> = [
    ...nowTasks.slice(0, FOCUS_CAP).map((t) => ({ task: t, why: "scheduled now" as const })),
  ];
  for (const t of overdueTasks) {
    if (focusEntries.length >= FOCUS_CAP) break;
    focusEntries.push({ task: t, why: "oldest recovery" });
  }
  const focusIds = new Set(focusEntries.map((e) => e.task.id));

  // ── RECOVER — overdue grouped by rule, sorted by pile size ─────────
  // Items already promoted into Focus are excluded so a task never
  // renders twice. Each group carries oldest-age + store concentration
  // ("Thyrocare ×28" reads as one lab problem, not 28 task problems).
  const recoverTasks = overdueTasks.filter((t) => !focusIds.has(t.id));
  const recoverGroups = (() => {
    const byRule = new Map<string, { ruleId: string; label: string; items: Task[] }>();
    for (const t of recoverTasks) {
      const id = t.taskRuleId ?? "unknown";
      if (!byRule.has(id)) {
        const raw = t.taskRule?.name ?? (id === "MANUAL" ? "Manual tasks" : id);
        const label = raw.replace(/^[^:]*:\s*/, "").replace(/\s*\(.*$/, "").trim() || raw;
        byRule.set(id, { ruleId: id, label, items: [] });
      }
      byRule.get(id)!.items.push(t);
    }
    return Array.from(byRule.values())
      .map((g) => {
        const oldest = g.items[0]; // items inherit overdueTasks' time sort (oldest first)
        const oldestMin = oldest?.appointmentTime
          ? Math.max(0, Math.round((now.getTime() - new Date(oldest.appointmentTime).getTime()) / 60_000))
          : null;
        const storeCounts = new Map<string, number>();
        for (const t of g.items) {
          const s = storeNameOf(t);
          if (s) storeCounts.set(s, (storeCounts.get(s) ?? 0) + 1);
        }
        const topStore = Array.from(storeCounts.entries()).sort((a, b) => b[1] - a[1])[0];
        return { ...g, oldestMin, topStore };
      })
      .sort((a, b) => b.items.length - a.items.length);
  })();
  const fmtAge = (min: number | null) => {
    if (min == null) return "—";
    if (min < 60) return `${min}m`;
    if (min < 60 * 24) return `${Math.floor(min / 60)}h ${min % 60}m`;
    return `${Math.floor(min / (60 * 24))}d ${Math.floor((min % (60 * 24)) / 60)}h`;
  };
  const openCount = overdueTasks.length + nowTasks.length + laterTasks.length;
  const totalToday = openCount + doneTasks.length;

  // Group laterTasks by hour for subdividers
  const laterByHour = new Map<number, Task[]>();
  for (const t of laterTasks) {
    const h = t.appointmentTime ? istHourOfDay(new Date(t.appointmentTime)) : 24;
    if (!laterByHour.has(h)) laterByHour.set(h, []);
    laterByHour.get(h)!.push(t);
  }
  const laterHours = Array.from(laterByHour.keys()).sort((a, b) => a - b);

  return (
    <div className="space-y-4">

      {/* Day progress line — replaces the misleading total badge. Open work
          vs team completions vs engine auto-closes at a glance; fills as
          the team completes. Auto-closes never masquerade as throughput. */}
      <div>
        <div className="h-1.5 rounded bg-zinc-800 overflow-hidden flex">
          <div
            className="bg-green-600 h-full"
            style={{ width: totalToday > 0 ? `${(doneByTeam.length / totalToday) * 100}%` : "0%" }}
          />
          <div
            className="bg-zinc-600 h-full"
            style={{ width: totalToday > 0 ? `${(doneByEngine.length / totalToday) * 100}%` : "0%" }}
          />
        </div>
        <div className="flex justify-between mt-1.5 text-[11px] text-zinc-500 tabular-nums">
          <span>
            <span className={openCount > 0 ? "text-red-300 font-medium" : "text-green-300 font-medium"}>
              {openCount} open
            </span>
            {" — "}{doneByTeam.length} done by team · {doneByEngine.length} auto-closed
          </span>
          <span>{totalToday} total today</span>
        </div>
      </div>

      {/* ◉ FOCUS — the "what matters this moment" zone. Never empty while
          open work exists: next-90-min items first, topped up with the
          oldest recoveries. Completing one pulls the next in. */}
      <Zone
        kind="focus"
        title={`◉ FOCUS — NEXT ${Math.min(FOCUS_CAP, Math.max(focusEntries.length, 1))}`}
        subtitle={
          focusEntries.length === 0
            ? undefined
            : `${nowTasks.length} scheduled in the next 90 min · topped up with the ${Math.max(0, focusEntries.length - Math.min(nowTasks.length, FOCUS_CAP))} oldest recoveries`
        }
        count={focusEntries.length}
        countClass="bg-blue-900/60 text-blue-300"
      >
        {focusEntries.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-zinc-500">
            All of today&apos;s work is complete. Genuinely nothing to do. 🎉
          </div>
        ) : (
          focusEntries.map(({ task: t, why }) => (
            <TaskRow
              key={t.id}
              task={t}
              now={now}
              agents={agents}
              onClick={() => onRowClick(t)}
              onReassign={onReassign}
              canReassign={canReassign}
              onComplete={onComplete}
              rightBadge={
                <span className={`px-2 py-0.5 rounded text-[10px] shrink-0 ${
                  why === "scheduled now" ? "bg-blue-900/50 text-blue-300" : "bg-red-900/40 text-red-300"
                }`}>
                  {why}
                </span>
              }
            />
          ))
        )}
        {recoverTasks.length > 0 && focusEntries.length > 0 && (
          <div className="px-5 py-2.5 text-[11px] text-zinc-500 border-t border-zinc-800">
            completing one pulls the next oldest in automatically
          </div>
        )}
      </Zone>

      {/* ⏰ RECOVER TODAY — remaining overdue, grouped by rule so 100+
          tasks read as a handful of piles. Expand only the pile being
          worked; "Assign all…" batches a pile to one agent. */}
      {recoverTasks.length > 0 && (
        <Zone
          kind="recover"
          title="⏰ RECOVER TODAY"
          subtitle="appointment passed, still open — burn down by pile"
          count={`${recoverTasks.length} remaining`}
          countClass="bg-red-900 text-red-300"
        >
          {recoverGroups.map((g, gi) => (
            <details key={g.ruleId} open={gi === 0} className="border-b border-zinc-800 last:border-b-0">
              <summary className="px-5 py-3 flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-800/30">
                <span className="text-zinc-500 text-[10px]">▸</span>
                <span className="text-sm font-semibold text-zinc-200">{g.label}</span>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-900/60 text-red-300 tabular-nums">{g.items.length}</span>
                <span className="text-[11px] text-zinc-500">
                  oldest {fmtAge(g.oldestMin)}
                  {g.topStore && g.topStore[1] > 1 ? ` · ${g.topStore[0]} ×${g.topStore[1]}` : ""}
                </span>
                <span className="flex-1" />
                {canReassign && (
                  <BulkAssignButton
                    taskIds={g.items.map((t) => t.id)}
                    agents={agents}
                    onBulkReassign={onBulkReassign}
                  />
                )}
              </summary>
              <div className="border-t border-zinc-800/60">
                {g.items.map((t) => (
                  <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} onComplete={onComplete} />
                ))}
              </div>
            </details>
          ))}
        </Zone>
      )}

      {prepTasks.length > 0 ? (
        <div className="rounded-lg border border-amber-900/40 ring-1 ring-amber-900/30">
          <details open className="bg-zinc-900">
            <summary className="px-5 py-4 bg-amber-950/20 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <div className="flex items-center gap-3">
                <span className="text-lg">🌙</span>
                <div>
                  <div className="font-semibold text-amber-200">TONIGHT'S PREP</div>
                  <div className="text-xs text-amber-400/70 mt-0.5">
                    confirmations for tomorrow's early-morning items (before 10 AM)
                  </div>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-700 text-amber-100">
                {prepTasks.length} due tonight
              </span>
            </summary>
            <div className="border-t border-amber-900/30">
              {prepTasks.map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
            </div>
          </details>
        </div>
      ) : !showPrep ? (
        // Pre-4 PM stub. The section materialises with content after 4 PM
        // IST; without this stub a new user has no idea it exists. Visible
        // but dim — clearly disabled, teaches the surface.
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 opacity-60">
            <span className="text-lg">🌙</span>
            <div>
              <div className="text-sm font-medium text-zinc-400">Tonight's prep</div>
              <div className="text-xs text-zinc-600 mt-0.5">
                tomorrow's early-morning confirmations will surface here after 4 PM
              </div>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-500">
            unlocks at 4 PM
          </span>
        </div>
      ) : null}

      {/* ◷ LATER TODAY — a single quiet line when empty (empty space must
          not pretend to be calm); hour-grouped rows when there's work. */}
      {laterTasks.length === 0 ? (
        <Zone kind="later" title="◷ LATER TODAY" subtitle="nothing else scheduled today" count={0} />
      ) : (
        <Zone
          kind="later"
          title="◷ LATER TODAY"
          subtitle={`${laterTasks.length} more until midnight`}
          count={laterTasks.length}
        >
          {laterHours.map(h => (
            <div key={h}>
              <div className="px-5 py-2 bg-zinc-950/40 border-b border-zinc-800 text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                ── {fmtHourHeader(h)} · {laterByHour.get(h)!.length} task{laterByHour.get(h)!.length > 1 ? "s" : ""} ──
              </div>
              {laterByHour.get(h)!.map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
            </div>
          ))}
        </Zone>
      )}

      <details className="rounded-lg border border-zinc-800 border-l-4 border-l-green-800 bg-zinc-900/50">
        <summary className="px-5 py-3 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <div className="flex items-center gap-3">
            <span className="text-green-400">✓</span>
            <div>
              <div className="text-sm font-medium text-zinc-300">Completed by team today</div>
              <div className="text-xs text-zinc-500">resets at midnight IST</div>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900 text-green-300">
            {doneByTeam.length} completed
          </span>
        </summary>
        <div className="border-t border-zinc-800">
          {doneByTeam.length === 0 ? (
            <div className="px-5 py-3 text-center text-xs text-zinc-500">Nothing completed yet today.</div>
          ) : (
            doneByTeam.slice(0, 20).map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)
          )}
        </div>
      </details>

      {/* Engine auto-retirements — collapsed by default. These are tasks the
          poller closed because the underlying order moved past the rule's
          statusIn (e.g. R5 task for an order that's now REPORT_DELIVERED).
          Surfaced separately so the "Completed by team" count above stays
          a clean measure of human throughput. */}
      {doneByEngine.length > 0 && (
        <details className="rounded-lg border border-zinc-800 border-l-4 border-l-green-900/60 bg-zinc-900/30">
          <summary className="px-5 py-3 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <div className="flex items-center gap-3">
              <span className="text-zinc-500">⚙</span>
              <div>
                <div className="text-sm font-medium text-zinc-400">Auto-closed by engine today</div>
                <div className="text-xs text-zinc-600">orders advanced past their rule&apos;s statusIn</div>
              </div>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400">
              {doneByEngine.length} auto
            </span>
          </summary>
          <div className="border-t border-zinc-800">
            {doneByEngine.slice(0, 20).map(t => <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />)}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── Tomorrow view ─────────────────────────────────────────────────────
function TomorrowView({ tasks, now, agents, canReassign, onRowClick, onReassign }: {
  tasks: Task[];
  now: Date;
  agents: Agent[];
  canReassign: boolean;
  onRowClick: (task: Task) => void;
  onReassign: (taskId: number, agentId: number | null) => void;
}) {
  // Simple chronological schedule (design rev 4): one plain summary line,
  // hour-divided read-only rows, busy hours collapsed to a count line.
  // Prep/risk WORK lives on Today (Tonight's Prep) — Tomorrow is only for
  // reading the shape of the day.
  const byHour = new Map<number, Task[]>();
  const noTime: Task[] = [];
  for (const t of tasks) {
    if (!t.appointmentTime) { noTime.push(t); continue; }
    const h = istHourOfDay(new Date(t.appointmentTime));
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(t);
  }
  const byTime = (a: Task, b: Task) =>
    new Date(a.appointmentTime!).getTime() - new Date(b.appointmentTime!).getTime();
  const hours = Array.from(byHour.keys()).sort((a, b) => a - b);
  hours.forEach((h) => byHour.get(h)!.sort(byTime));

  const beforeEight = tasks.filter(
    (t) => t.appointmentTime && istHourOfDay(new Date(t.appointmentTime)) < 8
  ).length;
  const noPhlebo = tasks.filter(
    (t) => hasPhleboWorkflow(t) && t.appointmentTime && !metaStr(t, "phleboName")
  ).length;

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowLabel = tomorrow.toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata",
  });

  // Hours with more rows than this start collapsed — the divider line with
  // its count is the information; the rows are detail on demand.
  const COLLAPSE_THRESHOLD = 10;

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-zinc-100">{tomorrowLabel}</h2>
          <span className="text-sm text-zinc-400 tabular-nums">
            {tasks.length} appointments
            {beforeEight > 0 && <> · <b className="text-amber-300">{beforeEight} before 8 AM</b></>}
            {noPhlebo > 0 && <> · {noPhlebo} without a phlebo yet</>}
          </span>
        </div>
        <div className="text-xs text-zinc-500 mt-1">
          Read-only schedule — tonight&apos;s prep work is on <b>Today → Tonight&apos;s Prep</b>.
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 border-l-4 border-l-zinc-600 rounded-lg overflow-hidden">
        {hours.length === 0 && noTime.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-zinc-500">Nothing scheduled for tomorrow yet.</div>
        ) : (
          <>
            {hours.map((h) => {
              const items = byHour.get(h)!;
              return (
                <details key={h} open={items.length <= COLLAPSE_THRESHOLD} className="border-b border-zinc-800 last:border-b-0">
                  <summary className="px-5 py-2.5 bg-zinc-950/40 flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-800/30">
                    <span className="text-[11px] text-zinc-400 uppercase tracking-wider font-semibold tabular-nums">{fmtHourHeader(h)}</span>
                    <span className="text-[11px] text-zinc-600 tabular-nums">{items.length} appointment{items.length !== 1 ? "s" : ""}</span>
                    {items.length > COLLAPSE_THRESHOLD && <span className="text-[10px] text-zinc-600">(click to expand)</span>}
                  </summary>
                  {items.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      now={now}
                      agents={agents}
                      onClick={() => onRowClick(t)}
                      onReassign={onReassign}
                      canReassign={canReassign}
                      rightBadge={
                        hasPhleboWorkflow(t) && !metaStr(t, "phleboName")
                          ? <span className="px-2 py-0.5 rounded text-[10px] shrink-0 bg-amber-900/30 text-amber-300/80">no phlebo yet</span>
                          : undefined
                      }
                    />
                  ))}
                </details>
              );
            })}
            {noTime.length > 0 && (
              <div>
                <div className="px-5 py-2.5 bg-zinc-950/40 text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                  No appointment time · {noTime.length}
                </div>
                {noTime.map((t) => (
                  <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Stuck view: age-zoned debt ledger (design rev 3) ──────────────────
// Age is Stuck's natural demarcation because age dictates the action:
//   Yesterday (amber)  → recover like Today's pile: ✓ Done / Assign
//   2–3 days  (red)    → chase hard, every item has slipped once already
//   Older     (dark)   → chasing failed; the honest options are a formal
//                        escalation or a recorded decision to stop. Rows
//                        show Escalate / Close-with-reason, not ✓.
// The old Age filter pills and sort toggle are gone — the zones ARE the
// age filter, fixed oldest-first. (Type/rule/store slicing lives in the
// workspace filter bar above the tabs.)
function StuckView({ tasks, now, agents, canReassign, onRowClick, onReassign, onComplete, onBulkReassign, onCloseWithReason }: {
  tasks: Task[];
  now: Date;
  agents: Agent[];
  canReassign: boolean;
  onRowClick: (task: Task) => void;
  onReassign: (taskId: number, agentId: number | null) => void;
  onComplete: (taskId: number) => void;
  onBulkReassign: (taskIds: number[], agentId: number) => void;
  onCloseWithReason: (taskId: number, reason: string) => void;
}) {
  // Whole IST days between the task's anchor (appointment, else creation)
  // and now. Stuck holds prior-day work, so diff ≥ 1 in the normal case;
  // clamp to ≥1 so a boundary artefact can't fall out of every band.
  const istMidnightMs = (d: Date) => {
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  };
  const dayAge = (t: Task) => {
    const anchor = t.appointmentTime ? new Date(t.appointmentTime) : new Date(t.createdAt);
    return Math.max(1, Math.round((istMidnightMs(now) - istMidnightMs(anchor)) / 86_400_000));
  };

  const anchorMs = (t: Task) =>
    t.appointmentTime ? new Date(t.appointmentTime).getTime() : new Date(t.createdAt).getTime();
  const sorted = [...tasks].sort((a, b) => anchorMs(a) - anchorMs(b)); // oldest first

  const bandYesterday = sorted.filter((t) => dayAge(t) === 1);
  const bandMid = sorted.filter((t) => { const d = dayAge(t); return d >= 2 && d <= 3; });
  const bandOld = sorted.filter((t) => dayAge(t) > 3);
  const total = tasks.length;

  const fmtDayAge = (t: Task) => {
    const d = dayAge(t);
    return d === 1 ? "1d" : `${d}d`;
  };

  // Systemic-pattern detection: one store owning ≥25% of the stuck pile
  // (min 3) is usually one upstream problem, not N task problems.
  const concentration = useMemo(() => {
    const byStore = new Map<string, number>();
    for (const t of tasks) {
      const s = storeNameOf(t);
      if (s) byStore.set(s, (byStore.get(s) ?? 0) + 1);
    }
    const top = Array.from(byStore.entries()).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= Math.max(3, Math.ceil(tasks.length * 0.25))) return top;
    return null;
  }, [tasks]);

  return (
    <div className="space-y-4">
      {/* Age composition bar — Stuck's scoreboard. A healthy operation's
          bar shrinks from the right; a growing dark tail is the warning. */}
      {total > 0 ? (
        <div>
          <div className="h-2 rounded bg-zinc-800 overflow-hidden flex">
            <div className="bg-amber-600 h-full" style={{ width: `${(bandYesterday.length / total) * 100}%` }} />
            <div className="bg-red-600 h-full" style={{ width: `${(bandMid.length / total) * 100}%` }} />
            <div className="bg-red-900 h-full" style={{ width: `${(bandOld.length / total) * 100}%` }} />
          </div>
          <div className="flex gap-5 mt-1.5 text-[11px] text-zinc-500 tabular-nums flex-wrap">
            <span><span className="inline-block w-2 h-2 rounded-sm bg-amber-600 mr-1.5" /><b className="text-zinc-300">{bandYesterday.length}</b> yesterday</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-red-600 mr-1.5" /><b className="text-zinc-300">{bandMid.length}</b> 2–3 days</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-red-900 mr-1.5" /><b className="text-zinc-300">{bandOld.length}</b> older — needs a decision</span>
            <span className="ml-auto">goal: this bar shrinks left-to-right</span>
          </div>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-sm font-medium text-green-300">✓ Nothing stuck</div>
          <div className="text-xs text-zinc-500 mt-1">No prior-day work is waiting. (Workspace filters apply here too.)</div>
        </div>
      )}

      {/* Systemic-pattern callout — one store owning ≥25% of the pile is
          one upstream problem, not N task problems. */}
      {concentration && (
        <div className="flex items-center gap-3 bg-amber-950/20 border border-amber-900/40 rounded-lg px-4 py-2.5 text-sm text-amber-300 flex-wrap">
          <span>⚠ Pattern: <b className="tabular-nums">{concentration[1]} of {total}</b> stuck tasks are {concentration[0]}.</span>
          <span className="text-amber-400/60 text-xs">Likely one upstream problem — worth a root-cause look before chasing individually.</span>
        </div>
      )}

      {/* ◔ YESTERDAY — fresh debt, recover exactly like Today's pile */}
      {bandYesterday.length > 0 && (
        <Zone
          kind="risk"
          title="◔ YESTERDAY"
          subtitle="fresh debt — recover exactly like Today's pile"
          count={bandYesterday.length}
          countClass="bg-amber-900/60 text-amber-300"
          headerRight={canReassign ? (
            <BulkAssignButton taskIds={bandYesterday.map((t) => t.id)} agents={agents} onBulkReassign={onBulkReassign} />
          ) : undefined}
        >
          {bandYesterday.map((t) => (
            <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} onComplete={onComplete}
              rightBadge={<span className="px-2 py-0.5 rounded text-[11px] shrink-0 bg-amber-900/40 text-amber-300 tabular-nums">{fmtDayAge(t)}</span>}
            />
          ))}
        </Zone>
      )}

      {/* ⏰ 2–3 DAYS — chase hard; every item here has slipped once already */}
      {bandMid.length > 0 && (
        <Zone
          kind="recover"
          title="⏰ 2–3 DAYS"
          subtitle="chase hard — every item here has slipped once already"
          count={bandMid.length}
          countClass="bg-red-900 text-red-300"
          headerRight={canReassign ? (
            <BulkAssignButton taskIds={bandMid.map((t) => t.id)} agents={agents} onBulkReassign={onBulkReassign} />
          ) : undefined}
        >
          {bandMid.map((t) => (
            <TaskRow key={t.id} task={t} now={now} agents={agents} onClick={() => onRowClick(t)} onReassign={onReassign} canReassign={canReassign} onComplete={onComplete}
              rightBadge={<span className="px-2 py-0.5 rounded text-[11px] shrink-0 bg-red-900/40 text-red-300 tabular-nums">{fmtDayAge(t)}</span>}
            />
          ))}
        </Zone>
      )}

      {/* ⛔ OLDER THAN 3 DAYS — chasing failed; rows show a decision, not ✓.
          Escalate opens the order context (drawer) so the head can raise it
          with full history; Close-with-reason records why we stopped. */}
      {bandOld.length > 0 && (
        <Zone
          kind="deep"
          title="⛔ OLDER THAN 3 DAYS"
          subtitle="chasing has failed — decide: escalate, or close with a reason"
          count={bandOld.length}
          countClass="bg-red-950 text-red-400"
        >
          {bandOld.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-800/40 transition-colors">
              <div className="text-center w-16 shrink-0">
                <div className="text-base font-bold text-red-400 tabular-nums">{fmtDayAge(t)}</div>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider">stuck</div>
              </div>
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onRowClick(t)} role="button" tabIndex={0}>
                <div className="font-medium text-sm text-zinc-100 truncate">{titleToIST(t.title)}</div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  #{t.entityId}{storeNameOf(t) ? ` · ${storeNameOf(t)}` : ""}
                </div>
              </div>
              <AssigneeChip task={t} agents={agents} onReassign={onReassign} canReassign={canReassign} />
              <button
                onClick={() => onRowClick(t)}
                className="px-2 py-1 rounded text-[11px] font-medium border border-red-900 text-red-300 hover:bg-red-900/30 transition-colors shrink-0"
                title="Open order context to raise an escalation"
              >
                Escalate ↗
              </button>
              <button
                onClick={() => {
                  const reason = window.prompt(
                    `Close "${t.title}"?\n\nRecord the reason (required) — this is a decision to stop chasing, kept in the task history:`
                  );
                  if (reason && reason.trim()) onCloseWithReason(t.id, reason.trim());
                }}
                className="px-2 py-1 rounded text-[11px] border border-zinc-700 text-zinc-400 hover:bg-zinc-800 transition-colors shrink-0"
              >
                Close w/ reason
              </button>
            </div>
          ))}
        </Zone>
      )}
    </div>
  );
}

// ─── Main board ────────────────────────────────────────────────────────
//
// Lead/Head and Agent share this component. The currentUser.role gates
// Lead-only UI:
//   - filter bar (only Leads have a workspace big enough to need filters)
//   - reassign popover on the assignee chip (Leads reassign; agents don't)
// Everyone gets the same row layout, drawer, and Today/Tomorrow/Stuck
// buckets. The /api/tasks endpoint already role-scopes results, so agents
// only see their own tasks even with the same component.
export default function MyWorkBoard({ currentUser }: { currentUser: CurrentUser }) {
  const isAgent = currentUser.role === "OPS_AGENT";

  const [tab, setTab] = useState<Tab>("today");
  const [exportOpen, setExportOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(new Date());
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  // Drawer state — full task object (not just an id), so TaskDetailPanel
  // can render immediately without a re-fetch. Updated optimistically by
  // the panel's actions; refetched via onUpdate to pick up server state.
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // Registered (active) data sources — drives the top-level Source filter so it
  // lists every source (e.g. Appointments) even when none of its tasks are in
  // the current view, instead of collapsing when only one source has tasks.
  const [registeredSources, setRegisteredSources] = useState<{ id: string; displayName: string; sourceId: string }[]>([]);

  // ── Filter state (Lead's main tool for slicing the workspace) ───────
  const [filterAssigneeId, setFilterAssigneeId] = useState<"all" | "unassigned" | number>("all");
  // Top-level Data Source filter ("all" | dataSource.id). The Type/Rule/Store
  // filters below are second-level — their options scope to the chosen source.
  const [filterDataSourceId, setFilterDataSourceId] = useState<string>("all");
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set()); // empty = all
  // Rule filter — slice the workspace by originating task rule (keyed on
  // taskRuleId). Lets the lead answer "which rule is generating the pile"
  // (e.g. select Sample Handover → Stuck tab = where handovers are stuck).
  const [filterRules, setFilterRules] = useState<Set<string>>(new Set()); // empty = all
  // Store / priority / SLA filters — combined with the above so any
  // permutation of (assignee × type × rule × store × priority × SLA) can
  // be sliced. All client-side over the already-fetched workspace.
  const [filterStore, setFilterStore] = useState<string>("all");
  const [filterPriorities, setFilterPriorities] = useState<Set<string>>(new Set()); // empty = all
  const [filterSla, setFilterSla] = useState<Set<string>>(new Set()); // empty = all

  // Keep "now" fresh so the sliding NOW window slides on its own.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000); // tick every minute
    return () => clearInterval(id);
  }, []);

  // Escape closes the task drawer.
  useEffect(() => {
    if (!selectedTask) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedTask(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTask]);

  // Load team members once for the assignee dropdown + reassign popovers.
  useEffect(() => {
    fetch("/api/team")
      .then((r) => r.json())
      .then((d) => {
        setAgents(
          (d.members ?? []).map((m: { userId: number; name: string; role: string }) => ({
            id: m.userId, name: m.name, role: m.role,
          }))
        );
      })
      .catch((err) => console.error("[MyWork] team fetch failed:", err));
  }, []);

  // Load registered data sources for the top-level Source filter.
  useEffect(() => {
    fetch("/api/data-sources")
      .then((r) => (r.ok ? r.json() : { dataSources: [] }))
      .then((d) => {
        const active = (d.dataSources ?? [])
          .filter((s: { isActive?: boolean }) => s.isActive !== false)
          .map((s: { id: string; displayName?: string; sourceId: string }) => ({
            id: s.id, displayName: s.displayName || s.sourceId, sourceId: s.sourceId,
          }));
        setRegisteredSources(active);
      })
      .catch((err) => console.error("[MyWork] data-sources fetch failed:", err));
  }, []);

  // Reassign handler — used by the AssigneeChip popover on every row.
  // Optimistic update + server call; on failure, revert + show error.
  // (Unassign is not supported by /api/tasks/bulk yet — popover hides the
  // option. When the endpoint adds an `unassign` action, accept agentId=null
  // here and branch.)
  const handleReassign = useCallback(async (taskId: number, agentId: number | null) => {
    if (agentId == null) return; // unassign not implemented server-side
    const prev = tasks;
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    setTasks((ts) =>
      ts.map((t) =>
        t.id === taskId ? { ...t, assignedTo: { id: agent.id, name: agent.name } } : t
      )
    );
    try {
      const res = await fetch("/api/tasks/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [taskId], action: "reassign", assignedToId: agentId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[MyWork] reassign failed:", e);
      setTasks(prev); // revert optimistic update
      setError(`Reassign failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }, [tasks, agents]);

  // ✓ Done from a row (Focus / Recover / Stuck zones). Optimistic: flip the
  // task to COMPLETED + viewBucket "done" locally so it moves to Cleared and
  // the Focus zone pulls the next item in immediately; revert on failure.
  const handleComplete = useCallback(async (taskId: number) => {
    const prev = tasks;
    const nowIso = new Date().toISOString();
    setTasks((ts) =>
      ts.map((t) =>
        t.id === taskId
          ? { ...t, status: "COMPLETED", completedAt: nowIso, viewBucket: "done" as const }
          : t
      )
    );
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED", note: "Completed from Smart View" }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[MyWork] complete failed:", e);
      setTasks(prev);
      setError(`Complete failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }, [tasks]);

  // Close-with-reason (Stuck → "Older" zone). CANCELLED + the operator's
  // reason in history — a recorded decision to stop chasing, distinct from
  // completion and from engine auto-retirement.
  const handleCloseWithReason = useCallback(async (taskId: number, reason: string) => {
    const prev = tasks;
    const nowIso = new Date().toISOString();
    setTasks((ts) =>
      ts.map((t) =>
        t.id === taskId
          ? { ...t, status: "CANCELLED", completedAt: nowIso, viewBucket: "done" as const }
          : t
      )
    );
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED", note: `Closed from Smart View — ${reason}` }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[MyWork] close failed:", e);
      setTasks(prev);
      setError(`Close failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }, [tasks]);

  // Bulk assign — one call for a whole pile/zone (reuses /api/tasks/bulk).
  const handleBulkReassign = useCallback(async (taskIds: number[], agentId: number) => {
    if (taskIds.length === 0) return;
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    const prev = tasks;
    const idSet = new Set(taskIds);
    setTasks((ts) =>
      ts.map((t) => (idSet.has(t.id) ? { ...t, assignedTo: { id: agent.id, name: agent.name } } : t))
    );
    try {
      const res = await fetch("/api/tasks/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: taskIds, action: "reassign", assignedToId: agentId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("[MyWork] bulk reassign failed:", e);
      setTasks(prev);
      setError(`Bulk assign failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }, [tasks, agents]);

  // Guards against overlapping fetches — the live-refresh interval, focus
  // refetch, manual Refresh, and post-action onUpdate can all fire close
  // together; only one request set should be in flight at a time.
  const fetchInFlight = useRef(false);

  const fetchTasks = useCallback(async (background = false) => {
    if (fetchInFlight.current) return;
    fetchInFlight.current = true;
    // Background refreshes swap data in place — no spinner, no flicker.
    // The full-page loading state is reserved for the first paint.
    if (!background) setLoading(true);
    setError(null);
    try {
      // Per-view fetches — one bounded query per bucket so no bucket can
      // starve another at the row cap.
      //
      // History of this bug: a single `status=<active>&limit=500&sortBy=
      // appointmentTime asc` fetch fed every bucket. Sorted by appointment
      // ascending, the hundreds of STUCK tasks (earliest appointments)
      // consumed the entire 500 cap before the query ever reached today's
      // or tomorrow's later-dated appointments — so Tomorrow silently
      // showed 0 even though the tasks existed. Splitting active-vs-done
      // earlier only half-fixed it (stuck still starved today/tomorrow
      // inside the active fetch).
      //
      // The real fix: use the server's `?view=` SQL filter (day-based,
      // mirrors computeViewBucket) to fetch today / tomorrow / stuck
      // independently. The view filter already excludes terminal statuses,
      // so no status= param is needed for those three. Done-today is a
      // separate terminal+completedAfter fetch for the strips below Today.
      const terminalStatuses = "COMPLETED,CANCELLED";
      // completedAfter = today IST midnight as UTC ISO. Filters on
      // completedAt so engine-retired tasks (createdAt weeks old, closed
      // just now) are included in the done strips.
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const istNow = Date.now() + istOffsetMs;
      const istMidnight = Math.floor(istNow / 86_400_000) * 86_400_000 - istOffsetMs;
      const todayMidnightIso = new Date(istMidnight).toISOString();

      const [todayRes, tomorrowRes, stuckRes, doneRes] = await Promise.all([
        fetch(`/api/tasks?view=today&limit=500&sortBy=appointmentTime&sortOrder=asc`),
        fetch(`/api/tasks?view=tomorrow&limit=300&sortBy=appointmentTime&sortOrder=asc`),
        fetch(`/api/tasks?view=stuck&limit=500&sortBy=appointmentTime&sortOrder=asc`),
        fetch(`/api/tasks?view=done&limit=300&sortBy=createdAt&sortOrder=desc&status=${terminalStatuses}&completedAfter=${encodeURIComponent(todayMidnightIso)}`),
      ]);
      for (const [r, label] of [[todayRes, "today"], [tomorrowRes, "tomorrow"], [stuckRes, "stuck"], [doneRes, "done"]] as const) {
        if (!r.ok) throw new Error(`HTTP ${r.status} (${label})`);
      }
      const [todayData, tomorrowData, stuckData, doneData] = await Promise.all([
        todayRes.json(), tomorrowRes.json(), stuckRes.json(), doneRes.json(),
      ]);
      // Merge + de-dup by id. The view buckets are mutually exclusive, but
      // a status transition between the parallel fetches could theoretically
      // surface a task in two — dedup guards that.
      const seen = new Set<number>();
      const merged: Task[] = [];
      for (const t of [
        ...(todayData.tasks ?? []),
        ...(tomorrowData.tasks ?? []),
        ...(stuckData.tasks ?? []),
        ...(doneData.tasks ?? []),
      ]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        merged.push(t);
      }
      setTasks(merged);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    } finally {
      setLoading(false);
      fetchInFlight.current = false;
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  // ── Live refresh ─────────────────────────────────────────────────────
  // The workspace re-syncs itself: a silent background refetch every 30s
  // (only while the tab is visible — a hidden dashboard shouldn't poll),
  // plus an immediate refetch the moment the tab regains focus. Combined
  // with the optimistic updates on Done/Assign, every view tracks the
  // engine within one interval of real time, with zero loading flicker
  // (background fetches swap data in place; the spinner is first-paint
  // only). Push (SSE/WS) was considered and rejected: the source data
  // only changes on poll-cycle writes and operator actions, so a socket
  // would add infrastructure without adding freshness.
  const LIVE_REFRESH_MS = 30_000;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchTasks(true);
    }, LIVE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchTasks(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [fetchTasks]);

  // Apply filters first, then bucket. Filters narrow the entire workspace
  // (today/tomorrow/stuck counts all update together).
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      // Assignee filter
      if (filterAssigneeId === "unassigned" && t.assignedTo) return false;
      if (typeof filterAssigneeId === "number" && t.assignedTo?.id !== filterAssigneeId) return false;
      // Data source filter (top-level; "all" = off)
      if (filterDataSourceId !== "all" && t.dataSource?.id !== filterDataSourceId) return false;
      // Entity-type filter (empty set = all)
      if (filterTypes.size > 0 && !filterTypes.has(t.orderType)) return false;
      // Rule filter (empty set = all)
      if (filterRules.size > 0 && !filterRules.has(t.taskRuleId)) return false;
      // Store filter ("all" = off; matches metadata.storeName)
      if (filterStore !== "all" && storeNameOf(t) !== filterStore) return false;
      // Priority filter (empty set = all)
      if (filterPriorities.size > 0 && !filterPriorities.has(t.priority)) return false;
      // SLA filter (empty set = all)
      if (filterSla.size > 0 && !filterSla.has(t.slaStatus)) return false;
      return true;
    });
  }, [tasks, filterAssigneeId, filterDataSourceId, filterTypes, filterRules, filterStore, filterPriorities, filterSla]);

  const byBucket = useMemo(() => {
    const t = { today: [] as Task[], tomorrow: [] as Task[], stuck: [] as Task[] };
    for (const x of filteredTasks) {
      // COMPLETED/CANCELLED/RESOLVED tasks: route to today (they appear
      // in Today's "Done today" strip).
      if (x.viewBucket === "done") { t.today.push(x); continue; }

      // Server's "stuck" bucket: prior-day appointment still open (or a
      // no-appt task created before today) — direct to Stuck tab.
      if (x.viewBucket === "stuck") { t.stuck.push(x); continue; }

      // Day-based bucketing: bucketing is decided by the appointment's IST
      // calendar day server-side (computeViewBucket), NOT by whether the
      // clock has passed it. A same-day appointment that's already overdue
      // stays in Today (it surfaces in TodayView's NOW/overdue section) so
      // the team sees today's full workload all day instead of watching it
      // drain into Stuck. The old clock-based override that pushed
      // past-appointment-today tasks to Stuck has been removed — it emptied
      // Today as the day progressed.
      if (x.viewBucket === "today") t.today.push(x);
      else if (x.viewBucket === "tomorrow") t.tomorrow.push(x);
    }
    return t;
  }, [filteredTasks, now]);

  const counts = {
    today: byBucket.today.length,
    tomorrow: byBucket.tomorrow.length,
    stuck: byBucket.stuck.length,
  };

  // Data sources present in the workspace — the TOP-LEVEL filter. Every
  // second-level option (type/rule/store) scopes to the selected source.
  const availableDataSources = useMemo(() => {
    // Count tasks per source in the current view.
    const counts = new Map<string, number>();
    for (const t of tasks) {
      const id = t.dataSource?.id;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // Prefer the registered-source list so the Source filter always lists every
    // active source (Appointments included) even with 0 tasks in view — the
    // tier no longer collapses when only one source happens to have tasks.
    if (registeredSources.length > 0) {
      const byId = new Map(registeredSources.map((s) => [s.id, s]));
      // Include any source present in tasks but not (yet) in the registered
      // list, so nothing a task belongs to is ever hidden.
      for (const t of tasks) {
        const ds = t.dataSource;
        if (ds?.id && !byId.has(ds.id)) byId.set(ds.id, { id: ds.id, displayName: ds.displayName || ds.sourceId, sourceId: ds.sourceId });
      }
      return Array.from(byId.values())
        .map((s) => ({ id: s.id, label: s.displayName, count: counts.get(s.id) ?? 0 }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    }
    // Fallback (registered list not loaded yet): derive from tasks present.
    const fromTasks = new Map<string, { id: string; label: string; count: number }>();
    for (const t of tasks) {
      const ds = t.dataSource;
      if (!ds?.id) continue;
      const existing = fromTasks.get(ds.id);
      if (existing) { existing.count++; continue; }
      fromTasks.set(ds.id, { id: ds.id, label: ds.displayName || ds.sourceId, count: 1 });
    }
    return Array.from(fromTasks.values()).sort((a, b) => b.count - a.count);
  }, [tasks, registeredSources]);

  // Tasks in scope of the top-level Data Source filter. The second-level
  // option lists (type/rule/store) are derived from THIS, so switching source
  // reshapes the row below to that source's own vocabulary.
  const scopedTasks = useMemo(
    () => (filterDataSourceId === "all" ? tasks : tasks.filter((t) => t.dataSource?.id === filterDataSourceId)),
    [tasks, filterDataSourceId],
  );

  // Set of entity types present in the scoped workspace — chips render
  // dynamically so we only show chips for types that exist.
  const availableTypes = useMemo(() => {
    const s = new Set<string>();
    for (const t of scopedTasks) s.add(t.orderType);
    return Array.from(s).sort();
  }, [scopedTasks]);

  // Rules present in the unfiltered workspace, with a compact chip label
  // and per-rule task count (count reflects the unfiltered workspace so the
  // lead sees the true per-rule volume — "where is the pile" at a glance).
  // Long rule names like "HSC: Sample Handover to Lab (>30 min after
  // collection)" compress to "Sample Handover to Lab".
  const availableRules = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; count: number }>();
    for (const t of scopedTasks) {
      const id = t.taskRuleId;
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) { existing.count++; continue; }
      const raw = t.taskRule?.name ?? (id === "MANUAL" ? "Manual tasks" : id);
      const label = raw.replace(/^[^:]*:\s*/, "").replace(/\s*\(.*$/, "").trim() || raw;
      byId.set(id, { id, label, count: 1 });
    }
    return Array.from(byId.values()).sort((a, b) => b.count - a.count);
  }, [scopedTasks]);

  // Stores present in the scoped workspace, by volume — powers the Store
  // select. Empty for sources without a store concept (e.g. Appointments), so
  // the Store control auto-hides via its length>1 guard for that scope.
  const availableStores = useMemo(() => {
    const byName = new Map<string, number>();
    for (const t of scopedTasks) {
      const s = storeNameOf(t);
      if (!s) continue;
      byName.set(s, (byName.get(s) ?? 0) + 1);
    }
    return Array.from(byName.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [scopedTasks]);

  const availablePriorities = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) if (t.priority) s.add(t.priority);
    // Stable severity order regardless of insertion.
    const ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
    return Array.from(s).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  }, [tasks]);

  const SLA_OPTIONS: Array<{ key: string; label: string }> = [
    { key: "breached", label: "Breached" },
    { key: "critical", label: "Critical" },
    { key: "warning", label: "Warning" },
    { key: "safe", label: "In SLA" },
  ];

  const anyFilterActive =
    filterAssigneeId !== "all" || filterDataSourceId !== "all" || filterTypes.size > 0 ||
    filterRules.size > 0 || filterStore !== "all" || filterPriorities.size > 0 || filterSla.size > 0;

  const clearAllFilters = () => {
    setFilterAssigneeId("all"); setFilterDataSourceId("all"); setFilterTypes(new Set());
    setFilterRules(new Set()); setFilterStore("all"); setFilterPriorities(new Set()); setFilterSla(new Set());
  };

  // Switching data source resets the second-level filters — they belong to a
  // specific source's vocabulary and would otherwise silently exclude the new
  // source's tasks (e.g. an Order "HSC" type filter left on while viewing
  // Appointments). Assignee / priority / SLA are cross-source, so they persist.
  const selectDataSource = (id: string) => {
    setFilterDataSourceId(id);
    setFilterTypes(new Set());
    setFilterRules(new Set());
    setFilterStore("all");
  };

  // Unassigned count for the chip badge (always reflects the unfiltered
  // workspace so the user sees the real "you have N unassigned" pulse).
  const unassignedCount = useMemo(
    () => tasks.filter((t) => !t.assignedTo).length,
    [tasks]
  );

  // Export the CURRENT view (all active filters already applied) to CSV. Scope
  // "all" = every open task across Today+Tomorrow+Stuck (so a Breached/Critical
  // SLA filter captures ALL breaching orders regardless of which tab is open);
  // a tab scope exports just that tab. Done tasks are excluded from "all".
  const openFiltered = useMemo(() => filteredTasks.filter((t) => t.viewBucket !== "done"), [filteredTasks]);
  const doExport = useCallback((scope: "all" | Tab) => {
    const list = scope === "all" ? openFiltered : byBucket[scope];
    if (!list.length) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadCsv(`smartview-${scope}-${stamp}.csv`, tasksToCsv(list));
    setExportOpen(false);
  }, [openFiltered, byBucket]);

  const lastUpdatedRel = useMemo(() => {
    const sec = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }, [now, lastUpdated]);

  return (
    <div className="px-8 py-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Smart View</h1>
          <div className="text-sm text-zinc-500 mt-1">
            {now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" })}
            <span className="mx-2">·</span>
            <span className="inline-flex items-center gap-1.5 text-zinc-400">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              Live · updated {lastUpdatedRel}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isAgent && (
            <div className="relative">
              <button
                onClick={() => setExportOpen((o) => !o)}
                disabled={loading || openFiltered.length === 0}
                className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                title="Download the current view (filters applied) as CSV / Excel"
              >
                ⤓ Export
              </button>
              {exportOpen && (
                <>
                  <button className="fixed inset-0 z-40 cursor-default" aria-label="Close export menu" onClick={() => setExportOpen(false)} />
                  <div className="absolute right-0 mt-1 z-50 w-64 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-1 text-sm">
                    <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Export to CSV · filters applied</div>
                    <button onClick={() => doExport("all")} className="w-full text-left px-3 py-2 rounded hover:bg-zinc-800 text-zinc-200 flex items-center justify-between gap-2">
                      <span>All open <span className="text-zinc-500">(Today + Tomorrow + Stuck)</span></span>
                      <span className="text-zinc-500 tabular-nums">{openFiltered.length}</span>
                    </button>
                    <button onClick={() => doExport(tab)} className="w-full text-left px-3 py-2 rounded hover:bg-zinc-800 text-zinc-200 flex items-center justify-between gap-2">
                      <span>Current tab <span className="text-zinc-500 capitalize">({tab})</span></span>
                      <span className="text-zinc-500 tabular-nums">{byBucket[tab].length}</span>
                    </button>
                    <div className="px-3 py-1.5 text-[11px] text-zinc-600 leading-snug border-t border-zinc-800 mt-1">
                      Tip: filter <b className="text-zinc-400">SLA → Breached / Critical / Warning</b> first to export exactly the breaching orders.
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          <button
            onClick={() => fetchTasks()}
            disabled={loading}
            className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            ⟳ Refresh
          </button>
        </div>
      </div>

      {/* Sticky control deck — filter bar + tab strip pin to the top of
          the scroll container so slicing/switching never requires
          scrolling back up through a long task list. The title row above
          scrolls away (it holds no controls the deck needs). Semi-opaque
          bg + blur masks rows passing underneath. */}
      <div className="sticky top-0 z-30 -mx-8 px-8 pt-2 bg-zinc-950/95 backdrop-blur-sm">

      {/* Filter bar — Lead's main tool for slicing the workspace.
          Sits above tabs so filters persist across Today/Tomorrow/Stuck.
          Hidden for agents (their queue is small enough that filters add
          noise rather than value). */}
      {!isAgent && (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 mb-4 flex flex-col gap-2.5">
        {/* ── Tier 1 — top level: WHO (assignee) and WHICH DATA (source) ── */}
        <div className="flex items-center gap-3 flex-wrap">
        {/* Assignee selector */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Assignee</span>
          <select
            value={typeof filterAssigneeId === "number" ? String(filterAssigneeId) : filterAssigneeId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "all" || v === "unassigned") setFilterAssigneeId(v);
              else setFilterAssigneeId(parseInt(v, 10));
            }}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="all">All team ({tasks.length})</option>
            <option value="unassigned">⚠ Unassigned ({unassignedCount})</option>
            <optgroup label="Team members">
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </optgroup>
          </select>
        </div>

        {/* Data Source chips — top-level slice. The Type/Rule/Store row below
            reshapes to the selected source's own vocabulary. */}
        {availableDataSources.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Source</span>
            <button
              onClick={() => selectDataSource("all")}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                filterDataSourceId === "all"
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              All
            </button>
            {availableDataSources.map((ds) => {
              const active = filterDataSourceId === ds.id;
              return (
                <button
                  key={ds.id}
                  onClick={() => selectDataSource(active ? "all" : ds.id)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {ds.label} <span className={active ? "text-blue-200" : "text-zinc-500"}>{ds.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Reset (only shows when something is filtered) */}
        {anyFilterActive && (
          <button
            onClick={clearAllFilters}
            className="text-xs text-zinc-500 hover:text-zinc-200 ml-auto"
          >
            Clear filters
          </button>
        )}
        </div>

        {/* ── Tier 2 — filters scoped to the chosen source (type / rule / store) ── */}
        {/* Rules render whenever ANY exist (they double as a per-rule count
            breakdown, valuable even for a single-rule source like Appointments);
            Type/Store need >1 to be a meaningful choice. */}
        {(availableTypes.length > 1 || availableRules.length > 0 || availableStores.length > 1) && (
        <div className="flex items-center gap-3 flex-wrap border-t border-zinc-800/70 pt-2.5">
        {/* Entity-type chips */}
        {availableTypes.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Type</span>
            <button
              onClick={() => setFilterTypes(new Set())}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                filterTypes.size === 0
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              All
            </button>
            {availableTypes.map((t) => {
              const active = filterTypes.has(t);
              return (
                <button
                  key={t}
                  onClick={() => {
                    const next = new Set(filterTypes);
                    if (active) next.delete(t); else next.add(t);
                    setFilterTypes(next);
                  }}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {typeLabel(t)}
                </button>
              );
            })}
          </div>
        )}

        {/* Rule chips — which rule produced the task. Sorted by volume so
            the biggest pile is the first chip; counts are workspace-wide. */}
        {availableRules.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Rule</span>
            <button
              onClick={() => setFilterRules(new Set())}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                filterRules.size === 0
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              All
            </button>
            {availableRules.map((r) => {
              const active = filterRules.has(r.id);
              return (
                <button
                  key={r.id}
                  onClick={() => {
                    const next = new Set(filterRules);
                    if (active) next.delete(r.id); else next.add(r.id);
                    setFilterRules(next);
                  }}
                  title={r.id}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {r.label} <span className={active ? "text-blue-200" : "text-zinc-500"}>{r.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Store selector — dropdown (store lists run long); sorted by volume */}
        {availableStores.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Store</span>
            <select
              value={filterStore}
              onChange={(e) => setFilterStore(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 max-w-[220px] focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All stores</option>
              {availableStores.map((s) => (
                <option key={s.name} value={s.name}>{s.name} ({s.count})</option>
              ))}
            </select>
          </div>
        )}
        </div>
        )}

        {/* ── Tier 3 — cross-source slices (priority / SLA) ── */}
        <div className="flex items-center gap-3 flex-wrap border-t border-zinc-800/70 pt-2.5">
        {/* Priority chips */}
        {availablePriorities.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Priority</span>
            {availablePriorities.map((p) => {
              const active = filterPriorities.has(p);
              return (
                <button
                  key={p}
                  onClick={() => {
                    const next = new Set(filterPriorities);
                    if (active) next.delete(p); else next.add(p);
                    setFilterPriorities(next);
                  }}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {p.charAt(0) + p.slice(1).toLowerCase()}
                </button>
              );
            })}
          </div>
        )}

        {/* SLA-state chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">SLA</span>
          {SLA_OPTIONS.map(({ key, label }) => {
            const active = filterSla.has(key);
            return (
              <button
                key={key}
                onClick={() => {
                  const next = new Set(filterSla);
                  if (active) next.delete(key); else next.add(key);
                  setFilterSla(next);
                }}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        </div>
      </div>
      )}

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-zinc-800 mb-6">
        {(["today", "tomorrow", "stuck"] as const).map(t => {
          const isActive = tab === t;
          const label = t === "today" ? "Today" : t === "tomorrow" ? "Tomorrow" : "Stuck";
          const countCls = isActive
            ? t === "stuck" ? "bg-red-600 text-white" : "bg-blue-600 text-white"
            : "bg-zinc-700 text-zinc-300";
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-zinc-900 border-b-2 border-blue-500 text-white -mb-px"
                  : "text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {label}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ml-2 ${countCls}`}>
                {counts[t]}
              </span>
            </button>
          );
        })}
      </div>

      {/* end sticky control deck */}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded bg-red-950/40 border border-red-900/40 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && tasks.length === 0 ? (
        <div className="py-16 text-center text-zinc-500">Loading…</div>
      ) : (
        <>
          {tab === "today" && (
            <TodayView
              tasks={byBucket.today}
              tomorrowTasks={byBucket.tomorrow}
              now={now}
              agents={agents}
              canReassign={!isAgent}
              onRowClick={(t) => setSelectedTask(t)}
              onReassign={handleReassign}
              onComplete={handleComplete}
              onBulkReassign={handleBulkReassign}
            />
          )}
          {tab === "tomorrow" && (
            <TomorrowView
              tasks={byBucket.tomorrow}
              now={now}
              agents={agents}
              canReassign={!isAgent}
              onRowClick={(t) => setSelectedTask(t)}
              onReassign={handleReassign}
            />
          )}
          {tab === "stuck" && (
            <StuckView
              tasks={byBucket.stuck}
              now={now}
              agents={agents}
              canReassign={!isAgent}
              onRowClick={(t) => setSelectedTask(t)}
              onReassign={handleReassign}
              onComplete={handleComplete}
              onBulkReassign={handleBulkReassign}
              onCloseWithReason={handleCloseWithReason}
            />
          )}
        </>
      )}

      {/* Task drawer — role-aware.
          - Agents: TaskDetailPanel in a slide-over. Full actions
            (start / complete checklist / snooze / flag for help / done).
            This is their daily workflow.
          - Heads / Admins: OrderQuickView. Read-only context — order
            details, related OpsFlow tasks, history. Heads oversee; they
            shouldn't be marking tasks complete from a monitoring view.
            They have the Reassign popover on the row for the one
            intervention they actually need from here. */}
      {selectedTask && isAgent && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setSelectedTask(null)}
            aria-hidden
          />
          <div className="fixed top-0 right-0 h-screen w-[520px] max-w-[95vw] z-50 bg-zinc-950 border-l border-zinc-800 shadow-2xl flex flex-col">
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0">
              <button
                onClick={() => setSelectedTask(null)}
                className="text-zinc-400 hover:text-zinc-100 text-sm flex items-center gap-1"
                aria-label="Close task panel"
              >
                ← Back
              </button>
              <span className="text-xs text-zinc-500">Order #{selectedTask.entityId}</span>
            </div>
            <div className="flex-1 min-h-0">
              <TaskDetailPanel
                key={selectedTask.id}
                task={selectedTask}
                onUpdate={() => { fetchTasks(); }}
              />
            </div>
          </div>
        </>
      )}
      {selectedTask && !isAgent && (
        (selectedTask.entityType ?? "").toUpperCase() === "APPOINTMENT" ||
        selectedTask.dataSource?.sourceId === "Appointments" ? (
          <AppointmentQuickView
            appointmentId={selectedTask.entityId}
            onClose={() => setSelectedTask(null)}
          />
        ) : (
          <OrderQuickView
            orderId={selectedTask.entityId}
            onClose={() => setSelectedTask(null)}
          />
        )
      )}
    </div>
  );
}
