/**
 * Timezone utility functions
 *
 * Labstack stores timestamps as naive UTC in TIMESTAMP WITHOUT TIME ZONE
 * columns (see src/lib/engine/labstack.ts for the empirical verification).
 * pg reads naive timestamps as UTC by default, so plain SELECTs return JS
 * Date objects pointing at the correct UTC instant — no SQL-side cast
 * needed.
 *
 * These helpers render that UTC Date in IST for display using the IANA
 * timezone identifier "Asia/Kolkata" (UTC+5:30). No manual offset
 * arithmetic is needed — the Intl API handles DST-safety and correct
 * offset application.
 *
 * ⚠️  Two historical band-aids that must NOT come back:
 *   1. Subtracting IST_OFFSET_MS from the UTC value before toLocaleString
 *      — was a workaround for an earlier (mistaken) assumption that
 *      labstack stored naive IST.
 *   2. Wrapping reads with `AT TIME ZONE 'Asia/Kolkata'` — same mistake
 *      at the SQL layer; double-shifts the timestamp 5h30 backwards and
 *      every appointment renders 5h30 too early.
 * If a future labstack table genuinely stores naive IST, cast THAT
 * column locally — never blanket-cast at the fetcher level.
 */

/**
 * Format a UTC timestamp string for display in IST (Asia/Kolkata).
 *
 * @param timestampString - any ISO 8601 / Date-parseable string (UTC)
 * @param options         - Intl.DateTimeFormatOptions (timeZone is forced to "Asia/Kolkata")
 * @returns formatted string, e.g. "23 May, 06:00 pm"
 */
export function formatISTTimestamp(
  timestampString: string,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }
): string {
  const date = new Date(timestampString);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", { ...options, timeZone: "Asia/Kolkata" });
}

/**
 * Format just the date portion of a UTC timestamp in IST.
 */
export function formatISTDate(
  timestampString: string,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  }
): string {
  const date = new Date(timestampString);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { ...options, timeZone: "Asia/Kolkata" });
}

/**
 * Format just the time portion of a UTC timestamp in IST.
 */
export function formatISTTime(
  timestampString: string,
  options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  }
): string {
  const date = new Date(timestampString);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-IN", { ...options, timeZone: "Asia/Kolkata" });
}

/**
 * Compact IST stamp: "DD-MM-YYYY HH:MM" (24h, Asia/Kolkata). Used inside task
 * titles so appointment date/times read as local wall-clock instead of a raw
 * UTC ISO string. Returns "" for an unparseable input.
 */
export function formatISTShort(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")} ${get("hour")}:${get("minute")}`;
}

// Any ISO-8601 UTC timestamp embedded in text (e.g. baked into a task title).
const ISO_UTC_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z/g;

/**
 * Rewrite any embedded ISO-8601 UTC timestamps in a string to compact IST
 * (DD-MM-YYYY HH:MM). Idempotent for already-formatted titles (no ISO to
 * match). Used at display time so tasks whose title baked a UTC ISO stamp read
 * in local time without a data backfill.
 */
export function titleToIST(text: string | null | undefined): string {
  if (!text) return text ?? "";
  return text.replace(ISO_UTC_RE, (m) => formatISTShort(m) || m);
}
