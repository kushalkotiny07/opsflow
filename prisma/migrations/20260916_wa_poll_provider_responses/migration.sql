-- Provider responses by WhatsApp POLL instead of tokenized links.
--
-- A provider used to answer a confirmation request by opening an accept /
-- reschedule / reject URL. This adds the native path: the gateway posts a poll
-- in the provider's group, the provider taps an option, and the vote is applied
-- to the confirmation workflow. The token route and /provider/action page are
-- deliberately left in place — links already sent stay valid.
--
-- Applied with `prisma db execute` rather than `prisma migrate` or `db push`,
-- for the same reason as the other files here: schema.prisma is the source of
-- truth and this repo has no _prisma_migrations table. A plain `db push` also
-- could not be used, because the dev database carries four drifted tables
-- (guardrail_policies, message_templates, workflow_definition*) that push wants
-- to drop. This file touches only what the feature needs.

-- ── 1. Poll lifecycle enum ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "WaPollStatus" AS ENUM ('PENDING','VOTED','APPLIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. wa_outbound learns to carry a poll ──────────────────────────────
-- pollOptions is [{ label, action }] in display order; a NULL pollName keeps
-- the row a plain text/media send, so every existing row is unaffected.
ALTER TABLE taskos.wa_outbound ADD COLUMN IF NOT EXISTS "pollName"    TEXT;
ALTER TABLE taskos.wa_outbound ADD COLUMN IF NOT EXISTS "pollOptions" JSONB;

-- ── 3. The poll itself, and the vote that came back ────────────────────
-- messageJson holds the poll creation message as Baileys returned it: votes
-- arrive encrypted and can only be opened with that message's messageSecret,
-- so it has to outlive a gateway restart.
CREATE TABLE IF NOT EXISTS taskos.wa_polls (
  "waMsgId"        TEXT PRIMARY KEY,
  "outboundId"     TEXT,
  "workflowId"     TEXT,
  "options"        JSONB        NOT NULL,
  "messageJson"    JSONB        NOT NULL,
  "status"         "WaPollStatus" NOT NULL DEFAULT 'PENDING',
  "votedAction"    "LabProviderActionType",
  "voterJid"       TEXT,
  "votedAt"        TIMESTAMP(3),
  "awaitingReason" BOOLEAN      NOT NULL DEFAULT false,
  "reason"         TEXT,
  "reasonAt"       TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The vote is applied the moment it lands so reminders stop; a reason that
-- arrives afterwards is a separate write, and this is what stops the tick
-- re-attaching the same text every minute.
ALTER TABLE taskos.wa_polls ADD COLUMN IF NOT EXISTS "reasonAppliedAt" TIMESTAMP(3);

-- One poll per outbound row, but many rows may have none.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_polls_outboundId_key" ON taskos.wa_polls("outboundId");
CREATE INDEX IF NOT EXISTS "wa_polls_status_idx"            ON taskos.wa_polls("status");
CREATE INDEX IF NOT EXISTS "wa_polls_workflowId_idx"        ON taskos.wa_polls("workflowId");
-- The gateway scans this every inbound message to see whether the sender owes
-- a rejection reason, so it wants its own index.
CREATE INDEX IF NOT EXISTS "wa_polls_awaitingReason_idx"    ON taskos.wa_polls("awaitingReason");
