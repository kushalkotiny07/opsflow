/**
 * Where a provider message is addressed, and how it stays guarded.
 *
 * Two shapes of target:
 *
 *   GROUP — `config.waGroupJid`, a WhatsApp group ("…@g.us"). Preferred: a
 *           reply lands in front of the provider's whole desk instead of one
 *           person's chat.
 *   DM    — `config.whatsappNumber`, a single handset.
 *
 * This module exists because addressing used to be one line, duplicated in
 * scheduler.ts and workflow.ts:
 *
 *     `${number.replace(/\D/g, "")}@s.whatsapp.net`
 *
 * which cannot express a group at all — stripping non-digits turns
 * "120363000000000000@g.us" into a nonsense DM address that WhatsApp would
 * either reject or, worse, deliver to whatever handset those digits happen to
 * name. Group jids also carry "-" in the legacy `<creator>-<created>@g.us`
 * form, which the same strip destroys.
 *
 * ── The guard ────────────────────────────────────────────────────────────
 * The gateway's drain (whatsapp-bot/lib/controltower.mjs) refuses to send an
 * outbound row whose `groupId` points at a group with `sendEnabled = false`.
 * That guard is the only thing standing between an automation bug and a real
 * provider group, so a group send MUST carry `groupId` — a bare jid with a
 * null groupId would slip straight past it.
 *
 * So an unknown group jid is registered here as a wa_groups row with
 * `sendEnabled = false`: messages queue, the drain fails them with "sending
 * disabled for group …", and nothing reaches WhatsApp until a human turns
 * sending on for that group in the console. Safe by default, and visible —
 * rather than either silently dropping the message or silently sending it.
 */
import prisma from "@/lib/db/client";

export type LabTargetKind = "GROUP" | "DM";

export interface LabTarget {
  kind: LabTargetKind;
  /** Address the gateway sends to: a group jid, or `<digits>@s.whatsapp.net`. */
  targetJid: string;
  /** wa_groups row id for GROUP targets — required for the sendEnabled guard. */
  groupId: string | null;
  /** True when the group exists but sending has not been enabled for it yet. */
  sendBlocked: boolean;
}

/** Minimal shape needed to address a lab — accepts a full NonApiLabConfig. */
export interface AddressableLabConfig {
  labId: number;
  labName: string;
  waGroupJid?: string | null;
  whatsappNumber?: string | null;
}

const GROUP_JID = /^[0-9]+(-[0-9]+)?@g\.us$/i;

/** Does this string already name a WhatsApp group? */
export function isGroupJid(value: string | null | undefined): boolean {
  return typeof value === "string" && GROUP_JID.test(value.trim());
}

/** A lab is addressable when it has either a group or a number. */
export function hasWhatsAppTarget(config: AddressableLabConfig): boolean {
  return isGroupJid(config.waGroupJid) || !!config.whatsappNumber;
}

/** `+91 98765 43210` → `919876543210@s.whatsapp.net`. */
export function toDirectJid(number: string): string {
  return `${number.replace(/\D/g, "")}@s.whatsapp.net`;
}

/**
 * Resolve the address for one message.
 *
 * `override` is the manager/rule-specified recipient when there is one; it is
 * treated as a handset, since a manager is a person. Falls through to the
 * lab's own target when absent — an escalation with nobody above the inbox on
 * file still has to go somewhere.
 */
export async function resolveLabTarget(
  config: AddressableLabConfig,
  override?: string | null,
): Promise<LabTarget> {
  if (override && !isGroupJid(override)) {
    return { kind: "DM", targetJid: toDirectJid(override), groupId: null, sendBlocked: false };
  }

  const groupJid = (override && isGroupJid(override) ? override : config.waGroupJid)?.trim();

  if (isGroupJid(groupJid)) {
    const jid = groupJid!;
    // Registered disabled on first sight — see "The guard" above.
    const group = await prisma.waGroup.upsert({
      where: { jid },
      update: {},
      create: {
        jid,
        subject: `${config.labName} (provider)`,
        role: "PROVIDER",
        labId: config.labId,
        sendEnabled: false,
        active: true,
      },
      select: { id: true, sendEnabled: true },
    });
    return { kind: "GROUP", targetJid: jid, groupId: group.id, sendBlocked: !group.sendEnabled };
  }

  if (config.whatsappNumber) {
    return { kind: "DM", targetJid: toDirectJid(config.whatsappNumber), groupId: null, sendBlocked: false };
  }

  throw new Error(`Lab ${config.labId} has neither waGroupJid nor whatsappNumber configured`);
}
