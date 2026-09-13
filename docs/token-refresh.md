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
endpoint. They are renewed by a different, simpler mechanism — see
"Project credentials" below.

## Refresh timing

Let `threshold` be the pre-emptive refresh window in seconds.

- Refresh **before** a request when `now >= access_expires_at - threshold`.
  Pre-emptive beats reacting to a 401, because hooks have little retry room.
- Never refresh when there is no `refresh` token (legacy or logged-out).
- When `access_expires_at` is absent, fall back to the JWT `exp` claim; if that
  is also missing, do not pre-emptively refresh (an opaque token of unknown
  lifetime), and rely on the 401 path.

### Legacy tokens are reported, not refreshed

A bundle with `refresh: null` came from a pre-0.10 file. It cannot be rotated:
the server stores a hash of the refresh token it issued, and a legacy access
JWT was never in that table, so submitting it returns 401. There is no local
fix — only `agentboard login` mints a pair.

Silence is the wrong default here. The token still works until it expires, and
then uploads fail with a 401 nobody sees. So:

- While a legacy token is comfortably valid, do nothing. It works.
- Once it is within `legacyThreshold` of expiry, return `reauth_required` with
  a reason that says the token predates refresh support. Upload anyway — the
  access token has life left, and the caller decides what to do with the
  outcome.
- If expiry is unknown (no `access_expires_at` and no `exp`), stay silent.
  A warning with no basis is worse than none.
- On the post-401 `force` path, report it regardless of expiry. The server has
  just refused the token, so what it claims about its own lifetime is moot.

`legacyThreshold` is **not** the access threshold. That one defaults to 300s,
sized for a one-hour access token; a legacy token lasts 30 days, so 300s would
warn five minutes before collection breaks. It is
`AGENTBOARD_LEGACY_NOTICE_SECONDS`, default 7 days, and the TTL cap that
applies to the access threshold does not apply to it — the cap exists to stop a
misconfigured threshold from refreshing on every request, and this path never
calls the server.

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
4. `POST {api}/v1/auth/token/refresh` with `{"refresh_token": "<opaque>"}`.
   **요청 키는 `refresh_token`, 응답 키는 `refresh` 다.** 이름이 어긋나는 것은
   서버 스키마(`api/src/modules/auth/routes/token.ts`)가 그렇게 정해져 있기
   때문이다. 요청을 `refresh` 로 보내면 400(ZodError)이 오는데, 400 은 아래
   표에서 `unavailable` 로 분류되어 조용히 삼켜지므로 — 로테이션이 한 번도
   돌지 않으면서 에러도 보이지 않는 상태가 된다. 이 문서가 `refresh` 로
   적혀 있어 양쪽 구현이 같은 실수를 했다. `revoke` 도 같은 스키마를 쓴다.
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

The same file carries the legacy-token notice above. The two are different
situations and must not read the same: a rejected refresh token means renewal
was tried and failed, while a legacy token was never renewable in the first
place. Telling a legacy user that "renewal failed" describes something that
never happened.

The record is rewritten only when its reason changes. Hooks run on every
session end, and rewriting an identical record each time churns the file that
concurrent hooks are reading.

## Project credentials

`agentboard connect` stores a device credential per connected directory in
`credentials/<ref>.cred` (a bare JWT, mode `0600`). The organization server
issues it for 90 days by default (`PROJECT_CREDENTIAL_TTL_SECONDS`). Until
0.10.0 nothing renewed it, so every connection went dark 90 days after
`connect`, with a 401 no hook reported.

**Who renews.** Hooks only. They are the only code that uploads with these
credentials, and renewing on upload means a machine that is actually used never
expires, while one left unused for the whole lifetime does — no indefinite
bearer. The CLI never calls the server for this; `status` and `doctor` only
report.

**When.** Before an upload, when `now >= exp - threshold`:

```
threshold = min(AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS (default 30 days), floor(ttl / 3))
```

`ttl = exp - iat` from the credential's own claims. The cap is the same guard as
for access tokens: verifying renewal means shortening the server TTL, and an
uncapped 30-day window would renew on every upload.

- An already expired credential is **not** sent: the server only renews a
  credential that is still valid, so the request could only fail. The CLI tells
  the user to connect again.
- No `exp` claim: do not renew.

**Procedure.**

1. `POST {api}/v1/collector/renew`, `Authorization: Bearer <credential>`,
   body `{"device_id": "<binding device id>"}`.
2. **2xx** — `{"credential": "<jwt>", ...}`. The new credential must decode and
   carry a future `exp`, otherwise treat the reply as transient.
3. **Compare before writing.** Re-read the `.cred` file. Write the new
   credential (temp file + `rename`) only if the file still holds the exact
   credential that was renewed:
   - another hook renewed first → keep theirs; both are valid, and the server
     does not burn families here, so no lock is needed;
   - the file is gone → the connection was removed (`disconnect`) or replaced
     mid-flight; recreating it would leave a live credential with no binding.
4. **400 / 401 / 403 / 404** — refused (`revoked_device`, `not_a_member`,
   `project_not_found`, `device_not_found`, `invalid_credential`, …). Keep the
   current credential — it still works until it expires — and record the
   refusal in `project-renewal.json` (below).
5. **5xx / 429 / network / timeout** — transient. Keep the current credential
   and try again on the next upload.

A renewal problem **never blocks an upload.**

**Surfacing failure.** `~/.agentboard/project-renewal.json`:

```jsonc
{
  "v": 1,
  "failures": {
    "<credential ref>": { "at": "<iso>", "status": 403, "code": "revoked_device" }
  }
}
```

Rewritten only when a ref's status or code changes (the same churn rule as
`auth-failure.json`), and the ref's entry is removed after a successful renewal.
`status` and `doctor` show each connection's expiry and any refusal, and ignore
entries whose ref no longer belongs to a connection.

## Login / logout

- `login` adds `v=2` to the `/cli/login` URL. `/cli/login` and
  `/cli/callback/github` are a public contract and keep their paths. The server
  returns the pair as JSON only when `v=2` is present; otherwise it serves the
  old single-JWT page. The pasted value may be raw JSON or base64-wrapped JSON.
- `login` still saves **only after** the server accepts the token
  (`registerDevice` succeeds first).
- `logout` calls `POST /v1/auth/token/revoke` with the refresh token. Network
  failure still deletes local state, with a warning.
