/**
 * Connection to the OpsFlow (taskos) database — the integration bus between
 * the WhatsApp gateway and the console. Separate from lib/lookup.mjs, which
 * reads the read-only LabStack replica.
 *
 * TASKOS_DATABASE_URL points at the taskos schema. We strip Prisma's
 * `?schema=` param (node-postgres doesn't understand it) and instead set the
 * search_path via connection options so every query lands in `taskos`.
 *
 * ── Why the session timezone is pinned to UTC ─────────────────────────────
 * Every timestamp column here is `timestamp WITHOUT time zone`, and the
 * convention the console writes by (Prisma) is "the naive value is UTC".
 * SQL `now()` is a timestamptz; assigning it to such a column casts it using
 * the SESSION timezone. This pool inherited the server's Asia/Kolkata, so
 * every `now()` the gateway wrote landed as IST wall-clock — 5h30m ahead of
 * everything the console wrote into the same column. That skew made
 * `sentAt - createdAt` read as 5h30m for a send that took 3 seconds, inflated
 * every response-time metric, and left unread badges permanently stuck
 * (message ts always "newer" than a UTC lastReadAt).
 *
 * Pinning the session to UTC makes `now()` agree with Prisma. Note this fixes
 * SQL-side `now()` only: a JS Date sent as a PARAMETER is serialized by
 * node-postgres in the process's local zone, and Postgres discards that offset
 * when parsing into a naive column — so those call sites send an explicit
 * UTC ISO string instead. See utcNow() in lib/controltower.mjs.
 */
import pg from "pg";

// ── Reading them back ──────────────────────────────────────────────────────
// The other half of the same convention. node-postgres parses a naive
// timestamp (oid 1114) in the PROCESS's local zone, so a stored UTC value read
// on an IST machine came back 5h30m early — the mirror image of the write bug,
// and the reason the two used to cancel out and look almost right. Prisma
// parses these columns as UTC; this makes the gateway agree.
//
// Global to the pg module by design: lib/lookup.mjs reads LabStack timestamps
// under the same "naive means UTC" convention and needs the same treatment.
pg.types.setTypeParser(1114, (value) => (value === null ? null : new Date(`${value.replace(" ", "T")}Z`)));

const rawUrl = process.env.TASKOS_DATABASE_URL || "";
const schemaMatch = rawUrl.match(/[?&]schema=([^&]+)/);
const schema = schemaMatch ? decodeURIComponent(schemaMatch[1]) : "public";
const connectionString = rawUrl.replace(/([?&])schema=[^&]+&?/, "$1").replace(/[?&]$/, "");

export const taskos = new pg.Pool({
  connectionString,
  max: 5,
  options: `-c search_path=${schema} -c timezone=UTC`,
  statement_timeout: 10000,
});

taskos.on("error", (e) => console.error("[taskosdb] pool error:", e.message));

export async function taskosQuery(text, params) {
  const c = await taskos.connect();
  try { return await c.query(text, params); }
  finally { c.release(); }
}
