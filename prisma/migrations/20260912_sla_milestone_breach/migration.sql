-- SLA milestone breach — automatic provider messaging for ALL labs.
--
-- Covers API and NON_API labs alike. Detection is keyed on the ORDER and the
-- LAB, never on a LabCommunicationWorkflow: an API lab never has one.
--
-- Applied with psql rather than `prisma migrate`. This repo has no
-- _prisma_migrations table — docker/entrypoint.sh uses `prisma db push`
-- because the migrations directory holds bare-SQL files like this one, and
-- schema.prisma is the source of truth. This file exists for the record and
-- to carry the two things db-push cannot express: the backfill and the
-- CHECK/partial-unique constraints.

-- ── 1. Enums ───────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "SlaMilestone" AS ENUM ('ORDER_CONFIRMED','PHLEBO_ASSIGNED','SAMPLE_COLLECTED','SAMPLE_DELIVERED','REPORT_UPLOADED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SlaAnchor" AS ENUM ('ORDER_CREATED','APPOINTMENT_TIME','PREV_MILESTONE_COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SlaBreachStatus" AS ENUM ('ACTIVE','RESOLVED','CAPPED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StepTriggerKind" AS ENUM ('RELATIVE_DELAY','SLA_BREACH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Breach steps on the existing rule model ─────────────────────────
ALTER TABLE "provider_communication_rules"
  ADD COLUMN IF NOT EXISTS "triggerKind"           "StepTriggerKind" NOT NULL DEFAULT 'RELATIVE_DELAY',
  ADD COLUMN IF NOT EXISTS "slaMilestone"          "SlaMilestone",
  ADD COLUMN IF NOT EXISTS "repeatIntervalMinutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "maxAttempts"           INTEGER;

-- Backfill: every pre-existing step is a timed sequence step. The column
-- default covers new rows; this covers rows written before the default
-- existed, so no current flow changes behaviour.
UPDATE "provider_communication_rules" SET "triggerKind" = 'RELATIVE_DELAY' WHERE "triggerKind" IS NULL;

-- A milestone is required exactly when the step is a breach watcher.
ALTER TABLE "provider_communication_rules" DROP CONSTRAINT IF EXISTS "provider_communication_rules_milestone_ck";
ALTER TABLE "provider_communication_rules" ADD CONSTRAINT "provider_communication_rules_milestone_ck"
  CHECK (("triggerKind" = 'SLA_BREACH') = ("slaMilestone" IS NOT NULL));

CREATE INDEX IF NOT EXISTS "provider_communication_rules_triggerKind_isActive_idx"
  ON "provider_communication_rules" ("triggerKind", "isActive");

-- ── 3. Per-lab milestone SLA config ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sla_milestone_configs" (
  "id"                    TEXT PRIMARY KEY,
  "labId"                 INTEGER,
  "milestone"             "SlaMilestone" NOT NULL,
  "anchor"                "SlaAnchor"    NOT NULL,
  "offsetMinutes"         INTEGER        NOT NULL,
  "enabled"               BOOLEAN        NOT NULL DEFAULT false,
  "repeatIntervalMinutes" INTEGER        NOT NULL DEFAULT 30,
  "maxAttempts"           INTEGER        NOT NULL DEFAULT 3,
  "ignoreQuietHours"      BOOLEAN        NOT NULL DEFAULT false,
  "createdAt"             TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt"             TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "sla_milestone_configs_labId_milestone_key"
  ON "sla_milestone_configs" ("labId", "milestone");

-- Postgres treats NULLs as distinct in a unique index, so the @@unique above
-- would happily allow many global-default rows for one milestone. This is the
-- constraint that actually enforces "at most one global default".
CREATE UNIQUE INDEX IF NOT EXISTS "sla_milestone_configs_global_default_key"
  ON "sla_milestone_configs" ("milestone") WHERE "labId" IS NULL;

CREATE INDEX IF NOT EXISTS "sla_milestone_configs_enabled_idx" ON "sla_milestone_configs" ("enabled");

-- ── 4. Breach ledger ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sla_breach_events" (
  "id"               TEXT PRIMARY KEY,
  "orderId"          INTEGER        NOT NULL,
  "labId"            INTEGER        NOT NULL,
  "milestone"        "SlaMilestone" NOT NULL,
  "deadlineAt"       TIMESTAMPTZ(3) NOT NULL,
  "firstBreachedAt"  TIMESTAMPTZ(3) NOT NULL,
  "attemptsSent"     INTEGER        NOT NULL DEFAULT 0,
  "lastSentAt"       TIMESTAMPTZ(3),
  "nextAttemptAt"    TIMESTAMPTZ(3),
  "status"           "SlaBreachStatus" NOT NULL DEFAULT 'ACTIVE',
  "resolvedAt"       TIMESTAMPTZ(3),
  "resolutionReason" TEXT,
  "createdAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- The idempotency guarantee: detection upserts on this key and never reads
-- first, so repeated ticks and concurrent runners cannot double-create.
CREATE UNIQUE INDEX IF NOT EXISTS "sla_breach_events_orderId_milestone_key"
  ON "sla_breach_events" ("orderId", "milestone");
CREATE INDEX IF NOT EXISTS "sla_breach_events_status_nextAttemptAt_idx"
  ON "sla_breach_events" ("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "sla_breach_events_labId_status_idx"
  ON "sla_breach_events" ("labId", "status");

CREATE TABLE IF NOT EXISTS "sla_breach_sends" (
  "id"            TEXT PRIMARY KEY,
  "breachEventId" TEXT           NOT NULL REFERENCES "sla_breach_events"("id") ON DELETE CASCADE,
  "attemptNo"     INTEGER        NOT NULL,
  "ruleId"        TEXT,
  "waOutboundId"  TEXT,
  "destination"   TEXT           NOT NULL,
  "renderedBody"  TEXT           NOT NULL,
  "sentAt"        TIMESTAMPTZ(3) NOT NULL,
  "dryRun"        BOOLEAN        NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS "sla_breach_sends_breachEventId_attemptNo_key"
  ON "sla_breach_sends" ("breachEventId", "attemptNo");
CREATE INDEX IF NOT EXISTS "sla_breach_sends_waOutboundId_idx" ON "sla_breach_sends" ("waOutboundId");

-- ── 5. Settings singleton ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "provider_comms_settings" (
  "id"                 TEXT PRIMARY KEY DEFAULT 'default',
  "slaBreachEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "slaBreachDryRun"    BOOLEAN NOT NULL DEFAULT true,
  "quietHoursStart"    INTEGER,
  "quietHoursEnd"      INTEGER,
  "perLabPerTickLimit" INTEGER NOT NULL DEFAULT 2,
  "updatedAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- Ships OFF and in dry run. Nothing sends until a human turns both.
INSERT INTO "provider_comms_settings" ("id") VALUES ('default') ON CONFLICT ("id") DO NOTHING;
