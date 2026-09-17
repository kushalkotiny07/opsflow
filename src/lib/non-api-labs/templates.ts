import prisma from "@/lib/db/client";

export const NON_API_NEW_ORDER_TEMPLATE = "NON_API_NEW_ORDER";
export const NON_API_REMINDER_TEMPLATE = "NON_API_REMINDER";
export const NON_API_ESCALATION_TEMPLATE = "NON_API_ESCALATION";
export const NON_API_APPOINTMENT_TEMPLATE = "NON_API_APPOINTMENT_REMINDER";
// Not NON_API_*: this one is sent to API labs too. See lib/provider-comms.
// What the provider gets back the moment they tap a poll option. Until these
// existed, Accept was answered with silence — the provider had no way to tell
// whether the tap registered, which is the one thing a poll cannot show.
export const NON_API_ACCEPTED_TEMPLATE = "NON_API_ACCEPTED";
export const NON_API_RESCHEDULE_ASK_TEMPLATE = "NON_API_RESCHEDULE_ASK";
export const NON_API_REJECT_ASK_TEMPLATE = "NON_API_REJECT_ASK";

export const PROVIDER_SLA_BREACH_TEMPLATE = "PROVIDER_SLA_BREACH";
export const SLA_MILESTONE_BREACH_TEMPLATE = "PROVIDER_SLA_MILESTONE";
// The once-a-day wrap-up. Not NON_API_*: any lab with a config can opt in.
export const PROVIDER_DAILY_DIGEST_TEMPLATE = "PROVIDER_DAILY_DIGEST";

// Order details every template may use. `lab_name` has always been supplied to
// the renderer by workflow.ts but was missing from this list, so a template
// using {{lab_name}} was rejected at save time even though it rendered fine.
const ORDER_VARIABLES = [
  "order_id", "patient_name", "appointment_date", "appointment_time",
  "location", "tests", "sla_deadline", "lab_name",
] as const;
// Still rendered, and the tokens behind them are still minted — but no longer
// present in any DEFAULT body. Providers answer by tapping the poll that rides
// with the message; these remain so that links already sent keep working and so
// Ops can still put one in a hand-edited template if they want a web form.
const ACTION_URL_VARIABLES = ["accept_url", "reschedule_url", "reject_url"] as const;

// The poll that replaces those links. Defined in ./poll-config, which has no
// imports, so the message-flow editor ("use client") can read it without
// pulling this module's Prisma import into the browser bundle. Re-exported here
// because server callers reach for it alongside the template bodies.
export { PROVIDER_POLL_NAME, PROVIDER_POLL_OPTIONS } from "./poll-config";
// Only the breach template has these: they describe an OpsFlow task that blew
// its deadline, which none of the confirmation-ladder messages know about.
const BREACH_VARIABLES = ["task_title", "breach_minutes", "breached_at"] as const;

// The SLA MILESTONE breach vocabulary (lib/provider-comms/breach-engine.ts).
// Distinct from BREACH_VARIABLES above, which belongs to the older
// task-SLA alert: this set describes an order milestone and its repeat
// schedule, and is the only place attempt counts are exposed to a message.
export const SLA_MILESTONE_VARIABLES = [
  "sla_milestone", "sla_deadline", "sla_overdue_by",
  "sla_attempt_no", "sla_attempts_remaining",
] as const;

// The digest vocabulary. Deliberately shares NOTHING with the order variables
// above: a digest names no order, no patient and no appointment, so a body
// that reached for {{order_id}} would render "undefined" for every lab every
// evening. Keeping the sets disjoint makes that a save-time error instead.
export const DIGEST_VARIABLES = [
  "lab_name", "digest_date",
  "today_total", "today_home", "today_centre", "today_collected",
  "today_pending", "today_reports_pending", "today_cancelled", "today_unconfirmed",
  "tomorrow_date", "tomorrow_total", "tomorrow_home", "tomorrow_centre",
  "tomorrow_first", "tomorrow_unconfirmed", "tomorrow_schedule",
] as const;

/** A message using any sla_* variable may only be attached to a breach step. */
export function usesMilestoneVariables(body: string): boolean {
  return SLA_MILESTONE_VARIABLES.some((variable) => body.includes(`{{${variable}}}`));
}

export const NON_API_NEW_ORDER_VARIABLES = [...ORDER_VARIABLES, ...ACTION_URL_VARIABLES] as const;

// Stored in the database on first use. It intentionally lives here (server
// configuration bootstrap) rather than in a React component, and Ops can edit
// the persisted body through the template API without a deploy.
export const DEFAULT_NON_API_NEW_ORDER_BODY = `LabStack New Order

Order ID: {{order_id}}
Patient: {{patient_name}}
Appointment: {{appointment_date}} at {{appointment_time}}
Location: {{location}}
Tests: {{tests}}

Please confirm by {{sla_deadline}}.

Tap an option in the poll below to respond.`;

export const DEFAULT_NON_API_REMINDER_BODY = `Reminder: please confirm LabStack order {{order_id}} for {{patient_name}}.
Appointment: {{appointment_date}} at {{appointment_time}}
Please confirm by {{sla_deadline}}.

Tap an option in the poll below to respond.`;

// Addressed to the lab's manager, not the lab inbox that has already gone
// quiet — hence {{manager_name}} and {{lab_name}}.
export const DEFAULT_NON_API_ESCALATION_BODY = `Hello {{manager_name}}, we still have no confirmation from {{lab_name}} for LabStack order {{order_id}}.
Patient: {{patient_name}}
Appointment: {{appointment_date}} at {{appointment_time}}
Please respond by {{sla_deadline}}.

Tap an option in the poll below to respond.`;

// Appointment clock. This one is about the patient's clock, not the lab's SLA,
// so it deliberately does not mention a confirmation deadline.
export const DEFAULT_NON_API_APPOINTMENT_BODY = `Upcoming appointment — LabStack order {{order_id}} is still unconfirmed.
Patient: {{patient_name}}
Appointment: {{appointment_date}} at {{appointment_time}}
Location: {{location}}

Tap an option in the poll below to respond.`;

// Deliberately carries no accept/reschedule/reject link. Those are bearer
// tokens minted against a LabCommunicationWorkflow, and an API lab never has
// one — a breach template that required them could not be sent to half the
// labs it is meant for. It reports the miss and points at the order instead.
export const DEFAULT_PROVIDER_SLA_BREACH_BODY = `SLA breached - LabStack order {{order_id}}

Lab: {{lab_name}}
Patient: {{patient_name}}
Appointment: {{appointment_date}} at {{appointment_time}}
Tests: {{tests}}

{{task_title}}
Due {{sla_deadline}}, now {{breach_minutes}} minutes overdue.

Please update this order in LabStack, or reply here if it cannot be served.`;

// Carries no accept/reschedule/reject link, for the same reason
// DEFAULT_PROVIDER_SLA_BREACH_BODY does not: those are bearer tokens minted
// against a LabCommunicationWorkflow, and an API lab never has one. This
// message goes to every lab type, so it can only reference what every lab
// type has.
export const DEFAULT_SLA_MILESTONE_BREACH_BODY = `*SLA missed - {{sla_milestone}}*

Order: {{order_id}}
Patient: {{patient_name}}
Appointment: {{appointment_date}} at {{appointment_time}}

{{sla_milestone}} was due {{sla_deadline}} and is now {{sla_overdue_by}} overdue.

Please update this order in LabStack, or reply here if it cannot be completed.`;

export type TemplateVariables = Record<string, string>;

export async function getActiveNewOrderTemplate() {
  return ensureTemplate(NON_API_NEW_ORDER_TEMPLATE);
}

/**
 * Shipped defaults. Exported so the block-editor round-trip test can assert
 * that opening any stock template in the builder does not rewrite it.
 */
// ── Replies to a poll tap ────────────────────────────────────────────────
// Accept repeats the order back deliberately. The provider tapped a button on
// a message that may be well up their chat by now, so "confirmed" on its own
// leaves them unsure WHICH order they just committed to.
export const DEFAULT_NON_API_ACCEPTED_BODY = `*Order confirmed — thank you.*

Order ID: {{order_id}}
Patient: {{patient_name}}
Appointment: {{appointment_date}} at {{appointment_time}}
Location: {{location}}
Tests: {{tests}}

We have marked this order as accepted. No further confirmation is needed.`;

export const DEFAULT_NON_API_RESCHEDULE_ASK_BODY = `Noted — reschedule requested for order {{order_id}} ({{patient_name}}).

Please reply to this message with the date and time you can do instead, and we will update the order.`;

export const DEFAULT_NON_API_REJECT_ASK_BODY = `Noted — order {{order_id}} ({{patient_name}}) marked as unable to fulfil.

Please reply to this message with the reason, so we can reassign it quickly.`;

// ── The daily digest ─────────────────────────────────────────────────────
// Written to be read on a phone, at the end of a shift. Today first, because
// the reader already lived it and only wants to check nothing is hanging;
// tomorrow second and in more detail, because that is the part they can still
// act on. The appointment list is the point of the whole message — a count
// tells a lab how busy tomorrow is, the list tells them what to staff.
export const DEFAULT_PROVIDER_DAILY_DIGEST_BODY = `*Daily summary — {{lab_name}}*
{{digest_date}}

*Today*
Orders: {{today_total}} ({{today_home}} home, {{today_centre}} centre)
Collected: {{today_collected}}
Still to collect: {{today_pending}}
Reports pending: {{today_reports_pending}}
Awaiting your confirmation: {{today_unconfirmed}}

*Tomorrow — {{tomorrow_date}}*
Orders: {{tomorrow_total}} ({{tomorrow_home}} home, {{tomorrow_centre}} centre)
First appointment: {{tomorrow_first}}
Awaiting your confirmation: {{tomorrow_unconfirmed}}

{{tomorrow_schedule}}

Please reply here if anything on tomorrow's list cannot be covered.`;

export const TEMPLATE_DEFAULTS: Record<string, { name: string; body: string }> = {
  [NON_API_NEW_ORDER_TEMPLATE]: { name: "Non-API lab: new order", body: DEFAULT_NON_API_NEW_ORDER_BODY },
  [NON_API_REMINDER_TEMPLATE]: { name: "Non-API lab: reminder", body: DEFAULT_NON_API_REMINDER_BODY },
  [NON_API_ESCALATION_TEMPLATE]: { name: "Non-API lab: escalation (manager)", body: DEFAULT_NON_API_ESCALATION_BODY },
  [NON_API_APPOINTMENT_TEMPLATE]: { name: "Non-API lab: appointment reminder", body: DEFAULT_NON_API_APPOINTMENT_BODY },
  [NON_API_ACCEPTED_TEMPLATE]: { name: "Non-API lab: order confirmed", body: DEFAULT_NON_API_ACCEPTED_BODY },
  [NON_API_RESCHEDULE_ASK_TEMPLATE]: { name: "Non-API lab: reschedule — ask for a time", body: DEFAULT_NON_API_RESCHEDULE_ASK_BODY },
  [NON_API_REJECT_ASK_TEMPLATE]: { name: "Non-API lab: cannot fulfil — ask for a reason", body: DEFAULT_NON_API_REJECT_ASK_BODY },
  [PROVIDER_SLA_BREACH_TEMPLATE]: { name: "Any lab: SLA breached", body: DEFAULT_PROVIDER_SLA_BREACH_BODY },
  [SLA_MILESTONE_BREACH_TEMPLATE]: { name: "Any lab: milestone SLA missed", body: DEFAULT_SLA_MILESTONE_BREACH_BODY },
  [PROVIDER_DAILY_DIGEST_TEMPLATE]: { name: "Any lab: daily summary (today & tomorrow)", body: DEFAULT_PROVIDER_DAILY_DIGEST_BODY },
};

export type NonApiTemplateKey = string;

export async function ensureTemplate(key: NonApiTemplateKey) {
  const fallback = TEMPLATE_DEFAULTS[key];
  if (!fallback) {
    const existing = await prisma.labCommunicationTemplate.findUnique({ where: { key } });
    if (!existing) throw new Error(`Template ${key} was not found`);
    return existing;
  }
  return prisma.labCommunicationTemplate.upsert({
    where: { key },
    create: { key, name: fallback.name, body: fallback.body },
    update: {},
  });
}

export async function ensureNonApiTemplates() {
  return Promise.all((Object.keys(TEMPLATE_DEFAULTS) as NonApiTemplateKey[]).map(ensureTemplate));
}

export function isNonApiTemplateKey(value: unknown): value is NonApiTemplateKey {
  return typeof value === "string" && (value in TEMPLATE_DEFAULTS || /^NON_API_CUSTOM_[A-Z0-9_]+$/.test(value));
}

/**
 * Strict, deliberately small mustache-style renderer. Templates are plain
 * WhatsApp text; missing data is an operational error, never an empty field.
 */
export function renderLabTemplate(body: string, variables: TemplateVariables): string {
  return body.replace(/{{\s*([a-z_]+)\s*}}/g, (_match, key: string) => {
    const value = variables[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Template variable {{${key}}} is missing`);
    }
    return value;
  });
}

type TemplateRules = { allowed: readonly string[]; required: readonly string[] };

const CONFIRMATION_RULES: TemplateRules = {
  allowed: NON_API_NEW_ORDER_VARIABLES,
  required: ["order_id", "patient_name", "appointment_date", "appointment_time", ...ACTION_URL_VARIABLES],
};

/**
 * Each template kind has its own contract. The escalation template is the one
 * addressed to a human manager, so it alone may use {{manager_name}}. The
 * appointment reminder rides the appointment clock and doesn't quote an SLA
 * deadline, so it isn't held to the confirmation template's required set.
 */
const TEMPLATE_RULES: Record<string, TemplateRules> = {
  [NON_API_NEW_ORDER_TEMPLATE]: CONFIRMATION_RULES,
  [NON_API_REMINDER_TEMPLATE]: CONFIRMATION_RULES,
  [NON_API_ESCALATION_TEMPLATE]: {
    allowed: [...NON_API_NEW_ORDER_VARIABLES, "manager_name"],
    required: ["order_id", "patient_name", "appointment_time", ...ACTION_URL_VARIABLES],
  },
  [NON_API_APPOINTMENT_TEMPLATE]: {
    allowed: NON_API_NEW_ORDER_VARIABLES,
    required: ["order_id", "patient_name", "appointment_time"],
  },
  // The breach template is the one message an API lab receives, so its allowed
  // set excludes the action links entirely rather than merely not requiring
  // them: a body that referenced {{accept_url}} would render fine for a
  // NON_API lab and throw for every API lab, which is exactly the kind of
  // half-broken template the save-time contract exists to prevent.
  [PROVIDER_SLA_BREACH_TEMPLATE]: {
    allowed: [...ORDER_VARIABLES, ...BREACH_VARIABLES],
    required: ["order_id", "breach_minutes"],
  },
  // No action links in the allowed set — an API lab has no workflow to mint
  // them against, and this message is sent to every lab type.
  [SLA_MILESTONE_BREACH_TEMPLATE]: {
    allowed: [...ORDER_VARIABLES, ...SLA_MILESTONE_VARIABLES],
    required: ["order_id", "sla_milestone", "sla_overdue_by"],
  },
  // Only the two totals are mandatory. Everything else is a matter of how much
  // detail a given provider wants in their evening message, and forcing the
  // full set would stop anyone trimming it to two lines.
  [PROVIDER_DAILY_DIGEST_TEMPLATE]: {
    allowed: DIGEST_VARIABLES,
    required: ["today_total", "tomorrow_total"],
  },
};

// Operator-authored templates get the full vocabulary and only the order
// reference is mandatory — they are opt-in and chosen per lab.
const CUSTOM_TEMPLATE_RULES: TemplateRules = {
  allowed: [...NON_API_NEW_ORDER_VARIABLES, "manager_name"],
  required: ["order_id"],
};

function validateAgainst(body: unknown, rules: TemplateRules): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof body !== "string" || !body.trim()) return { ok: false, error: "Template body is required" };
  const normalized = body.trim();
  if (normalized.length > 4000) return { ok: false, error: "Template body must be 4,000 characters or fewer" };
  const variables = [...normalized.matchAll(/{{\s*([a-z_]+)\s*}}/g)].map((match) => match[1]);
  const unknown = variables.find((variable) => !rules.allowed.includes(variable));
  if (unknown) return { ok: false, error: `Unknown template variable: {{${unknown}}}` };
  const missing = rules.required.find((variable) => !variables.includes(variable));
  if (missing) return { ok: false, error: `Template must include {{${missing}}}` };
  return { ok: true, body: normalized };
}

/**
 * Contract for a BRAND NEW operator-authored template — same loose contract
 * `validateNonApiTemplateBody` falls back to for any NON_API_CUSTOM_* key
 * once it exists. Creation must validate against the same rules the
 * template will live under afterward: the confirmation-ladder contract
 * (order_id, patient_name, appointment_date/time, and all three action
 * links) was being used here instead, which meant you could only ever
 * create a full confirmation message and never a plain reminder or note —
 * the "+ New message" action would reject anything without
 * {{accept_url}}/{{reschedule_url}}/{{reject_url}}, contracts a template
 * would stop being held to the moment it was saved.
 */
export function validateCustomTemplateBody(body: unknown) {
  return validateAgainst(body, CUSTOM_TEMPLATE_RULES);
}

export function validateNonApiTemplateBody(key: string, body: unknown) {
  return validateAgainst(body, TEMPLATE_RULES[key] ?? CUSTOM_TEMPLATE_RULES);
}

/** The variables an editor should offer for a given template key. */
export function allowedVariablesFor(key: string): readonly string[] {
  return (TEMPLATE_RULES[key] ?? CUSTOM_TEMPLATE_RULES).allowed;
}

/**
 * The variables a given template MUST include to save.
 *
 * Exported for the same reason as `allowedVariablesFor`: the editor should be
 * able to say "this message still needs the accept link" while you are
 * writing it, rather than letting the save round-trip fail with
 * `Template must include {{accept_url}}` after the fact.
 */
export function requiredVariablesFor(key: string): readonly string[] {
  return (TEMPLATE_RULES[key] ?? CUSTOM_TEMPLATE_RULES).required;
}
