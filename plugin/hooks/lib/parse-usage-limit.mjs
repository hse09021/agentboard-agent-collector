/**
 * agentboard usage-limit parser
 *
 * Pure text parser: turns raw `/usage` (Claude Code) or `/status` (Codex)
 * output into structured rate-limit fields. Never throws. Every field is
 * independently optional — a total non-match still returns `raw` so the
 * server can store it for offline inspection / future re-parsing.
 */

// Gap bounds are generous (up to ~150 chars) because real terminal output pads
// labels with spaces and renders a block-character progress bar (e.g.
// "5h limit:                    [███████████████████░] 97% left") between
// the label and the actual percentage. Confirmed against codex-cli 0.142.4
// real `/status` output — see /codex.md.
const PCT_5H = /(?:5[\s-]?h(?:our)?s?|five[\s-]?hour)[^\d%]{0,150}?(\d{1,3})\s*%/i;
const PCT_WEEK = /week(?:ly)?[^\d%]{0,150}?(\d{1,3})\s*%/i;
// Reset times are only extracted when on the same line as the limit label —
// in real output they sometimes wrap to a following line (e.g. weekly reset
// under a narrow terminal), which is inherently ambiguous to reattach
// without knowing the render width, so those cases are left unset rather
// than guessed at.
const RESET_5H = /(?:5[\s-]?h(?:our)?s?|five[\s-]?hour)[^\n]{0,150}?resets?[^\n]{0,20}?:?\s*([^\n]{5,40})/i;
const RESET_WEEK = /week(?:ly)?[^\n]{0,150}?resets?[^\n]{0,20}?:?\s*([^\n]{5,40})/i;
// Three accepted shapes: "<plan> plan" (e.g. "Pro plan"), "plan: <plan>",
// or "Account: ... (<plan>)" (Codex `/status` format).
const PLAN_NAME =
  /\b(free|pro|max\s?5x|max\s?20x|plus|team|business|enterprise)\s+plan\b|\bplan\b[^\n]{0,20}?:?\s*\b(free|pro|max\s?5x|max\s?20x|plus|team|business|enterprise)\b|\bAccount\b[^\n]{0,100}?\((free|pro|max\s?5x|max\s?20x|plus|team|business|enterprise)\)/i;

const PLAN_ALIASES = {
  free: 'free',
  pro: 'pro',
  'max 5x': 'max5x',
  max5x: 'max5x',
  'max 20x': 'max20x',
  max20x: 'max20x',
  plus: 'plus',
  team: 'team',
  business: 'business',
  enterprise: 'enterprise',
};

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(100, Math.max(0, n));
}

function parseResetTime(text) {
  if (!text) return undefined;
  const trimmed = text.trim();
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return undefined;
}

function normalizePlanName(match) {
  if (!match) return undefined;
  const key = match.toLowerCase().replace(/\s+/g, ' ').trim();
  return PLAN_ALIASES[key] ?? PLAN_ALIASES[key.replace(/\s/g, '')];
}

/**
 * @param {string} raw - raw stdout from `/usage` or `/status`
 * @param {{source: 'claude_code'|'codex'}} ctx
 * @returns {{
 *   parseOk: boolean, raw: string, planName?: string,
 *   fiveHourRemainingPct?: number, weeklyRemainingPct?: number,
 *   fiveHourResetAt?: string, weeklyResetAt?: string
 * }}
 */
export function parseUsageLimitText(raw, _ctx = {}) {
  const text = typeof raw === 'string' ? raw : '';

  if (!text.trim()) {
    return { parseOk: false, raw: text };
  }

  const fiveHourMatch = text.match(PCT_5H);
  const weeklyMatch = text.match(PCT_WEEK);
  const fiveHourResetMatch = text.match(RESET_5H);
  const weeklyResetMatch = text.match(RESET_WEEK);
  const planMatch = text.match(PLAN_NAME);

  const fiveHourRemainingPct = fiveHourMatch ? clampPct(fiveHourMatch[1]) : undefined;
  const weeklyRemainingPct = weeklyMatch ? clampPct(weeklyMatch[1]) : undefined;
  const fiveHourResetAt = fiveHourResetMatch ? parseResetTime(fiveHourResetMatch[1]) : undefined;
  const weeklyResetAt = weeklyResetMatch ? parseResetTime(weeklyResetMatch[1]) : undefined;
  const planName = planMatch
    ? normalizePlanName(planMatch[1] ?? planMatch[2] ?? planMatch[3])
    : undefined;

  const parseOk =
    fiveHourRemainingPct !== undefined ||
    weeklyRemainingPct !== undefined ||
    planName !== undefined;

  return {
    parseOk,
    raw: text,
    ...(planName !== undefined && { planName }),
    ...(fiveHourRemainingPct !== undefined && { fiveHourRemainingPct }),
    ...(weeklyRemainingPct !== undefined && { weeklyRemainingPct }),
    ...(fiveHourResetAt !== undefined && { fiveHourResetAt }),
    ...(weeklyResetAt !== undefined && { weeklyResetAt }),
  };
}
