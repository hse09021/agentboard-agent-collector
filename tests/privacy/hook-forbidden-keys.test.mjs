/**
 * Privacy tests for the hook-runtime guard (plugin/hooks/lib/forbidden-data-guard.mjs).
 *
 * This is the copy that actually runs in production — worker.mjs calls it
 * right before uploadEvents(). tests/privacy/forbidden-keys.test.ts covers the
 * src/ copy, which is only exercised by its own tests; this file is what
 * proves the real upload path is protected.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoForbiddenFields,
  ForbiddenDataError,
  FORBIDDEN_KEYS,
  sanitizeRawOutput,
  REDACTED_RAW_PLACEHOLDER,
} from '../../plugin/hooks/lib/forbidden-data-guard.mjs';

const SAFE_EVENT = {
  schema_version: '1.0',
  event_id: 'evt_privacy_test_001',
  device_id: 'dev_privacy_test',
  source: 'claude_code',
  model: 'claude-opus-4-5',
  session_id: 'ses_privacy_test',
  started_at: '2024-06-01T10:00:00Z',
  ended_at: '2024-06-01T10:30:00Z',
  input_tokens: 5000,
  output_tokens: 2000,
  cache_creation_tokens: 100,
  cache_read_tokens: 400,
  total_tokens: 7500,
  collector_version: '0.3.0',
};

describe('Hook privacy guard: safe event passes', () => {
  it('SAFE_EVENT passes forbidden data guard', () => {
    expect(() => assertNoForbiddenFields(SAFE_EVENT)).not.toThrow();
  });
});

describe('Hook privacy guard: forbidden payloads are rejected', () => {
  for (const key of FORBIDDEN_KEYS) {
    it(`rejects event with forbidden key: "${key}"`, () => {
      const payload = { ...SAFE_EVENT, [key]: 'sensitive-value' };
      expect(() => assertNoForbiddenFields(payload)).toThrow(ForbiddenDataError);
    });
  }

  it('rejects a forbidden key nested inside usage_snapshot', () => {
    const nested = {
      ...SAFE_EVENT,
      usage_snapshot: { raw: 'ok', metadata: { command: 'rm -rf /' } },
    };
    expect(() => assertNoForbiddenFields(nested)).toThrow(ForbiddenDataError);
  });
});

describe('sanitizeRawOutput: content-level redaction for usage_snapshot.raw', () => {
  it('leaves plain rate-limit text untouched', () => {
    const raw = '5-hour limit: [███████████████████░] 97% left\nWeekly limit: 80% left';
    expect(sanitizeRawOutput(raw)).toBe(raw);
  });

  it('redacts output containing a Unix home-dir path', () => {
    const raw = 'Session log at /Users/alice/projects/secret-app/notes.txt';
    expect(sanitizeRawOutput(raw)).toBe(REDACTED_RAW_PLACEHOLDER);
  });

  it('redacts output containing a Windows drive path', () => {
    const raw = 'Config loaded from C:\\Users\\bob\\secret\\config.toml';
    expect(sanitizeRawOutput(raw)).toBe(REDACTED_RAW_PLACEHOLDER);
  });

  it('passes through non-string values unchanged', () => {
    expect(sanitizeRawOutput(undefined)).toBe(undefined);
    expect(sanitizeRawOutput(null)).toBe(null);
  });
});
