-- Provider communication rules are shared by every configured provider lab.
ALTER TABLE "provider_communication_rules"
  DROP CONSTRAINT IF EXISTS "provider_communication_rules_labId_fkey";
DROP INDEX IF EXISTS "provider_communication_rules_labId_name_key";
DROP INDEX IF EXISTS "provider_communication_rules_labId_isActive_idx";
ALTER TABLE "provider_communication_rules"
  DROP COLUMN IF EXISTS "labId";
CREATE INDEX IF NOT EXISTS "provider_communication_rules_isActive_idx" ON "provider_communication_rules"("isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "provider_communication_rules_name_key" ON "provider_communication_rules"("name");
