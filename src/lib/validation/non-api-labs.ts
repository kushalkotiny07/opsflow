const PHONE_DIGITS = /^\d{8,15}$/;
// WhatsApp group jid: "<digits>@g.us", or the legacy "<creator>-<created>@g.us".
const GROUP_JID = /^\d+(-\d+)?@g\.us$/i;
const MAX_SLA_MINUTES = 7 * 24 * 60;

export type NonApiLabConfigInput = {
  labId?: unknown;
  labName?: unknown;
  integrationType?: unknown;
  waGroupJid?: unknown;
  whatsappNumber?: unknown;
  managerName?: unknown;
  managerWhatsapp?: unknown;
  isActive?: unknown;
  confirmationSlaMinutes?: unknown;
  reminderSlaMinutes?: unknown;
  escalationSlaMinutes?: unknown;
  initialTemplateKey?: unknown;
  reminderTemplateKey?: unknown;
  escalationTemplateKey?: unknown;
  appointmentTemplateKey?: unknown;
  appointmentRemindersEnabled?: unknown;
  quietWindowMinutes?: unknown;
  slaBreachAlertsEnabled?: unknown;
  slaBreachTemplateKey?: unknown;
  slaBreachMaxPerOrder?: unknown;
  dailyDigestEnabled?: unknown;
  dailyDigestHour?: unknown;
  dailyDigestMinute?: unknown;
  dailyDigestTemplateKey?: unknown;
  dailyDigestSkipWhenEmpty?: unknown;
};

export type ValidatedNonApiLabConfig = {
  labId: number;
  labName: string;
  integrationType: "API" | "NON_API";
  waGroupJid: string | null;
  whatsappNumber: string | null;
  managerName: string | null;
  managerWhatsapp: string | null;
  isActive: boolean;
  confirmationSlaMinutes: number;
  reminderSlaMinutes: number;
  escalationSlaMinutes: number;
  initialTemplateKey: string;
  reminderTemplateKey: string;
  escalationTemplateKey: string;
  appointmentTemplateKey: string;
  appointmentRemindersEnabled: boolean;
  quietWindowMinutes: number;
  slaBreachAlertsEnabled: boolean;
  slaBreachTemplateKey: string;
  slaBreachMaxPerOrder: number;
  dailyDigestEnabled: boolean;
  dailyDigestHour: number;
  dailyDigestMinute: number;
  dailyDigestTemplateKey: string;
  dailyDigestSkipWhenEmpty: boolean;
};

function optionalText(value: unknown, field: string, errors: Record<string, string>): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    errors[field] = "must be text";
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > 160) {
    errors[field] = "must be 160 characters or fewer";
    return null;
  }
  return trimmed || null;
}

function normalizePhone(value: unknown, field: string, errors: Record<string, string>): string | null {
  const text = optionalText(value, field, errors);
  if (text === null) return null;
  const digits = text.replace(/\D/g, "");
  if (!PHONE_DIGITS.test(digits)) {
    errors[field] = "must include an 8–15 digit phone number with country code";
    return null;
  }
  return `+${digits}`;
}

function normalizeGroupJid(value: unknown, field: string, errors: Record<string, string>): string | null {
  const text = optionalText(value, field, errors);
  if (text === null) return null;
  const trimmed = text.trim();
  if (!GROUP_JID.test(trimmed)) {
    errors[field] = 'must be a WhatsApp group id like "120363000000000000@g.us"';
    return null;
  }
  return trimmed.toLowerCase();
}

function positiveInt(value: unknown, field: string, errors: Record<string, string>): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_SLA_MINUTES) {
    errors[field] = `must be a whole number between 1 and ${MAX_SLA_MINUTES}`;
    return null;
  }
  return number;
}

/** Validate the config owned by OpsFlow; LabStack's Lab record remains read-only. */
export function validateNonApiLabConfig(input: NonApiLabConfigInput):
  | { ok: true; data: ValidatedNonApiLabConfig }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  // NOT positiveInt(): that helper caps at MAX_SLA_MINUTES (10080), which is a
  // bound on minutes and has nothing to do with a LabStack lab id. It made any
  // lab numbered above 10080 impossible to configure, reporting the confusing
  // "must be a whole number between 1 and 10080" against labId.
  const labIdNumber = typeof input.labId === "number" ? input.labId : Number(input.labId);
  const labId = Number.isInteger(labIdNumber) && labIdNumber >= 1 ? labIdNumber : null;
  if (labId === null) errors.labId = "must be a positive whole number (the LabStack lab id)";
  const labName = typeof input.labName === "string" ? input.labName.trim() : "";
  if (!labName || labName.length > 160) errors.labName = "must be between 1 and 160 characters";

  const integrationType = input.integrationType ?? "NON_API";
  if (integrationType !== "API" && integrationType !== "NON_API") {
    errors.integrationType = "must be API or NON_API";
  }
  if (typeof input.isActive !== "undefined" && typeof input.isActive !== "boolean") {
    errors.isActive = "must be true or false";
  }
  const isActive = typeof input.isActive === "boolean" ? input.isActive : true;

  const waGroupJid = normalizeGroupJid(input.waGroupJid, "waGroupJid", errors);
  const whatsappNumber = normalizePhone(input.whatsappNumber, "whatsappNumber", errors);
  // A lab OpsFlow cannot address is a config that silently never sends: every
  // path skips it and nothing says why. This used to be asked of NON_API labs
  // only, because they were the only ones that got messages. API labs now
  // receive SLA breach alerts, so they need a target too — an API row with no
  // group and no number is the same silent dead end it always was.
  if (!waGroupJid && !whatsappNumber && !errors.waGroupJid && !errors.whatsappNumber) {
    errors.waGroupJid = "provide a WhatsApp group id or a WhatsApp number";
  }
  const managerName = optionalText(input.managerName, "managerName", errors);
  const managerWhatsapp = normalizePhone(input.managerWhatsapp, "managerWhatsapp", errors);
  const confirmationSlaMinutes = positiveInt(input.confirmationSlaMinutes ?? 60, "confirmationSlaMinutes", errors);
  const reminderSlaMinutes = positiveInt(input.reminderSlaMinutes ?? 180, "reminderSlaMinutes", errors);
  const escalationSlaMinutes = positiveInt(input.escalationSlaMinutes ?? 300, "escalationSlaMinutes", errors);
  const templateKeys = ["initialTemplateKey", "reminderTemplateKey", "escalationTemplateKey", "appointmentTemplateKey"] as const;
  for (const field of templateKeys) {
    if (input[field] !== undefined && (typeof input[field] !== "string" || !input[field].trim())) errors[field] = "must be a template key";
  }

  if (typeof input.appointmentRemindersEnabled !== "undefined" && typeof input.appointmentRemindersEnabled !== "boolean") {
    errors.appointmentRemindersEnabled = "must be true or false";
  }
  const appointmentRemindersEnabled =
    typeof input.appointmentRemindersEnabled === "boolean" ? input.appointmentRemindersEnabled : true;

  if (typeof input.slaBreachAlertsEnabled !== "undefined" && typeof input.slaBreachAlertsEnabled !== "boolean") {
    errors.slaBreachAlertsEnabled = "must be true or false";
  }
  const slaBreachAlertsEnabled =
    typeof input.slaBreachAlertsEnabled === "boolean" ? input.slaBreachAlertsEnabled : true;
  if (input.slaBreachTemplateKey !== undefined && (typeof input.slaBreachTemplateKey !== "string" || !input.slaBreachTemplateKey.trim())) {
    errors.slaBreachTemplateKey = "must be a template key";
  }
  // 1 is the floor: 0 would disable breach alerts through the back door while
  // slaBreachAlertsEnabled still read as true, which is the kind of config
  // that looks switched on and sends nothing.
  const rawBreachCap = input.slaBreachMaxPerOrder ?? 2;
  const breachCapNumber = typeof rawBreachCap === "number" ? rawBreachCap : Number(rawBreachCap);
  if (!Number.isInteger(breachCapNumber) || breachCapNumber < 1 || breachCapNumber > 20) {
    errors.slaBreachMaxPerOrder = "must be a whole number between 1 and 20";
  }

  // ── Daily digest ───────────────────────────────────────────────────────
  for (const field of ["dailyDigestEnabled", "dailyDigestSkipWhenEmpty"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") errors[field] = "must be true or false";
  }
  const dailyDigestEnabled = typeof input.dailyDigestEnabled === "boolean" ? input.dailyDigestEnabled : false;
  const dailyDigestSkipWhenEmpty =
    typeof input.dailyDigestSkipWhenEmpty === "boolean" ? input.dailyDigestSkipWhenEmpty : true;

  // A wall-clock time, not a duration: 0 is midnight, and every hour of the
  // day is a legitimate choice, so neither of these can reuse positiveInt.
  const rawHour = input.dailyDigestHour ?? 19;
  const digestHour = typeof rawHour === "number" ? rawHour : Number(rawHour);
  if (!Number.isInteger(digestHour) || digestHour < 0 || digestHour > 23) {
    errors.dailyDigestHour = "must be an hour between 0 and 23";
  }
  const rawMinute = input.dailyDigestMinute ?? 0;
  const digestMinute = typeof rawMinute === "number" ? rawMinute : Number(rawMinute);
  if (!Number.isInteger(digestMinute) || digestMinute < 0 || digestMinute > 59) {
    errors.dailyDigestMinute = "must be a minute between 0 and 59";
  }
  if (input.dailyDigestTemplateKey !== undefined && (typeof input.dailyDigestTemplateKey !== "string" || !input.dailyDigestTemplateKey.trim())) {
    errors.dailyDigestTemplateKey = "must be a template key";
  }

  // 0 is a legitimate value here — it means "no quiet window" — so this can't
  // reuse positiveInt.
  const rawQuietWindow = input.quietWindowMinutes ?? 10;
  const quietWindowNumber = typeof rawQuietWindow === "number" ? rawQuietWindow : Number(rawQuietWindow);
  if (!Number.isInteger(quietWindowNumber) || quietWindowNumber < 0 || quietWindowNumber > 240) {
    errors.quietWindowMinutes = "must be a whole number of minutes between 0 and 240";
  }

  if (
    confirmationSlaMinutes !== null && reminderSlaMinutes !== null && escalationSlaMinutes !== null &&
    !(confirmationSlaMinutes < reminderSlaMinutes && reminderSlaMinutes < escalationSlaMinutes)
  ) {
    errors.sla = "confirmation, reminder, and escalation SLAs must be in ascending order";
  }
  if (Object.keys(errors).length || labId === null || !labName || confirmationSlaMinutes === null || reminderSlaMinutes === null || escalationSlaMinutes === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      labId,
      labName,
      integrationType: integrationType as "API" | "NON_API",
      waGroupJid,
      whatsappNumber,
      managerName,
      managerWhatsapp,
      isActive,
      confirmationSlaMinutes,
      reminderSlaMinutes,
      escalationSlaMinutes,
      initialTemplateKey: typeof input.initialTemplateKey === "string" && input.initialTemplateKey.trim() ? input.initialTemplateKey.trim() : "NON_API_NEW_ORDER",
      reminderTemplateKey: typeof input.reminderTemplateKey === "string" && input.reminderTemplateKey.trim() ? input.reminderTemplateKey.trim() : "NON_API_REMINDER",
      escalationTemplateKey: typeof input.escalationTemplateKey === "string" && input.escalationTemplateKey.trim() ? input.escalationTemplateKey.trim() : "NON_API_ESCALATION",
      appointmentTemplateKey: typeof input.appointmentTemplateKey === "string" && input.appointmentTemplateKey.trim() ? input.appointmentTemplateKey.trim() : "NON_API_APPOINTMENT_REMINDER",
      appointmentRemindersEnabled,
      quietWindowMinutes: quietWindowNumber,
      slaBreachAlertsEnabled,
      slaBreachTemplateKey:
        typeof input.slaBreachTemplateKey === "string" && input.slaBreachTemplateKey.trim()
          ? input.slaBreachTemplateKey.trim()
          : "PROVIDER_SLA_BREACH",
      slaBreachMaxPerOrder: breachCapNumber,
      dailyDigestEnabled,
      dailyDigestHour: digestHour,
      dailyDigestMinute: digestMinute,
      dailyDigestTemplateKey:
        typeof input.dailyDigestTemplateKey === "string" && input.dailyDigestTemplateKey.trim()
          ? input.dailyDigestTemplateKey.trim()
          : "PROVIDER_DAILY_DIGEST",
      dailyDigestSkipWhenEmpty,
    },
  };
}
