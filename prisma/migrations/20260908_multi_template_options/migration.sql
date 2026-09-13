-- Per-lab message template choices for each workflow stage.
ALTER TABLE "non_api_lab_configs"
  ADD COLUMN IF NOT EXISTS "initialTemplateKey" TEXT NOT NULL DEFAULT 'NON_API_NEW_ORDER',
  ADD COLUMN IF NOT EXISTS "reminderTemplateKey" TEXT NOT NULL DEFAULT 'NON_API_REMINDER',
  ADD COLUMN IF NOT EXISTS "escalationTemplateKey" TEXT NOT NULL DEFAULT 'NON_API_ESCALATION';
