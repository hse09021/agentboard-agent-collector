import { describe, it, expect } from "vitest";
import {
  CODEX_NOTIFY_COMMENT,
  rewriteCodexNotify,
  removeCodexNotify,
} from "../../src/core/codex-notify";

const OURS = `notify = ["node", "/pkg/plugin/hooks/codex/notify.mjs"] ${CODEX_NOTIFY_COMMENT}`;
const THEIRS = `notify = ["/usr/bin/my-alert", "--sound"]`;

describe("rewriteCodexNotify", () => {
  it("adds the line to an empty config", () => {
    const { content, displaced, unchanged } = rewriteCodexNotify("", OURS);
    expect(unchanged).toBe(false);
    expect(displaced).toBeUndefined();
    expect(content.trim()).toBe(OURS);
  });

  it("reports no change when the exact line is already there", () => {
    const existing = `model = "gpt-5"\n${OURS}\n`;
    const { content, unchanged } = rewriteCodexNotify(existing, OURS);
    expect(unchanged).toBe(true);
    expect(content).toBe(existing);
  });

  it("replaces a stale agentboard line without reporting a displacement", () => {
    const stale = `notify = ["node", "/old/path/notify.mjs"] ${CODEX_NOTIFY_COMMENT}`;
    const { content, displaced } = rewriteCodexNotify(`${stale}\n`, OURS);
    expect(displaced).toBeUndefined();
    expect(content).toContain(OURS);
    expect(content).not.toContain("/old/path");
  });

  // The regression that motivated this module: a user's own notify script used
  // to vanish silently on the first `install-hooks`.
  it("preserves a third-party notify line as a displacement", () => {
    const { content, displaced } = rewriteCodexNotify(`${THEIRS}\n`, OURS);
    expect(displaced).toBe(THEIRS);
    expect(content).toContain(OURS);
    // Codex honours only one notify, so it cannot remain in the file —
    // but the caller now has it and can restore it on uninstall.
    expect(content).not.toContain("my-alert");
  });

  // `notify` under a [section] is a different setting entirely.
  it("never touches a notify key nested under a section", () => {
    const existing = [
      `model = "gpt-5"`,
      ``,
      `[tui]`,
      `notify = ["something", "else"]`,
      ``,
    ].join("\n");

    const { content, displaced } = rewriteCodexNotify(existing, OURS);

    expect(displaced).toBeUndefined();
    expect(content).toContain(`[tui]`);
    expect(content).toContain(`notify = ["something", "else"]`);
    expect(content).toContain(OURS);
  });

  it("inserts before the first section so the key stays root-level", () => {
    const existing = [`model = "gpt-5"`, ``, `[tui]`, `theme = "dark"`, ``].join("\n");
    const { content } = rewriteCodexNotify(existing, OURS);

    const lines = content.split("\n");
    expect(lines.indexOf(OURS)).toBeLessThan(lines.findIndex((l) => l.startsWith("[tui]")));
  });

  it("does not leave duplicate notify lines", () => {
    const existing = `${OURS}\nmodel = "gpt-5"\n`;
    const updated = `notify = ["node", "/new/path/notify.mjs"] ${CODEX_NOTIFY_COMMENT}`;
    const { content } = rewriteCodexNotify(existing, updated);

    const count = content.split("\n").filter((l) => /^\s*notify\s*=/.test(l)).length;
    expect(count).toBe(1);
  });
});

describe("removeCodexNotify", () => {
  it("removes our line and reports the change", () => {
    const { content, changed } = removeCodexNotify(`model = "gpt-5"\n${OURS}\n`);
    expect(changed).toBe(true);
    expect(content).not.toContain("agentboard");
    expect(content).toContain(`model = "gpt-5"`);
  });

  it("leaves a third-party line alone", () => {
    const { content, changed } = removeCodexNotify(`${THEIRS}\n`);
    expect(changed).toBe(false);
    expect(content).toContain("my-alert");
  });

  it("restores a previously displaced line", () => {
    const { content, changed } = removeCodexNotify(`${OURS}\n`, THEIRS);
    expect(changed).toBe(true);
    expect(content).toContain("my-alert");
    expect(content).not.toContain("agentboard");
  });

  it("does nothing when there is no line of ours", () => {
    const existing = `model = "gpt-5"\n`;
    expect(removeCodexNotify(existing)).toEqual({ content: existing, changed: false });
  });
});
