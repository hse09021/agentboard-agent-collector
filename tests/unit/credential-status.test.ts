/**
 * How `status` and `doctor` describe the stored credential (stage 5).
 *
 * The trap this guards: with rotation, an EXPIRED access token is the normal
 * state between renewals. Reporting that as a failing check would make a
 * perfectly healthy install look broken and send users to re-login for no
 * reason. What actually decides health is whether renewal is still possible.
 */

import { describe, it, expect } from "vitest";
import {
  describeCredential,
  formatCredentialStatus,
  isCredentialHealthy,
} from "../../src/core/credential-status";

const NOW = new Date("2026-09-12T12:00:00Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const offset = (seconds: number) => sec(NOW) + seconds;

describe("describeCredential", () => {
  it("reports absent when nothing is stored", () => {
    expect(describeCredential(null, NOW)).toEqual({ kind: "absent" });
    expect(isCredentialHealthy(describeCredential(null, NOW))).toBe(false);
  });

  it("classifies a legacy token with no refresh", () => {
    const status = describeCredential(
      { v: 1, access: "a", access_expires_at: offset(86_400), refresh: null },
      NOW
    );

    expect(status.kind).toBe("legacy");
    expect(isCredentialHealthy(status)).toBe(true);
    expect(formatCredentialStatus(status, NOW)).toContain("no automatic renewal");
  });

  it("marks an expired legacy token unhealthy", () => {
    const status = describeCredential(
      { v: 1, access: "a", access_expires_at: offset(-10), refresh: null },
      NOW
    );

    expect(isCredentialHealthy(status)).toBe(false);
    expect(formatCredentialStatus(status, NOW)).toContain("agentboard login");
  });

  it("classifies a rotating bundle and reports when it renews", () => {
    const status = describeCredential(
      {
        v: 1,
        access: "a",
        access_expires_at: offset(3600),
        refresh: "r",
        refresh_expires_at: offset(7_776_000),
      },
      NOW
    );

    expect(status.kind).toBe("rotating");
    expect(isCredentialHealthy(status)).toBe(true);
    const text = formatCredentialStatus(status, NOW);
    expect(text).toContain("renews");
    expect(text).toContain("renewal valid until");
  });

  // 회전 사이에는 access 가 만료돼 있는 게 정상이다. 이걸 빨간불로 띄우면
  // 멀쩡한 설치가 고장난 것처럼 보인다.
  it("stays healthy when the access token expired but renewal is available", () => {
    const status = describeCredential(
      {
        v: 1,
        access: "a",
        access_expires_at: offset(-60),
        refresh: "r",
        refresh_expires_at: offset(7_776_000),
      },
      NOW
    );

    expect(isCredentialHealthy(status)).toBe(true);
    expect(formatCredentialStatus(status, NOW)).toContain("renews on next use");
  });

  // refresh 까지 만료면 스스로 회복할 수 없다 — 이때만 재로그인을 요구해야 한다.
  it("is unhealthy once the refresh token itself expires", () => {
    const status = describeCredential(
      {
        v: 1,
        access: "a",
        access_expires_at: offset(-60),
        refresh: "r",
        refresh_expires_at: offset(-10),
      },
      NOW
    );

    expect(isCredentialHealthy(status)).toBe(false);
    expect(formatCredentialStatus(status, NOW)).toContain("agentboard login");
  });

  it("handles an opaque token with no expiry information", () => {
    const status = describeCredential({ v: 1, access: "opaque", refresh: null }, NOW);

    expect(isCredentialHealthy(status)).toBe(true);
    expect(formatCredentialStatus(status, NOW)).toContain("expiry unknown");
  });
});
