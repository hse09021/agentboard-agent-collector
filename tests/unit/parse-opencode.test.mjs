import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseOpenCodeSession } from '../../plugin/hooks/lib/parse-opencode.mjs';

describe('parseOpenCodeSession — cache token fields', () => {
  it('keeps cache creation and cache read tokens separate', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'agentboard-opencode-'));
    const previousDataHome = process.env.XDG_DATA_HOME;
    const sessionDir = join(dataHome, 'opencode', 'storage', 'message', 'ses_test');

    try {
      process.env.XDG_DATA_HOME = dataHome;
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'message.json'), JSON.stringify({
        role: 'assistant',
        model: 'test-model',
        tokens: {
          input: 500,
          output: 100,
          cache: { write: 50, read: 200 },
        },
        time: { created: '2026-06-22T00:00:00.000Z' },
      }));

      const result = parseOpenCodeSession('ses_test');
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(100);
      expect(result.cacheCreationTokens).toBe(50);
      expect(result.cacheReadTokens).toBe(200);
      expect(result.totalTokens).toBe(650);
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
      rmSync(dataHome, { recursive: true, force: true });
    }
  });
});
