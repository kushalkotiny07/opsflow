/**
 * Editable polls — the question, the options, and each option's reply.
 *
 * Any message that wants a poll names a definition by key; this resolves it and
 * hands back the shape wa_outbound expects. Nothing downstream knows what the
 * options are: the gateway copies them onto the wa_polls row, and when a vote
 * comes back the reply is read from that copy. Adding a new kind of poll is
 * therefore a row in this table, not a deploy.
 *
 * Definitions are seeded on first use, the same way message templates are, so a
 * fresh database is usable without a manual step — and an Ops edit is never
 * overwritten afterwards.
 */
import prisma from "@/lib/db/client";
import { PROVIDER_POLL_NAME, PROVIDER_POLL_OPTIONS } from "./poll-config";

/** Where a poll is used. Keys are stable; the contents are Ops's to change. */
export const ORDER_CONFIRMATION_POLL = "ORDER_CONFIRMATION";
export const SLA_BREACH_POLL = "SLA_BREACH";

export type PollOption = {
  /** What the provider taps. Votes come back as this text, so it is the key. */
  label: string;
  /**
   * The workflow effect, if any. NULL means the answer is informational —
   * an SLA breach has no confirmation workflow to move.
   */
  action: "ACCEPT" | "RESCHEDULE" | "REJECT" | null;
  /** Reply sent when this option is chosen. Supports the usual {{variables}}. */
  ack: string;
};

export type ResolvedPoll = { question: string; options: PollOption[] };

const SEEDS: Record<string, { name: string; question: string; options: PollOption[] }> = {
  [ORDER_CONFIRMATION_POLL]: {
    name: "Order confirmation",
    question: PROVIDER_POLL_NAME,
    options: [
      {
        label: PROVIDER_POLL_OPTIONS[0].label,
        action: "ACCEPT",
        // Repeats the order back: the provider tapped a button on a message
        // that may be well up their chat, so a bare "confirmed" leaves them
        // unsure which order they just committed to.
        ack: `*Order confirmed — thank you.*

Order ID: {{order_id}}
Patient: {{patient_name}}
Appointment: {{appointment_date}} at {{appointment_time}}
Location: {{location}}
Tests: {{tests}}

We have marked this order as accepted. No further confirmation is needed.`,
      },
      {
        label: PROVIDER_POLL_OPTIONS[1].label,
        action: "RESCHEDULE",
        ack: `Noted — reschedule requested for order {{order_id}} ({{patient_name}}).

Please reply to this message with the date and time you can do instead, and we will update the order.`,
      },
      {
        label: PROVIDER_POLL_OPTIONS[2].label,
        action: "REJECT",
        ack: `Noted — order {{order_id}} ({{patient_name}}) marked as unable to fulfil.

Please reply to this message with the reason, so we can reassign it quickly.`,
      },
    ],
  },

  // A breach has no workflow to move, so every action is null: the value is
  // knowing what the provider says is happening, in their own words.
  [SLA_BREACH_POLL]: {
    name: "SLA breach — what is happening?",
    question: "This order has missed its deadline. What is the status?",
    options: [
      {
        label: "On the way",
        action: null,
        ack: `Thanks — noted that someone is on the way for order {{order_id}} ({{patient_name}}).

If it slips again, please reply here so we can tell the patient.`,
      },
      {
        label: "Already done",
        action: null,
        ack: `Thanks — you have marked order {{order_id}} as already done.

If the status in LabStack still looks wrong, reply here and we will correct it.`,
      },
      {
        label: "Delayed",
        action: null,
        ack: `Noted — order {{order_id}} ({{patient_name}}) is delayed.

Please reply with a realistic time so we can set the patient's expectation.`,
      },
      {
        label: "Cannot fulfil",
        action: "REJECT",
        ack: `Noted — order {{order_id}} cannot be fulfilled.

Please reply with the reason so we can reassign it.`,
      },
    ],
  },
};

function isPollOption(value: unknown): value is PollOption {
  if (!value || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  return typeof option.label === "string" && option.label.trim().length > 0
    && typeof option.ack === "string"
    && (option.action === null || option.action === undefined
      || ["ACCEPT", "RESCHEDULE", "REJECT"].includes(option.action as string));
}

/** Read the stored options defensively — this is user-edited JSON. */
export function parsePollOptions(raw: unknown): PollOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPollOption).map((option) => ({
    label: option.label.trim(),
    action: option.action ?? null,
    ack: option.ack,
  }));
}

export async function ensurePollDefinition(key: string) {
  const existing = await prisma.waPollDefinition.findUnique({ where: { key } });
  if (existing) return existing;

  const seed = SEEDS[key];
  if (!seed) throw new Error(`No poll definition for "${key}"`);
  // Concurrent ticks can race here; whoever loses just reads the winner's row.
  return prisma.waPollDefinition.upsert({
    where: { key },
    update: {},
    create: { key, name: seed.name, question: seed.question, options: seed.options },
  });
}

export async function seedPollDefinitions() {
  return Promise.all(Object.keys(SEEDS).map(ensurePollDefinition));
}

/**
 * The poll to attach to an outgoing message, or null to send plain text.
 *
 * Returns null when the definition is switched off or has fewer than two
 * usable options — WhatsApp cannot render a poll with one choice, and a
 * half-edited definition should degrade to a normal message rather than make
 * the send fail.
 */
export async function resolvePoll(key: string): Promise<ResolvedPoll | null> {
  const definition = await ensurePollDefinition(key).catch(() => null);
  if (!definition || !definition.isActive) return null;

  const options = parsePollOptions(definition.options);
  if (options.length < 2) return null;
  // WhatsApp caps a poll at 12 options.
  return { question: definition.question, options: options.slice(0, 12) };
}
