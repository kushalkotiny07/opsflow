/**
 * Message blocks — a structured *view* over a template's plain-text body.
 *
 * Templates are stored, validated and rendered as WhatsApp text with
 * `{{mustache}}` variables (see templates.ts). That is the right storage
 * format — it is exactly what the provider receives — but it is a poor
 * authoring format: the old editor was a bare textarea where you had to know
 * that `{{appointment_date}}` exists, spell it correctly, and remember which
 * variables a given template *requires* before the save would be accepted.
 *
 * So this module converts body ⇄ blocks, and the editor manipulates blocks.
 *
 * The conversion is deliberately line-based and total: every line maps to some
 * block, with `text` as the catch-all. Nothing is dropped, nothing is
 * reordered, and `toBody(fromBody(x)) === x` for any body the parser sees —
 * which is what lets the builder and the raw-text escape hatch coexist over
 * the same stored string without one silently rewriting the other's work.
 */

export type Block =
  /** `*Bold line*` — WhatsApp renders a single-asterisk pair as bold. */
  | { id: string; kind: "heading"; text: string }
  /** `Order ID: {{order_id}}` — a labelled value. */
  | { id: string; kind: "field"; label: string; variable: string }
  /** `Accept order: {{accept_url}}` — a labelled action link. */
  | { id: string; kind: "action"; label: string; variable: string }
  /** Any other line, including free prose with inline variables. */
  | { id: string; kind: "text"; text: string }
  /** A blank line. */
  | { id: string; kind: "spacer" };

export type BlockKind = Block["kind"];

let idCounter = 0;
/** Ids are for React keys and drag ordering only; they are never persisted. */
function nextId(): string {
  idCounter += 1;
  return `b${idCounter}`;
}

const HEADING = /^\*(.+)\*$/;
const LABELLED = /^([^:{}]{1,60}):\s*\{\{\s*([a-z_]+)\s*\}\}$/;

/** A labelled line whose variable is a link becomes an action, not a field. */
function isUrlVariable(variable: string): boolean {
  return variable.endsWith("_url");
}

/** Parse a stored body into blocks. Total: every line yields exactly one block. */
export function fromBody(body: string): Block[] {
  return body.split("\n").map((rawLine) => {
    const line = rawLine.trimEnd();
    if (line.trim() === "") return { id: nextId(), kind: "spacer" as const };

    const heading = HEADING.exec(line);
    if (heading) return { id: nextId(), kind: "heading" as const, text: heading[1] };

    const labelled = LABELLED.exec(line);
    if (labelled) {
      const [, label, variable] = labelled;
      return isUrlVariable(variable)
        ? { id: nextId(), kind: "action" as const, label: label.trim(), variable }
        : { id: nextId(), kind: "field" as const, label: label.trim(), variable };
    }

    return { id: nextId(), kind: "text" as const, text: line };
  });
}

/** Serialize blocks back to the stored body. Inverse of fromBody. */
export function toBody(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "heading": return `*${block.text}*`;
        case "field":
        case "action": return `${block.label}: {{${block.variable}}}`;
        case "text": return block.text;
        case "spacer": return "";
      }
    })
    .join("\n");
}

/** Every variable a set of blocks references, in order of appearance. */
export function variablesIn(blocks: Block[]): string[] {
  const found: string[] = [];
  for (const block of blocks) {
    if (block.kind === "field" || block.kind === "action") {
      if (!found.includes(block.variable)) found.push(block.variable);
    } else if (block.kind === "heading" || block.kind === "text") {
      for (const match of block.text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
        if (!found.includes(match[1])) found.push(match[1]);
      }
    }
  }
  return found;
}

/** Sample values for the preview — plausible, obviously fake, never real patients. */
export const SAMPLE_VALUES: Record<string, string> = {
  order_id: "73142",
  patient_name: "R. Sharma (sample)",
  appointment_date: "09 Sept 2026",
  appointment_time: "6:00 am",
  location: "Plum Benefits Pvt Ltd",
  tests: "PL - Core",
  sla_deadline: "09 Sept 2026 1:25 pm",
  manager_name: "Ops desk",
  accept_url: "https://opsflow.example/a/9f3c…",
  reschedule_url: "https://opsflow.example/r/2b81…",
  reject_url: "https://opsflow.example/x/7d45…",
  // Milestone breach. `sla_deadline` is already defined above and serves both
  // the confirmation templates and this one. The overdue value is deliberately
  // non-zero — a preview showing "0m overdue" would not tell an author whether
  // their wording reads right in the situation it is actually for.
  sla_milestone: "Sample collected",
  sla_overdue_by: "1h 20m",
  sla_attempt_no: "2",
  sla_attempts_remaining: "1",
};

/** Render a body with sample values, leaving unknown variables visible. */
export function renderPreview(body: string): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, key: string) => SAMPLE_VALUES[key] ?? `⟨${key}?⟩`);
}

/** A fresh block of the given kind, ready to insert. */
export function newBlock(kind: BlockKind): Block {
  switch (kind) {
    case "heading": return { id: nextId(), kind, text: "LabStack update" };
    case "field": return { id: nextId(), kind, label: "Order ID", variable: "order_id" };
    case "action": return { id: nextId(), kind, label: "Accept order", variable: "accept_url" };
    case "text": return { id: nextId(), kind, text: "Please confirm this order." };
    case "spacer": return { id: nextId(), kind };
  }
}

/** Human labels for the block palette. */
export const BLOCK_LABELS: Record<BlockKind, string> = {
  heading: "Heading",
  field: "Field",
  action: "Action link",
  text: "Text",
  spacer: "Blank line",
};

export function moveBlock(blocks: Block[], index: number, direction: -1 | 1): Block[] {
  const target = index + direction;
  if (target < 0 || target >= blocks.length) return blocks;
  const next = [...blocks];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
