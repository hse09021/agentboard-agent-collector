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

**Scope.** Everything up to "Project credentials" is about `.token`, the
default route. Each connected project's `credentials/<ref>.cred` rotates by the
same rules but through its own endpoints, files and lock, because it is a
different server's token — see "Project credentials" and "Keeping the routes
apart" below.

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

`agentboard connect` stores a credential per connected directory in
`credentials/<ref>.cred`, mode `0600`, issued by that project's organization
server. Until 0.10.0 nothing renewed it, so every connection went dark 90 days
after `connect`. 0.10.0 renewed the single 90-day credential; this section
adds access/refresh rotation, so a leaked file is good for an hour, and a
refresh token used twice is caught by the server.

**Who rotates.** Hooks only. They are the only code that uploads with these
credentials, and rotating on upload means a machine that is actually used
never expires, while one left unused for the whole lifetime does — no
indefinite bearer. The CLI never refreshes these; `status` and `doctor` only
report, and `disconnect` only revokes.

**Upgrade order is not fixed.** Self-hosted servers upgrade on the customer's
schedule, so a new collector must keep working against an old server. Every
decision below is made from the **shape of the server's reply**, never from a
guess at its version.

### Storage format

```jsonc
// credentials/<ref>.cred  (mode 0600)
{
  "v": 2,
  "access": "<jwt>",
  "access_expires_at": 1791003600,  // unix seconds
  "refresh": "<opaque>",
  "refresh_expires_at": 1798776000  // unix seconds, optional
}
```

The same discriminator as `.token`: a file whose first non-whitespace character
is `{` is the pair; anything else is a **legacy** bare 90-day JWT, promoted in
memory to `refresh: null`. A pair missing either token, or unparseable JSON,
is not a credential (it reads as missing, and `status` says to connect again).
A legacy credential is written back as the bare JWT it was.

Writes are atomic (sibling temp file + `rename`), in the CLI (`connect`) and
the hooks alike. The reader and writer are separate from `.token`'s on both
sides, even though the shapes are close — see "Keeping the routes apart".

### Protocol

| Path | Request | Success |
|---|---|---|
| `POST /v1/collector/enroll` | ticket as Bearer; body adds `"v": 2` | the pair below. Without `v` (or from an old server), `{ "credential" }` as before |
| `POST /v1/collector/refresh` | **no** auth header; `{"refresh_token", "device_id"}` | the pair |
| `POST /v1/collector/renew` | legacy credential as Bearer; body `{"device_id", "v": 2}` | the pair, and the credential sent is revoked at once. An old server ignores `v` and answers `{ "credential" }` |
| `POST /v1/collector/revoke` | `{"refresh_token"}` | always 204; revokes that refresh token's family |
| `POST /v1/collector/disconnect` | unchanged | unchanged; also revokes the device's refresh families |

The pair reply is `{"v": 2, "access", "access_expires_at", "refresh",
"refresh_expires_at", "device_id", "server", "project"}`. A pair's access token
carries `"pair": true`, and `renew` refuses it (400 `use_refresh`). That does
not touch the collector: a pair never calls `renew`, and whether a connection is
legacy is decided by the storage format, not by that claim.

### Rotation timing (pairs)

Same rule as `.token`: refresh before an upload when
`now >= access_expires_at - min(AGENTBOARD_REFRESH_THRESHOLD_SECONDS (300), ttl/3)`.
To verify rotation end to end, set the server's access TTL to 60s and the
threshold to 10s.

- An access token that has already expired is still refreshed — what has to
  be alive is the refresh token. A refresh token past `refresh_expires_at` is
  not sent; `status` says to connect again.
- A 401 on upload triggers **one** forced refresh and **one** retry. Never loop.

### Rotation procedure (pairs)

1. Take the connection's lock, `credentials/<ref>.lock` (same mechanics as
   `.token.lock`). One lock per connection: different connections are
   different families and never wait for each other. If the lock cannot be
   taken, do not refresh — re-read the file and use what the holder wrote.
2. **Re-read the file inside the lock.** If its refresh token changed, someone
   else rotated; use theirs.
3. `POST /v1/collector/refresh` to **the route's own** `api_base_url`.
4. Write the new pair atomically, inside the lock, and only if the file still
   holds the refresh token that was sent. If the file is gone, the connection
   was removed mid-flight; recreating it would leave a live credential with no
   connection.

Without the lock, the hazard is the same as for `.token`:

```
A Claude Code session and a Codex session in the same directory end together
hook 1: submits refresh "AAA" → success, AAA spent
hook 2: submits refresh "AAA" → outside the 30s grace window → reuse → family revoked
```

| Reply | Handling |
|---|---|
| 2xx | store as above |
| 401 `invalid_refresh` (missing, expired, revoked, reused, another device's), 403 `not_a_member`, 403 `revoked_device`, 404 `project_not_found`, 404 `device_not_found` | this refresh token is finished. Record it in `project-renewal.json` with a fingerprint of the token, and **never send that token again** — a spent refresh token sent twice only repeats the reuse detection. Keep using the access token until it expires. `status` and `doctor` say to connect again |
| 429 (body `code: "rate_limited"`), 5xx, 400, network, timeout | transient. Keep the current access token and try again on the next upload. The server counts its rate limit per client IP, so devices behind one address can still see 429 together |

A rotation problem **never blocks an upload.**

### Legacy credentials

A connection made before rotation, or against a server without it, holds a
legacy credential. It must move to a pair **without the user doing anything**:

- On the next upload — not 30 days before expiry — the hook calls `renew` with
  `"v": 2`, under the connection's lock, re-reading the file first.
- **A pair comes back:** the server has already revoked the credential that
  was sent, so the pair must be kept. Write it atomically inside the lock. If
  the write fails, the connection is lost: record `save_failed` (with a
  fingerprint of the revoked credential, so it is never sent again), use the
  new access token for this upload, and let `status` tell the user to connect
  again.
- **A `credential` comes back:** an old server, which hands out a fresh 90-day
  credential on every `renew`. Store it the same way (inside the lock, only if
  the file still holds the credential that was sent) and record the attempt in
  `project-renewal.json`. Ask again **at most once a
  day** per connection, so a server upgrade is picked up within a day without
  minting a credential per session. The old renewal window still applies on
  top: within `min(AGENTBOARD_PROJECT_RENEW_THRESHOLD_SECONDS (30 days), ttl/3)`
  of expiry the hook renews on every upload, exactly as before. That threshold
  applies to legacy credentials only.
- **Refused (400 / 401 / 403 / 404):** keep the credential, record the
  refusal and the attempt.
- **5xx / 429 / network / timeout:** transient; no attempt is recorded, so the
  next upload asks again.
- An already expired legacy credential is **not** sent: the server only renews
  a credential that is still valid. After a 401 a legacy credential is not
  sent either — `renew` refuses it for the same reason the upload did.

### Recording

`~/.agentboard/project-renewal.json`, written atomically:

```jsonc
{
  "v": 1,
  "failures": {
    "<ref>": { "at": "<iso>", "status": 401, "code": "invalid_refresh", "token_fp": "<16 hex>" }
  },
  "upgrades": {
    "<ref>": { "at": "<iso>", "outcome": "legacy" }  // or "refused"
  }
}
```

- `status` is absent for a failure that happened locally (`code: "save_failed"`).
- `token_fp` is the first 16 hex digits of the SHA-256 of the token the failure
  used up. The token itself is never stored here.
- An entry is rewritten only when it changes (the same churn rule as
  `auth-failure.json`), and removed after a successful rotation or exchange.
  The file is deleted when it holds nothing.
- `status` and `doctor` show, per connection: a pair's refresh expiry and any
  failure; a legacy credential's expiry, and "switches to rotating credentials
  on the next upload" until its server has answered the old way. Entries
  whose ref no longer belongs to a connection are ignored.

### Disconnect

`disconnect`, and `connect` replacing a connection, retire it (best-effort,
local deletion always proceeds):

1. Tell the server to revoke the device (`/v1/collector/disconnect`) only when
   no other connection on this machine uses the same device id. The stored
   access token is the Bearer even if it has expired; the server accepts it.
2. If the connection holds a refresh token, **always** `POST /v1/collector/revoke`
   with it — after step 1, so the device notice is not sent with an access token
   whose family was just revoked.
3. Delete the credential (overwritten, then unlinked) and its lock file.

## Keeping the routes apart

`.token` belongs to the default server (agentboard.cloud, or whatever `login`
targeted). Each `.cred` belongs to the organization server its directory is
connected to. A token sent to the other server is rejected — the signature does
not match — but by then it has been **shown to that server's operator**.
Rejection is a backstop; preventing it is the collector's job.

- Project rotation never reads or writes `.token` or `.token.lock`. Default
  route rotation never touches a `.cred` or `credentials/<ref>.lock`.
- Every refresh, renew or revoke goes only to the server that issued the token:
  the route's `api_base_url`.
- `ensureFreshToken()` (both runtimes) and `ApiClient`'s `autoRefresh` are for
  the default route only. Project rotation lives in
  `ensureFreshProjectCredential()` (`plugin/hooks/lib/project-credential.mjs`).
- The read/write functions for the two stores stay separate. Where a helper is
  shared (the lock, the atomic writer), the caller passes the path; there is no
  default that could fall back to `.token`.
- The hooks choose route and credential together in one place
  (`plugin/hooks/lib/upload-context.mjs`), which the Claude Code worker, the
  Codex hooks and the sweep all use.

## Login / logout

- `login` adds `v=2` to the `/cli/login` URL. `/cli/login` and
  `/cli/callback/github` are a public contract and keep their paths. The server
  returns the pair as JSON only when `v=2` is present; otherwise it serves the
  old single-JWT page. The pasted value may be raw JSON or base64-wrapped JSON.
- `login` still saves **only after** the server accepts the token
  (`registerDevice` succeeds first).
- `logout` calls `POST /v1/auth/token/revoke` with the refresh token. Network
  failure still deletes local state, with a warning.
