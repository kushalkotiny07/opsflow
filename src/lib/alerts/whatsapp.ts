/**
 * WhatsApp alert sender — the official Meta WhatsApp Business Platform
 * (Cloud API), used for OpsFlow's three internal, staff-facing alerts:
 * SLA breach, the escalation chain, and the daily summary. This is a
 * separate channel from lib/non-api-labs (which talks to external
 * providers over an unofficial linked-device gateway); this one talks to
 * OpsFlow's own team, and is the one built to Meta's actual rules.
 *
 * ── Why every message here must be a template ────────────────────────────
 * Cloud API lets a business send free-form `type: "text"` only inside the
 * 24-hour customer service window — the 24h after the RECIPIENT last
 * messaged the business number. Every alert this file sends is business-
 * initiated: an Ops head does not message OpsFlow first to "open" a window,
 * and nothing here runs a webhook that could receive that reply anyway.
 * So a plain text send is not a fallback path, it is invisible failure —
 * Meta returns error 131047 ("re-engagement message") and nothing arrives.
 *
 * A template is a message Meta has pre-approved: a fixed body with named
 * variables (`{{1}}`, `{{2}}`, ...), submitted once via WhatsApp Manager,
 * reusable forever after approval. `sendWhatsAppMessage` therefore takes a
 * `template` (name + params), and `sendWhatsAppText` — the old free-text
 * signature — is kept only for a future in-window reply, not for alerts.
 *
 * ── Templates this file expects to exist, already approved ───────────────
 * Category UTILITY (operational alert to your own identified staff — the
 * easiest category to get approved, and the correct one: this is not
 * marketing). Submit these exact bodies in WhatsApp Manager > Message
 * Templates before pointing WHATSAPP_API_TOKEN at a real number:
 *
 *   opsflow_sla_breach       "🚨 OpsFlow SLA Breach\n\nTask: {{1}}\nOrder:
 *                            #{{2}} — {{3}}\n{{4}}\n\nPlease review and
 *                            take action immediately."
 *   opsflow_escalation       "🔴 Escalation L{{1}} — Task: \"{{2}}\" (Order
 *                            #{{3}}) is SLA breached and needs attention.
 *                            — OpsFlow"
 *   opsflow_daily_summary    "Good morning. OpsFlow summary for today:
 *                            {{1}}"
 *
 * Meta reviews wording, not just structure — the body sent here MUST match
 * the approved template's text with only the {{n}} slots differing, or the
 * send is rejected. Keep this file and the Manager submission in sync.
 *
 * ── Setup (you do this in Meta's console, not in code) ───────────────────
 *   1. developers.facebook.com → Create App → type "Business" → add the
 *      WhatsApp product. This gives you a free TEST number instantly, no
 *      business verification needed — good enough to prove this file works
 *      end to end before anything is "official."
 *   2. In WhatsApp > API Setup: copy the Phone Number ID and a temporary
 *      access token (24h). Add up to 5 recipient numbers to the test
 *      allow-list — each must accept a WhatsApp message request first.
 *   3. In WhatsApp Manager > Message Templates: submit the three bodies
 *      above under category UTILITY. Approval is usually minutes for
 *      utility templates, sometimes longer.
 *   4. Set in .env:
 *        WHATSAPP_API_URL=https://graph.facebook.com/v20.0/<phone-number-id>/messages
 *        WHATSAPP_API_TOKEN=<token>
 *   5. Give each OPS_HEAD user a real phone (E.164 digits, no +) via
 *      Team settings — nothing sends to a user with no phone on file.
 *   6. For production: verify the business in Meta Business Manager, move
 *      to a real number, generate a PERMANENT token from a System User
 *      (a temporary token expires and every alert after that silently
 *      fails), and request the WhatsApp Business Platform review needed
 *      to message beyond the 5-number test allow-list.
 *
 * Until WHATSAPP_API_URL/TOKEN are set, every call here logs to console
 * and returns false — safe by default, same as before.
 */

const WA_API_URL = process.env.WHATSAPP_API_URL ?? "";
const WA_API_TOKEN = process.env.WHATSAPP_API_TOKEN ?? "";
const WA_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG ?? "en_US";

export interface WaTemplateMessage {
  to: string; // phone number, country code, no +  e.g. "919876543210"
  /** The exact name the template was approved under in WhatsApp Manager. */
  template: string;
  /** Positional {{1}}, {{2}}, ... values, in order. */
  params: string[];
  taskId?: number; // optional, for logging only
}

export interface WaTextMessage {
  to: string;
  body: string;
  taskId?: number;
}

type CloudApiResult = { ok: true; messageId: string | null } | { ok: false; error: string };

async function postToCloudApi(payload: Record<string, unknown>, logTarget: string): Promise<CloudApiResult> {
  if (!WA_API_URL || !WA_API_TOKEN) {
    console.log(`[WhatsApp DISABLED] → ${logTarget}: ${JSON.stringify(payload).slice(0, 200)}`);
    return { ok: false, error: "not configured" };
  }
  try {
    const res = await fetch(WA_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_API_TOKEN}` },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Meta's error shape: { error: { message, type, code, error_subcode, fbtrace_id } }.
      // Surfaced whole, because 131047 (outside the 24h window — see header)
      // and 132000 (template not approved / name-language mismatch) look
      // identical from a bare HTTP status and need the code to diagnose.
      const detail = json?.error ? `[${json.error.code}${json.error.error_subcode ? `/${json.error.error_subcode}` : ""}] ${json.error.message}` : await Promise.resolve(JSON.stringify(json)).catch(() => res.statusText);
      console.error(`[WhatsApp] Send failed to ${logTarget}:`, detail);
      return { ok: false, error: detail };
    }
    const messageId = json?.messages?.[0]?.id ?? null;
    console.log(`[WhatsApp] Sent to ${logTarget}${messageId ? ` (${messageId})` : ""}`);
    return { ok: true, messageId };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[WhatsApp] Network error sending to ${logTarget}:`, detail);
    return { ok: false, error: detail };
  }
}

/**
 * Send an approved template message. This is the path every alert in this
 * codebase should use — see the header for why free text does not work for
 * a business-initiated message with no open customer-service window.
 */
export async function sendWhatsAppMessage(msg: WaTemplateMessage): Promise<boolean> {
  const result = await postToCloudApi(
    {
      messaging_product: "whatsapp",
      to: msg.to,
      type: "template",
      template: {
        name: msg.template,
        language: { code: WA_TEMPLATE_LANG },
        components: msg.params.length
          ? [{ type: "body", parameters: msg.params.map((text) => ({ type: "text", text })) }]
          : [],
      },
    },
    `${msg.to}${msg.taskId ? ` (task #${msg.taskId})` : ""}`,
  );
  return result.ok;
}

/**
 * Free-form text. Only valid inside the 24h window opened by an inbound
 * message from `to` — there is no such inbound path in this codebase today,
 * so nothing currently calls this. Kept for a future reply-in-session
 * feature; do not use it for a cold alert, it will be rejected by Meta.
 */
export async function sendWhatsAppText(msg: WaTextMessage): Promise<boolean> {
  const result = await postToCloudApi(
    { messaging_product: "whatsapp", to: msg.to, type: "text", text: { body: msg.body } },
    `${msg.to}${msg.taskId ? ` (task #${msg.taskId})` : ""}`,
  );
  return result.ok;
}

/** Params for the `opsflow_sla_breach` template, in the order Meta expects. */
export function slaBreachTemplateParams(params: {
  taskTitle: string;
  orderId: number;
  patientName: string;
  assignedTo: string | null;
}): string[] {
  return [
    params.taskTitle,
    String(params.orderId),
    params.patientName,
    params.assignedTo ? `Assigned to: ${params.assignedTo}` : "⚠️ Currently unassigned",
  ];
}

