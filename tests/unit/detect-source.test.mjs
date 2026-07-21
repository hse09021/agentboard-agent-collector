import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// detectSource is internal to worker.mjs, which runs its upload pipeline on
// import. Extract the function instead of importing the module.
const WORKER = fileURLToPath(
  new URL('../../plugin/hooks/worker.mjs', import.meta.url)
);

function loadDetectSource() {
  const src = readFileSync(WORKER, 'utf-8');
  const consts = src.slice(
    src.indexOf('const CODEX_SESSION_ID'),
    src.indexOf('// ─── Source detection')
  );
  const body = src.slice(
    src.indexOf('// Only Claude Code and Codex'),
    src.indexOf('// ─── UsageEvent builder')
  );
  return new Function('basename', `${consts}${body}; return detectSource;`)(
    basename
  );
}

const detectSource = loadDetectSource();

describe('detectSource', () => {
  it('detects Claude Code from a .jsonl transcript path', () => {
    const result = detectSource({
      transcript_path: '/Users/x/.claude/projects/proj/abc.jsonl',
    });
    expect(result?.source).toBe('claude_code');
  });

  it('detects Codex from a bare UUID session id', () => {
    const result = detectSource({
      session_id: '019f2034-6632-7212-a407-5a4ff1a88434',
    });
    expect(result?.source).toBe('codex');
  });

  // Regression: OpenCode sends a bare session id with no transcript path, the
  // same shape as Codex. Matching "any id without a path" as Codex would file
  // OpenCode usage under Codex.
  it('does not mistake an OpenCode session id for Codex', () => {
    expect(detectSource({ session_id: 'ses_abc123' })).toBeNull();
  });

  it.each([
    ['Gemini CLI', '/Users/x/.gemini/tmp/z/chats/session-1.json'],
    ['Antigravity', '/Users/x/.antigravity/tmp/z/chats/session-1.json'],
  ])('drops %s payloads', (_name, transcript_path) => {
    expect(detectSource({ transcript_path })).toBeNull();
  });

  it('returns null for an empty payload', () => {
    expect(detectSource({})).toBeNull();
  });
});
