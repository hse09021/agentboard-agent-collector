import { describe, it, expect } from "vitest";
import { validateUsageEvent } from "../../src/core/validation";

function validEvent() {
  return {
    schema_version: "1.0" as const,
    event_id: "evt_abc123",
    device_id: "dev_xyz",
    source: "claude_code" as const,
    session_id: "ses_abc",
    started_at: "2024-01-01T00:00:00Z",
    total_tokens: 1000,
    input_tokens: 800,
    output_tokens: 200,
    collector_version: "0.3.0",
  };
}

describe("validateUsageEvent", () => {
  it("passes for a valid event", () => {
    const result = validateUsageEvent(validEvent());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails for non-object input", () => {
    expect(validateUsageEvent(null).valid).toBe(false);
    expect(validateUsageEvent("string").valid).toBe(false);
    expect(validateUsageEvent(42).valid).toBe(false);
  });

  it("fails when schema_version is wrong", () => {
    const result = validateUsageEvent({ ...validEvent(), schema_version: "2.0" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("fails when event_id is missing", () => {
    const { event_id, ...rest } = validEvent();
    const result = validateUsageEvent(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("event_id"))).toBe(true);
  });

  it("fails when device_id is missing", () => {
    const { device_id, ...rest } = validEvent();
    const result = validateUsageEvent(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("device_id"))).toBe(true);
  });

  it("fails when source is invalid", () => {
    const result = validateUsageEvent({ ...validEvent(), source: "unknown_tool" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("source"))).toBe(true);
  });

  it("accepts all valid sources", () => {
    const sources = ["claude_code", "codex", "opencode", "github_copilot", "gemini_cli"];
    for (const source of sources) {
      const result = validateUsageEvent({ ...validEvent(), source });
      expect(result.valid).toBe(true);
    }
  });

  it("fails when started_at is not ISO 8601", () => {
    const result = validateUsageEvent({
      ...validEvent(),
      started_at: "not-a-date",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("started_at"))).toBe(true);
  });

  it("fails when total_tokens is zero", () => {
    const result = validateUsageEvent({ ...validEvent(), total_tokens: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("total_tokens"))).toBe(true);
  });

  it("fails when total_tokens is negative", () => {
    const result = validateUsageEvent({ ...validEvent(), total_tokens: -1 });
    expect(result.valid).toBe(false);
  });

  it("fails when total_tokens is a float", () => {
    const result = validateUsageEvent({ ...validEvent(), total_tokens: 1.5 });
    expect(result.valid).toBe(false);
  });

  it("passes when optional token fields are valid", () => {
    const result = validateUsageEvent({
      ...validEvent(),
      input_tokens: 0,
      output_tokens: 1000,
      cache_creation_tokens: 50,
      cache_read_tokens: 150,
    });
    expect(result.valid).toBe(true);
  });

  it("fails when optional token fields are negative", () => {
    const result = validateUsageEvent({ ...validEvent(), input_tokens: -1 });
    expect(result.valid).toBe(false);
  });

  it("fails when cache creation tokens are negative", () => {
    const result = validateUsageEvent({
      ...validEvent(),
      cache_creation_tokens: -1,
    });
    expect(result.valid).toBe(false);
  });

  it("fails when cache read tokens are floats", () => {
    const result = validateUsageEvent({
      ...validEvent(),
      cache_read_tokens: 1.5,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects the deprecated cached_tokens field", () => {
    const result = validateUsageEvent({
      ...validEvent(),
      cached_tokens: 100,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cache_read_tokens"))).toBe(true);
  });

  it("fails when optional token fields are floats", () => {
    const result = validateUsageEvent({ ...validEvent(), output_tokens: 10.5 });
    expect(result.valid).toBe(false);
  });

  it("rejects events with forbidden fields", () => {
    const result = validateUsageEvent({
      ...validEvent(),
      prompt: "my secret prompt",
    } as any);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("forbidden"))).toBe(true);
  });

  it("accepts optional fields like model, ended_at, os, editor", () => {
    const result = validateUsageEvent({
      ...validEvent(),
      model: "claude-opus-4-5",
      ended_at: "2024-01-01T01:00:00Z",
      os: "macos",
      editor: "vscode",
    });
    expect(result.valid).toBe(true);
  });
});
