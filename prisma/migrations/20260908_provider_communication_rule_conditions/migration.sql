-- Provider communication rules become authorable the way task rules are.
--
-- Before this, a rule was an anchor plus an offset: it could say "60 minutes
-- after the order" but not "only for these providers", "only while the order
-- is still unconfirmed", or "never at 3am". Those are the questions Ops
-- actually asks about a message, so they move into the rule.
--
--   allowedLabIds / allowedOrderTypes — scope, empty array = everything
--   recipient                         — LAB or MANAGER
--   sendCondition                     — gates re-evaluated at send time
--
-- Additive only, with defaults that preserve the behaviour of every rule that
-- already exists: unscoped, to the lab, no extra gates.

ALTER TABLE "provider_communication_rules"
  ADD COLUMN IF NOT EXISTS "allowedLabIds" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "allowedOrderTypes" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "recipient" TEXT NOT NULL DEFAULT 'LAB',
  ADD COLUMN IF NOT EXISTS "sendCondition" JSONB NOT NULL DEFAULT '{}';

-- Rule attribution on the things a rule produces.
--
-- `rungKey` has been carrying the rule id by convention since custom rules
-- landed, which made "how many messages has this rule sent" a string compare
-- against a column whose other values are built-in rung names. A real column
-- makes per-rule metrics and the recent-sends list an indexed lookup, and
-- keeps sent history intact when the rule is deleted (no FK on purpose).
ALTER TABLE "lab_scheduled_actions" ADD COLUMN IF NOT EXISTS "ruleId" TEXT;
ALTER TABLE "lab_communications"    ADD COLUMN IF NOT EXISTS "ruleId" TEXT;

CREATE INDEX IF NOT EXISTS "lab_scheduled_actions_ruleId_status_idx"
  ON "lab_scheduled_actions" ("ruleId", "status");
CREATE INDEX IF NOT EXISTS "lab_communications_ruleId_createdAt_idx"
  ON "lab_communications" ("ruleId", "createdAt");

-- Backfill the actions the old convention already tagged, so rules created
-- before this migration keep their history.
UPDATE "lab_scheduled_actions" AS a
   SET "ruleId" = a."rungKey"
 WHERE a."ruleId" IS NULL
   AND a."rungKey" IS NOT NULL
   AND EXISTS (SELECT 1 FROM "provider_communication_rules" r WHERE r."id" = a."rungKey");
