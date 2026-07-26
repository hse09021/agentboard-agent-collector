import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// detectSource is internal to worker.mjs, which runs its upload pipeline on
// import. Extract the function instead of importing the module.
const WORKER = fileURLToPath(
  new URL('../../plugin/hooks/claude/worker.mjs', import.meta.url)
);

function loadDetectSource() {
  const src = readFileSync(WORKER, 'utf-8');
  const body = src.slice(
    src.indexOf('// ─── Source detection'),
    src.indexOf('// ─── UsageEvent builder')
  );
  return new Function('basename', `${body}; return detectSource;`)(basename);
}

const detectSource = loadDetectSource();

describe('detectSource', () => {
  it('detects Claude Code from a .jsonl transcript path', () => {
    const result = detectSource({
      transcript_path: '/Users/x/.claude/projects/proj/abc.jsonl',
    });
    expect(result?.source).toBe('claude_code');
  });

  // Only Claude Code is collected through this worker; a bare session id with
  // no .jsonl transcript path (Codex, or any other tool) is dropped here.
  it('drops a bare session id with no transcript path', () => {
    expect(
      detectSource({ session_id: '019f2034-6632-7212-a407-5a4ff1a88434' })
    ).toBeNull();
    expect(detectSource({ session_id: 'ses_abc123' })).toBeNull();
  });

  it('drops payloads whose transcript path is not a .jsonl session file', () => {
    expect(detectSource({ transcript_path: '/Users/x/tmp/z/chats/session-1.json' })).toBeNull();
  });

  it('returns null for an empty payload', () => {
    expect(detectSource({})).toBeNull();
  });
});
