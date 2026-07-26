/**
 * Reads the full hook payload from stdin as a UTF-8 string.
 *
 * Shared by the stdin-based hook entry points (claude/session-end.mjs,
 * codex/session-end.mjs, codex/subagent-stop.mjs). worker.mjs does NOT use this
 * — it reads its payload from a temp file path passed on argv.
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
