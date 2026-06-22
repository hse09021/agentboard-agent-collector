import { describe, it, expect } from "vitest";
import {
  assertNoForbiddenFields,
  hasForbiddenFields,
  ForbiddenDataError,
  FORBIDDEN_KEYS,
} from "../../src/core/forbidden-data-guard";

describe("assertNoForbiddenFields", () => {
  it("passes for an empty object", () => {
    expect(() => assertNoForbiddenFields({})).not.toThrow();
  });

  it("passes for null or undefined", () => {
    expect(() => assertNoForbiddenFields(null)).not.toThrow();
    expect(() => assertNoForbiddenFields(undefined)).not.toThrow();
  });

  it("passes for a valid UsageEvent-like object", () => {
    const event = {
      schema_version: "1.0",
      event_id: "evt_abc123",
      device_id: "dev_xyz",
      source: "claude_code",
      session_id: "ses_abc",
      started_at: "2024-01-01T00:00:00Z",
      total_tokens: 1000,
      input_tokens: 800,
      output_tokens: 200,
      collector_version: "0.3.0",
    };
    expect(() => assertNoForbiddenFields(event)).not.toThrow();
  });

  it("rejects an object with 'prompt' key", () => {
    expect(() => assertNoForbiddenFields({ prompt: "tell me a joke" })).toThrow(
      ForbiddenDataError
    );
  });

  it("rejects an object with 'code' key", () => {
    expect(() => assertNoForbiddenFields({ code: "function foo() {}" })).toThrow(
      ForbiddenDataError
    );
  });

  it("rejects an object with 'content' key", () => {
    expect(() => assertNoForbiddenFields({ content: "some text" })).toThrow(
      ForbiddenDataError
    );
  });

  it("rejects an object with 'file_path' key", () => {
    expect(() =>
      assertNoForbiddenFields({ file_path: "/home/user/project/main.ts" })
    ).toThrow(ForbiddenDataError);
  });

  it("rejects nested forbidden keys", () => {
    expect(() =>
      assertNoForbiddenFields({
        metadata: {
          nested: {
            prompt: "do something",
          },
        },
      })
    ).toThrow(ForbiddenDataError);
  });

  it("rejects forbidden keys inside arrays", () => {
    expect(() =>
      assertNoForbiddenFields({
        items: [{ id: 1 }, { prompt: "array prompt" }],
      })
    ).toThrow(ForbiddenDataError);
  });

  it("error message contains the key name but not the value", () => {
    let caught: ForbiddenDataError | undefined;
    try {
      assertNoForbiddenFields({ prompt: "my secret prompt value" });
    } catch (err) {
      caught = err as ForbiddenDataError;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("prompt");
    expect(caught!.message).not.toContain("my secret prompt value");
  });

  it("rejects 'cwd' key", () => {
    expect(() =>
      assertNoForbiddenFields({ cwd: "/home/user/projects" })
    ).toThrow(ForbiddenDataError);
  });

  it("rejects 'repository' key", () => {
    expect(() =>
      assertNoForbiddenFields({ repository: "my-private-repo" })
    ).toThrow(ForbiddenDataError);
  });

  it("rejects 'commit' key", () => {
    expect(() =>
      assertNoForbiddenFields({ commit: "abc123def456" })
    ).toThrow(ForbiddenDataError);
  });

  it("rejects 'pull_request' key", () => {
    expect(() =>
      assertNoForbiddenFields({ pull_request: { number: 42 } })
    ).toThrow(ForbiddenDataError);
  });

  it("rejects 'terminal_command' key", () => {
    expect(() =>
      assertNoForbiddenFields({ terminal_command: "rm -rf /" })
    ).toThrow(ForbiddenDataError);
  });

  it("rejects key containing a forbidden fragment (e.g. 'user_prompt')", () => {
    expect(() =>
      assertNoForbiddenFields({ user_prompt: "something" })
    ).toThrow(ForbiddenDataError);
  });

  it("reports the forbidden key name in the error", () => {
    let caught: ForbiddenDataError | undefined;
    try {
      assertNoForbiddenFields({ file_path: "/secret/path" });
    } catch (err) {
      caught = err as ForbiddenDataError;
    }
    expect(caught!.forbiddenKey).toBe("file_path");
  });
});

describe("hasForbiddenFields", () => {
  it("returns false for a clean object", () => {
    expect(hasForbiddenFields({ total_tokens: 100 })).toBe(false);
  });

  it("returns true for an object with forbidden keys", () => {
    expect(hasForbiddenFields({ prompt: "hello" })).toBe(true);
  });
});

describe("FORBIDDEN_KEYS", () => {
  it("includes all required forbidden key fragments", () => {
    const required = [
      "prompt",
      "code",
      "content",
      "file",
      "path",
      "repo",
      "commit",
      "pr",
      "cwd",
    ];
    for (const key of required) {
      expect(FORBIDDEN_KEYS).toContain(key);
    }
  });
});
