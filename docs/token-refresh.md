# Token refresh — behaviour spec

The collector reaches the server by two paths that **cannot share code**:

| Path | Code | Nature |
|---|---|---|
| CLI | `src/api/client.ts` + `src/platform/credential-store.ts` (TypeScript, built) | interactive, has stdout |
| Hook | `plugin/hooks/lib/*.mjs` (standalone ESM) | background, non-interactive |

Hooks are executed directly by Claude Code / Codex (`node .../session-end.mjs`), so
they cannot import from `src/`. The **token file is shared**; the code is not.

This document is the contract both implementations follow. Change it first, then
change both sides.

## Storage format

`~/.agentboard/.token`, mode `0600`:

```jsonc
{
  "v": 1,
  "access": "<jwt>",
  "access_expires_at": 1757260800,  // unix seconds, for pre-emptive refresh
  "refresh": "<opaque>",
  "refresh_expires_at": 1765000000  // unix seconds, optional
}
```

**Legacy compatibility.** A file whose first non-whitespace character is not `{`
is a pre-0.10 single JWT. It is promoted in memory to
`{ v: 1, access: <raw>, refresh: null }` so callers only ever handle one shape.
Legacy files are never rewritten on read — only a successful refresh or a fresh
login writes the new format.

**Atomic writes.** Always write a sibling temp file and `rename()`. Hooks read
this file concurrently; a truncated read must be impossible. Mode `0600` must
survive every write.

**Scope.** Refresh applies to `.token` (the default route) only. Per-project
credentials under `credentials/<ref>.cred` are separate enrollment credentials,
are not part of a refresh family, and must never be sent to the refresh
endpoint.

## Refresh timing

Let `threshold` be the pre-emptive refresh window in seconds.

- Refresh **before** a request when `now >= access_expires_at - threshold`.
  Pre-emptive beats reacting to a 401, because hooks have little retry room.
- Never refresh when there is no `refresh` token (legacy or logged-out).
- When `access_expires_at` is absent, fall back to the JWT `exp` claim; if that
  is also missing, do not pre-emptively refresh (an opaque token of unknown
  lifetime), and rely on the 401 path.

### The threshold must not be a constant

Verifying rotation end-to-end means shortening the server's access TTL to 60s.
With a hardcoded 300s threshold, `exp - 300` is already in the past the moment a
token is issued, so **every** request refreshes: the "only when near expiry"
branch is never exercised, and `/v1/auth/token/refresh` (unauthenticated, IP
rate-limited at 30/min by default) starts returning 429.

So the threshold is configurable on both sides via
`AGENTBOARD_REFRESH_THRESHOLD_SECONDS`, and is additionally capped:

```
effective = min(configured, floor(ttl / 3))
```

where `ttl = access_expires_at - issued_at` (using the JWT `iat` claim, else the
observed lifetime). The cap makes a misconfigured threshold degrade to "refresh
near the end of the lifetime" instead of "refresh on every request".

| Value | Production | Rotation verification |
|---|---|---|
| server `AUTH_CLI_TOKEN_TTL_SECONDS` | 3600 | 60 |
| collector `AGENTBOARD_REFRESH_THRESHOLD_SECONDS` | 300 (default) | 10 |

## Refresh procedure

1. Decide a refresh is needed (pre-emptive, or a 401 came back).
2. **Acquire the file lock** (below).
3. **Re-read the token file.** Another process may have refreshed while we
   waited. If the access token on disk is now usable, use it and do not call the
   server.
4. `POST {api}/v1/auth/token/refresh` with `{"refresh": "<opaque>"}`.
5. On success, write the new bundle atomically.
6. **Release the lock in `finally`.**

Responses:

- **2xx** — `{"v":1,"access":…,"access_expires_at":…,"refresh":…,"refresh_expires_at":…}`.
  Persist and continue.
- **401 / 403** — the refresh token is dead (expired, revoked, or the family was
  burned). Re-login is required. The stored bundle is left alone; the CLI says
  so, the hook records it (see "Surfacing failure").
- **5xx / network / timeout** — transient. **Keep the existing bundle** and let
  the caller proceed with the current access token; it may still be valid.

A 401 on a normal request triggers **at most one** refresh-and-retry. Never loop.

## File lock

`~/.agentboard/.token.lock`, created with `fs.openSync(path, 'wx')` — atomic
create-if-absent, and unlike `mkdir` it carries an mtime we can age.

- **Acquire fails** → wait briefly and re-read the token file; another process is
  most likely finishing a refresh right now. Bounded loop, no recursion.
- **Stale** → mtime older than 30s is treated as dead and taken over. Hooks are
  killed often enough that a leaked lock is a real scenario, and a permanently
  stuck lock would delay every later refresh.
- **Release in `finally`**, always.

Two hooks refreshing with the same refresh token would look like token theft to
the server and burn the whole family — logging the user out. The lock is the
first of two defences; the second is the server's 30s grace window on `used_at`.

## Surfacing failure

A hook has no stdout the user reads. When it cannot refresh because the refresh
token itself is rejected, it appends to `~/.agentboard/auth-failure.json`, and
the next `agentboard status` / `agentboard doctor` shows it.

## Login / logout

- `login` adds `v=2` to the `/cli/login` URL. `/cli/login` and
  `/cli/callback/github` are a public contract and keep their paths. The server
  returns the pair as JSON only when `v=2` is present; otherwise it serves the
  old single-JWT page. The pasted value may be raw JSON or base64-wrapped JSON.
- `login` still saves **only after** the server accepts the token
  (`registerDevice` succeeds first).
- `logout` calls `POST /v1/auth/token/revoke` with the refresh token. Network
  failure still deletes local state, with a warning.
