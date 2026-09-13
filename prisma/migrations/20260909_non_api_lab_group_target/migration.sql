-- Provider messages can target a WhatsApp GROUP, not just a handset.
--
-- Before this, NonApiLabConfig only held `whatsappNumber`, and the send path
-- built its address with `number.replace(/\D/g, "") + "@s.whatsapp.net"` —
-- which silently mangles a group jid ("1203...@g.us" lost its "@g.us" and
-- became a nonsense DM address). A provider's ops group is the right target
-- for these messages: a reply is visible to their whole desk rather than
-- sitting in one person's chat.
--
-- Nullable and additive: labs already configured with a number keep working,
-- and the resolver prefers the group when both are present.
ALTER TABLE "non_api_lab_configs" ADD COLUMN IF NOT EXISTS "waGroupJid" text;

COMMENT ON COLUMN "non_api_lab_configs"."waGroupJid" IS
  'WhatsApp group jid (…@g.us) for provider messages. Takes precedence over whatsappNumber.';
