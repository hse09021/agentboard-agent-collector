/**
 * Rewriting the `notify` key in Codex's config.toml.
 *
 * Until v0.7.0 registration removed EVERY line matching /^\s*notify\s*=/ before
 * inserting its own. Codex allows one `notify`, so a user who had their own
 * notification script wired up lost it silently and permanently the first time
 * they ran `agentboard install-hooks` — with no warning and no way to get it
 * back.
 *
 * Two other problems came with it: the regex also matched a `notify` key nested
 * under a `[section]` (a different setting entirely), and nothing recorded what
 * had been displaced.
 *
 * This module is pure string-in/string-out so the behaviour is testable without
 * touching a real config file.
 */

export const CODEX_NOTIFY_COMMENT = "# agentboard-notify";

export interface NotifyRewrite {
  /** The config.toml content to write. */
  content: string;
  /**
   * A third party's `notify` line that had to be displaced, if any. The caller
   * warns about it and records it so `uninstall-hooks` can put it back.
   */
  displaced?: string;
  /** True when the file already had exactly the line we want. */
  unchanged: boolean;
}

function isOurNotifyLine(line: string): boolean {
  if (!/^\s*notify\s*=/.test(line)) return false;
  return (
    line.includes(CODEX_NOTIFY_COMMENT) ||
    /agentboard/i.test(line) ||
    /codex[\\/]notify\.mjs/.test(line)
  );
}

/**
 * Index of the first `[section]` header. Keys after it belong to that table, so
 * only lines before it are root-level `notify` keys.
 */
function firstSectionIndex(lines: string[]): number {
  return lines.findIndex((l) => /^\s*\[/.test(l));
}

export function rewriteCodexNotify(
  existing: string,
  newLine: string
): NotifyRewrite {
  const lines = existing.split("\n");

  if (lines.some((l) => l.trim() === newLine.trim())) {
    return { content: existing, unchanged: true };
  }

  const sectionIdx = firstSectionIndex(lines);
  const rootEnd = sectionIdx === -1 ? lines.length : sectionIdx;

  let displaced: string | undefined;
  const kept: string[] = [];

  lines.forEach((line, index) => {
    // Below the first [section] header, `notify` belongs to that table and is
    // none of our business.
    const isRootNotify = index < rootEnd && /^\s*notify\s*=/.test(line);
    if (!isRootNotify) {
      kept.push(line);
      return;
    }

    if (isOurNotifyLine(line)) return; // ours, replaced below

    // Someone else's. Codex only honours one `notify`, so it cannot stay —
    // but it is preserved for uninstall and the caller is told about it.
    displaced = line.trim();
  });

  const cleaned = kept.join("\n");
  const cleanedLines = cleaned.split("\n");
  const insertAt = firstSectionIndex(cleanedLines);

  let content: string;
  if (insertAt === -1) {
    content = cleaned.trimEnd() + (cleaned.trim() ? "\n" : "") + newLine + "\n";
  } else {
    cleanedLines.splice(insertAt, 0, newLine, "");
    content = cleanedLines.join("\n");
    if (!content.endsWith("\n")) content += "\n";
  }

  return { content, displaced, unchanged: false };
}

/**
 * Removes our own `notify` line, restoring a previously displaced one if given.
 */
export function removeCodexNotify(
  existing: string,
  restore?: string
): { content: string; changed: boolean } {
  const lines = existing.split("\n");
  const sectionIdx = firstSectionIndex(lines);
  const rootEnd = sectionIdx === -1 ? lines.length : sectionIdx;

  let changed = false;
  const kept = lines.filter((line, index) => {
    const isRootNotify = index < rootEnd && /^\s*notify\s*=/.test(line);
    if (isRootNotify && isOurNotifyLine(line)) {
      changed = true;
      return false;
    }
    return true;
  });

  if (!changed) return { content: existing, changed: false };

  let content = kept.join("\n");

  if (restore && !content.split("\n").some((l) => l.trim() === restore.trim())) {
    const restoredLines = content.split("\n");
    const insertAt = firstSectionIndex(restoredLines);
    if (insertAt === -1) {
      content = content.trimEnd() + (content.trim() ? "\n" : "") + restore + "\n";
    } else {
      restoredLines.splice(insertAt, 0, restore, "");
      content = restoredLines.join("\n");
    }
  }

  if (content && !content.endsWith("\n")) content += "\n";
  return { content, changed: true };
}
