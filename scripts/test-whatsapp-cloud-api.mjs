#!/usr/bin/env node
/**
 * Connectivity smoke test for the official Cloud API path — separate from
 * the app, so you can run it the moment you have real Meta credentials
 * without needing a task to actually breach.
 *
 * Reads WHATSAPP_API_URL / WHATSAPP_API_TOKEN / WHATSAPP_TEMPLATE_LANG from
 * .env directly — nothing is typed into chat or logged beyond a redacted
 * token prefix.
 *
 * Usage:
 *   node scripts/test-whatsapp-cloud-api.mjs <to-number-e164-no-plus> <template-name>
 *   node scripts/test-whatsapp-cloud-api.mjs 919876543210 opsflow_sla_breach
 *
 * <to-number> must be on the test app's recipient allow-list (WhatsApp >
 * API Setup) until the WhatsApp Business Platform review is granted.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../.env") });

const URL_ = process.env.WHATSAPP_API_URL ?? "";
const TOKEN = process.env.WHATSAPP_API_TOKEN ?? "";
const LANG = process.env.WHATSAPP_TEMPLATE_LANG ?? "en_US";

const [to, templateName = "opsflow_sla_breach"] = process.argv.slice(2);

if (!URL_ || !TOKEN) {
  console.error("✘ WHATSAPP_API_URL / WHATSAPP_API_TOKEN are not set in .env — nothing to test.");
  console.error("  See src/lib/alerts/whatsapp.ts for the six setup steps.");
  process.exit(1);
}
if (!to) {
  console.error("Usage: node scripts/test-whatsapp-cloud-api.mjs <to-number-e164-no-plus> [template-name]");
  process.exit(1);
}

// One sample param set per template this codebase ships, so the same command
// works for any of the three without extra flags.
const SAMPLE_PARAMS = {
  opsflow_sla_breach: ["Sample handover to lab", "12345", "Test Patient", "Assigned to: Test Agent"],
  opsflow_escalation: ["1", "Sample handover to lab", "12345"],
  opsflow_daily_summary: ["Tasks Created: 10\nCompleted: 8\nSLA Breached: 1\nSLA Health: 90%"],
};
const params = SAMPLE_PARAMS[templateName] ?? [];

console.log(`→ POST ${URL_}`);
console.log(`  token: ${TOKEN.slice(0, 8)}…${TOKEN.slice(-4)} (redacted)`);
console.log(`  to: ${to}   template: ${templateName}   lang: ${LANG}`);
if (!SAMPLE_PARAMS[templateName]) {
  console.log(`  (unrecognised template name — sending with zero params; pass one of ${Object.keys(SAMPLE_PARAMS).join(", ")} to use the built-in samples)`);
}

const payload = {
  messaging_product: "whatsapp",
  to,
  type: "template",
  template: {
    name: templateName,
    language: { code: LANG },
    components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : [],
  },
};

const res = await fetch(URL_, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(payload),
});
const json = await res.json().catch(() => ({}));

if (res.ok) {
  console.log(`\n✔ HTTP ${res.status} — message id: ${json?.messages?.[0]?.id ?? "(none returned)"}`);
  console.log("  Check the recipient's WhatsApp — it should arrive within seconds.");
  process.exit(0);
}

console.error(`\n✘ HTTP ${res.status}`);
console.error(JSON.stringify(json, null, 2));
if (json?.error?.code === 132001 || /template.*not.*exist|does not exist/i.test(json?.error?.message ?? "")) {
  console.error(`\n  → "${templateName}" isn't approved yet (or the name/language don't match). Check WhatsApp Manager > Message Templates.`);
} else if (json?.error?.code === 131047) {
  console.error("\n  → Outside the 24h window — this only applies to type:\"text\" sends; a template send hitting this usually means the template itself was rejected. Check its status in WhatsApp Manager.");
} else if (json?.error?.code === 100 && /recipient/i.test(json?.error?.message ?? "")) {
  console.error(`\n  → On a TEST number, "${to}" must be added to the allow-list first: WhatsApp > API Setup > Manage phone number list.`);
}
process.exit(1);
