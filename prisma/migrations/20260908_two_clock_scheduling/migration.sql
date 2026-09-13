-- Two-clock scheduling for non-API lab communications (PRD §6).
--
-- Scheduled actions gain an anchor + signed offset so runAt becomes derived
-- rather than frozen at creation: an appointment moving in LabStack can now
-- re-derive every appointment-anchored reminder. `priority` breaks ties when
-- both clocks come due in the same tick.
--
-- Additive only. Nothing here touches the labstack public schema.

DO $$ BEGIN CREATE TYPE "LabScheduleAnchor" AS ENUM ('ORDER', 'APPOINTMENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "lab_scheduled_actions"
  ADD COLUMN IF NOT EXISTS "anchor" "LabScheduleAnchor" NOT NULL DEFAULT 'ORDER',
  ADD COLUMN IF NOT EXISTS "offsetMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 4,
  -- Nullable so any pre-existing dev rows stay valid; the runner treats a NULL
  -- rungKey as a legacy order-clock reminder.
  ADD COLUMN IF NOT EXISTS "rungKey" TEXT;

-- Arbitration reads every due action for one workflow, cheapest priority first.
CREATE INDEX IF NOT EXISTS "lab_scheduled_actions_arbitration_idx"
  ON "lab_scheduled_actions" ("workflowId", "status", "priority");

ALTER TABLE "non_api_lab_configs"
  ADD COLUMN IF NOT EXISTS "appointmentRemindersEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "quietWindowMinutes" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "appointmentTemplateKey" TEXT NOT NULL DEFAULT 'NON_API_APPOINTMENT_REMINDER';
