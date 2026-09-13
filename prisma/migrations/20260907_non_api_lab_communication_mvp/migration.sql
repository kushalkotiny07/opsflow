-- Non-API lab communication MVP — owned OpsFlow workflow state only.
-- This is additive and never changes LabStack's public schema.

DO $$ BEGIN CREATE TYPE "LabIntegrationType" AS ENUM ('API', 'NON_API'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabCommunicationWorkflowStatus" AS ENUM ('WAITING_FOR_LAB_CONFIRMATION', 'LAB_ACCEPTED', 'LAB_RESCHEDULE_REQUESTED', 'LAB_REJECTED', 'ESCALATED', 'COMPLETED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabCommunicationChannel" AS ENUM ('WHATSAPP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabCommunicationType" AS ENUM ('INITIAL_NOTIFICATION', 'REMINDER', 'ESCALATION', 'MANUAL_RESEND'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabCommunicationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SUPPRESSED', 'ACTION_TAKEN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabScheduledActionType" AS ENUM ('SEND_REMINDER', 'ESCALATE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabScheduledActionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED', 'SUPPRESSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabProviderActionType" AS ENUM ('ACCEPT', 'RESCHEDULE', 'REJECT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabEscalationStatus" AS ENUM ('OPEN', 'NOTIFIED', 'RESOLVED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LabOrderEventType" AS ENUM ('ORDER_DETECTED', 'WORKFLOW_STARTED', 'MESSAGE_QUEUED', 'MESSAGE_SENT', 'MESSAGE_DELIVERED', 'MESSAGE_READ', 'ACTION_LINK_OPENED', 'LAB_ACCEPTED', 'LAB_RESCHEDULE_REQUESTED', 'LAB_REJECTED', 'REMINDER_SCHEDULED', 'REMINDER_SENT', 'REMINDER_SUPPRESSED', 'ESCALATION_TRIGGERED', 'WORKFLOW_CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "non_api_lab_configs" (
  "labId" INTEGER NOT NULL,
  "labName" TEXT NOT NULL,
  "integrationType" "LabIntegrationType" NOT NULL DEFAULT 'NON_API',
  "whatsappNumber" TEXT,
  "managerName" TEXT,
  "managerWhatsapp" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "confirmationSlaMinutes" INTEGER NOT NULL DEFAULT 60,
  "reminderSlaMinutes" INTEGER NOT NULL DEFAULT 180,
  "escalationSlaMinutes" INTEGER NOT NULL DEFAULT 300,
  "createdById" INTEGER,
  "updatedById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "non_api_lab_configs_pkey" PRIMARY KEY ("labId")
);

CREATE TABLE IF NOT EXISTS "lab_communication_workflows" (
  "id" TEXT NOT NULL,
  "orderId" INTEGER NOT NULL,
  "labId" INTEGER NOT NULL,
  "status" "LabCommunicationWorkflowStatus" NOT NULL DEFAULT 'WAITING_FOR_LAB_CONFIRMATION',
  "sourceOrderStatus" TEXT,
  "orderSnapshot" JSONB NOT NULL,
  "appointmentTime" TIMESTAMP(3),
  "confirmationDeadline" TIMESTAMP(3) NOT NULL,
  "reminderDeadline" TIMESTAMP(3) NOT NULL,
  "escalationDeadline" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3), "rescheduleRequestedAt" TIMESTAMP(3), "rejectedAt" TIMESTAMP(3),
  "rejectionReason" TEXT, "cancelledAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lab_communication_workflows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lab_communications" (
  "id" TEXT NOT NULL, "workflowId" TEXT NOT NULL,
  "channel" "LabCommunicationChannel" NOT NULL DEFAULT 'WHATSAPP',
  "type" "LabCommunicationType" NOT NULL,
  "status" "LabCommunicationStatus" NOT NULL DEFAULT 'QUEUED',
  "recipient" TEXT NOT NULL, "templateKey" TEXT NOT NULL, "templateVariables" JSONB NOT NULL,
  "waOutboundId" TEXT, "providerMessageId" TEXT, "idempotencyKey" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3), "readAt" TIMESTAMP(3), "actionTakenAt" TIMESTAMP(3), "suppressedAt" TIMESTAMP(3), "failedAt" TIMESTAMP(3), "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lab_communications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lab_scheduled_actions" (
  "id" TEXT NOT NULL, "workflowId" TEXT NOT NULL, "type" "LabScheduledActionType" NOT NULL,
  "status" "LabScheduledActionStatus" NOT NULL DEFAULT 'PENDING', "runAt" TIMESTAMP(3) NOT NULL,
  "idempotencyKey" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0, "lockedAt" TIMESTAMP(3), "lockedBy" TEXT,
  "completedAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lab_scheduled_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lab_provider_action_tokens" (
  "id" TEXT NOT NULL, "workflowId" TEXT NOT NULL, "action" "LabProviderActionType" NOT NULL,
  "tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3), "openedAt" TIMESTAMP(3), "usedIpHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lab_provider_action_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lab_communication_escalations" (
  "id" TEXT NOT NULL, "workflowId" TEXT NOT NULL, "level" INTEGER NOT NULL,
  "status" "LabEscalationStatus" NOT NULL DEFAULT 'OPEN', "recipient" TEXT, "reason" TEXT NOT NULL,
  "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "notifiedAt" TIMESTAMP(3), "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lab_communication_escalations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lab_communication_order_events" (
  "id" TEXT NOT NULL, "workflowId" TEXT NOT NULL, "type" "LabOrderEventType" NOT NULL,
  "actorType" TEXT, "actorId" TEXT, "payload" JSONB, "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lab_communication_order_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lab_communication_audit_logs" (
  "id" TEXT NOT NULL, "workflowId" TEXT NOT NULL, "action" TEXT NOT NULL, "actorType" TEXT NOT NULL,
  "actorId" TEXT, "requestId" TEXT, "metadata" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lab_communication_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "lab_communication_workflows_orderId_key" ON "lab_communication_workflows"("orderId");
CREATE INDEX IF NOT EXISTS "non_api_lab_configs_integrationType_isActive_idx" ON "non_api_lab_configs"("integrationType", "isActive");
CREATE INDEX IF NOT EXISTS "lab_communication_workflows_labId_status_idx" ON "lab_communication_workflows"("labId", "status");
CREATE INDEX IF NOT EXISTS "lab_communication_workflows_status_confirmationDeadline_idx" ON "lab_communication_workflows"("status", "confirmationDeadline");
CREATE UNIQUE INDEX IF NOT EXISTS "lab_communications_waOutboundId_key" ON "lab_communications"("waOutboundId");
CREATE UNIQUE INDEX IF NOT EXISTS "lab_communications_providerMessageId_key" ON "lab_communications"("providerMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "lab_communications_idempotencyKey_key" ON "lab_communications"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "lab_communications_workflowId_createdAt_idx" ON "lab_communications"("workflowId", "createdAt");
CREATE INDEX IF NOT EXISTS "lab_communications_status_idx" ON "lab_communications"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "lab_scheduled_actions_idempotencyKey_key" ON "lab_scheduled_actions"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "lab_scheduled_actions_status_runAt_idx" ON "lab_scheduled_actions"("status", "runAt");
CREATE INDEX IF NOT EXISTS "lab_scheduled_actions_workflowId_idx" ON "lab_scheduled_actions"("workflowId");
CREATE UNIQUE INDEX IF NOT EXISTS "lab_provider_action_tokens_tokenHash_key" ON "lab_provider_action_tokens"("tokenHash");
CREATE INDEX IF NOT EXISTS "lab_provider_action_tokens_workflowId_action_idx" ON "lab_provider_action_tokens"("workflowId", "action");
CREATE INDEX IF NOT EXISTS "lab_provider_action_tokens_expiresAt_idx" ON "lab_provider_action_tokens"("expiresAt");
CREATE UNIQUE INDEX IF NOT EXISTS "lab_communication_escalations_workflowId_level_key" ON "lab_communication_escalations"("workflowId", "level");
CREATE INDEX IF NOT EXISTS "lab_communication_escalations_status_triggeredAt_idx" ON "lab_communication_escalations"("status", "triggeredAt");
CREATE INDEX IF NOT EXISTS "lab_communication_order_events_workflowId_occurredAt_idx" ON "lab_communication_order_events"("workflowId", "occurredAt");
CREATE INDEX IF NOT EXISTS "lab_communication_order_events_type_idx" ON "lab_communication_order_events"("type");
CREATE INDEX IF NOT EXISTS "lab_communication_audit_logs_workflowId_createdAt_idx" ON "lab_communication_audit_logs"("workflowId", "createdAt");
CREATE INDEX IF NOT EXISTS "lab_communication_audit_logs_requestId_idx" ON "lab_communication_audit_logs"("requestId");

DO $$ BEGIN ALTER TABLE "lab_communications" ADD CONSTRAINT "lab_communications_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "lab_communication_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "lab_scheduled_actions" ADD CONSTRAINT "lab_scheduled_actions_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "lab_communication_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "lab_provider_action_tokens" ADD CONSTRAINT "lab_provider_action_tokens_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "lab_communication_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "lab_communication_escalations" ADD CONSTRAINT "lab_communication_escalations_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "lab_communication_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "lab_communication_order_events" ADD CONSTRAINT "lab_communication_order_events_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "lab_communication_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "lab_communication_audit_logs" ADD CONSTRAINT "lab_communication_audit_logs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "lab_communication_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
