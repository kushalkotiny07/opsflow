#!/usr/bin/env node
/**
 * Turns the CSV extract of the "Labstacks orders" sheet into 02-seed.sql,
 * the file Postgres runs on first boot of the labstack-db container.
 *
 * Two conversions happen here, both deliberate:
 *
 *  1. IST → naive UTC. The sheet shows IST wall-clock ("appointment 7:00"
 *     means 7 AM in Bengaluru). Real LabStack columns are TIMESTAMP WITHOUT
 *     TIME ZONE holding the UTC instant, and OpsFlow reads them that way
 *     (see the timestamp note atop src/lib/engine/labstack.ts). So every
 *     timestamp is written as `ts - 5:30`, and the UI renders the sheet's
 *     original IST time back to the user.
 *
 *  2. Day-shift, applied at INSERT time rather than baked in. The sheet is
 *     a snapshot of one operating day (2026-08-17). The poller only fetches
 *     orders whose appointmentTime is within NOW() ± 10 days, so a hard-coded
 *     August date would go invisible a fortnight later. Each timestamp is
 *     emitted as dummy_day_shift('<literal>'), which adds
 *     (CURRENT_DATE - 2026-08-17) whole days — so whenever the container is
 *     initialised (or the seed re-run), the sheet's day becomes "today" and
 *     every relative gap inside it is preserved exactly.
 *
 * Run: node docker/labstack-dummy/generate-seed.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");

/** The operating day the sheet captures. Everything shifts relative to it. */
const REFERENCE_DAY = "2026-08-17";
/** IST is UTC+5:30 — the offset we strip to get LabStack's naive-UTC values. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;
/** First synthetic patient id. High enough not to look like a real user id. */
const USER_ID_BASE = 500001;

/** Split a pipe-delimited sheet into objects keyed by its header row. */
function readCsv(name) {
  const lines = readFileSync(join(DATA, name), "utf8").trim().split("\n");
  const header = lines[0].split("|");
  return lines.slice(1).map((line, i) => {
    const cells = line.split("|");
    if (cells.length !== header.length) {
      throw new Error(`${name} line ${i + 2}: ${cells.length} fields, expected ${header.length}`);
    }
    return Object.fromEntries(header.map((h, j) => [h, cells[j].trim()]));
  });
}

const sqlText = (v) => (v === "" || v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const sqlNum = (v) => (v === "" || v == null ? "NULL" : String(Number(v)));

/** "2026-08-17 07:00" (IST) → dummy_day_shift('2026-08-17 01:30:00') */
function sqlShiftedTs(ist) {
  if (!ist) return "NULL";
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/.exec(ist);
  if (!m) throw new Error(`Unparseable timestamp: ${ist}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MINUTES * 60_000);
  const literal = utc.toISOString().slice(0, 19).replace("T", " ");
  return `dummy_day_shift('${literal}')`;
}

const stores = readCsv("stores.csv");
const labs = readCsv("labs.csv");
const orders = readCsv("orders.csv");

// ── Patients ──────────────────────────────────────────────────────────────
// The sheet carries patient details on the order row; LabStack keeps them on
// public."User". Key on name+mobile, not mobile alone: several numbers in the
// sheet are shared by family members (9765720651, 9632365115, 9256298216),
// and collapsing those would attribute one person's orders to another.
const users = new Map();
for (const o of orders) {
  const key = `${o.patient_name}|${o.mobile}`;
  if (!users.has(key)) {
    users.set(key, {
      id: USER_ID_BASE + users.size,
      name: o.patient_name,
      mobile: o.mobile,
      gender: o.gender,
      dob: o.dob,
      city: o.city,
    });
  }
  o._userId = users.get(key).id;
}

// ── Emit ──────────────────────────────────────────────────────────────────
const out = [];
out.push(`-- GENERATED FILE — do not edit by hand.`);
out.push(`-- Source: docker/labstack-dummy/data/*.csv (the "Labstacks orders" sheet).`);
out.push(`-- Regenerate: node docker/labstack-dummy/generate-seed.mjs`);
out.push(`--`);
out.push(`-- ${orders.length} orders, ${users.size} patients, ${labs.length} labs, ${stores.length} stores.`);
out.push(`-- Sheet operating day ${REFERENCE_DAY}; timestamps are IST converted to`);
out.push(`-- naive UTC, then day-shifted onto the current date at insert time.`);
out.push("");
out.push(`-- Adds (today - ${REFERENCE_DAY}) whole days, so the snapshot always lands on`);
out.push(`-- the day it is loaded. STABLE, not IMMUTABLE: it reads CURRENT_DATE.`);
out.push(`CREATE OR REPLACE FUNCTION public.dummy_day_shift(ts timestamp)`);
out.push(`RETURNS timestamp LANGUAGE sql STABLE AS $$`);
out.push(`  SELECT ts + make_interval(days => (CURRENT_DATE - DATE '${REFERENCE_DAY}'))`);
out.push(`$$;`);
out.push("");
out.push("BEGIN;");
out.push("");
out.push(`-- Idempotent: re-running this file replaces the dummy data wholesale.`);
out.push(`TRUNCATE public."Order", public."Appointment", public."Request", public."User", public."Lab", public."Store" CASCADE;`);
out.push("");

out.push(`INSERT INTO public."Store" (id, "storeName") VALUES`);
out.push(stores.map((s) => `  (${sqlNum(s.store_id)}, ${sqlText(s.store_name)})`).join(",\n") + ";");
out.push("");

out.push(`INSERT INTO public."Lab" (id, "labName") VALUES`);
out.push(labs.map((l) => `  (${sqlNum(l.lab_id)}, ${sqlText(l.lab_name)})`).join(",\n") + ";");
out.push("");

out.push(`INSERT INTO public."User" (id, name, mobile, gender, "dateOfBirth", city) VALUES`);
out.push(
  [...users.values()]
    .map((u) => `  (${u.id}, ${sqlText(u.name)}, ${sqlText(u.mobile)}, ${sqlText(u.gender)}, ${sqlText(u.dob)}, ${sqlText(u.city)})`)
    .join(",\n") + ";"
);
out.push("");

const ORDER_COLUMNS = [
  "id", '"labOrderId"', '"userId"', '"storeId"', '"labId"', '"orderType"', '"orderStatus"',
  '"paymentTerm"', '"paymentNote"', '"appointmentTime"', '"createdAt"', '"updatedAt"',
  '"statusUpdatedAt"', '"cancelReason"', '"rescheduleReason"', '"sampleCollectedAt"',
  '"reportDeliveredAt"', '"validationStatus"', '"packageName"', '"storeCost"', '"labCost"',
  "city", "pincode", "feedback", '"referenceId"',
];
out.push(`INSERT INTO public."Order" (${ORDER_COLUMNS.join(", ")}) VALUES`);
out.push(
  orders
    .map((o) =>
      "  (" +
      [
        sqlNum(o.order_id),
        sqlText(o.lab_order_id),
        o._userId,
        sqlNum(o.store_id),
        sqlNum(o.lab_id),
        `${sqlText(o.order_type)}::public."OrderType"`,
        `${sqlText(o.order_status)}::public."OrderStatus"`,
        sqlText(o.payment_term),
        sqlText(o.payment_note),
        sqlShiftedTs(o.appointment_time),
        sqlShiftedTs(o.created_at),
        // The sheet's "Last Updated At" is the only mutation timestamp it
        // carries, and the poller's incremental fetch keys off updatedAt OR
        // statusUpdatedAt — so both get it.
        sqlShiftedTs(o.status_updated_at),
        sqlShiftedTs(o.status_updated_at),
        sqlText(o.cancel_reason),
        sqlText(o.reschedule_reason),
        sqlShiftedTs(o.sample_collected_at),
        sqlShiftedTs(o.report_delivered_at),
        sqlText(o.validation_status),
        sqlText(o.package),
        sqlNum(o.store_cost),
        sqlNum(o.lab_cost),
        sqlText(o.city),
        sqlText(o.pincode),
        sqlText(o.feedback),
        sqlText(o.reference_id),
      ].join(", ") +
      ")"
    )
    .join(",\n") + ";"
);
out.push("");
out.push("COMMIT;");
out.push("");

writeFileSync(join(HERE, "02-seed.sql"), out.join("\n"));
console.log(
  `✔ 02-seed.sql — ${orders.length} orders, ${users.size} patients, ${labs.length} labs, ${stores.length} stores`
);
