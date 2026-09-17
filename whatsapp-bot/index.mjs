/**
 * LabStack WhatsApp ops bot — DRY-RUN skeleton.
 *
 * Connects to WhatsApp as a linked device (Baileys), reads group messages,
 * classifies each, looks up the live order/request status, and LOGS what it
 * WOULD reply — sending NOTHING. This lets you validate the bot's answers
 * against real traffic with zero risk of a wrong auto-reply.
 *
 * Flip to live sending only after the dry-run log looks correct AND the
 * account is a dedicated number (see README). Sending is intentionally not
 * implemented in this file yet.
 *
 * Run:  node index.mjs      (first run prints a QR — scan from WhatsApp →
 *                            Linked Devices → Link a Device)
 */
import "dotenv/config";
import * as baileys from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "node:fs";
import { classify, extractIds, DISPOSITION, isLabstack } from "./lib/classifier.mjs";
import { lookupIds } from "./lib/lookup.mjs";
import { compose } from "./lib/reply.mjs";
import * as CT from "./lib/controltower.mjs";
import * as Analyst from "./lib/analyst.mjs";

// Control Tower integration is active only when the taskos DB is configured.
const CT_ENABLED = !!process.env.TASKOS_DATABASE_URL;
// Case analyst (LLM). Runs only when an Anthropic key is present.
const ANALYST_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANALYST_MODEL = process.env.WA_ANALYST_MODEL || "claude-sonnet-5";
const ANALYST_ENABLED = CT_ENABLED && !!ANALYST_API_KEY && process.env.WA_ANALYST !== "false";
let currentSock = null;   // updated each (re)connect so loops use the live socket
let loopsStarted = false;
// Every interval startLoops() registers, so a logged-out gateway can stop them
// and exit instead of heartbeating from a dead socket. See connection.update.
const loopTimers = [];
// Set to "RELINK" | "LOGOUT" while WE are the reason the session is ending, so
// the 401 that follows is read as the command succeeding rather than as
// WhatsApp cutting us off. Cleared as soon as that close is handled.
let selfInitiatedLogout = null;
// When the CURRENT session finished linking. Commands queued before this are
// requests to fix a gateway that was down — already satisfied by the link
// itself — so acting on them now would undo it.
let connectedAt = null;
/** setInterval that remembers its handle. */
function everyMs(fn, ms) {
  const timer = setInterval(fn, ms);
  loopTimers.push(timer);
  return timer;
}

// Baileys exposes these as top-level named exports; the default export is
// makeWASocket itself, so we pull everything off the namespace.
const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const DRY_RUN = process.env.DRY_RUN !== "false"; // default TRUE — safe
const LOG_FILE = process.env.LOG_FILE || "./dry-run.log.jsonl";
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 3); // history window
const logger = pino({ level: "silent" });

// ── Group scoping ─────────────────────────────────────────────────────────
// Only groups whose SUBJECT matches GROUP_FILTER (a case-insensitive regex)
// are observed — everything else (personal groups) is skipped entirely: not
// classified, not logged. Default scopes to Labstack partner-ops groups, and
// auto-includes any new Labstack group without editing a static list.
// GROUP_ALLOW is an optional comma-separated list of extra jids to force-in
// (for ops groups that don't carry "labstack" in the name).
// Set GROUP_FILTER="" AND GROUP_ALLOW="" to observe everything again.
const GROUP_FILTER = process.env.GROUP_FILTER ?? "labstack";
const GROUP_RE = GROUP_FILTER ? new RegExp(GROUP_FILTER, "i") : null;
const GROUP_ALLOW = new Set(
  (process.env.GROUP_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean)
);
// jid → subject, populated on connect and kept fresh as groups change.
const groupSubjects = new Map();

function inScope(jid) {
  if (!GROUP_RE && GROUP_ALLOW.size === 0) return true; // no filter → observe all
  if (GROUP_ALLOW.has(jid)) return true;
  const subject = groupSubjects.get(jid);
  if (!subject) return false;            // unknown group → out of scope until named
  return GROUP_RE ? GROUP_RE.test(subject) : false;
}

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG_FILE, line + "\n");
}
// Full transcript — EVERY in-scope message (partner questions, team replies
// incl. our own sends, acks). This is the ground-truth for learning how the
// team actually handles messages. Separate from the decision log.
const RAW_LOG = process.env.RAW_LOG || "./messages.log.jsonl";
function rawLine(obj) {
  fs.appendFileSync(RAW_LOG, JSON.stringify(obj) + "\n");
}
function banner(s) { console.log(`\n\x1b[36m${s}\x1b[0m`); }

// Crash-proof reconnect: single-flight, exponential backoff. Baileys surfaces
// transient WebSocket failures (1006, 408, 428) as promise rejections — without
// this the process would exit on the first blip.
let reconnecting = false;
let backoff = 2000;
function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  const delay = backoff;
  backoff = Math.min(backoff * 2, 60000); // cap at 60s
  console.log(`(reconnecting in ${Math.round(delay / 1000)}s)`);
  setTimeout(() => {
    reconnecting = false;
    start().catch((e) => { console.error("reconnect failed:", e?.message || e); reconnect(); });
  }, delay);
}

// Never let a stray socket rejection take the whole process down.
process.on("unhandledRejection", (r) => console.error("unhandledRejection:", r?.message || r));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e?.message || e));

// Background loops (started once): drain the outbound send queue, obey admin
// commands (RELINK/LOGOUT) from the console, heartbeat, and refresh group config.
function startLoops() {
  if (loopsStarted || !CT_ENABLED) return;
  loopsStarted = true;

  const send = async (jid, text, { quoted = null, media = null, mentions = null } = {}) => {
    if (!currentSock) throw new Error("gateway not connected");
    // `quoted` threads the reply under the original; `media` attaches a file;
    // `mentions` is an array of jids to @-notify (text carries "@<localpart>").
    // Resolve mention jids to the group's ACTUAL participant jids so the tag
    // lights up even when the stored jid differs (phone vs LID). Rewrites the
    // "@<localpart>" token in the text to match whatever jid we end up using.
    if (mentions && mentions.length && jid.endsWith("@g.us")) {
      try {
        const meta = await currentSock.groupMetadata(jid);
        const parts = meta?.participants || [];
        const last10 = (j) => (j || "").split("@")[0].replace(/\D/g, "").slice(-10);
        const resolved = [];
        for (const m of mentions) {
          const hit = parts.find((p) => p.id === m)
            || parts.find((p) => last10(p.id) && last10(p.id) === last10(m))
            || parts.find((p) => p.jid && (p.jid === m || (last10(p.jid) && last10(p.jid) === last10(m))))
            || parts.find((p) => p.phoneNumber && last10(p.phoneNumber) === last10(m));
          const rid = hit?.id || m;
          if (rid !== m) {
            const oldLocal = m.split("@")[0], newLocal = rid.split("@")[0];
            if (oldLocal && newLocal) text = (text || "").split("@" + oldLocal).join("@" + newLocal);
          }
          resolved.push(rid);
        }
        mentions = [...new Set(resolved)];
      } catch (e) { console.error("mention resolve:", e.message); }
    }
    let content;
    if (media && media.bytes) {
      const caption = text || undefined;
      content = (media.mime || "").startsWith("image/")
        ? { image: media.bytes, caption, mimetype: media.mime }
        : { document: media.bytes, fileName: media.name || "file", mimetype: media.mime || "application/octet-stream", caption };
    } else {
      content = { text };
    }
    if (mentions && mentions.length) content.mentions = mentions;
    const r = await currentSock.sendMessage(jid, content, quoted ? { quoted } : {});
    await new Promise((res) => setTimeout(res, 1200)); // human-paced spacing
    return r?.key?.id;
  };

  // Returns the WHOLE sent message, not just its id: a poll's votes are
  // encrypted against this message's own secret, so the caller has to keep it.
  const sendPoll = async (jid, name, values) => {
    if (!currentSock) throw new Error("gateway not connected");
    const r = await currentSock.sendMessage(jid, {
      poll: { name, values, selectableCount: 1 },
    });
    await new Promise((res) => setTimeout(res, 1200));
    return r;
  };

  everyMs(async () => {
    if (DRY_RUN) return; // master kill switch — nothing sends while DRY_RUN
    try { await CT.drainOutbound(send, { sendPoll }); } catch (e) { console.error("drain:", e.message); }
  }, 4000);

  everyMs(async () => {
    try {
      const { command: cmd, requestedAt } = await CT.consumeCommand();

      // Drop a command that predates this connection. "Re-link (show QR)" is
      // pressed precisely when the console shows no QR — i.e. while the gateway
      // is down — so by the time it is read the link it asked for has usually
      // already happened. Running it then logs the new session out and the
      // console goes back to showing no QR, which invites another press.
      if (cmd && connectedAt && requestedAt && new Date(requestedAt) < connectedAt) {
        console.log(`ignoring stale ${cmd} queued at ${new Date(requestedAt).toISOString()} — the gateway linked after it was requested`);
        return;
      }

      if (cmd === "LOGOUT" || cmd === "RELINK") {
        console.log(`admin command: ${cmd}`);
        // sock.logout() ENDS the WhatsApp session, which comes back as a 401
        // close a moment later. That 401 is the expected consequence of this
        // command, not a session someone killed on us — connection.update has
        // to be able to tell the two apart, or a RELINK (whose whole purpose is
        // to produce a fresh QR) exits the process instead.
        selfInitiatedLogout = cmd;
        try { await currentSock?.logout(); } catch {}
        try { fs.rmSync("./auth", { recursive: true, force: true }); } catch {}
        // RELINK wants a new QR; LOGOUT wants to stay down. reconnect() is
        // therefore only correct for RELINK — the 401 handler does the rest.
        if (cmd === "RELINK") reconnect();
      } else if (cmd === "BACKFILL") {
        // Re-resolve threads/ids for the recent window right away (reliable),
        // then ask WhatsApp for a fresh recent-history sync so the
        // messaging-history.set handler can backfill any missed media.
        console.log(`admin command: BACKFILL (${BACKFILL_DAYS}d)`);
        try {
          const res = await CT.reresolveWindow({ days: BACKFILL_DAYS });
          console.log(`backfill re-resolve: ${JSON.stringify(res)}`);
        } catch (e) { console.error("backfill resolve:", e.message); }
        try {
          const rr = await CT.backfillResponses();
          console.log(`backfill responses: ${JSON.stringify(rr)}`);
        } catch (e) { console.error("backfill responses:", e.message); }
        try {
          const pc = await CT.backfillProviderCases({ days: BACKFILL_DAYS });
          console.log(`backfill provider cases: ${JSON.stringify(pc)}`);
        } catch (e) { console.error("backfill provider cases:", e.message); }
        try {
          const lm = await CT.mapLabGroups();
          console.log(`lab-group mapping: ${JSON.stringify(lm)}`);
        } catch (e) { console.error("lab-group mapping:", e.message); }
        try {
          if (typeof currentSock?.fetchMessageHistory === "function") {
            // Anchor at the newest message per active group and pull a page of
            // recent history; results arrive via messaging-history.set.
            const anchors = await CT.newestPerActiveGroup();
            for (const a of anchors) {
              if (!a.waMsgId) continue;
              try {
                await currentSock.fetchMessageHistory(
                  50,
                  { remoteJid: a.jid, id: a.waMsgId, fromMe: a.fromMe },
                  Math.floor(new Date(a.ts).getTime() / 1000)
                );
              } catch { /* per-group best-effort */ }
            }
            console.log(`backfill: requested history for ${anchors.length} groups`);
          }
        } catch (e) { console.error("backfill history:", e.message); }
      }
    } catch {}
  }, 5000);

  everyMs(() => CT.heartbeat(DRY_RUN).catch(() => {}), 20000);
  everyMs(() => CT.refreshGroups().catch(() => {}), 30000);

  // Case analyst: continuously (but change-detected) synthesize an LLM brief
  // per active order — status, timeline, resolution, in-context suggestions.
  if (ANALYST_ENABLED) {
    console.log(`case analyst ON (model=${ANALYST_MODEL})`);
    everyMs(() => {
      Analyst.analyzeActiveCases({ limit: 8, model: ANALYST_MODEL, apiKey: ANALYST_API_KEY })
        .then((r) => { if (r?.analyzed) console.log(`analyst: ${r.analyzed}/${r.candidates} cases`); })
        .catch((e) => console.error("analyst loop:", e.message));
    }, 30000);
  }

  // Groups can be empty right after a FRESH link (the phone hasn't pushed group
  // metadata to the new device yet), so the one-shot discovery on "open" may
  // register nothing. Re-discover shortly after connect and then periodically,
  // so the console fills in on its own — no manual restart needed.
  const discoverAndSync = async () => {
    if (!currentSock || !CT_ENABLED) return;
    try {
      const groups = await currentSock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) groupSubjects.set(g.id, g.subject);
      const all = Object.values(groups).map((g) => [g.id, g.subject]);
      // Register every group; pre-activate only the ones matching the listen hint.
      const preActive = all.filter(([jid, subject]) => GROUP_ALLOW.has(jid) || (GROUP_RE ? GROUP_RE.test(subject || "") : false)).map(([jid]) => jid);
      if (all.length) { await CT.syncGroups(all, preActive); console.log(`registered ${all.length} groups (${preActive.length} pre-activated) in the console`); }
    } catch (e) { console.error("group discovery:", e.message); }
  };
  setTimeout(discoverAndSync, 15000);    // catch the fresh-link case quickly
  everyMs(discoverAndSync, 120000);  // and keep it current every 2 min
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, auth: state, logger, markOnlineOnConnect: false,
    /**
     * Hand Baileys back a message it sent earlier.
     *
     * This is what makes poll votes work. A vote arrives encrypted against the
     * POLL CREATION message's own secret, so Baileys has to re-read that
     * message to open it — and it gets it by calling this. With no getMessage
     * the library cannot decrypt the vote, emits nothing, and a tap is silently
     * lost: the poll sits PENDING forever and no error appears anywhere, which
     * is precisely how this went unnoticed.
     *
     * wa_polls.messageJson exists for this. It is also used for retry receipts,
     * so returning undefined for anything we did not store is correct.
     */
    getMessage: async (key) => {
      if (!CT_ENABLED || !key?.id) return undefined;
      try {
        const poll = await CT.getPoll(key.id);
        const stored = poll?.messageJson?.message;
        if (!stored) return undefined;
        // Re-hydrate through the protobuf before handing it back.
        //
        // The message was persisted with JSON.stringify, which encodes every
        // `bytes` field as base64 TEXT — including messageContextInfo
        // .messageSecret, the key a poll vote is encrypted against. Returned as
        // a plain string, decryption fails and Baileys emits nothing at all: the
        // tap disappears with no error. fromObject() turns those base64 strings
        // back into Uint8Array, which is what the crypto actually needs.
        return baileys.proto.Message.fromObject(stored);
      } catch (e) {
        console.error("getMessage:", e.message);
        return undefined;
      }
    },
  });
  currentSock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      banner("Scan this QR from WhatsApp → Settings → Linked Devices → Link a Device:");
      qrcode.generate(qr, { small: true });
      // Also persist the raw payload so it can be rendered as a crisp PNG.
      try { fs.writeFileSync("./last-qr.txt", qr); } catch {}
      if (CT_ENABLED) CT.setQr(qr).catch((e) => console.error("CT setQr:", e.message));
    }
    if (connection === "open") {
      backoff = 2000; // healthy again — reset reconnect backoff
      connectedAt = new Date();
      banner(`✅ Connected as ${sock.user?.id || "?"} — DRY_RUN=${DRY_RUN}`);
      if (CT_ENABLED) {
        try {
          await CT.refreshGroups();
          const num = String(sock.user?.id || "").split(/[:@]/)[0];
          await CT.setConnected(num);
        } catch (e) { console.error("CT connect:", e.message); }
        startLoops();
      }
      // Discover groups so you can label them partner vs lab in config.
      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const g of Object.values(groups)) groupSubjects.set(g.id, g.subject);
        const all = [...groupSubjects.entries()];
        const preActive = all.filter(([jid, subject]) => GROUP_ALLOW.has(jid) || (GROUP_RE ? GROUP_RE.test(subject || "") : false)).map(([jid]) => jid);
        banner(`In ${groupSubjects.size} groups · ${preActive.length} match the listen hint (/${GROUP_FILTER}/i) — pick which to listen to in Settings:`);
        for (const [jid, subject] of all) console.log(`  ${preActive.includes(jid) ? "•" : " "} ${jid}   ${subject}`);
        console.log("");
        // Register EVERY group in the console so the admin sees the full roster
        // and picks which to listen to. New groups land inactive; the ones that
        // match the hint are pre-activated for a turnkey first run.
        if (CT_ENABLED) await CT.syncGroups(all, preActive);
      } catch (e) { console.warn("Could not fetch groups:", e.message); }
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      banner(`Connection closed (code ${code}). ${loggedOut ? "Logged out — delete ./auth and re-scan." : "Reconnecting…"}`);
      if (CT_ENABLED) CT.setStatus(loggedOut ? "LOGGED_OUT" : "CONNECTING").catch(() => {});
      if (!loggedOut) { reconnect(); return; }

      // ── A logout we asked for ───────────────────────────────────────────
      // RELINK deliberately ends the session to get a fresh QR, so this 401 is
      // the command working, not a failure. Exiting here would make the RELINK
      // button in the console do the opposite of what it says.
      if (selfInitiatedLogout) {
        const command = selfInitiatedLogout;
        selfInitiatedLogout = null;
        if (command === "RELINK") {
          banner("Relinking — a new QR will appear in a moment.");
          if (CT_ENABLED) CT.setStatus("CONNECTING").catch(() => {});
          return; // reconnect() was already scheduled when the command ran
        }
        banner("Logged out on request. Exiting.");
        currentSock = null;
        for (const timer of loopTimers) clearInterval(timer);
        loopTimers.length = 0;
        setTimeout(() => process.exit(0), 500);
        return;
      }

      // ── Logged out by WhatsApp: stop pretending to be alive ─────────────
      // This used to fall through and leave the process up. Once startLoops()
      // has run, its intervals keep the event loop alive forever, so the
      // heartbeat carried on writing lastSeenAt from a DEAD socket: the console
      // showed "Gateway online", the drain kept trying, and every send failed
      // deep inside Baileys. A logged-out gateway is not degraded, it is
      // finished — only a re-scan fixes it — so drop the socket, stop the
      // loops, and exit so a supervisor reports it instead of hiding it.
      currentSock = null;
      for (const timer of loopTimers) clearInterval(timer);
      loopTimers.length = 0;
      banner("Exiting. Re-link with:  ./run-gateway.sh relink  then  ./run-gateway.sh start");
      // Non-zero so the exit is distinguishable from a clean shutdown.
      setTimeout(() => process.exit(2), 500);
    }
  });

  // Keep subjects fresh as groups are created / renamed.
  sock.ev.on("groups.upsert", (gs) => { for (const g of gs) groupSubjects.set(g.id, g.subject); });
  sock.ev.on("groups.update", (gs) => { for (const g of gs) if (g.id && g.subject) groupSubjects.set(g.id, g.subject); });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      // A poll vote arrives HERE, as a pollUpdateMessage — not as a
      // messages.update carrying pollUpdates. Baileys used to translate one
      // into the other, but that code is commented out in 6.7.x ("TODO: Remove
      // entirely"), so nothing emits pollUpdates any more and a listener on
      // messages.update waits forever. handle() would then drop this message
      // for having no text and no media, which is how a tap vanished without
      // a single line in the log. So we do the decryption the library dropped.
      if (m.message?.pollUpdateMessage) {
        try { await handlePollVote(m); } catch (e) { console.error("poll vote:", e.message); }
        continue;
      }
      try { await handle(m); } catch (e) { console.error("handle error:", e.message); }
    }
  });

  // ── Poll votes ───────────────────────────────────────────────────────────
  // A vote is not a message — it arrives as an UPDATE to the poll we sent, and
  // its content is encrypted against that poll's own messageSecret. So we look
  // up the original message we stored and let Baileys decrypt against it.
  //
  // Only the workflow-facing part happens here: the vote is written to
  // wa_polls and the console's every-minute tick applies it. The gateway
  // deliberately does not touch the workflow state machine itself.
  sock.ev.on("messages.update", async (updates) => {
    // Kept as a safety net in case a future Baileys restores this path; the
    // live route is handlePollVote() from messages.upsert.
    for (const u of updates) {
      const pollUpdates = u.update?.pollUpdates;
      if (!pollUpdates?.length || !u.key?.id) continue;
      // Every branch below that gives up now says so. A vote that vanishes
      // without a trace is the failure mode that cost the most time here: the
      // poll simply stayed PENDING and nothing anywhere mentioned a tap.
      console.log(`poll update received for ${u.key.id} (${pollUpdates.length} update(s))`);
      try {
        const poll = await CT.getPoll(u.key.id);
        if (!poll) { console.log(`poll ${u.key.id}: not one of ours — ignoring`); continue; }
        if (poll.status !== "PENDING") { console.log(`poll ${u.key.id}: already ${poll.status} — first answer stands`); continue; }

        const aggregated = baileys.getAggregateVotesInPollMessage({
          message: poll.messageJson?.message,
          pollUpdates,
        });
        // selectableCount is 1, so at most one option should carry a voter.
        const chosen = (aggregated || []).find((o) => o.voters?.length > 0);
        if (!chosen) {
          // Either the vote was retracted, or decryption produced nothing —
          // which is what happens when getMessage cannot supply the original.
          console.log(`poll ${u.key.id}: no option carries a voter (retracted, or the vote could not be decrypted)`);
          continue;
        }

        const options = Array.isArray(poll.options) ? poll.options : [];
        const match = options.find((o) => o?.label === chosen.name);
        if (!match?.action) {
          console.error(`poll ${u.key.id}: vote "${chosen.name}" matches no known option`);
          continue;
        }

        const voterJid = chosen.voters[0] || null;
        const saved = await CT.recordPollVote(u.key.id, match.action, voterJid);
        if (!saved) { console.log(`poll ${u.key.id}: another handler recorded it first`); continue; }
        console.log(`poll vote: ${match.action} on ${u.key.id} by ${voterJid || "unknown"}`);

        // The reply to a tap — "order confirmed" for ACCEPT, "tell us why" for
        // the other two — is composed by the console, not here. It used to be a
        // raw sendMessage from this handler, which skipped the per-group
        // sendEnabled guard, carried no signature, left no lab_communications
        // row, and hardcoded wording Ops could not edit. The tick now renders it
        // from a template and queues it like any other message; see
        // acknowledge() in lib/non-api-labs/poll-votes.ts.
      } catch (e) {
        console.error("poll update:", e.message);
      }
    }
  });

  // Historical messages WhatsApp pushes on (re)connect, or in response to a
  // fetchMessageHistory request. Processing them through the SAME pipeline is
  // idempotent and backfills anything we missed while offline or before media
  // capture — including image bytes, as long as WhatsApp still serves them.
  sock.ev.on("messaging-history.set", async ({ messages }) => {
    if (!messages?.length) return;
    const cutoff = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86400;
    let done = 0;
    for (const m of messages) {
      const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
      if (ts && ts < cutoff) continue; // keep to the recent window
      try { await handle(m); done++; } catch { /* best-effort */ }
    }
    if (done) console.log(`history sync: processed ${done}/${messages.length} recent messages`);
  });
}

function contentOf(msg = {}) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ""
  );
}
function extractText(m) { return contentOf(m.message || {}); }

// Identify an attachment on the message (image/document/video/audio/sticker).
// Returns { kind, mime, filename } or null. WhatsApp wraps some media in
// viewOnce/ephemeral envelopes, so we unwrap those first.
function mediaInfo(m) {
  let msg = m.message || {};
  msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg;
  if (msg.imageMessage) return { kind: "image", mime: msg.imageMessage.mimetype || "image/jpeg", filename: null };
  if (msg.documentMessage) return { kind: "document", mime: msg.documentMessage.mimetype || "application/octet-stream", filename: msg.documentMessage.fileName || null };
  if (msg.documentWithCaptionMessage?.message?.documentMessage) {
    const d = msg.documentWithCaptionMessage.message.documentMessage;
    return { kind: "document", mime: d.mimetype || "application/octet-stream", filename: d.fileName || null };
  }
  if (msg.stickerMessage) return { kind: "sticker", mime: msg.stickerMessage.mimetype || "image/webp", filename: null };
  if (msg.videoMessage) return { kind: "video", mime: msg.videoMessage.mimetype || "video/mp4", filename: null };
  return null;
}

const MAX_MEDIA_BYTES = 12 * 1024 * 1024; // don't pull huge files into the gateway
async function downloadMedia(m) {
  try {
    const buf = await baileys.downloadMediaMessage(
      m, "buffer", {},
      { reuploadRequest: currentSock?.updateMediaMessage?.bind(currentSock) }
    );
    if (!buf || buf.length === 0 || buf.length > MAX_MEDIA_BYTES) return null;
    return buf;
  } catch (e) {
    console.error("media download:", e.message);
    return null;
  }
}

// Pull the quoted/replied-to message (WhatsApp "reply") for direct Q→A linking.
// contextInfo can hang off ANY message type (text, image, document…), so we
// look across them — a reply on a photo must keep the chain too.
function replyContext(m) {
  let msg = m.message || {};
  msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg;
  const ci =
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ||
    msg.stickerMessage?.contextInfo ||
    msg.audioMessage?.contextInfo;
  if (!ci?.stanzaId) return null;
  return {
    replyToId: ci.stanzaId,
    replyToAuthor: ci.participant || "",
    replyToText: contentOf(ci.quotedMessage || {}).replace(/\s+/g, " ").slice(0, 300),
  };
}

/**
 * Decrypt a poll vote and record it.
 *
 * This is the work Baileys used to do and no longer does: in 6.7.x the
 * pollUpdateMessage branch of processMessage is commented out, so nothing ever
 * emits `messages.update` with `pollUpdates`. The algorithm below is that dead
 * code, restored — fetch the poll creation message, take its messageSecret as
 * the decryption key, and open the vote with decryptPollVote.
 *
 * The vote names its options as SHA-256 hashes rather than text, which is why
 * getAggregateVotesInPollMessage is still used: it hashes the known option
 * names and matches them back to labels.
 */
async function handlePollVote(m) {
  const update = m.message?.pollUpdateMessage;
  const creationKey = update?.pollCreationMessageKey;
  if (!update?.vote || !creationKey?.id) return;

  const poll = await CT.getPoll(creationKey.id);
  if (!poll) { console.log(`poll vote for ${creationKey.id}: not a poll we sent — ignoring`); return; }
  if (poll.status !== "PENDING") { console.log(`poll ${creationKey.id}: already ${poll.status} — first answer stands`); return; }

  const stored = poll.messageJson?.message;
  if (!stored) { console.error(`poll ${creationKey.id}: no stored creation message — cannot decrypt`); return; }
  // Same re-hydration as getMessage: JSON storage turned every bytes field into
  // base64 text, and the secret has to be real bytes to decrypt with.
  const pollMsg = baileys.proto.Message.fromObject(stored);
  const pollEncKey = pollMsg?.messageContextInfo?.messageSecret;
  if (!pollEncKey) { console.error(`poll ${creationKey.id}: creation message carries no messageSecret`); return; }

  const meId = baileys.jidNormalizedUser(currentSock?.user?.id || "");
  const voterJid = baileys.getKeyAuthor(m.key, meId);

  let vote;
  try {
    vote = baileys.decryptPollVote(update.vote, {
      pollEncKey,
      pollCreatorJid: baileys.getKeyAuthor(creationKey, meId),
      pollMsgId: creationKey.id,
      voterJid,
    });
  } catch (e) {
    console.error(`poll ${creationKey.id}: vote would not decrypt — ${e.message}`);
    return;
  }

  // Hash -> label, using the options as WhatsApp itself sees them.
  const aggregated = baileys.getAggregateVotesInPollMessage(
    { message: pollMsg, pollUpdates: [{ pollUpdateMessageKey: m.key, vote }] },
    meId,
  );
  const chosen = (aggregated || []).find((o) => o.voters?.length > 0);
  if (!chosen) { console.log(`poll ${creationKey.id}: vote decrypted but selects nothing (retracted)`); return; }

  const options = Array.isArray(poll.options) ? poll.options : [];
  const match = options.find((o) => o?.label === chosen.name);
  // An option with no action is valid — it is informational, and its value is
  // the answer itself. Only an option we do not recognise at all is an error.
  if (!match) { console.error(`poll ${creationKey.id}: "${chosen.name}" matches no known option`); return; }

  const saved = await CT.recordPollVote(creationKey.id, match.action ?? null, voterJid, match.label);
  if (!saved) { console.log(`poll ${creationKey.id}: recorded by another handler first`); return; }
  console.log(`poll vote: "${match.label}"${match.action ? ` (${match.action})` : " (informational)"} on ${creationKey.id} by ${voterJid}`);
  // The reply is composed by the console from a template; see
  // acknowledge() in lib/non-api-labs/poll-votes.ts.
}

async function handle(m) {
  const jid = m.key.remoteJid || "";
  if (!jid.endsWith("@g.us")) return; // groups only
  // Listen only to groups the admin picked (active). Discovery registers EVERY
  // group so they can be chosen in Settings; until a group is activated we don't
  // process it (no media pulled, nothing stored). Falls back to the env hint
  // when the console DB isn't wired up (pure dry-run).
  if (CT_ENABLED) {
    const g = CT.getGroup(jid);
    if (!g || !g.active) return;
  } else if (!inScope(jid)) return;

  const text = extractText(m).trim();
  const media = mediaInfo(m);
  if (!text && !media) return; // pure system/empty event — nothing to capture
  const fromMe = !!m.key.fromMe;
  const sender = fromMe ? "me (LabStack)" : (m.pushName || m.key.participant || "");
  const side = fromMe || isLabstack(sender) ? "LAB" : "PARTNER";
  const rc = replyContext(m);

  // ── Follow-up to a poll vote ─────────────────────────────────────────────
  // A REJECT/RESCHEDULE tap leaves the poll waiting for a reason. If this
  // message is that answer, capture it — the console attaches it to the
  // workflow. Our own messages are skipped so the bot's own "please reply with
  // the reason" prompt is never mistaken for the provider's answer.
  if (CT_ENABLED && !fromMe && text) {
    try {
      const attached = await CT.attachPollReason({ jid, senderJid: m.key.participant || null, text });
      if (attached) console.log(`poll reason captured for ${attached.waMsgId} (${attached.votedAction})`);
    } catch (e) { console.error("poll reason:", e.message); }
  }

  // ── FULL TRANSCRIPT: log EVERY message, including our own team replies and
  // acks. This is what we learn "how it's handled" from. ──────────────────
  const { ids: rawIds } = extractIds(text);
  rawLine({
    ts: new Date().toISOString(), jid, group: groupSubjects.get(jid) || "",
    msgId: m.key.id, fromMe, side, sender, text,
    ids: rawIds, intent: classify(text, sender),
    ...(rc || {}),
  });

  // ── CONTROL TOWER: persist to the taskos DB (messages + tickets) ─────────
  if (CT_ENABLED) {
    const tsSec = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000);
    // Pull the actual bytes for image/document media so the console can show
    // and interpret it — a caption-less report screenshot is otherwise blind.
    let mediaBytes = null;
    if (media && (media.kind === "image" || media.kind === "document")) {
      mediaBytes = await downloadMedia(m);
    }
    try {
      await CT.ingestMessage({
        jid, waMsgId: m.key.id, fromMe, sender, senderJid: m.key.participant || null, text,
        // ISO (UTC) rather than a Date: wa_messages.ts is a naive column and
        // node-postgres would serialize a Date in local time, storing IST.
        ts: new Date(tsSec * 1000).toISOString(), replyToWaId: rc?.replyToId || null,
        mediaKind: media?.kind || null, mediaMime: media?.mime || null,
        mediaFilename: media?.filename || null, mediaBytes,
      });
    } catch (e) { console.error("CT ingest:", e.message); }
  }

  // ── DECISION LOGIC (dry-run): only for inbound partner messages ──────────
  if (fromMe) return;                 // don't auto-act on our own posts

  const intent = classify(text, sender);
  const disposition = DISPOSITION[intent];
  if (disposition === "NOISE") return; // don't log chatter

  const { ids } = extractIds(text);
  const lookup = disposition === "AUTO_ANSWER" ? await lookupIds(ids) : { orders: [], requests: [] };
  const { willReply, text: replyText, note } = compose({ intent, disposition, lookup });

  // Console view — human-readable
  const tag = willReply ? "\x1b[32mWOULD REPLY\x1b[0m" : "\x1b[33m" + disposition + "\x1b[0m";
  console.log(`[${tag}] (${intent}) ${sender}: ${text.replace(/\n/g, " ⏎ ").slice(0, 90)}`);
  if (willReply) console.log(`      ↳ ${replyText.replace(/\n/g, "\n        ")}`);
  else console.log(`      ↳ ${note}`);

  // Structured log — for measuring accuracy over the trial
  logLine({ jid, group: groupSubjects.get(jid) || "", sender, text, intent, disposition, ids, willReply, reply: replyText, note });

  // ── SENDING IS DISABLED IN DRY-RUN ──────────────────────────────────────
  // When you go live (dedicated number + validated log), this is where a
  // guarded sock.sendMessage(jid, { text: replyText }, { quoted: m }) goes,
  // gated on DRY_RUN === false and per-group opt-in.
}

start().catch((e) => { console.error("fatal:", e); process.exit(1); });
