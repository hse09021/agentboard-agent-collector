/**
 * Privacy tests — prove that forbidden data is never stored, logged,
 * queued, or passed through the validation layer.
 *
 * Fixtures must not contain prompts, code, file paths, repo names,
 * commit contents, PR contents, or commands.
 */
import { describe, it, expect } from "vitest";
import { assertNoForbiddenFields, ForbiddenDataError, FORBIDDEN_KEYS } from "../../src/core/forbidden-data-guard";
import { validateUsageEvent } from "../../src/core/validation";
import type { UsageEvent } from "../../src/core/usage-event";

// All fixtures contain only safe token metadata — no prompts, code, or paths.

const SAFE_EVENT: UsageEvent = {
  schema_version: "1.0",
  event_id: "evt_privacy_test_001",
  device_id: "dev_privacy_test",
  source: "claude_code",
  model: "claude-opus-4-5",
  session_id: "ses_privacy_test",
  started_at: "2024-06-01T10:00:00Z",
  ended_at: "2024-06-01T10:30:00Z",
  input_tokens: 5000,
  output_tokens: 2000,
  cache_creation_tokens: 100,
  cache_read_tokens: 400,
  total_tokens: 7500,
  collector_version: "0.3.0",
  os: "macos",
};

describe("Privacy: safe event passes all guards", () => {
  it("SAFE_EVENT passes forbidden data guard", () => {
    expect(() => assertNoForbiddenFields(SAFE_EVENT)).not.toThrow();
  });

  it("SAFE_EVENT passes validation", () => {
    const result = validateUsageEvent(SAFE_EVENT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("Privacy: forbidden payloads are rejected", () => {
  const forbiddenPayloads = FORBIDDEN_KEYS.map((key) => ({
    key,
    payload: { ...SAFE_EVENT, [key]: "sensitive-value" } as any,
  }));

  for (const { key, payload } of forbiddenPayloads) {
    it(`rejects event with forbidden key: "${key}"`, () => {
      expect(() => assertNoForbiddenFields(payload)).toThrow(ForbiddenDataError);
    });
  }

  it("rejects deeply nested forbidden key", () => {
    const nested = {
      ...SAFE_EVENT,
      metadata: {
        context: {
          prompt: "nested forbidden value",
        },
      },
    } as any;
    expect(() => assertNoForbiddenFields(nested)).toThrow(ForbiddenDataError);
  });

  it("error message never contains the forbidden value", () => {
    const sensitiveValue = "MY_VERY_SECRET_PROMPT_DO_NOT_LOG";
    let errorMessage = "";
    try {
      assertNoForbiddenFields({ prompt: sensitiveValue });
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    expect(errorMessage).not.toContain(sensitiveValue);
  });
});

describe("Privacy: UsageEvent schema has no forbidden field names", () => {
  it("the safe event's own keys are not forbidden", () => {
    const keys = Object.keys(SAFE_EVENT);
    for (const key of keys) {
      const lowerKey = key.toLowerCase();
      for (const forbidden of FORBIDDEN_KEYS) {
        const isForbidden = lowerKey === forbidden || lowerKey.includes(forbidden);
        expect(isForbidden).toBe(false);
      }
    }
  });
});

describe("Privacy: validation rejects events with forbidden fields", () => {
  it("validates that forbidden keys cause rejection", () => {
    const withPrompt = { ...SAFE_EVENT, prompt: "user asked this" } as any;
    const result = validateUsageEvent(withPrompt);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("forbidden"))).toBe(true);
  });

  it("validation errors do not include forbidden field values", () => {
    const secretValue = "TOP_SECRET_CODE_SNIPPET";
    const withCode = { ...SAFE_EVENT, code: secretValue } as any;
    const result = validateUsageEvent(withCode);
    expect(result.valid).toBe(false);
    for (const error of result.errors) {
      expect(error).not.toContain(secretValue);
    }
  });
});
