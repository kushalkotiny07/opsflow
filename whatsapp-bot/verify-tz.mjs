/**
 * Verify the UTC timestamp fix, using the real pool from lib/taskosdb.mjs
 * (so the session option and the type parser under test are the live ones).
 *
 * Asserts, rather than prints-and-hopes:
 *   1. session timezone is UTC        → SQL now() casts to UTC
 *   2. now()::timestamp == node UTC   → writes agree with Prisma
 *   3. naive column round-trips       → reads agree with Prisma
 */
import "dotenv/config";
import { taskosQuery, taskos } from "./lib/taskosdb.mjs";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};

const tz = (await taskosQuery("SHOW TimeZone")).rows[0].TimeZone;
console.log("── session ──");
check("session timezone is UTC", tz === "UTC", `got ${tz}`);

console.log("\n── writes: SQL now() ──");
const r = (await taskosQuery(`SELECT now()::timestamp AS naive_now`)).rows[0];
const nodeNow = Date.now();
const skewSeconds = Math.abs(r.naive_now.getTime() - nodeNow) / 1000;
check(
  "now()::timestamp matches node's UTC clock",
  skewSeconds < 5,
  `skew ${skewSeconds.toFixed(1)}s (was 19800s = 5h30m)`,
);

console.log("\n── round trip: write a Date, read it back ──");
// Exercise the exact path the gateway uses: an ISO string in, naive column out.
const sent = new Date();
const rt = (
  await taskosQuery(`SELECT $1::timestamp AS back`, [sent.toISOString()])
).rows[0].back;
const rtSkew = Math.abs(rt.getTime() - sent.getTime()) / 1000;
check("ISO string round-trips to the same instant", rtSkew < 1, `drift ${rtSkew.toFixed(3)}s`);

// And prove the OLD way would still be wrong, so the fix is load-bearing.
const naiveDate = (await taskosQuery(`SELECT $1::timestamp AS back`, [sent])).rows[0].back;
const naiveSkew = Math.round((naiveDate.getTime() - sent.getTime()) / 1000);
console.log(`  note  passing a raw Date drifts by ${naiveSkew}s — why call sites send ISO strings`);

console.log(failed === 0 ? "\nAll checks passed ✔" : `\n${failed} check(s) FAILED`);
await taskos.end();
process.exit(failed === 0 ? 0 : 1);
