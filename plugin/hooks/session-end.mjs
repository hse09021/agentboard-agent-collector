#!/usr/bin/env node
/**
 * agentboard session-end hook entry point
 *
 * Registered as a SessionEnd hook for:
 *   - Claude Code  (~/.claude/settings.json  → hooks.SessionEnd)
 *   - OpenCode     (plugin system)
 *   - Antigravity CLI (~/.antigravity/settings.json  → hooks.SessionEnd)
 *   - Gemini CLI legacy (~/.gemini/settings.json  → hooks.SessionEnd)
 *
 * The hook runner (the AI tool) invokes this script and writes the hook
 * payload to stdin as JSON. This script:
 *   1. Reads the full payload from stdin
 *   2. Writes it to a temp file
 *   3. Spawns worker.mjs as a detached background process
 *   4. Exits immediately (< tool's hook timeout)
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = join(HOOKS_DIR, 'worker.mjs');
const TMP_DIR = join(tmpdir(), 'agentboard');

const DEBUG_LOG = join(
  process.env.APPDATA ?? join(tmpdir(), 'agentboard'),
  'agentboard',
  'hook-debug.log'
);

function debugLog(msg) {
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  debugLog(`hook invoked pid=${process.pid}`);

  let payloadText = '';
  try {
    payloadText = await readStdin();
  } catch {
    // stdin may not be available in some environments; continue with empty
  }

  debugLog(`stdin length=${payloadText.length} preview=${payloadText.slice(0, 120).replace(/\n/g, ' ')}`);

  let payload = {};
  try {
    if (payloadText.trim()) {
      payload = JSON.parse(payloadText);
    }
  } catch {
    payload = { raw: payloadText };
  }

  debugLog(`payload keys=${Object.keys(payload).join(',')} session_id=${payload.session_id ?? payload.sessionId ?? 'none'}`);

  let tmpFile;
  try {
    mkdirSync(TMP_DIR, { recursive: true });
    tmpFile = join(TMP_DIR, `payload-${Date.now()}-${process.pid}.json`);
    writeFileSync(tmpFile, JSON.stringify(payload));
  } catch (err) {
    process.stderr.write(`agentboard: failed to write temp payload: ${err.message}\n`);
    process.exit(0);
  }

  try {
    const child = spawn(process.execPath, [WORKER_PATH, tmpFile], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    process.stderr.write(`agentboard: failed to spawn worker: ${err.message}\n`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
