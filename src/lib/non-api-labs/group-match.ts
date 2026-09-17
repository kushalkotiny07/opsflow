/**
 * Matching a LabStack lab to a WhatsApp group the gateway has actually seen.
 *
 * The WhatsApp target used to be typed in as a raw jid — a 20-digit string
 * ending in "@g.us". That is the single most error-prone field on the screen,
 * and the cost of getting it wrong is silent: a malformed jid is still a valid
 * string, so the config saves, the tick runs, and messages go nowhere. Lab 403
 * in this very database is configured as "20363000000000000@g.us", missing the
 * leading 1, and nothing has ever complained.
 *
 * The gateway already stores every group it can see, so the jid never needs to
 * be typed. This scores those groups against a lab's name so the UI can offer
 * the likely one first.
 *
 * No imports on purpose: the config screen is a client component.
 */

export type MatchableGroup = { jid: string; subject: string };

/** Words that say nothing about WHICH lab a group belongs to. */
const NOISE = new Set([
  "lab", "labs", "laboratory", "diagnostics", "diagnostic", "health", "healthcare",
  "pvt", "ltd", "llp", "private", "limited", "india", "the", "and", "group",
  "provider", "support", "ops", "team", "chat", "official", "inc", "co",
]);

/** Lowercase, strip punctuation, drop noise words and very short tokens. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !NOISE.has(word));
}

/**
 * 0..1, how strongly a group subject looks like this lab.
 *
 * Deliberately generous on partial words ("advaitha" vs "advaithalab") because
 * group names are typed by humans in a hurry, and deliberately scaled by how
 * much of the LAB name was matched rather than the group name — a group called
 * "Thyrocare India Ops Escalations Bangalore" is still the right group.
 */
export function scoreMatch(labName: string, groupSubject: string): number {
  const labTokens = tokenize(labName);
  const groupTokens = tokenize(groupSubject);
  if (labTokens.length === 0 || groupTokens.length === 0) return 0;

  let hits = 0;
  for (const token of labTokens) {
    const hit = groupTokens.some((other) => other === token || isNearPrefix(token, other));
    if (hit) hits += 1;
  }
  const coverage = hits / labTokens.length;

  // A lab name that is one token away from another lab's is the dangerous
  // case: "Orange Health - Hyderabad" scores 0.5 against the BANGALORE group,
  // because "orange" matches and the city does not. Suggesting that would point
  // a lab's orders at a different lab's group — worse than suggesting nothing.
  // So a token the lab has and the group lacks is counted against the match.
  const misses = labTokens.length - hits;
  return misses > 0 ? coverage * (1 - misses / labTokens.length) : coverage;
}

/**
 * Prefix match, but only where it means something.
 *
 * A bare startsWith lets "gene" match "gen", which is how "The Gene Box" ended
 * up matching a finance club. Require the shorter token to be a real word and
 * the two to be close in length, so inflections match and coincidences do not.
 */
function isNearPrefix(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 4) return false;
  if (longer.length - shorter.length > 3) return false;
  return longer.startsWith(shorter);
}

/**
 * The best group for a lab, or null when nothing is convincing.
 *
 * The threshold exists so a lab with no group gets an empty picker rather than
 * a confident wrong answer — the failure this whole change is meant to prevent.
 */
export function suggestGroup<T extends MatchableGroup>(
  labName: string,
  groups: T[],
  { threshold = 0.75 }: { threshold?: number } = {},
): { group: T; score: number } | null {
  let best: { group: T; score: number } | null = null;
  for (const group of groups) {
    const score = scoreMatch(labName, group.subject);
    if (score > (best?.score ?? 0)) best = { group, score };
  }
  return best && best.score >= threshold ? best : null;
}
