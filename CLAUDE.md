# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc → dist/ (the CLI runs from dist/cli/index.js)
npm run dev            # run the CLI from TS source via tsx (no build step)
npm run lint           # type-check only (tsc --noEmit)
npm test               # vitest run (all tests once)
npm run test:watch     # vitest in watch mode
npx vitest run tests/unit/validation.test.ts    # run a single test file
npx vitest run -t "rejects forbidden"           # run tests matching a name
```

Requires Node >= 20. Tests are `vitest` and cover both `.ts` files (in `src/`) and `.mjs`
hook files (in `plugin/hooks/`) — see `vitest.config.ts` for the include globs.

## Architecture

This is a privacy-first CLI that collects **token usage counts only** (never prompts, code,
file paths, or repo info) from AI coding tools and uploads them to the AgentBoard API. The
README (Korean) is the canonical product spec for the privacy model.

The codebase is split into two intentionally separate runtimes — understand this before editing:

### 1. The CLI (`src/`, TypeScript, compiled to `dist/`)
User-facing commands wired up in `src/cli/index.ts` via `commander`, lazy-importing each command
module. Commands: `login`, `logout`, `status`, `doctor`, `install-hooks`, `uninstall-hooks`.
The CLI manages auth, device registration, and hook installation — it does **not** parse sessions
or upload usage at runtime.

`install-hooks` registers hooks into each detected tool's own config file: Claude Code gets
`plugin/hooks/session-end.mjs` on **both `Stop` (per turn) and `SessionEnd`** in
`~/.claude/settings.json`; Codex gets `codex-notify.mjs` as the `notify` command (per turn) in
`~/.codex/config.toml`. It locates the hooks dir relative to the compiled file at
`dist/cli/commands/` (3 levels up to package root), so the layout of `plugin/` vs `dist/` matters.

### 2. The hooks (`plugin/hooks/`, plain `.mjs`, shipped as-is)
These run **outside the compiled TypeScript context**, invoked by the AI tools themselves. The
upload pipeline lives entirely here, not in `src/`:

```
Claude Code turn ends (Stop) / session ends (SessionEnd)
  → session-end.mjs   reads hook payload from stdin, writes it to a temp file in os.tmpdir()/agentboard,
                      spawns worker.mjs detached, and exits immediately (stays under the tool's hook timeout)
  → worker.mjs        the real work: detectSource() → per-session lock → parse → delta → UsageEvent → upload
       ├ lib/parse-claude.mjs    (transcript .jsonl)
       └ lib/parse-codex.mjs     (UUID session id, no path)
```

`worker.mjs:detectSource()` infers the tool from the shape of `transcript_path`/`session_id` in
the payload; unrecognized shapes are dropped, never guessed. Uploads are **delta-based**: the
ledger `~/.agentboard/hook-sent.json` stores the cumulative totals already uploaded per
`source:sessionId`, and each invocation sends only what accrued since (`computeDelta` in
`lib/config.mjs`). A per-session lock (`acquireSessionLock`, mkdir-based under
`~/.agentboard/locks/`) keeps overlapping per-turn invocations from uploading the same delta
twice. Codex is collected by `codex-notify.mjs` (per-turn notify hook) through the same
delta + lock helpers.

### The deliberate duplication
`plugin/hooks/lib/config.mjs` re-implements config-dir resolution, token loading, and ID generation
that also exist in `src/core/config.ts` / `src/core/event-id.ts` / `src/platform/credential-store.ts`.
This duplication is **intentional** — the hooks can't import compiled TS. When you change config
paths, the API URL default, the device/event ID format, or `COLLECTOR_VERSION`, update **both**
sides. `COLLECTOR_VERSION` is hard-coded in `config.mjs` (currently `0.3.0`) and must match
`package.json` and `src/core/usage-event.ts`.

### Shared state on disk (`~/.agentboard/`, `%APPDATA%\agentboard` on Windows)
`config.json` (device_id + URLs), `.token` (auth, mode 0600), `hook-sent.json` (dedup ledger).
Config dir is created mode 0700. Local state lives here, never inside the package, so it survives
reinstalls/updates.

## The privacy guard (do not weaken)

`src/core/forbidden-data-guard.ts` defines `FORBIDDEN_KEYS` and `assertNoForbiddenFields()`, which
recursively rejects any payload whose keys contain forbidden fragments (prompt, code, content, file,
path, repo, commit, command, cwd, etc.). This is the enforcement mechanism for the privacy promise.
`tests/privacy/forbidden-keys.test.ts` and `tests/unit/forbidden-data-guard.test.ts` guard it. Any
field added to a `UsageEvent` must be a count, timestamp, model name, OS type, or the anonymized
device/event id — adding anything that could leak content will (and should) break these tests.

## Configuration / env vars

| Var | Purpose | Default |
|-----|---------|---------|
| `AGENTBOARD_API_URL` | core-api proxy endpoint | `https://agentboard.kro.kr/api/proxy` |
| `AGENTBOARD_APP_URL` | OAuth web app URL | derived from API URL origin |

Hooks also write a best-effort debug log to `<configdir>/hook-debug.log` (always on) for diagnosing
the detached worker, since its stdout/stderr are discarded.
