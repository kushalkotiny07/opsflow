-- Daily provider digest: one message a day per lab, summarising the day that
-- is ending and the one that starts tomorrow. PRD §31.
--
-- Until now every provider message was triggered by a single order — a new
-- order, a reminder, an escalation, a breach. A digest is the first one that
-- is about a lab's DAY, which is why it carries a null orderId and needs its
-- own LabCommunicationType rather than borrowing REMINDER.
--
-- Applied with `prisma db execute`, like the other files in this directory:
-- schema.prisma is the source of truth, this repo has no _prisma_migrations
-- table, and a plain `db push` wants to drop four drifted tables that still
-- hold data.

DO $$ BEGIN
  ALTER TYPE "LabCommunicationType" ADD VALUE IF NOT EXISTS 'DAILY_DIGEST';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Off by default. A recurring broadcast into a real provider group is a thing
-- a human switches on per lab, never something a deploy starts doing.
ALTER TABLE taskos.non_api_lab_configs
  ADD COLUMN IF NOT EXISTS "dailyDigestEnabled"       BOOLEAN NOT NULL DEFAULT false,
  -- Local clock (TIMEZONE), not UTC: "19:00" means the provider's 19:00.
  ADD COLUMN IF NOT EXISTS "dailyDigestHour"          INTEGER NOT NULL DEFAULT 19,
  ADD COLUMN IF NOT EXISTS "dailyDigestMinute"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "dailyDigestTemplateKey"   TEXT    NOT NULL DEFAULT 'PROVIDER_DAILY_DIGEST',
  -- A nightly "0 today, 0 tomorrow" trains a provider to ignore the thread.
  ADD COLUMN IF NOT EXISTS "dailyDigestSkipWhenEmpty" BOOLEAN NOT NULL DEFAULT true;
