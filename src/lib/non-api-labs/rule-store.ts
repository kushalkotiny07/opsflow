/**
 * The one place a stored provider communication rule becomes the pure
 * `CommunicationRule` the engine reasons about.
 *
 * Scope and conditions are JSONB columns, so every read has to survive rows
 * written by an older shape (or by hand). Coercing here — once — means
 * planRuleActions and evaluateSendCondition can take their inputs at face
 * value, and a malformed row degrades to "unscoped, no extra gates" instead of
 * throwing inside a scheduler tick.
 */

import prisma from "@/lib/db/client";
import type { CommunicationRule, ProviderRuleRecipient, SendCondition } from "./rules";

type RuleRow = {
  id: string;
  name: string;
  isActive: boolean;
  anchor: string;
  action: string;
  offsetMinutes: number;
  priority: number;
  templateKey: string;
  recipient: string;
  allowedLabIds: unknown;
  allowedOrderTypes: unknown;
  sendCondition: unknown;
};

function asNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function asPositiveInt(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function toSendCondition(value: unknown): SendCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const condition: SendCondition = {};

  const workflowStatusIn = asStrings(raw.workflowStatusIn);
  if (workflowStatusIn.length) condition.workflowStatusIn = workflowStatusIn;

  const sourceStatusIn = asStrings(raw.sourceStatusIn);
  if (sourceStatusIn.length) condition.sourceStatusIn = sourceStatusIn;

  if (raw.requireAppointment === true) condition.requireAppointment = true;

  const skipWithin = asPositiveInt(raw.skipWithinMinutesOfAppointment);
  if (skipWithin !== undefined) condition.skipWithinMinutesOfAppointment = skipWithin;

  const minGap = asPositiveInt(raw.minMinutesSinceLastMessage);
  if (minGap !== undefined) condition.minMinutesSinceLastMessage = minGap;

  const window = raw.sendWindow;
  if (window && typeof window === "object" && !Array.isArray(window)) {
    const startHour = asPositiveInt((window as Record<string, unknown>).startHour);
    const endHour = asPositiveInt((window as Record<string, unknown>).endHour);
    // A window that does not open before it closes is dropped rather than
    // guessed at — the API rejects it on save, so a row like this is hand-made.
    if (startHour !== undefined && endHour !== undefined && startHour < endHour && endHour <= 24) {
      condition.sendWindow = { startHour, endHour };
    }
  }

  return condition;
}

export function toCommunicationRule(row: RuleRow): CommunicationRule {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    anchor: row.anchor === "APPOINTMENT" ? "APPOINTMENT" : "ORDER",
    action: row.action === "ESCALATE" ? "ESCALATE" : "SEND_REMINDER",
    recipient: (row.recipient === "MANAGER" ? "MANAGER" : "LAB") satisfies ProviderRuleRecipient,
    templateKey: row.templateKey,
    offsetMinutes: row.offsetMinutes,
    priority: row.priority,
    allowedLabIds: asNumbers(row.allowedLabIds),
    allowedOrderTypes: asStrings(row.allowedOrderTypes),
    sendCondition: toSendCondition(row.sendCondition),
  };
}

/**
 * Soonest offset first, so a plan reads in the order the provider sees it.
 *
 * SLA_BREACH steps are excluded, and that exclusion is load-bearing rather
 * than cosmetic. workflow.ts decides the whole plan with
 *   `scopedRules.length > 0 ? ruleActions : buildLadder(...)`
 * so any rule this function returns replaces the provider's entire built-in
 * ladder. A breach step is a conditional watcher, not a sequence step — if it
 * appeared here, adding one would silently delete every timed step the
 * provider had. The breach engine loads them separately.
 */
export async function loadActiveCommunicationRules(): Promise<CommunicationRule[]> {
  const rows = await prisma.providerCommunicationRule.findMany({
    where: { isActive: true, triggerKind: "RELATIVE_DELAY" },
    orderBy: [{ anchor: "asc" }, { offsetMinutes: "asc" }, { priority: "asc" }],
  });
  return rows.map(toCommunicationRule);
}

export async function loadCommunicationRule(id: string): Promise<CommunicationRule | null> {
  const row = await prisma.providerCommunicationRule.findUnique({ where: { id } });
  return row ? toCommunicationRule(row) : null;
}
