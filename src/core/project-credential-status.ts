/**
 * How a connected project's credential is described to the user.
 *
 * Hooks rotate or renew these credentials in the background
 * (plugin/hooks/lib/project-credential.mjs). When the server refuses, or a
 * machine went unused until the credential expired, the only symptom would be
 * an organization dashboard that stops growing — so `status` and `doctor` say
 * it, and share this module so the two cannot disagree.
 *
 * "Project credentials" in docs/token-refresh.md is the contract.
 */

import * as fs from "fs";
import * as path from "path";
import type { Binding } from "./config-schema";
import { getConfigDir } from "./config";
import { decodeJwtClaims } from "./jwt";
import { isProjectRenewalDue } from "./refresh-policy";
import {
  parseProjectCredentialFile,
  type ProjectCredential,
} from "../platform/credential-store";

export interface ProjectRenewalFailure {
  at: string;
  /** Absent for a failure that happened here rather than on the server. */
  status?: number;
  code?: string;
}

/**
 * When a legacy connection last asked to be exchanged for a pair. `legacy`
 * means its server answered the old way: it does not support rotation yet.
 */
export interface ProjectUpgradeAttempt {
  at: string;
  outcome: "legacy" | "refused";
}

export type ProjectCredentialStatus =
  | { kind: "missing" }
  /** A legacy credential with no readable expiry. Nothing to warn about. */
  | { kind: "unknown" }
  /** A legacy credential, renewed through /v1/collector/renew. */
  | { kind: "valid"; expiresAt: Date; renewalDue: boolean }
  /** The legacy credential, or the pair's refresh token, has expired. */
  | { kind: "expired"; expiresAt: Date }
  /** An access/refresh pair, rotated by the hooks. */
  | { kind: "rotating"; refreshExpiresAt?: Date };

/**
 * @param credential the stored credential; a string is read as file contents
 */
export function describeProjectCredential(
  credential: ProjectCredential | string | null,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): ProjectCredentialStatus {
  const stored = typeof credential === "string" ? parseProjectCredentialFile(credential) : credential;
  if (!stored) return { kind: "missing" };

  if (stored.refresh) {
    if (stored.refresh_expires_at === undefined) return { kind: "rotating" };
    const refreshExpiresAt = new Date(stored.refresh_expires_at * 1000);
    if (refreshExpiresAt.getTime() <= nowMs) return { kind: "expired", expiresAt: refreshExpiresAt };
    return { kind: "rotating", refreshExpiresAt };
  }

  const claims = decodeJwtClaims(stored.access);
  if (typeof claims?.exp !== "number") return { kind: "unknown" };

  const expiresAt = new Date(claims.exp * 1000);
  if (expiresAt.getTime() <= nowMs) return { kind: "expired", expiresAt };
  return { kind: "valid", expiresAt, renewalDue: isProjectRenewalDue(claims, nowMs, env) };
}

export function getProjectRenewalPath(): string {
  return path.join(getConfigDir(), "project-renewal.json");
}

function readRenewalRecord(): { failures?: unknown; upgrades?: unknown } {
  try {
    const target = getProjectRenewalPath();
    if (!fs.existsSync(target)) return {};
    const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function entries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).filter(
    (e): e is [string, Record<string, unknown>] => typeof e[1] === "object" && e[1] !== null
  );
}

/** Written by the hooks. Unreadable or absent reads as "no refusals". */
export function readProjectRenewalFailures(): Record<string, ProjectRenewalFailure> {
  const out: Record<string, ProjectRenewalFailure> = {};
  for (const [ref, r] of entries(readRenewalRecord().failures)) {
    const status = typeof r.status === "number" ? r.status : undefined;
    const code = typeof r.code === "string" && r.code ? r.code : undefined;
    if (status === undefined && code === undefined) continue;
    out[ref] = { at: typeof r.at === "string" ? r.at : "", status, code };
  }
  return out;
}

/** Written by the hooks. Unreadable or absent reads as "never asked". */
export function readProjectUpgradeAttempts(): Record<string, ProjectUpgradeAttempt> {
  const out: Record<string, ProjectUpgradeAttempt> = {};
  for (const [ref, r] of entries(readRenewalRecord().upgrades)) {
    if (r.outcome !== "legacy" && r.outcome !== "refused") continue;
    out[ref] = { at: typeof r.at === "string" ? r.at : "", outcome: r.outcome };
  }
  return out;
}

const REFUSAL_REASONS: Record<string, string> = {
  not_a_member: "you are no longer a member of this organization",
  project_not_found: "the project was archived or deleted",
  device_not_found: "the server no longer knows this device",
  invalid_credential: "the server rejected the credential",
  invalid_refresh: "the server no longer accepts this connection's refresh token",
};

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function refusalReason(failure: ProjectRenewalFailure): string {
  return (
    (failure.code && REFUSAL_REASONS[failure.code]) ||
    (failure.status !== undefined
      ? `HTTP ${failure.status}${failure.code ? ` ${failure.code}` : ""}`
      : failure.code ?? "refused")
  );
}

/**
 * One line per connection, plus whether it needs the user's attention.
 *
 * A refusal only matters while the credential still works: once it expires,
 * "connect again" is the whole story regardless of why renewal failed.
 */
export function formatProjectCredential(
  binding: Pick<Binding, "abs_dir">,
  status: ProjectCredentialStatus,
  failure?: ProjectRenewalFailure,
  upgrade?: ProjectUpgradeAttempt
): { ok: boolean; message: string } {
  const reconnect = `run \`agentboard connect ${binding.abs_dir}\` again`;

  // The server replaced the credential and the replacement was lost: what is
  // on disk has been revoked or spent, whatever its expiry says.
  if (failure?.code === "save_failed" && status.kind !== "missing") {
    return {
      ok: false,
      message: `a renewed credential could not be saved, so uploads have stopped — ${reconnect}`,
    };
  }

  switch (status.kind) {
    case "missing":
      return { ok: false, message: `credential missing — ${reconnect}` };
    case "unknown":
      return { ok: true, message: "credential without an expiry" };
    case "expired":
      return { ok: false, message: `expired on ${day(status.expiresAt)} — ${reconnect}` };
    case "rotating": {
      if (failure?.code === "revoked_device") {
        return {
          ok: false,
          message: `this device was revoked on the server; uploads are blocked — ${reconnect}`,
        };
      }
      // The access token lasts an hour, so a refused refresh means the
      // connection has stopped, not that it will.
      if (failure) {
        return {
          ok: false,
          message: `the server stopped renewing this connection (${refusalReason(failure)}) — ${reconnect}`,
        };
      }
      return {
        ok: true,
        message: status.refreshExpiresAt
          ? `rotates automatically (refresh expires ${day(status.refreshExpiresAt)})`
          : "rotates automatically",
      };
    }
    case "valid": {
      // A revoked device is refused at upload too, so it has already stopped —
      // "stops working on <expiry>" would promise days that do not exist.
      if (failure?.code === "revoked_device") {
        return {
          ok: false,
          message: `this device was revoked on the server; uploads are blocked — ${reconnect}`,
        };
      }
      if (failure) {
        return {
          ok: false,
          message: `renewal refused (${refusalReason(failure)}); stops working on ${day(status.expiresAt)}`,
        };
      }
      // Until its server has said it cannot, a legacy connection is exchanged
      // for a pair on the next upload.
      if (upgrade?.outcome !== "legacy") {
        return {
          ok: true,
          message: `switches to rotating credentials on the next upload (expires ${day(status.expiresAt)})`,
        };
      }
      return {
        ok: true,
        message: status.renewalDue
          ? `renews on the next upload (expires ${day(status.expiresAt)})`
          : `renews automatically (expires ${day(status.expiresAt)})`,
      };
    }
  }
}

export interface ProjectCredentialRow {
  label: string;
  ok: boolean;
  message: string;
}

/**
 * The rows `status` and `doctor` print. Records kept for refs that no longer
 * belong to a connection are ignored — a disconnect does not clean the
 * record, and a stale warning about a connection that is gone would mislead.
 */
export function reportProjectCredentials(
  bindings: Binding[],
  loadCredential: (ref: string) => ProjectCredential | string | null,
  nowMs: number = Date.now()
): ProjectCredentialRow[] {
  const failures = readProjectRenewalFailures();
  const upgrades = readProjectUpgradeAttempts();
  return bindings.map((b) => {
    const status = describeProjectCredential(loadCredential(b.credential_ref), nowMs);
    const { ok, message } = formatProjectCredential(
      b,
      status,
      failures[b.credential_ref],
      upgrades[b.credential_ref]
    );
    const where = b.server.label ?? b.server.app_base_url;
    return { label: `${b.project_label ?? b.abs_dir} -> ${where}`, ok, message };
  });
}
