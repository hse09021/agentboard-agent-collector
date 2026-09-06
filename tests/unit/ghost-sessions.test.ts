import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isGhostTranscript,
  scanGhostSessions,
  removeGhostSessions,
} from "../../src/core/ghost-sessions";

// Shapes taken from real transcripts on disk (2026-09-06).
const GHOST_LINES = [
  { type: "queue-operation" },
  { type: "user", message: { content: "<local-command-caveat>Caveat: ...</local-command-caveat>" } },
  {
    type: "user",
    message: { content: "<command-name>/usage</command-name>\n<command-message>usage</command-message>" },
  },
  { type: "system", subtype: "local_command", content: "limits report" },
  { type: "last-prompt" },
];

const REAL_LINES = [
  { type: "queue-operation" },
  { type: "user", message: { content: "refactor the parser" } },
  { type: "assistant", message: { stop_reason: "end_turn", usage: { input_tokens: 10 } } },
];

const toJsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("isGhostTranscript", () => {
  it("classifies a /usage snapshot session as a ghost", () => {
    expect(isGhostTranscript(toJsonl(GHOST_LINES))).toBe(true);
  });

  it("never classifies a session with a completed assistant turn", () => {
    expect(isGhostTranscript(toJsonl(REAL_LINES))).toBe(false);
  });

  // The guard that makes deletion safe: even a session that ran /usage
  // interactively is kept, because it also produced real turns.
  it("keeps a real session that happens to contain /usage", () => {
    const mixed = [...GHOST_LINES, { type: "assistant", message: { stop_reason: "end_turn" } }];
    expect(isGhostTranscript(toJsonl(mixed))).toBe(false);
  });

  it("requires the local_command marker, not just the text", () => {
    const noMarker = GHOST_LINES.filter((l) => l.type !== "system");
    expect(isGhostTranscript(toJsonl(noMarker))).toBe(false);
  });

  it("refuses to classify a file with an unparsable line", () => {
    expect(isGhostTranscript(toJsonl(GHOST_LINES) + "{not json\n")).toBe(false);
  });

  it("treats an empty file as not-a-ghost", () => {
    expect(isGhostTranscript("")).toBe(false);
  });
});

describe("scanGhostSessions / removeGhostSessions", () => {
  let root: string;
  let projects: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-ghost-"));
    projects = path.join(root, "projects");
    fs.mkdirSync(path.join(projects, "proj-a"), { recursive: true });
    fs.writeFileSync(path.join(projects, "proj-a", "ghost1.jsonl"), toJsonl(GHOST_LINES));
    fs.writeFileSync(path.join(projects, "proj-a", "ghost2.jsonl"), toJsonl(GHOST_LINES));
    fs.writeFileSync(path.join(projects, "proj-a", "real.jsonl"), toJsonl(REAL_LINES));
    fs.writeFileSync(path.join(projects, "proj-a", "notes.txt"), "ignored");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds ghosts and leaves everything else counted as kept", () => {
    const result = scanGhostSessions(projects);
    expect(result.ghosts.map((g) => path.basename(g.filePath)).sort()).toEqual([
      "ghost1.jsonl",
      "ghost2.jsonl",
    ]);
    expect(result.keptCount).toBe(1);
    expect(result.missingRoot).toBe(false);
  });

  it("reports a missing projects directory instead of throwing", () => {
    const result = scanGhostSessions(path.join(root, "nope"));
    expect(result.missingRoot).toBe(true);
    expect(result.ghosts).toEqual([]);
  });

  it("removes only the ghosts and keeps real sessions on disk", () => {
    const { ghosts } = scanGhostSessions(projects);
    const result = removeGhostSessions(ghosts);

    expect(result.removed).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(path.join(projects, "proj-a", "real.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(projects, "proj-a", "ghost1.jsonl"))).toBe(false);
  });

  // A scan result can be minutes old by the time the user confirms.
  it("re-verifies before deleting and skips a file that gained real content", () => {
    const { ghosts } = scanGhostSessions(projects);
    const target = ghosts.find((g) => g.filePath.endsWith("ghost1.jsonl"))!;
    fs.writeFileSync(target.filePath, toJsonl(REAL_LINES));

    const result = removeGhostSessions(ghosts);

    expect(result.removed).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].filePath).toBe(target.filePath);
    expect(fs.existsSync(target.filePath)).toBe(true);
  });
});
