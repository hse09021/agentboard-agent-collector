/**
 * agentboard usage-limit parser
 *
 * `parseUsageLimitText()` is a pure text parser for Claude Code's `/usage`
 * output (regex-based, since it's terminal text). Codex does NOT go through
 * this — its rate limits come back as structured JSON from `codex
 * app-server`'s `account/rateLimits/read` RPC, so `normalizeCodexRateLimits()`
 * below converts that shape directly with no regex involved. Both are never
 * throwing; every field is independently optional — a total non-match still
 * returns `raw` so the server can store it for offline inspection / future
 * re-parsing.
 */

// Gap bounds are generous (up to ~150 chars) because real terminal output pads
// labels with spaces and renders a block-character progress bar (e.g.
// "5h limit:                    [███████████████████░] 97% left") between
// the label and the actual percentage. Confirmed against codex-cli 0.142.4
// real `/status` output — see /codex.md.
//
// Real Claude Code (`claude -p "/usage"`, v2.1.197) labels the 5-hour bucket
// "Current session" rather than "5-hour"/"five hour" — confirmed via a
// local-command capture (no billable turn; see usage-limit.mjs SAFETY note).
// "week" alone already matches inside "Current week", so no separate alias
// is needed there. Crucially, Claude Code reports "NN% used" while Codex
// reports "NN% left"/"remaining" — the trailing qualifier is captured so
// "used" readings can be inverted to remaining-percentage semantics below.
const PCT_5H = /(?:5[\s-]?h(?:our)?s?|five[\s-]?hour|current\s+session)[^\d%]{0,150}?(\d{1,3})\s*%(?:\s*(used|remaining|left))?/i;
const PCT_WEEK = /week(?:ly)?[^\d%]{0,150}?(\d{1,3})\s*%(?:\s*(used|remaining|left))?/i;
// Reset times are only extracted when on the same line as the limit label —
// in real output they sometimes wrap to a following line (e.g. weekly reset
// under a narrow terminal), which is inherently ambiguous to reattach
// without knowing the render width, so those cases are left unset rather
// than guessed at.
const RESET_5H = /(?:5[\s-]?h(?:our)?s?|five[\s-]?hour|current\s+session)[^\n]{0,150}?resets?[^\n]{0,20}?:?\s*([^\n]{5,40})/i;
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

// The stored field is always *remaining*. Absent a qualifier, assume the
// number already means remaining (matches legacy phrasing with no trailing
// word); "used" readings are inverted.
function toRemainingPct(rawPct, qualifier) {
  const n = clampPct(rawPct);
  if (n === undefined) return undefined;
  return qualifier && qualifier.toLowerCase() === 'used' ? 100 - n : n;
}

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Claude Code renders reset times in the machine's LOCAL timezone, e.g.
// "Jul 27, 12:40am (Asia/Seoul)" or "Jul 26 at 10:10pm (Asia/Seoul)". The hook
// runs on that same machine, so we read it as a local wall-clock time — Date's
// numeric constructor is local, and toISOString() converts to UTC — with no
// timezone-name parsing or offset math (DST is handled by the runtime). The
// parenthesized zone therefore equals the local one and is ignored.
const NL_RESET =
  /\b([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,|\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

export function parseResetTime(text, now = new Date()) {
  if (!text) return undefined;
  const trimmed = text.trim();

  const nl = trimmed.match(NL_RESET);
  if (nl) {
    const month = MONTH_INDEX[nl[1].toLowerCase()];
    const day = Number(nl[2]);
    let hour = Number(nl[3]) % 12; // 12am -> 0, 12pm handled by the +12 below
    if (nl[5].toLowerCase() === 'pm') hour += 12;
    const minute = nl[4] ? Number(nl[4]) : 0;
    if (month !== undefined && day >= 1 && day <= 31 && hour <= 23 && minute <= 59) {
      // The year is absent; a reset is always in the future, so use the current
      // year and roll forward if that lands in the past (handles Dec -> Jan).
      let candidate = new Date(now.getFullYear(), month, day, hour, minute);
      if (candidate.getTime() < now.getTime()) {
        candidate = new Date(now.getFullYear() + 1, month, day, hour, minute);
      }
      if (!Number.isNaN(candidate.getTime())) return candidate.toISOString();
    }
  }

  // ISO / other Date-parseable strings (e.g. "2026-07-01T18:00:00Z").
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

  const fiveHourRemainingPct = fiveHourMatch
    ? toRemainingPct(fiveHourMatch[1], fiveHourMatch[2])
    : undefined;
  const weeklyRemainingPct = weeklyMatch
    ? toRemainingPct(weeklyMatch[1], weeklyMatch[2])
    : undefined;
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

/**
 * Converts a codex `app-server` `account/rateLimits/read` JSON-RPC result
 * into the same snapshot shape as parseUsageLimitText() — but with no regex
 * involved, since the response is already typed numeric fields (see
 * usage-limit-collector.mjs `readCodexRateLimits()`). `primary`/`secondary`
 * are not documented as always meaning "5-hour"/"weekly" specifically, so
 * windows are matched by `windowDurationMins` (shorter = five-hour bucket,
 * longer = weekly bucket) rather than assumed by position.
 *
 * `primary`/`secondary` are matched to the five-hour vs weekly slot by each
 * window's own `windowDurationMins`, NOT by position or by how many are
 * present. Real accounts return only ONE window in some states — e.g. a Plus
 * account whose app-server reports just `primary` (windowDurationMins 10080 =
 * 7 days, the *weekly* bucket) with `secondary: null`. Assigning by position
 * there would mislabel that weekly reading as the five-hour value and leave
 * weekly blank; a window ≤ a day is the short/session bucket, anything longer
 * (weekly 10080, or a free-plan 30-day 43200 cap) is the weekly/rolling one.
 *
 * @param {object} rpcResult - the `result` field of the JSON-RPC response
 *   (i.e. `{ rateLimits: {...}, ... }`)
 * @param {string} raw - raw JSON-RPC response line, stored verbatim for
 *   offline inspection/reprocessing
 * @returns {{
 *   parseOk: boolean, raw: string, planName?: string,
 *   fiveHourRemainingPct?: number, weeklyRemainingPct?: number,
 *   fiveHourResetAt?: string, weeklyResetAt?: string
 * }}
 */
// A window whose rolling period is at most this long is the short/"5h" bucket;
// anything longer (weekly 10080, monthly 43200) is the weekly/rolling cap.
const SHORT_WINDOW_MAX_MINS = 1440; // 1 day

export function normalizeCodexRateLimits(rpcResult, raw) {
  const text = typeof raw === 'string' ? raw : '';
  const rl = rpcResult?.rateLimits;
  if (!rl) return { parseOk: false, raw: text };

  const windows = [rl.primary, rl.secondary].filter(
    (w) => w && typeof w.usedPercent === 'number'
  );
  const byDurationAsc = (a, b) =>
    (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity);
  // Unknown-duration windows fall through to the weekly/rolling slot (Infinity),
  // matching the prior behavior of sorting nulls to the end.
  const fiveHourWindow = windows
    .filter((w) => (w.windowDurationMins ?? Infinity) <= SHORT_WINDOW_MAX_MINS)
    .sort(byDurationAsc)[0];
  const weeklyWindow = windows
    .filter((w) => (w.windowDurationMins ?? Infinity) > SHORT_WINDOW_MAX_MINS)
    .sort(byDurationAsc)[0];

  const toRemaining = (w) => (w ? clampPct(100 - w.usedPercent) : undefined);
  const toResetIso = (w) =>
    w && typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : undefined;

  const fiveHourRemainingPct = toRemaining(fiveHourWindow);
  const weeklyRemainingPct = toRemaining(weeklyWindow);
  const fiveHourResetAt = toResetIso(fiveHourWindow);
  const weeklyResetAt = toResetIso(weeklyWindow);
  const planName =
    typeof rl.planType === 'string' && rl.planType !== 'unknown' ? rl.planType : undefined;

  const parseOk =
    fiveHourRemainingPct !== undefined || weeklyRemainingPct !== undefined || planName !== undefined;

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
