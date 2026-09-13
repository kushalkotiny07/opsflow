-- Editable template storage for the Non-API lab workflow. Additive only.
CREATE TABLE IF NOT EXISTS "lab_communication_templates" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "channel" "LabCommunicationChannel" NOT NULL DEFAULT 'WHATSAPP',
  "body" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" INTEGER,
  "updatedById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lab_communication_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "lab_communication_templates_key_key" ON "lab_communication_templates"("key");
CREATE INDEX IF NOT EXISTS "lab_communication_templates_channel_isActive_idx" ON "lab_communication_templates"("channel", "isActive");
