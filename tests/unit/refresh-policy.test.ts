/**
 * Refresh timing (stage 3).
 *
 * The thing these tests exist to prevent: a threshold that is large relative to
 * the token's lifetime makes EVERY request refresh. That is not a small
 * inefficiency — the refresh endpoint is unauthenticated and IP rate-limited to
 * 30/min, so a hook firing on every session end starts collecting 429s, and the
 * "only when near expiry" branch is never exercised at all.
 */

import { describe, it, expect } from "vitest";
import {
  configuredThresholdSeconds,
  effectiveThresholdSeconds,
  shouldRefresh,
  tokenTtlSeconds,
  DEFAULT_REFRESH_THRESHOLD_SECONDS,
  REFRESH_THRESHOLD_ENV,
} from "../../src/core/refresh-policy";

describe("configuredThresholdSeconds", () => {
  it("defaults to 300s", () => {
    expect(configuredThresholdSeconds({})).toBe(DEFAULT_REFRESH_THRESHOLD_SECONDS);
  });

  // 로테이션 검증에서 TTL 60초와 함께 낮추는 값. 상수로 박으면 검증이 불가능하다.
  it("reads the env var", () => {
    expect(configuredThresholdSeconds({ [REFRESH_THRESHOLD_ENV]: "10" })).toBe(10);
  });

  it("falls back to the default for a malformed value", () => {
    for (const raw of ["", "abc", "-5", "NaN"]) {
      expect(configuredThresholdSeconds({ [REFRESH_THRESHOLD_ENV]: raw })).toBe(
        DEFAULT_REFRESH_THRESHOLD_SECONDS
      );
    }
  });
});

describe("effectiveThresholdSeconds", () => {
  it("uses the configured value when it is well under the TTL", () => {
    expect(effectiveThresholdSeconds(3600, 300)).toBe(300);
  });

  // 임계값이 TTL 이상이면 발급 직후부터 항상 "만료 임박" 이 되어 매 요청 갱신이다.
  it("caps the threshold at a third of the TTL", () => {
    expect(effectiveThresholdSeconds(60, 300)).toBe(20);
    expect(effectiveThresholdSeconds(30, 300)).toBe(10);
  });

  it("applies the configured value when the TTL is unknown", () => {
    expect(effectiveThresholdSeconds(undefined, 300)).toBe(300);
  });

  it("ignores a nonsensical TTL", () => {
    expect(effectiveThresholdSeconds(0, 300)).toBe(300);
    expect(effectiveThresholdSeconds(-1, 300)).toBe(300);
  });
});

describe("tokenTtlSeconds", () => {
  it("derives the lifetime from iat/exp", () => {
    expect(tokenTtlSeconds({ iat: 1000, exp: 4600 })).toBe(3600);
  });

  it("returns undefined when either claim is missing", () => {
    expect(tokenTtlSeconds({ exp: 4600 })).toBeUndefined();
    expect(tokenTtlSeconds({ iat: 1000 })).toBeUndefined();
    expect(tokenTtlSeconds({})).toBeUndefined();
  });

  it("returns undefined for a non-positive lifetime", () => {
    expect(tokenTtlSeconds({ iat: 4600, exp: 1000 })).toBeUndefined();
  });
});

describe("shouldRefresh", () => {
  const now = 1_760_000_000_000; // ms
  const nowSec = now / 1000;

  it("does not refresh a token with plenty of life left", () => {
    expect(shouldRefresh(nowSec + 3600, 300, now)).toBe(false);
  });

  it("refreshes once inside the threshold", () => {
    expect(shouldRefresh(nowSec + 200, 300, now)).toBe(true);
  });

  it("refreshes exactly at the boundary", () => {
    expect(shouldRefresh(nowSec + 300, 300, now)).toBe(true);
  });

  it("refreshes an already expired token", () => {
    expect(shouldRefresh(nowSec - 10, 300, now)).toBe(true);
  });

  // 수명을 모르는 불투명 토큰을 매번 갱신하면 그것도 rate limit 행이다.
  it("does not pre-emptively refresh when the expiry is unknown", () => {
    expect(shouldRefresh(undefined, 300, now)).toBe(false);
  });
});

describe("short-TTL verification scenario", () => {
  // 이슈의 검증 시나리오: 서버 TTL 60초 + 임계값 10초. 매 요청 갱신이 되면 안 된다.
  it("does not refresh on every request at TTL 60s / threshold 10s", () => {
    const issuedAt = 1_760_000_000;
    const exp = issuedAt + 60;
    const threshold = effectiveThresholdSeconds(60, 10); // min(10, 20) = 10

    expect(threshold).toBe(10);
    // Freshly issued, and halfway through: no refresh.
    expect(shouldRefresh(exp, threshold, issuedAt * 1000)).toBe(false);
    expect(shouldRefresh(exp, threshold, (issuedAt + 30) * 1000)).toBe(false);
    // Only in the last 10 seconds.
    expect(shouldRefresh(exp, threshold, (issuedAt + 51) * 1000)).toBe(true);
  });

  // 같은 TTL 60초인데 임계값을 안 줄이면(기본 300초) 상한이 없으면 매 요청 갱신이다.
  it("the cap prevents refresh-on-every-request when the threshold was not lowered", () => {
    const issuedAt = 1_760_000_000;
    const exp = issuedAt + 60;
    const capped = effectiveThresholdSeconds(60, 300);

    expect(capped).toBe(20);
    expect(shouldRefresh(exp, capped, issuedAt * 1000)).toBe(false);
    // Without the cap this would be true from the moment of issue:
    expect(shouldRefresh(exp, 300, issuedAt * 1000)).toBe(true);
  });
});
