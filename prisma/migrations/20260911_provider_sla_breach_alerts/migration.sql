-- Provider communication becomes common to API and NON_API labs.
--
-- Until now a provider config only did anything for NON_API labs: the
-- confirmation ladder was gated on integrationType and nothing else messaged a
-- provider. This migration adds a second trigger — an SLA breach on any
-- OpsFlow task for the lab's order — which applies to both integration types.
--
-- An API lab never runs the confirmation workflow, so a breach alert has no
-- workflow to hang off. lab_communications."workflowId" therefore becomes
-- nullable and the order/lab are denormalized onto the row.

-- 1. The new message kind.
ALTER TYPE "LabCommunicationType" ADD VALUE IF NOT EXISTS 'SLA_BREACH';

-- 2. Breach alerts can stand alone.
ALTER TABLE "lab_communications" ALTER COLUMN "workflowId" DROP NOT NULL;
ALTER TABLE "lab_communications" ADD COLUMN IF NOT EXISTS "orderId" INTEGER;
ALTER TABLE "lab_communications" ADD COLUMN IF NOT EXISTS "labId"   INTEGER;

COMMENT ON COLUMN "lab_communications"."workflowId" IS
  'NULL only for SLA_BREACH rows: API labs have no confirmation workflow.';
COMMENT ON COLUMN "lab_communications"."labId" IS
  'Denormalized so the per-lab quiet window spans both triggers.';

-- Backfill the existing workflow-backed rows so the new per-lab queries see
-- the full history rather than only messages sent after this deploy.
UPDATE "lab_communications" c
   SET "orderId" = w."orderId", "labId" = w."labId"
  FROM "lab_communication_workflows" w
 WHERE c."workflowId" = w."id"
   AND (c."orderId" IS NULL OR c."labId" IS NULL);

CREATE INDEX IF NOT EXISTS "lab_communications_labId_createdAt_idx"
  ON "lab_communications" ("labId", "createdAt");

-- 3. Per-lab breach-alert settings.
ALTER TABLE "non_api_lab_configs"
  ADD COLUMN IF NOT EXISTS "slaBreachAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "slaBreachTemplateKey"   TEXT    NOT NULL DEFAULT 'PROVIDER_SLA_BREACH',
  ADD COLUMN IF NOT EXISTS "slaBreachMaxPerOrder"   INTEGER NOT NULL DEFAULT 2;

COMMENT ON COLUMN "non_api_lab_configs"."slaBreachAlertsEnabled" IS
  'Message this lab when one of its orders breaches an OpsFlow task SLA. Applies to API labs too.';
