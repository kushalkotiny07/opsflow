"use client";

import { useCallback, useEffect, useState } from "react";

type Gateway = { status: string; online: boolean; connectedNumber: string | null; qrDataUrl: string | null; lastSeenAt: string | null; gatewayLive?: boolean };
type Group = { id: string; jid: string; subject: string; role: string; storeId: number | null; labId: number | null; active: boolean; sendEnabled: boolean; autoAskIdOnMissing: boolean };

const ROLES = [
  { v: "SUPPORT", label: "Customer" },
  { v: "PROVIDER", label: "Provider" },
  { v: "INTERNAL", label: "Internal" },
  { v: "IGNORE", label: "Ignore" },
];

export function WhatsAppSettings() {
  const [gw, setGw] = useState<Gateway | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [listenFilter, setListenFilter] = useState<"ALL" | "ON" | "OFF">("ALL");
  const [contacts, setContacts] = useState<{ id: string; name: string; phone: string | null; team: string | null }[]>([]);
  const [contactText, setContactText] = useState("");
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };

  const shownGroups = groups.filter(
    (g) =>
      (roleFilter === "ALL" || g.role === roleFilter) &&
      (listenFilter === "ALL" || (listenFilter === "ON" ? g.active : !g.active)) &&
      g.subject.toLowerCase().includes(q.toLowerCase())
  );
  const listeningCount = groups.filter((g) => g.active).length;

  const loadGw = useCallback(async () => {
    const r = await fetch("/api/whatsapp/gateway"); if (r.ok) setGw(await r.json());
  }, []);
  const loadGroups = useCallback(async () => {
    const r = await fetch("/api/whatsapp/groups"); if (r.ok) setGroups((await r.json()).groups);
  }, []);
  const loadContacts = useCallback(async () => {
    const r = await fetch("/api/whatsapp/contacts"); if (r.ok) setContacts((await r.json()).contacts);
  }, []);

  async function saveContacts() {
    if (!contactText.trim()) return flash("Paste Name, Phone lines first");
    const r = await fetch("/api/whatsapp/contacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: contactText }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return flash(d.error || "Save failed");
    flash(`Saved ${d.total} team members`); setContactText(""); loadContacts();
  }
  async function deleteContact(id: string) {
    await fetch(`/api/whatsapp/contacts/${id}`, { method: "DELETE" }); loadContacts();
  }

  useEffect(() => { loadGw(); loadGroups(); loadContacts(); }, [loadGw, loadGroups, loadContacts]);
  useEffect(() => { const t = setInterval(loadGw, 3000); return () => clearInterval(t); }, [loadGw]); // live QR/status

  async function command(command: string) {
    await fetch("/api/whatsapp/gateway", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
    flash(command === "LOGOUT" ? "Unlinking…" : command === "BACKFILL" ? "Backfilling last 3 days — re-resolving threads & pulling media…" : "Re-linking — scan the new QR");
    loadGw();
  }

  async function patchGroup(id: string, patch: Partial<Group>) {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    const r = await fetch(`/api/whatsapp/groups/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (!r.ok) { flash("Save failed"); loadGroups(); }
  }

  const connected = gw?.status === "CONNECTED";
  const needsScan = gw?.status === "QR" || gw?.status === "LOGGED_OUT";

  return (
    <div className="max-w-5xl">
      <div className="mb-1 text-xs text-zinc-500"><a href="/head/whatsapp" className="hover:text-zinc-300">‹ Back to inbox</a> &nbsp;·&nbsp; Settings / Integrations / <span className="text-zinc-300 font-medium">WhatsApp</span></div>
      <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">WhatsApp integration</h1>
      <p className="text-sm text-zinc-400 mt-1 mb-5">Link the ops WhatsApp account and classify each group. Powers the WhatsApp Control Tower inbox — admins only.</p>

      {/* Connection */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 mb-6">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold mb-3">WhatsApp connection</div>
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-emerald-500" : needsScan ? "bg-amber-500" : "bg-zinc-500"}`} />
          <div>
            <div className="text-sm text-zinc-100">
              {connected ? <>Connected as <span className="font-mono font-semibold">+{gw?.connectedNumber}</span></> : needsScan ? "Waiting for scan" : "Connecting…"}
            </div>
            <div className="text-xs text-zinc-500">{gw?.online ? "Linked device · online" : "Gateway offline"}{gw?.lastSeenAt ? ` · last seen ${new Date(gw.lastSeenAt).toLocaleTimeString()}` : ""}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <button onClick={() => command("BACKFILL")} className="text-xs font-semibold border border-zinc-700 hover:border-emerald-500 hover:text-emerald-400 rounded-lg px-3 py-2 text-zinc-300">Backfill last 3 days</button>
            <button onClick={() => command("RELINK")} className="text-xs font-semibold border border-zinc-700 hover:border-blue-500 rounded-lg px-3 py-2 text-zinc-300">Re-link (show QR)</button>
            <button onClick={() => command("LOGOUT")} className="text-xs font-semibold border border-zinc-700 hover:border-rose-500 hover:text-rose-400 rounded-lg px-3 py-2 text-zinc-300">Unlink</button>
          </div>
        </div>
        {needsScan && (
          <div className="mt-4 flex gap-5 items-center rounded-lg border border-dashed border-zinc-700 p-4 bg-zinc-900/60">
            {gw?.qrDataUrl
              ? <img src={gw.qrDataUrl} alt="WhatsApp QR" width={180} height={180} className="rounded bg-white p-2" />
              : (
                // A stale QR means the gateway stopped: the row still holds the
                // last code it pushed, but that code expired seconds later and
                // scanning it can only fail. Saying so beats "Generating QR…"
                // forever, which is what this showed while nothing was running.
                <div className="w-[180px] h-[180px] grid place-items-center rounded border border-dashed border-zinc-700 px-3 text-center text-xs text-zinc-500">
                  {gw && gw.gatewayLive === false
                    ? <span>The gateway is not running,<br />so no QR is being produced.</span>
                    : <span>Generating QR…</span>}
                </div>
              )}
            <div className="text-sm text-zinc-300">
              <div className="font-semibold text-zinc-100 mb-1">Scan to link</div>
              <p className="text-zinc-400 max-w-xs">On the ops phone: <b>WhatsApp → Settings → Linked Devices → Link a Device</b>, then scan this code.</p>
              <p className="text-xs text-zinc-500 mt-2">Refreshes automatically until the device connects.</p>
              {gw && gw.gatewayLive === false && (
                <p className="text-xs text-amber-400 mt-2">
                  Start it on the server with <code className="font-mono">./run-gateway.sh start</code>, then this code refreshes on its own.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Group classification */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3 flex-wrap">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Group classification</div>
          <span className="text-[11px] text-zinc-500">Listening to <b className="text-emerald-400">{listeningCount}</b> of {groups.length} groups</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups…"
            className="ml-auto w-56 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 text-xs text-zinc-200 focus:border-blue-500 outline-none" />
          <div className="flex rounded-md border border-zinc-700 overflow-hidden text-xs">
            {(["ALL", "ON", "OFF"] as const).map((v) => (
              <button key={v} onClick={() => setListenFilter(v)} className={`px-2.5 py-1.5 font-medium ${listenFilter === v ? "bg-blue-600 text-white" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"}`}>
                {v === "ALL" ? "All" : v === "ON" ? "Listening" : "Not listening"}
              </button>
            ))}
          </div>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-300 focus:border-blue-500 outline-none">
            <option value="ALL">All roles</option>
            {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
          <span className="text-xs text-zinc-500">{shownGroups.length}/{groups.length}</span>
        </div>
        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-950/95 backdrop-blur">
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
                <th className="px-4 py-2.5 font-semibold">Group</th>
                <th className="px-3 py-2.5 font-semibold">Role</th>
                <th className="px-3 py-2.5 font-semibold">Map (store/lab id)</th>
                <th className="px-3 py-2.5 font-semibold text-center">Active</th>
                <th className="px-3 py-2.5 font-semibold text-center">Send</th>
                <th className="px-3 py-2.5 font-semibold text-center">Ask ID</th>
              </tr>
            </thead>
            <tbody>
              {shownGroups.map((g) => (
                <tr key={g.id} className="border-b border-zinc-800/60 hover:bg-zinc-900/40">
                  <td className="px-4 py-2.5 text-zinc-200 font-medium">{g.subject.replace("Labstack", "LS").replace("LABSTACK", "LS")}</td>
                  <td className="px-3 py-2.5">
                    <select value={g.role} onChange={(e) => patchGroup(g.id, { role: e.target.value })}
                      className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 focus:border-blue-500 outline-none">
                      {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5">
                    {g.role === "SUPPORT" || g.role === "PROVIDER" ? (
                      <input type="number" defaultValue={(g.role === "SUPPORT" ? g.storeId : g.labId) ?? ""} placeholder={g.role === "SUPPORT" ? "store id" : "lab id"}
                        onBlur={(e) => patchGroup(g.id, g.role === "SUPPORT" ? { storeId: e.target.value ? Number(e.target.value) : null } : { labId: e.target.value ? Number(e.target.value) : null })}
                        className="w-24 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 focus:border-blue-500 outline-none" />
                    ) : <span className="text-zinc-600 text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-center"><Toggle on={g.active} onChange={(v) => patchGroup(g.id, { active: v })} /></td>
                  <td className="px-3 py-2.5 text-center"><Toggle on={g.sendEnabled} onChange={(v) => patchGroup(g.id, { sendEnabled: v })} /></td>
                  <td className="px-3 py-2.5 text-center"><Toggle on={g.autoAskIdOnMissing} onChange={(v) => patchGroup(g.id, { autoAskIdOnMissing: v })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* LS team roster */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden mt-6">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">LS team contacts</div>
          <span className="ml-auto text-xs text-zinc-500">{contacts.length} members</span>
        </div>
        <div className="p-4 grid grid-cols-[1fr_1fr] gap-4 max-md:grid-cols-1">
          <div>
            <p className="text-xs text-zinc-400 mb-2">Paste one per line: <span className="font-mono text-zinc-300">Name, Phone[, Team]</span>. This is how the console tells your team&apos;s replies apart from incoming customer messages.</p>
            <textarea value={contactText} onChange={(e) => setContactText(e.target.value)} rows={6}
              placeholder={"Sushma, 919876543210, Store ops\nVijay Kansal, 919812345678, Lab desk"}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 outline-none font-mono" />
            <button onClick={saveContacts} className="mt-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-3 py-2">Save team members</button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {contacts.length === 0 && <div className="text-sm text-zinc-500">No team members yet.</div>}
            {contacts.map((c) => (
              <div key={c.id} className="flex items-center gap-2 py-1.5 border-b border-zinc-800/60 text-sm">
                <span className="text-zinc-200 font-medium">{c.name}</span>
                {c.phone && <span className="text-xs font-mono text-zinc-500">{c.phone}</span>}
                {c.team && <span className="text-[10px] text-zinc-400 bg-zinc-800 px-1.5 rounded">{c.team}</span>}
                <button onClick={() => deleteContact(c.id)} className="ml-auto text-xs text-zinc-500 hover:text-rose-400">remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {toast && <div className="fixed left-1/2 bottom-6 -translate-x-1/2 bg-zinc-100 text-zinc-900 px-4 py-2 rounded-lg font-medium text-sm shadow-lg z-10">{toast}</div>}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`relative w-9 h-5 rounded-full transition-colors ${on ? "bg-blue-600" : "bg-zinc-700"}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}
