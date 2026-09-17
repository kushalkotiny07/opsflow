-- Editable polls: the question, the options, and the reply each option earns.
--
-- Poll options were a hardcoded array in the app and the reply to a tap was a
-- fixed template picked by action. That worked for exactly one poll — the
-- order-confirmation ladder — and meant any other kind (an SLA breach asking
-- "what is happening with this sample?") needed new code and a deploy. Both
-- halves become data here.
--
-- Applied with `prisma db execute`, like the other files in this directory:
-- schema.prisma is the source of truth, this repo has no _prisma_migrations
-- table, and a plain `db push` wants to drop four drifted tables that still
-- hold data.

CREATE TABLE IF NOT EXISTS taskos.wa_poll_definitions (
  "id"        TEXT PRIMARY KEY,
  "key"       TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "question"  TEXT NOT NULL,
  "isActive"  BOOLEAN NOT NULL DEFAULT true,
  -- [{ label, action, ack }] — action NULL means the answer is informational.
  "options"   JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "wa_poll_definitions_key_key" ON taskos.wa_poll_definitions("key");

-- Which option was tapped. votedAction alone cannot identify the reply: an
-- informational option has no action, and two options may share one.
ALTER TABLE taskos.wa_polls ADD COLUMN IF NOT EXISTS "votedLabel" TEXT;

-- An informational poll answer moves no workflow state, but the provider's
-- words still belong on the order. Without this they would have to be recorded
-- as LAB_REJECTED, which would be a lie.
DO $$ BEGIN
  ALTER TYPE "LabOrderEventType" ADD VALUE IF NOT EXISTS 'PROVIDER_NOTE';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
