import prisma from "@/lib/db/client";

async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default async function ProviderActionPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { token } = await params;
  const { result } = await searchParams;
  const actionToken = /^[a-f0-9]{64}$/.test(token)
    ? await prisma.labProviderActionToken.findUnique({ where: { tokenHash: await sha256(token) }, include: { workflow: true } })
    : null;
  const available = Boolean(actionToken && !actionToken.usedAt && actionToken.expiresAt > new Date() && !["CANCELLED", "COMPLETED", "LAB_REJECTED"].includes(actionToken.workflow.status));
  if (available && actionToken && !actionToken.openedAt) {
    const openedAt = new Date();
    const opened = await prisma.labProviderActionToken.updateMany({ where: { id: actionToken.id, openedAt: null }, data: { openedAt } });
    if (opened.count) {
      await prisma.labCommunicationOrderEvent.create({
        data: { workflowId: actionToken.workflowId, type: "ACTION_LINK_OPENED", actorType: "LAB", payload: { tokenId: actionToken.id } },
      });
    }
  }
  const snapshot = actionToken?.workflow.orderSnapshot as { orderId?: number; labName?: string; patientName?: string; appointmentTime?: string } | undefined;

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-12 text-zinc-100">
      <section className="mx-auto max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <div className="text-xs font-semibold uppercase tracking-wide text-blue-400">LabStack order confirmation</div>
        <h1 className="mt-2 text-2xl font-semibold">{available ? "Please choose an action" : result === "success" ? "Action recorded" : "Action link unavailable"}</h1>
        {available && snapshot ? (
          <div className="mt-5 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-300">
            <div><span className="text-zinc-500">Lab:</span> {snapshot.labName ?? "Lab"}</div>
            <div><span className="text-zinc-500">Order:</span> #{snapshot.orderId ?? "-"}</div>
            <div><span className="text-zinc-500">Patient:</span> {snapshot.patientName ?? "Patient"}</div>
            {snapshot.appointmentTime && <div><span className="text-zinc-500">Appointment:</span> {new Date(snapshot.appointmentTime).toLocaleString("en-IN")}</div>}
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-400">This link may have expired or another team member may have already responded.</p>
        )}
        {available && actionToken && (
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {(["ACCEPT", "RESCHEDULE", "REJECT"] as const).map((action) => (
              <form key={action} action={`/api/provider/action/${token}`} method="post" className="space-y-2">
                <input type="hidden" name="action" value={action} />
                {action === "RESCHEDULE" && <input name="proposedAppointmentTime" placeholder="Proposed date/time" className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-200" maxLength={100} />}
                {action !== "ACCEPT" && <textarea name="reason" placeholder={action === "REJECT" ? "Reason (optional)" : "Reason or preferred slot (optional)"} className="min-h-16 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-200" maxLength={500} />}
                <button className={`w-full rounded-lg px-3 py-2 text-sm font-semibold ${action === "ACCEPT" ? "bg-emerald-600 hover:bg-emerald-500" : action === "RESCHEDULE" ? "bg-amber-600 hover:bg-amber-500" : "bg-rose-600 hover:bg-rose-500"}`}>
                  {action === "ACCEPT" ? "Accept" : action === "RESCHEDULE" ? "Reschedule" : "Cannot fulfil"}
                </button>
              </form>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
