/**
 * Forbidden Data Guard
 *
 * Recursively inspects object keys to ensure no sensitive data
 * (prompts, code, file paths, repo names, etc.) is present.
 * This guard runs before any event is stored, queued, or uploaded.
 */

export const FORBIDDEN_KEYS = [
  "prompt",
  "code",
  "content",
  "file",
  "file_content",
  "file_path",
  "path",
  "repo",
  "repository",
  "commit",
  "pr",
  "pull_request",
  "command",
  "terminal_command",
  "cwd",
  "working_directory",
] as const;

export type ForbiddenKey = (typeof FORBIDDEN_KEYS)[number];

export class ForbiddenDataError extends Error {
  constructor(public readonly forbiddenKey: string) {
    super(
      `Forbidden field detected in payload: "${forbiddenKey}". Payload rejected.`
    );
    this.name = "ForbiddenDataError";
  }
}

/**
 * Recursively inspects all object keys for forbidden fragments.
 * Throws ForbiddenDataError if any forbidden key is found.
 * Never includes the offending value in the error message.
 */
export function assertNoForbiddenFields(payload: unknown): void {
  if (payload === null || payload === undefined) return;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      assertNoForbiddenFields(item);
    }
    return;
  }

  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      for (const forbidden of FORBIDDEN_KEYS) {
        if (lowerKey === forbidden || lowerKey.includes(forbidden)) {
          throw new ForbiddenDataError(key);
        }
      }
      assertNoForbiddenFields(obj[key]);
    }
  }
}

export function hasForbiddenFields(payload: unknown): boolean {
  try {
    assertNoForbiddenFields(payload);
    return false;
  } catch {
    return true;
  }
}
