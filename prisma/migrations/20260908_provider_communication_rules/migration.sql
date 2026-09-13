CREATE TABLE IF NOT EXISTS "provider_communication_rules" (
  "id" TEXT NOT NULL,
  "labId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "anchor" "LabScheduleAnchor" NOT NULL,
  "action" "LabScheduledActionType" NOT NULL,
  "offsetMinutes" INTEGER NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 4,
  "templateKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_communication_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_communication_rules_labId_isActive_idx" ON "provider_communication_rules"("labId", "isActive");
CREATE UNIQUE INDEX IF NOT EXISTS "provider_communication_rules_labId_name_key" ON "provider_communication_rules"("labId", "name");
DO $$ BEGIN
  ALTER TABLE "provider_communication_rules" ADD CONSTRAINT "provider_communication_rules_labId_fkey" FOREIGN KEY ("labId") REFERENCES "non_api_lab_configs"("labId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;