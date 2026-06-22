import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseGeminiSession } from '../../plugin/hooks/lib/parse-gemini.mjs';

describe('parseGeminiSession — cache read tokens', () => {
  it('maps cachedContentTokenCount to cacheReadTokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-gemini-'));
    const file = join(dir, 'session.json');

    try {
      writeFileSync(file, JSON.stringify({
        history: [{
          type: 'gemini',
          timestamp: '2026-06-22T00:00:00.000Z',
          metadata: {
            tokenCount: {
              inputTokenCount: 500,
              outputTokenCount: 100,
              cachedContentTokenCount: 200,
              thoughtsTokenCount: 50,
            },
          },
        }],
      }));

      const result = parseGeminiSession(file);
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
      expect(result.cacheReadTokens).toBe(200);
      expect(result.totalTokens).toBe(650);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
