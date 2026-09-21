/**
 * Control Tower integration — the gateway's writes to the OpsFlow (taskos) DB.
 *
 * Responsibilities:
 *   - publish gateway status + live QR   → wa_gateway (singleton "default")
 *   - persist every in-scope message     → wa_messages (idempotent)
 *   - create/enrich tickets              → wa_tickets  (+ context from replica)
 *   - missing-id auto-reply              → wa_outbound (debounced)
 *   - drain the outbound queue           → send via the caller-provided socket
 *
 * Group scope + roles come from wa_groups (admin-configured), replacing the
 * hardcoded /labstack/i filter: only groups present + active are handled.
 */
import { taskos, taskosQuery } from "./taskosdb.mjs";
import { classify, extractIds, extractReferences, DISPOSITION, isLabstack } from "./classifier.mjs";
import { lookupIds, resolveEntities, orderLabs } from "./lookup.mjs";
import { loadTeam, makeTeamMatcher } from "./team.mjs";

// ── group cache (jid → config row) ─────────────────────────────────────────
let groupCache = new Map();
export async function refreshGroups() {
  const r = await taskosQuery(
    `SELECT id, jid, subject, role, active, "storeId", "labId", "autoAskIdOnMissing", "sendEnabled" FROM wa_groups`
  );
  const m = new Map();
  for (const g of r.rows) m.set(g.jid, g);
  groupCache = m;
  return m;
}
export const getGroup = (jid) => groupCache.get(jid);
export const knownGroupCount = () => groupCache.size;

// Auto-register groups the gateway discovers on connect. Inserts new jids
// (default role SUPPORT for an admin to classify) and refreshes the subject on
// existing ones — never overwrites an admin's role/mapping. Makes server
// deploys turnkey: no manual seed step. `pairs` = iterable of [jid, subject].
export async function syncGroups(pairs, preActiveJids = null) {
  // preActiveJids: jids to activate on FIRST registration (e.g. hint matches).
  // When null, every discovered group is pre-activated (legacy turnkey). On
  // conflict we only refresh the subject — never the admin's active/role choice.
  const activeSet = preActiveJids ? new Set(preActiveJids) : null;
  for (const [jid, subject] of pairs) {
    const active = activeSet ? activeSet.has(jid) : true;
    try {
      await taskosQuery(
        `INSERT INTO wa_groups (id, jid, subject, role, active, "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'SUPPORT', $3, now())
         ON CONFLICT (jid) DO UPDATE SET subject = EXCLUDED.subject, "updatedAt" = now()`,
        [jid, subject, active]
      );
    } catch (e) { console.error("syncGroups:", e.message); }
  }
  return refreshGroups();
}

// ── gateway status / QR ────────────────────────────────────────────────────
export async function gatewayUpsert(fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const insCols = keys.map((k) => `"${k}"`).join(", ");
  const insVals = keys.map((_, i) => `$${i + 2}`).join(", ");
  const setCols = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
  await taskosQuery(
    `INSERT INTO wa_gateway (id, ${insCols}, "updatedAt") VALUES ($1, ${insVals}, now())
     ON CONFLICT (id) DO UPDATE SET ${setCols}, "updatedAt" = now()`,
    ["default", ...keys.map((k) => fields[k])]
  );
}
/**
 * A timestamp these columns can store correctly.
 *
 * The timestamp columns are naive (`WITHOUT time zone`) and hold UTC by
 * convention. Handing node-postgres a Date makes it serialize in the process's
 * local zone ("…T13:28:23+05:30"); Postgres then DISCARDS that offset and keeps
 * the literal wall-clock, storing IST. An explicit ISO string is already UTC,
 * so the value that lands is the one we meant. See lib/taskosdb.mjs.
 */
export const utcNow = () => new Date().toISOString();

export const setQr = (qr) => gatewayUpsert({ status: "QR", qr, qrUpdatedAt: utcNow() });
export const setConnected = (number) =>
  gatewayUpsert({ status: "CONNECTED", connectedNumber: number, qr: null, lastSeenAt: utcNow() });
export const setStatus = (status) => gatewayUpsert({ status });
export const heartbeat = (dryRun = null) =>
  gatewayUpsert(dryRun === null ? { lastSeenAt: utcNow() } : { lastSeenAt: utcNow(), dryRun });

// admin command (RELINK / LOGOUT) — read once and clear
/**
 * Read and clear the pending admin command.
 *
 * Returns the time it was requested as well as the command, because WHEN it was
 * asked for decides whether it still means anything. A RELINK queued while the
 * gateway was down is a request to get back online; running it after the
 * gateway has since linked logs the fresh session straight out again — which
 * is exactly the loop that kept the console showing no QR: no QR, click
 * "Re-link", the link succeeds, the stale RELINK kills it, still no QR.
 * See the connectedAt check in index.mjs.
 */
export async function consumeCommand() {
  const r = await taskosQuery(`SELECT command, "commandRequestedAt" FROM wa_gateway WHERE id = 'default'`);
  const command = r.rows[0]?.command || null;
  const requestedAt = r.rows[0]?.commandRequestedAt || null;
  if (command) await taskosQuery(`UPDATE wa_gateway SET command = NULL, "commandRequestedAt" = NULL WHERE id = 'default'`);
  return { command, requestedAt };
}

// ── ticket helpers ─────────────────────────────────────────────────────────
async function enrichContext(orderId, requestId) {
  try {
    const ids = [orderId, requestId].filter(Boolean);
    if (!ids.length) return null;
    const { orders = [], requests = [] } = await lookupIds(ids);
    const o = orders[0], rq = requests[0];
    if (o) return {
      kind: "order", id: o.id, status: o.status || o.orderStatus,
      appointmentTime: o.appointmentTime, orderType: o.orderType, capturedAt: new Date().toISOString(),
    };
    if (rq) return { kind: "request", id: rq.id, status: rq.status, capturedAt: new Date().toISOString() };
  } catch (e) { /* replica hiccup — leave context null */ }
  return null;
}

// find an open ticket for this group+id, else create one
async function upsertTicket({ group, orderId, requestId, intent, ts, origin = "CUSTOMER",
                              entityKind = null, idConfidence = null, idWarning = null, idAlt = null }) {
  const idCond = orderId ? `"orderId" = $2` : requestId ? `"requestId" = $2` : `"orderId" IS NULL AND "requestId" IS NULL`;
  const idVal = orderId || requestId || null;
  const params = idVal ? [group.id, idVal] : [group.id];
  const found = await taskosQuery(
    `SELECT id FROM wa_tickets WHERE "groupId" = $1 AND ${idCond} AND status <> 'RESOLVED'
       ORDER BY "lastActivityAt" DESC LIMIT 1`,
    params
  );
  const altJson = idAlt ? JSON.stringify(idAlt) : null;
  if (found.rows[0]) {
    // Refresh the resolution provenance on re-touch, but never overwrite a value
    // with null (COALESCE) so a bare follow-up doesn't wipe the original decision.
    await taskosQuery(
      `UPDATE wa_tickets SET "lastActivityAt" = $2, intent = COALESCE($3, intent),
         "entityKind" = COALESCE($4, "entityKind"), "idConfidence" = COALESCE($5, "idConfidence"),
         "idWarning" = $6, "idAlt" = COALESCE($7::jsonb, "idAlt") WHERE id = $1`,
      [found.rows[0].id, ts, intent, entityKind, idConfidence, idWarning, altJson]
    );
    return found.rows[0].id;
  }
  const ctx = await enrichContext(orderId, requestId);
  const status = !idVal ? "WAITING_INFO" : "OPEN";
  const r = await taskosQuery(
    `INSERT INTO wa_tickets (id, "groupId", "storeId", origin, status, "orderId", "requestId", "entityKind", "idConfidence", "idWarning", "idAlt", intent, "contextSnapshot", "lastActivityAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, now(), now()) RETURNING id`,
    [group.id, group.storeId, origin, status, orderId, requestId, entityKind, idConfidence, idWarning, altJson, intent, ctx ? JSON.stringify(ctx) : null, ts]
  );
  return r.rows[0].id;
}

// ── message ingest ─────────────────────────────────────────────────────────
const lastAskAt = new Map(); // jid → ts (debounce auto-ask)
// Master kill switch for the "share the order id" auto-reply. OFF by default —
// it must be explicitly enabled with WA_AUTO_ASK=true AND per-group opt-in.
// Without this, an admin toggle alone can spam partner groups.
const AUTO_ASK_ENABLED = process.env.WA_AUTO_ASK === "true";
// Window for conversational carry-forward: a no-id follow-up in a CX group
// attaches to a case active within this many minutes.
const CARRY_MINUTES = Number(process.env.WA_CARRY_MINUTES || 30);
// A lab message counts as a PROVIDER REQUEST (worth a case) when it's one of
// these intents — or cites an id. Pure status updates / acks stay investigation.
const PROVIDER_ACTIONABLE = new Set([
  "SERVICEABILITY", "REPORT_REQUEST", "RESCHEDULE", "CANCEL_REQUEST", "CANCEL_REASON",
  "PATIENT_DATA", "FEASIBILITY_QUOTE", "ESCALATION", "CREATE_ACTION", "NEW_BOOKING",
  "SLOT_CHECK", "TECH_ISSUE", "STATUS_CHECK",
]);

/**
 * Persist a message and (for substantive inbound) attach it to a ticket.
 * Returns { stored, ticketId, autoAsk } — autoAsk is the text to send if a
 * missing-id nudge is due.
 */
export async function ingestMessage(m) {
  const { jid, waMsgId, fromMe, sender, senderJid, replyToWaId } = m;
  const { mediaKind = null, mediaMime = null, mediaFilename = null, mediaBytes = null } = m;
  const ts = m.ts;
  const group = getGroup(jid);
  if (!group || !group.active) return { stored: false }; // not an admin-configured active group

  // Caption-less media still needs a legible label in list views / threads.
  const mediaLabel = mediaKind === "document" ? `📄 ${mediaFilename || "Document"}`
    : mediaKind === "image" ? "📷 Photo"
    : mediaKind ? `📎 ${mediaKind}` : "";
  const text = (m.text && m.text.trim()) || mediaLabel;

  const intent = classify(text, sender);
  // Canonical, VALIDATED id resolution. Order/Request/Appointment ids overlap
  // numerically, so we never trust a bare number blindly: extractReferences
  // keeps the namespaces apart and resolveEntities validates each against the
  // replica, canonicalizing to a single Order key and flagging what it can't
  // safely decide. This is what stops us from showing the wrong patient.
  const refs = extractReferences(text);
  // Pass the intent + message time so a bare number resolves to the entity the
  // conversation is actually about (a live reschedule Request, not a year-old
  // delivered Order that shares the id) — not just "the first Order that matches".
  const resolved = await resolveEntities({ ...refs, intent, convTs: ts }).catch((e) => {
    console.error("resolveEntities:", e.message);
    return { orderIds: [], requestIds: [], primary: null, ambiguous: [] };
  });
  let allOrderIds = resolved.orderIds;
  let validRequestIds = resolved.requestIds;
  const ambiguousIds = resolved.ambiguous.map((a) => a.n);
  let orderId = resolved.primary?.orderId || null;
  let requestId = resolved.primary?.requestId || null;
  let idType = resolved.primary?.type || null;
  // Carry the ranking reason / staleness warning into provenance so the console
  // can show "low confidence — order delivered months ago" instead of asserting it.
  let idVia = resolved.primary?.warning
    ? `${resolved.primary.via} · ⚠ ${resolved.primary.warning}`
    : resolved.primary?.via || null;
  let inheritedTicketId = null;

  // Reply-chain inheritance. People reply to a root message ("any update on
  // 46259?") without repeating the id ("still pending?"). WhatsApp gives us the
  // quoted message id (replyToWaId); if THIS message resolved no id of its own,
  // inherit the quoted message's already-resolved order/request + ticket so the
  // reply threads to the same case. One hop suffices — inheritance is applied
  // at ingest, so the parent already carries any it inherited.
  if (!orderId && !requestId && replyToWaId) {
    const parent = (await taskosQuery(
      `SELECT "orderIds", "requestIds", "ticketId", "idType", "idVia" FROM wa_messages WHERE "waMsgId" = $1 LIMIT 1`,
      [replyToWaId]
    )).rows[0];
    if (parent && ((parent.orderIds && parent.orderIds.length) || (parent.requestIds && parent.requestIds.length))) {
      allOrderIds = parent.orderIds || [];
      validRequestIds = parent.requestIds || [];
      orderId = allOrderIds[0] || null;
      requestId = validRequestIds[0] || null;
      idType = parent.idType || (orderId ? "ORDER" : requestId ? "REQUEST" : null);
      idVia = `reply · ${parent.idVia || (orderId ? `order ${orderId}` : `request ${requestId}`)}`;
      inheritedTicketId = parent.ticketId || null;
    }
  }

  const side = fromMe || isLabstack(sender) ? "LAB" : "PARTNER";
  const substantive = intent !== "NOISE" && intent !== "SYSTEM";

  // A QUERY only originates in a CX (SUPPORT) group. Messages in PROVIDER/
  // INTERNAL groups are investigation — they still store + thread to the order
  // for the timeline/analyst, but they don't spawn their own cases. This is
  // what stops lab status posts and ops chatter from becoming phantom cases.
  // Is this our team responding, or a customer asking? A team member replies
  // from their OWN phone (direction IN, not fromMe) — the roster tells us. This
  // is how we credit native WhatsApp replies as real responses.
  const matchTeam = makeTeamMatcher(await loadTeam());
  const matched = fromMe ? null : matchTeam(sender, senderJid);
  const isTeamMsg = fromMe || !!matched || isLabstack(sender);
  const teamName = fromMe ? "You" : (matched || (isLabstack(sender) ? sender : null));

  let ticketId = null;
  let autoAsk = null;
  const isCX = group.role === "SUPPORT";
  const isProvider = group.role === "PROVIDER";
  if (substantive && (isCX || isProvider)) {
    const origin = isCX ? "CUSTOMER" : "PROVIDER";
    // Find the case this message belongs to: reply-chain → our-outreach subject →
    // by id → active thread (conversational carry-forward for a bare follow-up).
    ticketId = inheritedTicketId || null;
    // Context from our OWN outreach: if we recently messaged THIS group about an
    // order (an "ask the lab" / reschedule / forward carrying #id + lab ref), a
    // bare reply here is about that order — adopt it as the subject instead of
    // spawning a "needs an id" case. Labs answer slower, so allow a wider window.
    if (!orderId && !requestId) {
      const seed = (await taskosQuery(
        `SELECT t."orderId", t."requestId" FROM wa_outbound o JOIN wa_tickets t ON t.id = o."ticketId"
          WHERE o."targetJid" = $1 AND (t."orderId" IS NOT NULL OR t."requestId" IS NOT NULL)
            AND o."createdAt" > now() - ($2 || ' minutes')::interval
          ORDER BY o."createdAt" DESC LIMIT 1`,
        [jid, String(CARRY_MINUTES * 4)]
      )).rows[0];
      if (seed?.orderId) { orderId = seed.orderId; allOrderIds = [seed.orderId]; idType = idType || "CONTEXT"; idVia = idVia || `context · we asked this group about order ${seed.orderId}`; }
      else if (seed?.requestId) { requestId = seed.requestId; validRequestIds = [seed.requestId]; idType = idType || "CONTEXT"; idVia = idVia || `context · we asked this group about request ${seed.requestId}`; }
    }
    if (!ticketId && (orderId || requestId)) {
      const ex = (await taskosQuery(
        `SELECT id FROM wa_tickets WHERE "groupId" = $1 AND ${orderId ? '"orderId" = $2' : '"requestId" = $2'} AND status <> 'RESOLVED' ORDER BY "lastActivityAt" DESC LIMIT 1`,
        [group.id, orderId || requestId]
      )).rows[0];
      if (ex) ticketId = ex.id;
    }
    if (!ticketId) {
      const active = (await taskosQuery(
        `SELECT id, "orderId", "requestId" FROM wa_tickets
          WHERE "groupId" = $1 AND status <> 'RESOLVED' AND ("orderId" IS NOT NULL OR "requestId" IS NOT NULL)
            AND "lastActivityAt" > now() - ($2 || ' minutes')::interval
          ORDER BY "lastActivityAt" DESC LIMIT 1`,
        [group.id, String(CARRY_MINUTES)]
      )).rows[0];
      if (active) {
        ticketId = active.id;
        if (active.orderId) { orderId = active.orderId; allOrderIds = [active.orderId]; idType = idType || "CONTEXT"; idVia = idVia || `active thread · order ${active.orderId}`; }
        else if (active.requestId) { requestId = active.requestId; validRequestIds = [active.requestId]; idType = idType || "CONTEXT"; idVia = idVia || `active thread · request ${active.requestId}`; }
      }
    }

    if (isTeamMsg) {
      // TEAM RESPONSE (native phone OR console echo) → mark the case answered and
      // stamp who / when / channel. Works for both lanes; never creates a case.
      if (ticketId) {
        await taskosQuery(
          `UPDATE wa_tickets SET
             status = CASE WHEN status IN ('NEW','OPEN','WAITING_LAB','WAITING_INFO') THEN 'ANSWERED' ELSE status END,
             "firstResponseAt" = COALESCE("firstResponseAt", $2),
             "respondedVia" = COALESCE("respondedVia", $3),
             "lastResponderName" = $4,
             "lastActivityAt" = $2
           WHERE id = $1`,
          [ticketId, ts, fromMe ? "console" : "native", teamName || "team"]
        ).catch(() => {});
      }
    } else {
      // A CUSTOMER QUERY (CX group) or a PROVIDER REQUEST (lab group). For labs
      // we only open a case for an ACTIONABLE request (or one citing an id) —
      // pure status/acks stay investigation, so lab groups surface real work
      // without the noise.
      const worthy = isCX || PROVIDER_ACTIONABLE.has(intent) || !!orderId || !!requestId || refs.refs.length > 0;
      if (!ticketId && worthy) {
        // Carry the resolver's confidence ONLY when the case binds to exactly what
        // the resolver decided. If the id came from carry-forward / reply-chain
        // (a deliberate context binding), treat it as high-confidence, no warning.
        const p = resolved.primary;
        const boundToPrimary = p && ((p.orderId && +p.orderId === +orderId) || (p.requestId && +p.requestId === +requestId));
        ticketId = await upsertTicket({
          group, orderId: orderId ? +orderId : null, requestId: requestId ? +requestId : null, intent, ts, origin,
          entityKind: boundToPrimary ? p.type : (orderId ? "ORDER" : requestId ? "REQUEST" : null),
          idConfidence: boundToPrimary ? (p.confidence || "high") : "high",
          idWarning: boundToPrimary ? (p.warning || null) : null,
          idAlt: boundToPrimary ? (p.alt || null) : null,
        });
      } else if (ticketId) {
        await taskosQuery(
          `UPDATE wa_tickets SET status = CASE WHEN status IN ('ANSWERED','RESOLVED') THEN 'OPEN' ELSE status END,
             "resolvedAt" = CASE WHEN status = 'RESOLVED' THEN NULL ELSE "resolvedAt" END, "lastActivityAt" = $2 WHERE id = $1`,
          [ticketId, ts]
        ).catch(() => {});
      }
      if (isCX) {
        const needsId = DISPOSITION[intent] === "AUTO_ANSWER" && !orderId && !requestId && !inheritedTicketId;
        if (AUTO_ASK_ENABLED && needsId && group.autoAskIdOnMissing) {
          const last = lastAskAt.get(jid) || 0;
          if (Date.now() - last > 30 * 60 * 1000) {
            lastAskAt.set(jid, Date.now());
            autoAsk = "Please share the order/booking ID and your query so we can act on it 🙏";
          }
        }
      }
    }
  }

  // A reply (even a team ack) threads to the parent's case when it carried no
  // id of its own — so the chain stays intact in the thread and timeline.
  const threadTicketId = ticketId || inheritedTicketId;
  const stored = await taskosQuery(
    `INSERT INTO wa_messages (id, "waMsgId", "groupId", "ticketId", direction, "fromMe", sender, "senderJid", text, ts, "replyToWaId", intent, "orderIds", "requestIds", "refIds", "idType", "idVia", "ambiguousIds", "mediaType", "mediaMime", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
     ON CONFLICT ("waMsgId") DO NOTHING RETURNING id`,
    [waMsgId, group.id, threadTicketId, fromMe ? "OUT" : "IN", fromMe, sender, senderJid || null, text, ts, replyToWaId,
     intent, allOrderIds, validRequestIds, refs.refs, idType, idVia, ambiguousIds, mediaKind, mediaMime]
  );

  // Backfill-safe: if this message row already existed as text-only (media was
  // dropped before capture), tag its media flags now so the console shows it.
  if (mediaKind) {
    await taskosQuery(
      `UPDATE wa_messages SET "mediaType"=$2, "mediaMime"=$3 WHERE "waMsgId"=$1 AND "mediaType" IS DISTINCT FROM $2`,
      [waMsgId, mediaKind, mediaMime]
    ).catch(() => {});
  }
  // Persist the raw bytes separately so the console can serve/interpret them.
  if (mediaBytes && mediaMime) {
    await taskosQuery(
      `INSERT INTO wa_media (id, "waMsgId", "groupId", mime, bytes, "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())
       ON CONFLICT ("waMsgId") DO NOTHING`,
      [waMsgId, group.id, mediaMime, mediaBytes]
    ).catch((e) => console.error("wa_media insert:", e.message));
  }

  if (autoAsk) await enqueueOutbound({ targetJid: jid, text: autoAsk, groupId: group.id, ticketId });
  return { stored: !!stored.rows[0], ticketId, autoAsk, side, intent, media: mediaKind };
}

/**
 * Re-resolve stored messages in a recent window against the CURRENT logic:
 * validate ids, canonicalize to an order, and inherit order/request + ticket
 * down reply chains. Fixes threading/ids retroactively for messages captured
 * before this logic existed. Does NOT touch media (bytes were never stored;
 * media backfill needs a WhatsApp history re-fetch). Idempotent.
 * Processes oldest→newest so a reply's parent is already re-resolved.
 */
export async function reresolveWindow({ days = 3 } = {}) {
  await refreshGroups();
  const rows = (await taskosQuery(
    `SELECT m."waMsgId", m.text, m."replyToWaId", m."fromMe", m.sender, m.ts, m.intent, g.jid AS gjid
       FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
      WHERE m.ts >= now() - ($1 || ' days')::interval AND g.active = true
      ORDER BY m.ts ASC`,
    [String(days)]
  )).rows;

  let updated = 0, inherited = 0, tickets = 0;
  for (const r of rows) {
    const refs = extractReferences(r.text || "");
    const resolved = await resolveEntities({ ...refs, intent: r.intent, convTs: r.ts }).catch(() => ({ orderIds: [], requestIds: [], primary: null, ambiguous: [] }));
    let allOrderIds = resolved.orderIds;
    let validRequestIds = resolved.requestIds;
    let orderId = resolved.primary?.orderId || null;
    let requestId = resolved.primary?.requestId || null;
    let idType = resolved.primary?.type || null;
    let idVia = resolved.primary?.warning ? `${resolved.primary.via} · ⚠ ${resolved.primary.warning}` : (resolved.primary?.via || null);
    let ticketId = null;

    if (!orderId && !requestId && r.replyToWaId) {
      const parent = (await taskosQuery(
        `SELECT "orderIds", "requestIds", "ticketId", "idType", "idVia" FROM wa_messages WHERE "waMsgId" = $1 LIMIT 1`,
        [r.replyToWaId]
      )).rows[0];
      if (parent && ((parent.orderIds && parent.orderIds.length) || (parent.requestIds && parent.requestIds.length))) {
        allOrderIds = parent.orderIds || [];
        validRequestIds = parent.requestIds || [];
        orderId = allOrderIds[0] || null;
        requestId = validRequestIds[0] || null;
        idType = parent.idType || (orderId ? "ORDER" : requestId ? "REQUEST" : null);
        idVia = `reply · ${parent.idVia || (orderId ? `order ${orderId}` : `request ${requestId}`)}`;
        ticketId = parent.ticketId || null;
        inherited++;
      }
    }

    const group = getGroup(r.gjid);
    const substantive = r.intent !== "NOISE" && r.intent !== "SYSTEM";
    if (group && substantive && !r.fromMe && (orderId || requestId)) {
      const p = resolved.primary;
      const boundToPrimary = p && ((p.orderId && +p.orderId === +orderId) || (p.requestId && +p.requestId === +requestId));
      ticketId = await upsertTicket({
        group, orderId: orderId ? +orderId : null, requestId: requestId ? +requestId : null, intent: r.intent, ts: r.ts,
        entityKind: boundToPrimary ? p.type : (orderId ? "ORDER" : requestId ? "REQUEST" : null),
        idConfidence: boundToPrimary ? (p.confidence || "high") : "high",
        idWarning: boundToPrimary ? (p.warning || null) : null,
        idAlt: boundToPrimary ? (p.alt || null) : null,
      });
      tickets++;
    }

    await taskosQuery(
      `UPDATE wa_messages SET "orderIds"=$2, "requestIds"=$3, "refIds"=$4, "idType"=$5, "idVia"=$6, "ambiguousIds"=$7, "ticketId"=COALESCE($8, "ticketId") WHERE "waMsgId"=$1`,
      [r.waMsgId, allOrderIds, validRequestIds, refs.refs, idType, idVia, resolved.ambiguous.map((a) => a.n), ticketId]
    );
    updated++;
  }
  return { scanned: rows.length, updated, inherited, tickets };
}

/**
 * One-time backfill: stamp firstResponseAt / respondedVia / lastResponderName
 * (and flip status to ANSWERED) on existing open cases from the team messages
 * ALREADY captured — so the response/health metrics are meaningful immediately
 * instead of only for new activity. Idempotent (COALESCE keeps existing stamps).
 */
export async function backfillResponses() {
  const matchTeam = makeTeamMatcher(await loadTeam());
  const tickets = (await taskosQuery(
    `SELECT id, "groupId", "orderId", "requestId" FROM wa_tickets WHERE status <> 'RESOLVED'`
  )).rows;

  let stamped = 0;
  for (const t of tickets) {
    const hasId = t.orderId || t.requestId;
    const idCond = t.orderId ? `$3 = ANY(m."orderIds")` : t.requestId ? `$3 = ANY(m."requestIds")` : `false`;
    const params = hasId ? [t.id, t.groupId, hasId] : [t.id, t.groupId];
    const msgs = (await taskosQuery(
      `SELECT m."fromMe", m.sender, m."senderJid", m.ts
         FROM wa_messages m
        WHERE m."ticketId" = $1 OR (m."groupId" = $2 AND ${idCond})
        ORDER BY m.ts ASC`,
      params
    )).rows;
    const team = msgs.filter((m) => m.fromMe || !!matchTeam(m.sender, m.senderJid) || isLabstack(m.sender));
    if (!team.length) continue;
    const first = team[0], lastT = team[team.length - 1];
    const responder = lastT.fromMe ? "You" : (matchTeam(lastT.sender, lastT.senderJid) || lastT.sender);
    await taskosQuery(
      `UPDATE wa_tickets SET
         "firstResponseAt" = COALESCE("firstResponseAt", $2),
         "respondedVia" = COALESCE("respondedVia", $3),
         "lastResponderName" = COALESCE("lastResponderName", $4),
         status = CASE WHEN status IN ('NEW','OPEN','WAITING_LAB','WAITING_INFO') THEN 'ANSWERED' ELSE status END
       WHERE id = $1`,
      [t.id, first.ts, first.fromMe ? "console" : "native", responder]
    ).catch(() => {});
    stamped++;
  }
  return { tickets: tickets.length, stamped };
}

/**
 * One-time backfill: replay the provider-request logic over recent PROVIDER-group
 * history, so lab groups surface their existing requests immediately instead of
 * only from new messages. Mirrors ingest: opens a PROVIDER case for an actionable
 * lab message, threads it, and credits team responses. Idempotent.
 */
export async function backfillProviderCases({ days = 7 } = {}) {
  await refreshGroups();
  const matchTeam = makeTeamMatcher(await loadTeam());
  const rows = (await taskosQuery(
    `SELECT m."waMsgId", m."fromMe", m.sender, m."senderJid", m.ts, m.intent,
            m."orderIds", m."requestIds", m."refIds", m."ticketId", g.jid AS gjid
       FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
      WHERE g.active = true AND g.role = 'PROVIDER' AND m.ts >= now() - ($1 || ' days')::interval
      ORDER BY m.ts ASC`,
    [String(days)]
  )).rows;

  let created = 0, attached = 0, answered = 0;
  for (const r of rows) {
    if (r.intent === "NOISE" || r.intent === "SYSTEM") continue;
    const group = getGroup(r.gjid);
    if (!group) continue;
    const orderId = (r.orderIds || [])[0] || null;
    const requestId = (r.requestIds || [])[0] || null;
    const isTeamMsg = r.fromMe || !!matchTeam(r.sender, r.senderJid) || isLabstack(r.sender);

    let ticketId = r.ticketId || null;
    if (!ticketId && (orderId || requestId)) {
      const ex = (await taskosQuery(
        `SELECT id FROM wa_tickets WHERE "groupId" = $1 AND ${orderId ? '"orderId" = $2' : '"requestId" = $2'} AND status <> 'RESOLVED' ORDER BY "lastActivityAt" DESC LIMIT 1`,
        [group.id, orderId || requestId]
      )).rows[0];
      if (ex) ticketId = ex.id;
    }
    if (!ticketId) {
      const active = (await taskosQuery(
        `SELECT id FROM wa_tickets WHERE "groupId" = $1 AND status <> 'RESOLVED' AND ("orderId" IS NOT NULL OR "requestId" IS NOT NULL)
            AND "lastActivityAt" > $2::timestamptz - ($3 || ' minutes')::interval ORDER BY "lastActivityAt" DESC LIMIT 1`,
        [group.id, r.ts, String(CARRY_MINUTES)]
      )).rows[0];
      if (active) ticketId = active.id;
    }

    if (isTeamMsg) {
      if (ticketId) {
        const responder = r.fromMe ? "You" : (matchTeam(r.sender, r.senderJid) || r.sender);
        await taskosQuery(
          `UPDATE wa_tickets SET status = CASE WHEN status IN ('NEW','OPEN','WAITING_LAB','WAITING_INFO') THEN 'ANSWERED' ELSE status END,
             "firstResponseAt" = COALESCE("firstResponseAt", $2), "respondedVia" = COALESCE("respondedVia", $3),
             "lastResponderName" = COALESCE("lastResponderName", $4), "lastActivityAt" = GREATEST("lastActivityAt", $2) WHERE id = $1`,
          [ticketId, r.ts, r.fromMe ? "console" : "native", responder]
        ).catch(() => {});
        answered++;
      }
    } else {
      const worthy = PROVIDER_ACTIONABLE.has(r.intent) || orderId || requestId || (r.refIds || []).length > 0;
      if (!ticketId && worthy) {
        ticketId = await upsertTicket({ group, orderId, requestId, intent: r.intent, ts: r.ts, origin: "PROVIDER" });
        created++;
      }
    }
    if (ticketId && !r.ticketId) {
      await taskosQuery(`UPDATE wa_messages SET "ticketId" = $2 WHERE "waMsgId" = $1`, [r.waMsgId, ticketId]).catch(() => {});
      attached++;
    }
  }
  return { scanned: rows.length, created, attached, answered };
}

/**
 * Auto-map each PROVIDER group to its lab: infer group.labId from the labIds of
 * the orders discussed in that group (the orders in "Orange Ops" belong to the
 * Orange lab). So "Send to Lab" auto-routes without anyone hand-mapping labId.
 * Only sets it when confident (a clear dominant lab). Never overwrites an
 * existing mapping.
 */
export async function mapLabGroups() {
  const groups = (await taskosQuery(
    `SELECT id FROM wa_groups WHERE role = 'PROVIDER' AND active = true AND "labId" IS NULL`
  )).rows;
  let mapped = 0;
  for (const g of groups) {
    const ords = (await taskosQuery(
      `SELECT DISTINCT o AS oid FROM wa_messages m, unnest(m."orderIds") o WHERE m."groupId" = $1 LIMIT 300`,
      [g.id]
    )).rows.map((r) => r.oid).filter(Boolean);
    if (ords.length < 3) continue;
    const rows = await orderLabs(ords).catch(() => []);
    const counts = {};
    for (const r of rows) if (r.labId) counts[r.labId] = (counts[r.labId] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    // require a clear dominant lab (>=3 orders and >=60% share) to avoid mis-map
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    if (top && top[1] >= 3 && top[1] / total >= 0.6) {
      await taskosQuery(`UPDATE wa_groups SET "labId" = $2 WHERE id = $1 AND "labId" IS NULL`, [g.id, +top[0]]).catch(() => {});
      mapped++;
    }
  }
  await refreshGroups();
  return { candidates: groups.length, mapped };
}

// Newest stored message per active group — used to anchor a history re-fetch.
export async function newestPerActiveGroup() {
  const rows = (await taskosQuery(
    `SELECT DISTINCT ON (g.jid) g.jid, m."waMsgId", m."fromMe", m.ts
       FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
      WHERE g.active = true
      ORDER BY g.jid, m.ts DESC`
  )).rows;
  return rows;
}

// ── outbound queue ─────────────────────────────────────────────────────────
export async function enqueueOutbound({ targetJid, text, groupId = null, ticketId = null, quotedWaId = null, createdById = null }) {
  await taskosQuery(
    `INSERT INTO wa_outbound (id, "targetJid", text, status, "groupId", "ticketId", "quotedWaId", "createdById", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'QUEUED', $3, $4, $5, $6, now())`,
    [targetJid, text, groupId, ticketId, quotedWaId, createdById]
  );
}

/**
 * Drain queued outbound rows. `send(targetJid, text, quotedWaId)` must return
 * the sent WhatsApp message id (or throw). Respects per-group sendEnabled.
 */
// Every message we send is signed so partners always know it came from ops.
// Configurable via WA_SIGNATURE (set empty to disable). Italic in WhatsApp.
const SIGNATURE = (process.env.WA_SIGNATURE ?? "Sent by Labstack Operations").trim();
function signText(text) {
  const body = (text || "").trimEnd();
  if (!SIGNATURE) return body;
  if (body.includes(SIGNATURE)) return body; // already signed — don't double-sign
  return body ? `${body}\n\n_${SIGNATURE}_` : `_${SIGNATURE}_`;
}

/**
 * Send the poll that belongs to an outbound row and remember it.
 *
 * The stored `messageJson` is not bookkeeping: WhatsApp poll votes are
 * encrypted against the poll creation message's own `messageSecret`, so without
 * the original message a vote can never be opened — including after a gateway
 * restart, which is exactly when a provider is most likely to have answered.
 *
 * `options` is stored per-poll rather than read from config at vote time, so
 * relabelling an option later cannot change what an old poll's votes mean.
 */
async function recordPoll(row, sendPoll) {
  let options = [];
  try {
    options = Array.isArray(row.pollOptions) ? row.pollOptions : JSON.parse(row.pollOptions || "[]");
  } catch { options = []; }
  const labels = options.map((o) => o?.label).filter(Boolean);
  if (labels.length < 2) return; // a poll needs something to choose between

  const msg = await sendPoll(row.targetJid, row.pollName, labels);
  const waMsgId = msg?.key?.id;
  if (!waMsgId) throw new Error("poll sent but no message id came back");

  // The confirmation workflow this poll is asking about, via the communication
  // row the scheduler linked to this outbound.
  const workflowId = (await taskosQuery(
    `SELECT "workflowId" FROM lab_communications WHERE "waOutboundId" = $1 AND "workflowId" IS NOT NULL LIMIT 1`,
    [row.id]
  )).rows[0]?.workflowId ?? null;

  await taskosQuery(
    `INSERT INTO wa_polls ("waMsgId", "outboundId", "workflowId", options, "messageJson", status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'PENDING', now(), now())
     ON CONFLICT ("waMsgId") DO NOTHING`,
    [waMsgId, row.id, workflowId, JSON.stringify(options), JSON.stringify(msg)]
  );
}

/** The poll creation message for a given id, or null if we never sent it. */
export async function getPoll(waMsgId) {
  return (await taskosQuery(
    `SELECT "waMsgId", "workflowId", options, "messageJson", status, "votedAction"
       FROM wa_polls WHERE "waMsgId" = $1 LIMIT 1`, [waMsgId]
  )).rows[0] ?? null;
}

/**
 * Record a decrypted vote.
 *
 * Deliberately only PENDING → VOTED: a provider who taps a second option has
 * changed their mind after we already told the workflow, and silently
 * overwriting an applied answer would desync the two. The first answer stands
 * and the desk can see the rest in the group.
 *
 * REJECT and RESCHEDULE set awaitingReason, which makes the next message from
 * that person in that chat get captured as the reason — a poll tap carries no
 * text of its own.
 */
export async function recordPollVote(waMsgId, action, voterJid, label = null) {
  // The LABEL is what identifies the reply — an informational option has no
  // action, and two options may share one. Kept alongside the action so the
  // console can find the exact option the provider tapped.
  //
  // Anything that is not a plain acceptance invites a written follow-up: a
  // reschedule needs a time, a rejection needs a reason, and an informational
  // answer ("Delayed") is only useful with the detail behind it.
  const needsReason = action !== "ACCEPT";
  const r = await taskosQuery(
    `UPDATE wa_polls
        SET status='VOTED', "votedAction"=$2, "votedLabel"=$5, "voterJid"=$3, "votedAt"=now(),
            "awaitingReason"=$4, "updatedAt"=now()
      WHERE "waMsgId"=$1 AND status='PENDING'
      RETURNING "workflowId"`,
    [waMsgId, action || null, voterJid || null, needsReason, label]
  );
  return r.rows[0] ?? null;
}

/**
 * Attach a follow-up reason to the most recent poll in this chat that is still
 * waiting for one from this sender.
 *
 * Scoped to the voter so an unrelated person chatting in the group cannot have
 * their message recorded as the lab's reason.
 */
export async function attachPollReason({ jid, senderJid, text }) {
  if (!text?.trim()) return null;
  const r = await taskosQuery(
    `UPDATE wa_polls SET reason=$3, "reasonAt"=now(), "awaitingReason"=false, "updatedAt"=now()
      WHERE "waMsgId" = (
        SELECT p."waMsgId" FROM wa_polls p
          JOIN wa_outbound o ON o.id = p."outboundId"
         WHERE p."awaitingReason" = true
           AND o."targetJid" = $1
           AND ($2::text IS NULL OR p."voterJid" IS NULL OR p."voterJid" = $2)
         ORDER BY p."votedAt" DESC NULLS LAST LIMIT 1
      )
      RETURNING "waMsgId", "workflowId", "votedAction"`,
    [jid, senderJid || null, text.trim().slice(0, 500)]
  );
  return r.rows[0] ?? null;
}

/**
 * Return messages the gateway abandoned mid-send.
 *
 * drainOutbound marks a row SENDING before handing it to WhatsApp. If the
 * process dies in that window — a crash, a logout, a stop — the row stays
 * SENDING forever: the drain only ever selects QUEUED, so nothing retries it
 * and nothing reports it. One such message sat unsent for 23 hours before an
 * audit noticed.
 *
 * Anything still SENDING after `olderThanMinutes` cannot be in flight — a send
 * takes seconds — so it is put back. `attempts` still guards against a message
 * that fails forever.
 *
 * Measured from `sendingAt`, NOT `createdAt`. createdAt is when the row was
 * QUEUED, which says nothing about how long the send has been running: a
 * message that waited out a gateway outage is already older than the threshold
 * the moment it starts sending, so it was born eligible to be reclaimed out
 * from under an in-flight send. COALESCE covers rows queued before the column
 * existed.
 */
// Exported so a regression test can prove a dropped send comes back.
export async function reclaimStalledSends({ olderThanMinutes = 5, maxAttempts = 5 } = {}) {
  const r = await taskosQuery(
    `UPDATE wa_outbound
        SET status = CASE WHEN attempts >= $2
                          THEN 'FAILED'::"WaOutboundStatus"
                          ELSE 'QUEUED'::"WaOutboundStatus" END,
            error  = CASE WHEN attempts >= $2
                          THEN 'abandoned mid-send after ' || attempts || ' attempts'
                          ELSE error END
      WHERE status = 'SENDING'
        AND COALESCE("sendingAt", "createdAt") < now() - ($1 || ' minutes')::interval
        -- A row that already has a WhatsApp id DID reach WhatsApp; requeuing it
        -- would send it a second time, which is the thing this guard is for.
        AND "sentWaMsgId" IS NULL
      RETURNING id, attempts, status`,
    [String(olderThanMinutes), maxAttempts]
  );
  for (const row of r.rows) {
    console.log(`reclaimed stalled send ${row.id} -> ${row.status} (attempt ${row.attempts})`);
  }
  return r.rows.length;
}

export async function drainOutbound(send, { limit = 5, sendPoll = null } = {}) {
  // Before taking new work, pick up anything a previous run dropped.
  try { await reclaimStalledSends(); } catch (e) { console.error("reclaim:", e.message); }

  // Claim the batch ATOMICALLY — the update and the select are one statement.
  //
  // This used to be a plain SELECT, with each row marked SENDING one at a time
  // inside the send loop below. drainOutbound runs on a 4-second setInterval
  // that does not wait for the previous run, and a batch of five takes longer
  // than four seconds, so the next tick fired mid-batch and re-selected every
  // row the first pass had not reached yet. Both passes then sent them. That
  // is how order 999404 reached the provider twice: it was last of four, so it
  // sat QUEUED the longest with a send already under way.
  //
  // FOR UPDATE SKIP LOCKED is what makes a second drain step over rows this
  // one has taken rather than queue up behind them.
  const rows = (await taskosQuery(
    `WITH claimed AS (
       UPDATE wa_outbound
          SET status = 'SENDING', attempts = attempts + 1, "sendingAt" = now()
        WHERE id IN (
          SELECT id FROM wa_outbound
           WHERE status = 'QUEUED'
           ORDER BY "createdAt" ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
       RETURNING *
     )
     SELECT c.id, c."targetJid", c.text, c."groupId", c."quotedWaId", c."mentions",
            c."mediaMime", c."mediaName", c."mediaBytes", c."pollName", c."pollOptions",
            c."createdAt", g."sendEnabled", g.subject
       FROM claimed c LEFT JOIN wa_groups g ON g.id = c."groupId"
      ORDER BY c."createdAt" ASC`, [limit]
  )).rows;
  let sent = 0;
  for (const row of rows) {
    // a group target must be send-enabled; non-group (raw number) sends are allowed
    // attempts was already incremented by the claim above.
    if (row.groupId && !row.sendEnabled) {
      await taskosQuery(`UPDATE wa_outbound SET status='FAILED', error=$2 WHERE id=$1`,
        [row.id, `sending disabled for group "${row.subject}"`]);
      continue;
    }
    try {
      // Build a quoted stub so the reply threads under the original message.
      // WhatsApp only renders a quote when the quoted message lives in the SAME
      // chat, so require the quoted message's group jid to match the target.
      let quoted = null;
      if (row.quotedWaId) {
        const qm = (await taskosQuery(
          `SELECT m."waMsgId", m."senderJid", m."fromMe", m.text, g.jid AS gjid
             FROM wa_messages m JOIN wa_groups g ON g.id = m."groupId"
            WHERE m."waMsgId" = $1 LIMIT 1`, [row.quotedWaId]
        )).rows[0];
        if (qm && qm.gjid === row.targetJid) {
          quoted = {
            key: { remoteJid: qm.gjid, id: qm.waMsgId, fromMe: !!qm.fromMe, participant: qm.senderJid || undefined },
            message: { conversation: qm.text || "" },
          };
        }
      }
      const media = row.mediaBytes ? { mime: row.mediaMime, name: row.mediaName, bytes: row.mediaBytes } : null;
      // @-mentions: jids to notify (the text already carries "@<localpart>").
      let mentions = null;
      try { mentions = Array.isArray(row.mentions) ? row.mentions : (row.mentions ? JSON.parse(row.mentions) : null); } catch { mentions = null; }
      const waId = await send(row.targetJid, signText(row.text), { quoted, media, mentions: mentions?.length ? mentions : null });
      await taskosQuery(`UPDATE wa_outbound SET status='SENT', "sentWaMsgId"=$2, "sentAt"=now() WHERE id=$1`, [row.id, waId || null]);
      await taskosQuery(
        `UPDATE lab_communications SET status='SENT', "sentAt"=COALESCE("sentAt", now()), "updatedAt"=now()
         WHERE "waOutboundId"=$1 AND status='QUEUED'`,
        [row.id]
      );
      // A poll rides after the text, as its own message — WhatsApp has no way to
      // attach options to a text body. Sent AFTER the row is marked SENT so a
      // poll failure can never cause the message itself to be re-sent.
      if (row.pollName && sendPoll) {
        try { await recordPoll(row, sendPoll); }
        catch (e) { console.error(`poll for outbound ${row.id}:`, e.message); }
      }
      sent++;
    } catch (e) {
      await taskosQuery(`UPDATE wa_outbound SET status='FAILED', error=$2 WHERE id=$1`, [row.id, (e?.message || String(e)).slice(0, 300)]);
    }
  }
  return { drained: rows.length, sent };
}
