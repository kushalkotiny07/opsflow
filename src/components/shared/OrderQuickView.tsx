"use client";

import { useState, useEffect, useRef } from "react";
import StatusBadge from "@/components/shared/StatusBadge";
import PriorityBadge from "@/components/shared/PriorityBadge";
import SlaCountdown from "@/components/shared/SlaCountdown";
import { formatISTTimestamp, formatISTDate } from "@/lib/utils/timezone";

interface OrderDetail {
  id: number;
  orderType: string;
  orderStatus: string;
  appointmentTime: string;
  storeId: number | null;
  labId: number | null;
  userId: number;
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string;
  internalNotes: string | null;
  notes: string | null;
  phleboName: string | null;
  phleboNumber: string | null;
  patientName: string;
  labName: string | null;
  storeName: string | null;
}

interface OrderTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  slaDeadline: string;
  slaBreachedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignedTo: { id: number; name: string } | null;
  taskType: { label: string } | null;
}

/** A milestone SLA breach on this order, from lib/provider-comms. */
interface OrderSlaBreach {
  id: string;
  milestone: string;
  deadlineAt: string;
  overdueMinutes: number;
  attemptsSent: number;
  nextAttemptAt: string | null;
  status: "ACTIVE" | "RESOLVED" | "CAPPED" | "CANCELLED";
  resolutionReason: string | null;
  lastDeliveryStatus: string | null;
}

const MILESTONE_LABELS: Record<string, string> = {
  ORDER_CONFIRMED: "Order confirmed",
  PHLEBO_ASSIGNED: "Phlebotomist assigned",
  SAMPLE_COLLECTED: "Sample collected",
  SAMPLE_DELIVERED: "Sample delivered to lab",
  REPORT_UPLOADED: "Report uploaded",
};

const BREACH_STATUS_STYLE: Record<OrderSlaBreach["status"], string> = {
  ACTIVE: "bg-rose-500/10 text-rose-300",
  RESOLVED: "bg-emerald-500/10 text-emerald-300",
  CAPPED: "bg-amber-500/10 text-amber-300",
  CANCELLED: "bg-zinc-800 text-zinc-400",
};

/** "1h 20m" — always unit-labelled, never a bare number. */
function overdueLabel(totalMinutes: number): string {
  const minutes = Math.max(0, totalMinutes);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

interface OrderQuickViewProps {
  orderId: number;
  onClose: () => void;
}

const ORDER_STATUS_COLOR: Record<string, string> = {
  PENDING: "text-amber-400",
  CONFIRMED: "text-blue-400",
  AGENT_ASSIGNED: "text-purple-400",
  SAMPLE_COLLECTED: "text-teal-400",
  REPORT_UPLOADED: "text-emerald-400",
  REPORT_DELIVERED: "text-emerald-400",
  CANCELED: "text-red-400",
  PATIENT_MISSED: "text-red-400",
};

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-[10px] text-zinc-600 w-28 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-zinc-300 flex-1">{value ?? "—"}</span>
    </div>
  );
}

export default function OrderQuickView({ orderId, onClose }: OrderQuickViewProps) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [tasks, setTasks] = useState<OrderTask[]>([]);
  const [slaBreaches, setSlaBreaches] = useState<OrderSlaBreach[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/orders/${orderId}`);
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.error ?? "Order not found");
        }
        const data = await res.json();
        setOrder(data.order);
        setTasks(data.tasks ?? []);
        setSlaBreaches(data.slaBreaches ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load order");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [orderId]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Slide-over panel */}
      <div
        ref={panelRef}
        className="fixed right-0 top-0 h-full w-full max-w-md bg-zinc-900 border-l border-zinc-700 shadow-2xl z-50 flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white">Order #{orderId}</h2>
              {order && (
                <span className={`text-[10px] font-semibold ${ORDER_STATUS_COLOR[order.orderStatus] ?? "text-zinc-400"}`}>
                  {order.orderStatus}
                </span>
              )}
            </div>
            {order && (
              <p className="text-xs text-zinc-500 mt-0.5">{order.orderType.replace(/_/g, " ")}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="px-5 py-6">
              <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">{error}</div>
            </div>
          ) : order ? (
            <div className="px-5 py-5 space-y-6">
              {/* Patient info */}
              <div>
                <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Patient</h3>
                <div className="space-y-2">
                  <InfoRow label="Name" value={order.patientName} />
                  <InfoRow label="User ID" value={`#${order.userId}`} />
                </div>
              </div>

              {/* Order info */}
              <div>
                <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Order Details</h3>
                <div className="space-y-2">
                  <InfoRow label="Appointment" value={
                    <span>{formatISTTimestamp(order.appointmentTime, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  } />
                  <InfoRow label="Store" value={order.storeName ?? (order.storeId ? `#${order.storeId}` : null)} />
                  <InfoRow label="Lab" value={order.labName ?? (order.labId ? `#${order.labId}` : null)} />
                  <InfoRow label="Phlebo" value={
                    order.phleboName ? `${order.phleboName}${order.phleboNumber ? ` (${order.phleboNumber})` : ""}` : null
                  } />
                  <InfoRow label="Created" value={formatISTDate(order.createdAt)} />
                  <InfoRow label="Last Updated" value={formatISTTimestamp(order.updatedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} />
                </div>
              </div>

              {/* Notes */}
              {(order.notes || order.internalNotes) && (
                <div>
                  <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">Notes</h3>
                  <div className="space-y-2">
                    {order.notes && (
                      <div>
                        <div className="text-[10px] text-zinc-600 mb-1">Customer Notes</div>
                        <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap bg-zinc-800 rounded-lg px-3 py-2.5">{order.notes}</p>
                      </div>
                    )}
                    {order.internalNotes && (
                      <div>
                        <div className="text-[10px] text-zinc-600 mb-1">Internal Notes (OpsFlow)</div>
                        <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap bg-zinc-800 rounded-lg px-3 py-2.5">{order.internalNotes}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Milestone SLA breaches — what the PROVIDER was chased about.
                  Distinct from the tasks below, which are OpsFlow's own
                  internal work: a breach here is a message that went to the
                  lab, and it exists for API labs too. Hidden entirely when
                  there are none, so the drawer does not grow an empty section
                  on the majority of orders. */}
              {slaBreaches.length > 0 && (
                <div>
                  <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
                    SLA Breaches
                    <span className="ml-1.5 text-zinc-600">({slaBreaches.length})</span>
                  </h3>
                  <div className="space-y-2">
                    {slaBreaches.map((breach) => (
                      <div key={breach.id} className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-3">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-zinc-200 leading-snug">
                              {MILESTONE_LABELS[breach.milestone] ?? breach.milestone}
                            </div>
                            <div className="text-[10px] text-zinc-600 mt-0.5">
                              Due {formatISTTimestamp(breach.deadlineAt, { hour: "2-digit", minute: "2-digit" })}
                            </div>
                          </div>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${BREACH_STATUS_STYLE[breach.status]}`}>
                            {breach.status}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <span className={`text-[10px] font-semibold ${breach.status === "ACTIVE" ? "text-rose-400" : "text-zinc-500"}`}>
                            +{overdueLabel(breach.overdueMinutes)} overdue
                          </span>
                          <span className="text-[10px] text-zinc-500">
                            {breach.attemptsSent} attempt{breach.attemptsSent === 1 ? "" : "s"} to the lab
                          </span>
                          {breach.lastDeliveryStatus && (
                            <span
                              className={`text-[10px] ${
                                breach.lastDeliveryStatus === "FAILED" ? "text-rose-400"
                                  : breach.lastDeliveryStatus === "SENT" ? "text-emerald-500"
                                  : breach.lastDeliveryStatus === "DRY_RUN" ? "text-amber-400"
                                  : "text-zinc-500"
                              }`}
                            >
                              {breach.lastDeliveryStatus}
                            </span>
                          )}
                          {breach.resolutionReason && (
                            <span className="text-[10px] text-zinc-600">
                              {breach.resolutionReason.replaceAll("_", " ").toLowerCase()}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* OpsFlow Tasks */}
              <div>
                <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
                  OpsFlow Tasks
                  <span className="ml-1.5 text-zinc-600">({tasks.length})</span>
                </h3>
                {tasks.length === 0 ? (
                  <p className="text-xs text-zinc-600">No tasks created for this order</p>
                ) : (
                  <div className="space-y-2">
                    {tasks.map((task) => (
                      <div key={task.id} className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-3">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-zinc-200 leading-snug">{task.title}</div>
                            <div className="text-[10px] text-zinc-600 mt-0.5">
                              #{task.id} · {task.taskType?.label ?? "Task"}
                            </div>
                          </div>
                          <StatusBadge status={task.status as never} />
                        </div>
                        <div className="flex items-center gap-3">
                          <PriorityBadge priority={task.priority as never} />
                          <span className="text-[10px] text-zinc-500">
                            {task.assignedTo ? task.assignedTo.name : "Unassigned"}
                          </span>
                          {task.status !== "COMPLETED" && task.status !== "CANCELLED" && (
                            <SlaCountdown deadline={task.slaDeadline} compact />
                          )}
                          {task.completedAt && (
                            <span className="text-[10px] text-emerald-500">
                              Done {formatISTTimestamp(task.completedAt, { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
