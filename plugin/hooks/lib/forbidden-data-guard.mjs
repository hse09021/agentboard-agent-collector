/**
 * Forbidden Data Guard (hook runtime copy)
 *
 * Mirrors src/core/forbidden-data-guard.ts. Duplicated deliberately: the hooks
 * run as plain .mjs, outside the compiled TypeScript context (see CLAUDE.md's
 * "deliberate duplication" section) — when one side changes, update both.
 *
 * Recursively inspects object keys to ensure no sensitive data
 * (prompts, code, file paths, repo names, etc.) is present.
 * This guard must run before any event is uploaded.
 */

export const FORBIDDEN_KEYS = [
  'prompt',
  'code',
  'content',
  'file',
  'file_content',
  'file_path',
  'path',
  'repo',
  'repository',
  'commit',
  'pr',
  'pull_request',
  'command',
  'terminal_command',
  'cwd',
  'working_directory',
];

export class ForbiddenDataError extends Error {
  constructor(forbiddenKey) {
    super(`Forbidden field detected in payload: "${forbiddenKey}". Payload rejected.`);
    this.name = 'ForbiddenDataError';
    this.forbiddenKey = forbiddenKey;
  }
}

// Path-like patterns: absolute Unix paths, home-dir paths, and Windows drive
// paths. Unlike assertNoForbiddenFields (key-name based), this inspects the
// *content* of a known-risky free-text field (usage_snapshot.raw is verbatim
// CLI stdout, so a forbidden key name can't catch a leaked path/command
// inside it).
const PATH_LIKE_PATTERN = /(\/(?:Users|home|root)\/[^\s"]+|[A-Za-z]:\\[^\s"]+)/;

export const REDACTED_RAW_PLACEHOLDER = '[redacted: raw output withheld — looked like it contained a file path]';

/**
 * Returns a safe-to-upload version of raw CLI stdout: unchanged if no
 * path-like content is detected, otherwise replaced with a placeholder.
 * Never throws — this guards a single field, not the whole event.
 */
export function sanitizeRawOutput(raw) {
  if (typeof raw !== 'string') return raw;
  return PATH_LIKE_PATTERN.test(raw) ? REDACTED_RAW_PLACEHOLDER : raw;
}

export function assertNoForbiddenFields(payload) {
  if (payload === null || payload === undefined) return;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      assertNoForbiddenFields(item);
    }
    return;
  }

  if (typeof payload === 'object') {
    for (const key of Object.keys(payload)) {
      const lowerKey = key.toLowerCase();
      for (const forbidden of FORBIDDEN_KEYS) {
        if (lowerKey === forbidden || lowerKey.includes(forbidden)) {
          throw new ForbiddenDataError(key);
        }
      }
      assertNoForbiddenFields(payload[key]);
    }
  }
}
