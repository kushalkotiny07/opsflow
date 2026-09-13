-- ─────────────────────────────────────────────────────────────────────────
-- Local LabStack stand-in (DUMMY DATA — not a replica of production).
--
-- OpsFlow reads its source-of-truth data straight out of the LabStack
-- Postgres: public."Order" joined to public."User" / "Lab" / "Store", with
-- "orderType" / "orderStatus" as native pg enums (src/lib/db/enums.ts reads
-- pg_enum for both). Locally that database simply did not exist, so
-- SOURCE_DATABASE_URL was blank and the rule engine had nothing to poll.
--
-- This file recreates just enough of that shape for the engine, the order
-- drawer and the WhatsApp order-context lookups to work against a local
-- container. Column set is driven by what the app actually selects
-- (see src/lib/engine/labstack.ts) plus the columns present in the
-- "Labstacks orders" export, which the seed loads as sample rows.
--
-- TIMESTAMP WITHOUT TIME ZONE holding **naive UTC** — deliberately the same
-- convention as real LabStack (see the timestamp note at the top of
-- src/lib/engine/labstack.ts). The seed converts the export's IST
-- wall-clock times to UTC, so the UI renders the original IST times back.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Enums ───────────────────────────────────────────────────────────────
-- Labels are the union of what appears in the orders export and what the
-- app's task rules reference (PHLEBO_ASSIGNED / PHLEBO_DISPATCHED are used
-- by the seeded HSC rules but never appear in the export).
CREATE TYPE public."OrderType" AS ENUM (
  'HOME_SAMPLE',
  'CENTER_VISIT',
  'KIT_BASED'
);

CREATE TYPE public."OrderStatus" AS ENUM (
  'ORDER_SCHEDULED',
  'RESCHEDULED',
  'PHLEBO_ASSIGNED',
  'PHLEBO_DISPATCHED',
  'PHLEBO_STARTED',
  'PATIENT_VISITED',
  'SAMPLE_COLLECTED',
  'SAMPLE_IN_TRANSIT',
  'SAMPLE_DELIVERED',
  'SAMPLE_PROCESSED',
  'PARTIAL_DELIVERED',
  'REPORT_READY',
  'REPORT_DELIVERED',
  'PATIENT_MISSED',
  'CANCELED'
);

-- ── Patients ────────────────────────────────────────────────────────────
CREATE TABLE public."User" (
  id          integer PRIMARY KEY,
  name        text NOT NULL,
  mobile      text,
  email       text,
  gender      text,
  "dateOfBirth" date,
  city        text,
  "isActive"  boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "updatedAt" timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX "User_mobile_idx" ON public."User" (mobile);

-- ── Labs (the fulfilling diagnostic provider) ───────────────────────────
CREATE TABLE public."Lab" (
  id          integer PRIMARY KEY,
  "labName"   text NOT NULL,
  city        text,
  "isActive"  boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

-- ── Stores (the partner / client that booked the order) ─────────────────
CREATE TABLE public."Store" (
  id          integer PRIMARY KEY,
  "storeName" text NOT NULL,
  -- Selected by /api/stores, /api/stores/overview and /api/tasks. The sheet's
  -- City column is the patient's, not the partner's, so this stays NULL —
  -- the UI renders stores without a city rather than showing an invented one.
  city        text,
  "isActive"  boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

-- ── Requests (pre-order enquiries; WhatsApp ticket context) ─────────────
-- Declared before "Order" because Order."requestId" references it. Left
-- empty — the sheet is an order export and carries no request rows.
CREATE TABLE public."Request" (
  id              integer PRIMARY KEY,
  name            text,
  status          text,
  "isServiceable" boolean,
  "quotedPrice"   numeric(10,2),
  "createdAt"     timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "updatedAt"     timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

-- ── Orders ──────────────────────────────────────────────────────────────
CREATE TABLE public."Order" (
  id                  integer PRIMARY KEY,
  "labOrderId"        text,
  "userId"            integer NOT NULL REFERENCES public."User" (id),
  -- whatsapp-bot/lib/lookup.mjs walks Request → Order through this. Null here:
  -- the sheet carries no request ids.
  "requestId"         integer REFERENCES public."Request" (id),
  "storeId"           integer REFERENCES public."Store" (id),
  "labId"             integer REFERENCES public."Lab" (id),
  "orderType"         public."OrderType"   NOT NULL,
  "orderStatus"       public."OrderStatus" NOT NULL,
  "paymentTerm"       text,
  "paymentNote"       text,
  "appointmentTime"   timestamp,
  "createdAt"         timestamp NOT NULL,
  "updatedAt"         timestamp NOT NULL,
  "statusUpdatedAt"   timestamp,
  -- OpsFlow COALESCEs these to '' and never writes them; the export has no
  -- phlebo columns, so they stay NULL rather than being invented.
  "internalNotes"     text,
  notes               text,
  "phleboName"        text,
  "phleboNumber"      text,
  "cancelReason"      text,
  "rescheduleReason"  text,
  "sampleCollectedAt" timestamp,
  "reportDeliveredAt" timestamp,
  "validationStatus"  text,
  "packageName"       text,
  "storeCost"         numeric(10,2),
  "labCost"           numeric(10,2),
  city                text,
  pincode             text,
  feedback            text,
  "referenceId"       text
);

-- appointmentTime first: every poller fetch is bounded on it
-- (APPT_WINDOW_SQL in src/lib/engine/labstack.ts).
CREATE INDEX "Order_appointmentTime_idx"  ON public."Order" ("appointmentTime");
CREATE INDEX "Order_orderStatus_idx"      ON public."Order" ("orderStatus");
CREATE INDEX "Order_updatedAt_idx"        ON public."Order" ("updatedAt");
CREATE INDEX "Order_statusUpdatedAt_idx"  ON public."Order" ("statusUpdatedAt");
CREATE INDEX "Order_labId_idx"            ON public."Order" ("labId");
CREATE INDEX "Order_storeId_idx"          ON public."Order" ("storeId");
CREATE INDEX "Order_labOrderId_idx"       ON public."Order" (upper("labOrderId"));

-- ── Appointments ────────────────────────────────────────────────────────
-- Created empty so the code paths that read it (the Data Sources table
-- picker, the WhatsApp bot's appointment lookup) return "no rows" rather
-- than erroring on a missing relation.
CREATE TABLE public."Appointment" (
  id                integer PRIMARY KEY,
  -- snake_case, matching the column the WhatsApp bot queries verbatim.
  order_id          integer REFERENCES public."Order" (id),
  "userId"          integer REFERENCES public."User" (id),
  "storeId"         integer REFERENCES public."Store" (id),
  status            text,
  "appointmentTime" timestamp,
  "createdAt"       timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "updatedAt"       timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
