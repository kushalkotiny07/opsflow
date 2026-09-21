/**
 * Task-title template renderer.
 *
 * Rules use the `{{key}}` syntax in `task_rules.titleTemplate`. Today the
 * supported keys are `patientName` and `orderId`; we keep the door open
 * for new keys without forcing every call site to remember them.
 *
 * Two important design properties:
 *
 *   1. **No literal `{{...}}` in the output.** If a template references a
 *      placeholder we don't know about (e.g. typo, or a future placeholder
 *      that wasn't backfilled into the renderer), we substitute a visible
 *      `[missing: key]` marker instead of leaving the brace literal.
 *      Surfacing it makes the next bug cheap to spot — the previous
 *      behaviour silently rendered `{{patientName}}` to end users.
 *
 *   2. **Global match, not first-match.** The earlier inline implementation
 *      used `String.prototype.replace(string, ...)` which only swaps the
 *      first occurrence. Templates that repeat a token would silently leave
 *      later occurrences unrendered. We use a `RegExp(..., "g")` here.
 */

import { formatISTShort, titleToIST } from "@/lib/utils/timezone";

export interface TitleContext {
  patientName?: string | null;
  orderId?: number | string | null;
  storeName?: string | null;
  labName?: string | null;
  phleboName?: string | null;
  appointmentTime?: string | Date | null;
  // Free-form for future additions — render via `${value}`.
  [key: string]: unknown;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Render a `{{...}}`-style template against the provided context.
 * Returns a string that contains no literal `{{...}}` placeholders.
 */
export function renderTitleTemplate(
  template: string,
  ctx: TitleContext
): string {
  return template.replace(PLACEHOLDER, (_full, key: string) => {
    const value = ctx[key];
    if (value === null || value === undefined || value === "") {
      // Special-case the well-known fallbacks the legacy code expected.
      // Keeps existing rule behaviour identical for blank-but-defined fields.
      if (key === "patientName") return "Patient";
      if (key === "orderId") return ctx.orderId != null ? String(ctx.orderId) : "[missing: orderId]";
      if (key === "storeName" || key === "labName" || key === "phleboName") return "";
      return `[missing: ${key}]`;
    }
    // Dates render as compact IST (DD-MM-YYYY HH:MM) — task titles are read by
    // humans in IST, not as raw UTC ISO. Also catch ISO-string values (e.g. a
    // metadata field carried through as a string) via titleToIST below.
    if (value instanceof Date) return formatISTShort(value);
    return titleToIST(String(value));
  });
}

/**
 * Quick check used by tests + a future migration script: returns true iff
 * the rendered string still contains a `{{...}}` placeholder. Should always
 * be false for output of `renderTitleTemplate`.
 */
export function hasUnresolvedPlaceholders(s: string): boolean {
  return PLACEHOLDER.test(s);
}
