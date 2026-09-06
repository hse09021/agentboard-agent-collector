/**
 * Detection and cleanup of `/usage` ghost transcripts.
 *
 * Before v0.7.0 the rate-limit snapshot ran `claude -p /usage`, which starts a
 * real headless session — and Claude Code writes a transcript for it under
 * ~/.claude/projects/. Those transcripts show up in the /resume session picker
 * as "/usage" entries, so a user who has run the collector for a while cannot
 * find their own sessions. One dev machine had 17 ghosts against 3 real
 * sessions.
 *
 * v0.7.0 stops creating them (see plugin/hooks/lib/usage-limit-collector.mjs),
 * but the ones already on disk stay until something removes them.
 *
 * These files belong to Claude Code, not to us, so detection is deliberately
 * conservative and removal never happens automatically — the CLI reports a
 * count and only deletes when the user explicitly asks.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface GhostSession {
  filePath: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface GhostScanResult {
  ghosts: GhostSession[];
  /** Transcripts examined that were NOT classified as ghosts. */
  keptCount: number;
  /** True when the projects directory does not exist (Claude Code not installed). */
  missingRoot: boolean;
}

export function getClaudeProjectsDir(): string {
  // Test override, same spirit as AGENTBOARD_CONFIG_DIR.
  if (process.env.AGENTBOARD_CLAUDE_DIR) {
    return path.join(process.env.AGENTBOARD_CLAUDE_DIR, "projects");
  }
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * A transcript is a ghost only when ALL of these hold:
 *
 *   1. a user message carries `<command-name>/usage</command-name>`
 *   2. it contains a `type:"system", subtype:"local_command"` entry
 *   3. it has ZERO assistant turns with a `stop_reason`
 *
 * (3) is what makes this safe. A real session — including one where the user
 * happened to type /usage themselves — always has completed assistant turns,
 * so it can never match. A session with no completed turns holds no
 * conversation worth keeping either way.
 */
export function isGhostTranscript(content: string): boolean {
  let sawUsageCommand = false;
  let sawLocalCommand = false;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A malformed line means we cannot reason about this file. Refuse to
      // classify it as a ghost rather than risk deleting something else.
      return false;
    }

    const type = entry.type;

    if (type === "assistant") {
      const message = entry.message as { stop_reason?: unknown } | undefined;
      if (message?.stop_reason) return false; // billable turn → real session
    }

    if (type === "system" && entry.subtype === "local_command") {
      sawLocalCommand = true;
    }

    if (type === "user") {
      const message = entry.message as { content?: unknown } | undefined;
      const raw = typeof message?.content === "string" ? message.content : "";
      if (raw.includes("<command-name>/usage</command-name>")) {
        sawUsageCommand = true;
      }
    }
  }

  return sawUsageCommand && sawLocalCommand;
}

export function scanGhostSessions(
  projectsDir = getClaudeProjectsDir()
): GhostScanResult {
  if (!fs.existsSync(projectsDir)) {
    return { ghosts: [], keptCount: 0, missingRoot: true };
  }

  const ghosts: GhostSession[] = [];
  let keptCount = 0;

  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, file);

      let content: string;
      let stat: fs.Stats;
      try {
        content = fs.readFileSync(filePath, "utf-8");
        stat = fs.statSync(filePath);
      } catch {
        keptCount++; // unreadable → leave it alone
        continue;
      }

      if (isGhostTranscript(content)) {
        ghosts.push({
          filePath,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
        });
      } else {
        keptCount++;
      }
    }
  }

  return { ghosts, keptCount, missingRoot: false };
}

export interface GhostRemovalResult {
  removed: string[];
  failed: Array<{ filePath: string; reason: string }>;
}

/**
 * Deletes the given transcripts, re-verifying each one immediately before
 * removal. The re-read matters: a scan result can be minutes old, and a file
 * that has since gained real content must not be deleted.
 */
export function removeGhostSessions(ghosts: GhostSession[]): GhostRemovalResult {
  const removed: string[] = [];
  const failed: Array<{ filePath: string; reason: string }> = [];

  for (const ghost of ghosts) {
    try {
      const content = fs.readFileSync(ghost.filePath, "utf-8");
      if (!isGhostTranscript(content)) {
        failed.push({
          filePath: ghost.filePath,
          reason: "no longer looks like a /usage session — left in place",
        });
        continue;
      }
      fs.unlinkSync(ghost.filePath);
      removed.push(ghost.filePath);
    } catch (err) {
      failed.push({
        filePath: ghost.filePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { removed, failed };
}
