"use client";

/**
 * One provider's orders for today and tomorrow.
 *
 * Reached by clicking a lab on the board. A page rather than an expanding row
 * because this is where someone settles in to work a provider: it can be
 * linked to, opened in a tab next to the WhatsApp thread, and refreshed without
 * losing the rest of the board's state.
 *
 * Grouped by day, because "what is left today" and "what lands tomorrow" are
 * two different decisions and mixing them makes the reader do the separating.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type OrderRow = {
  orderId: number;
  labOrderId: string | null;
  orderType: string;
  orderStatus: string;
  appointmentTime: string | null;
  patientName: string | null;
  location: string | null;
  when: "today" | "tomorrow";
  confirmation: string | null;
  rejectionReason: string | null;
};

/** What `GET /api/provider-comms/daily-digest` hands back. */
type DigestPreview = {
  text?: string;
  recipient?: string;
  sendBlocked?: boolean;
  schedule: { enabled: boolean; hour: number; minute: number; skipWhenEmpty: boolean; timeZone: string };
};

type Lab = {
  labId: number;
  labName: string;
  integrationType: "API" | "NON_API";
  isActive: boolean;
  reachable: boolean;
  waGroupJid: string | null;
  confirmationSlaMinutes: number;
  reminderSlaMinutes: number;
  escalationSlaMinutes: number;
};

/** The provider's answer, in their terms rather than as a status code. */
const CONFIRMATION_LABEL: Record<string, { text: string; tone: string }> = {
  WAITING_FOR_LAB_CONFIRMATION: { text: "Awaiting reply", tone: "text-amber-400" },
  LAB_ACCEPTED: { text: "Accepted", tone: "text-emerald-400" },
  LAB_RESCHEDULE_REQUESTED: { text: "Reschedule asked", tone: "text-amber-400" },
  LAB_REJECTED: { text: "Cannot fulfil", tone: "text-red-400" },
  ESCALATED: { text: "Escalated", tone: "text-red-400" },
  CANCELLED: { text: "Cancelled", tone: "text-zinc-500" },
  COMPLETED: { text: "Done", tone: "text-zinc-400" },
};

export function ProviderOrdersPage({ labId }: { labId: number }) {
  const [lab, setLab] = useState<Lab | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [timeZone, setTimeZone] = useState("Asia/Kolkata");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<DigestPreview | null>(null);
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestNote, setDigestNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/provider-comms/daily-board/${labId}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error ?? "Could not load this provider"); return; }
      setLab(data.lab ?? null);
      setOrders(data.orders ?? []);
      setTruncated(!!data.truncated);
      if (data.timeZone) setTimeZone(data.timeZone);
      setError(null);
    } catch {
      setError("Could not load this provider");
    } finally {
      setLoading(false);
    }
  }, [labId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  /** Render the evening message without sending it. */
  const previewDigest = useCallback(async () => {
    if (digest) { setDigest(null); return; }
    setDigestBusy(true); setDigestNote(null);
    try {
      const response = await fetch(`/api/provider-comms/daily-digest?labId=${labId}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) setDigestNote(data.error ?? "Could not build the preview");
      else setDigest(data);
    } catch {
      setDigestNote("Could not build the preview");
    } finally {
      setDigestBusy(false);
    }
  }, [labId, digest]);

  /** Send it now, as a one-off. Does not consume today's scheduled slot. */
  const sendDigest = useCallback(async () => {
    setDigestBusy(true); setDigestNote(null);
    try {
      const response = await fetch("/api/provider-comms/daily-digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labId }),
      });
      const data = await response.json().catch(() => ({}));
      setDigestNote(
        !response.ok ? (data.error ?? "Could not send the summary")
          : data.sendBlocked ? "Queued — but sending is still switched off for this group, so it will not leave until you enable it."
          : "Queued. The gateway will send it within a minute.",
      );
    } catch {
      setDigestNote("Could not send the summary");
    } finally {
      setDigestBusy(false);
    }
  }, [labId]);

  const clock = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso)) : "—";

  const groups = [
    { key: "today", label: "Today", rows: orders.filter((o) => o.when === "today") },
    { key: "tomorrow", label: "Tomorrow", rows: orders.filter((o) => o.when === "tomorrow") },
  ];

  const unanswered = orders.filter((o) => o.confirmation === "WAITING_FOR_LAB_CONFIRMATION").length;
  const notAsked = orders.filter((o) => o.confirmation === null).length;

  return (
    <div>
      <Link href="/head/non-api-labs/board" className="text-xs text-zinc-500 hover:text-zinc-300">
        ‹ Back to all providers
      </Link>

      {loading ? (
        <div className="p-10 text-center text-sm text-zinc-500">Loading orders…</div>
      ) : error ? (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {error} <button onClick={load} className="underline hover:text-red-200">Try again</button>
        </div>
      ) : (
        <>
          <div className="mb-5 mt-2 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{lab?.labName}</h1>
              <div className="mt-1 font-mono text-[11px] text-zinc-500">
                Lab #{lab?.labId} · {lab?.integrationType}
                {lab && !lab.isActive && <span className="ml-1 text-amber-400">· paused</span>}
                {lab?.isActive && !lab.reachable && <span className="ml-1 text-red-400">· no WhatsApp target</span>}
              </div>
              {lab?.integrationType === "NON_API" && (
                <div className="mt-1 text-[11px] text-zinc-500">
                  Chased at {lab.confirmationSlaMinutes}m / {lab.reminderSlaMinutes}m, escalates at {lab.escalationSlaMinutes}m
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Link
                href="/head/non-api-labs/lab-config"
                className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200"
              >
                Lab config
              </Link>
              <button
                onClick={previewDigest}
                disabled={digestBusy}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
              >
                {digest ? "Hide daily summary" : "Daily summary"}
              </button>
              <button onClick={load} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200">
                Refresh
              </button>
            </div>
          </div>

          {digestNote && (
            <div className="mb-4 rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-2.5 text-xs text-zinc-300">
              {digestNote}
            </div>
          )}

          {digest && (
            <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-medium text-zinc-200">Daily summary</div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {digest.schedule.enabled
                      ? `Sends automatically at ${String(digest.schedule.hour).padStart(2, "0")}:${String(digest.schedule.minute).padStart(2, "0")} ${digest.schedule.timeZone}`
                      : "Not scheduled — switch it on for this lab under Lab config"}
                    {digest.schedule.enabled && digest.schedule.skipWhenEmpty && " · skipped on days with no orders"}
                  </div>
                </div>
                <button
                  onClick={sendDigest}
                  disabled={digestBusy}
                  className="rounded-lg border border-zinc-600 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {digestBusy ? "Sending…" : "Send now"}
                </button>
              </div>
              {/* Exactly what would be sent, whitespace and all — a summary of
                  the summary would defeat the point of looking. */}
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs leading-relaxed text-zinc-300">
                {digest.text}
              </pre>
              <div className="mt-2 font-mono text-[11px] text-zinc-600">
                To {digest.recipient}
                {digest.sendBlocked && <span className="ml-1 text-amber-400">· sending is off for this group</span>}
              </div>
            </div>
          )}

          <div className="mb-5 grid grid-cols-4 gap-3 max-md:grid-cols-2">
            <Metric label="Today" value={groups[0].rows.length} />
            <Metric label="Tomorrow" value={groups[1].rows.length} />
            <Metric label="Awaiting reply" value={unanswered} tone={unanswered ? "text-amber-400" : "text-zinc-100"} />
            {/* Never asked is a different problem from asked-and-ignored. */}
            <Metric label="Never asked" value={notAsked} tone={notAsked ? "text-zinc-400" : "text-zinc-100"} />
          </div>

          {orders.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 p-10 text-center text-sm text-zinc-400">
              No orders today or tomorrow for {lab?.labName}.
            </div>
          ) : (
            <div className="space-y-6">
              {groups.filter((group) => group.rows.length > 0).map((group) => (
                <div key={group.key}>
                  <div className="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">
                    {group.label} · {group.rows.length} order{group.rows.length > 1 ? "s" : ""}
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-zinc-800">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-950/70">
                        <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                          <th className="px-4 py-2.5">Time</th>
                          <th className="px-3 py-2.5">Order</th>
                          <th className="px-3 py-2.5">Patient</th>
                          <th className="px-3 py-2.5">Type</th>
                          <th className="px-3 py-2.5">Location</th>
                          <th className="px-3 py-2.5">Order status</th>
                          <th className="px-3 py-2.5">Provider said</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.rows.map((order) => {
                          const confirmation = order.confirmation ? CONFIRMATION_LABEL[order.confirmation] : null;
                          return (
                            <tr key={order.orderId} className="border-b border-zinc-800/60 hover:bg-zinc-900/40">
                              <td className="px-4 py-3 text-zinc-200">{clock(order.appointmentTime)}</td>
                              <td className="px-3 py-3 font-mono text-[11px] text-zinc-400">
                                #{order.orderId}
                                {order.labOrderId && <div className="text-zinc-600">{order.labOrderId}</div>}
                              </td>
                              <td className="px-3 py-3 text-zinc-200">{order.patientName ?? "—"}</td>
                              <td className="px-3 py-3 text-xs text-zinc-400">
                                {order.orderType === "HOME_SAMPLE" ? "Home collection"
                                  : order.orderType === "CENTER_VISIT" ? "Centre visit"
                                  : order.orderType}
                              </td>
                              <td className="px-3 py-3 text-xs text-zinc-400">{order.location ?? "—"}</td>
                              <td className="px-3 py-3 text-xs text-zinc-400">
                                {order.orderStatus.replaceAll("_", " ").toLowerCase()}
                              </td>
                              <td className="px-3 py-3 text-xs">
                                {confirmation
                                  ? <span className={confirmation.tone}>{confirmation.text}</span>
                                  // No workflow at all: we have never opened a
                                  // conversation about this order.
                                  : <span className="text-zinc-600">Not asked</span>}
                                {order.rejectionReason && (
                                  <div className="mt-0.5 text-[11px] text-zinc-500">{order.rejectionReason}</div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              {truncated && (
                <p className="text-[11px] text-amber-400">
                  Showing the first 200 orders only — this provider has more than this screen is meant for.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, tone = "text-zinc-100" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
