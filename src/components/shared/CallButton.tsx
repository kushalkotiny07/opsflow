"use client";

import { useState } from "react";

/**
 * Click-to-call button. Posts to /api/calls, which asks Exotel to ring the
 * logged-in user's own phone first and then bridge to `to`. Shows brief inline
 * status; resets itself after a few seconds.
 */
export default function CallButton({
  to,
  name,
  taskId,
  storeId,
  triggeredFrom,
  compact = true,
}: {
  to: string | null | undefined;
  name?: string | null;
  taskId?: number;
  storeId?: number;
  triggeredFrom?: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<"idle" | "calling" | "ringing" | "error">("idle");
  const [msg, setMsg] = useState<string>("");

  if (!to) return null;

  const place = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "calling") return;
    setState("calling");
    setMsg("");
    try {
      const res = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, toName: name ?? null, taskId, storeId, triggeredFrom }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMsg(data.error ?? "Call failed");
      } else {
        setState("ringing");
        setMsg("Ringing your phone…");
      }
    } catch {
      setState("error");
      setMsg("Network error");
    } finally {
      setTimeout(() => { setState("idle"); setMsg(""); }, 6000);
    }
  };

  const busy = state === "calling";
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <button
        type="button"
        onClick={place}
        disabled={busy}
        title={`Call ${name ?? to} — rings your phone first`}
        className={`inline-flex items-center gap-1 rounded-full border transition-colors disabled:opacity-50 ${
          compact ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
        } ${
          state === "error"
            ? "border-red-700/50 bg-red-500/10 text-red-300"
            : "border-emerald-700/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
        }`}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
        </svg>
        {busy ? "Calling…" : "Call"}
      </button>
      {msg && (
        <span className={`text-[10px] ${state === "error" ? "text-red-400" : "text-emerald-400"}`}>{msg}</span>
      )}
    </span>
  );
}
