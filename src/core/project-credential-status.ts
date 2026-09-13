/**
 * How a connected project's credential is described to the user.
 *
 * Hooks renew these credentials in the background
 * (plugin/hooks/lib/project-credential.mjs). When renewal is refused, or a
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

export interface ProjectRenewalFailure {
  at: string;
  status: number;
  code?: string;
}

export type ProjectCredentialStatus =
  | { kind: "missing" }
  /** No readable expiry. Nothing to renew or warn about. */
  | { kind: "unknown" }
  | { kind: "valid"; expiresAt: Date; renewalDue: boolean }
  | { kind: "expired"; expiresAt: Date };

export function describeProjectCredential(
  credential: string | null,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): ProjectCredentialStatus {
  if (!credential) return { kind: "missing" };
  const claims = decodeJwtClaims(credential);
  if (typeof claims?.exp !== "number") return { kind: "unknown" };

  const expiresAt = new Date(claims.exp * 1000);
  if (expiresAt.getTime() <= nowMs) return { kind: "expired", expiresAt };
  return { kind: "valid", expiresAt, renewalDue: isProjectRenewalDue(claims, nowMs, env) };
}

export function getProjectRenewalPath(): string {
  return path.join(getConfigDir(), "project-renewal.json");
}

/** Written by the hooks. Unreadable or absent reads as "no refusals". */
export function readProjectRenewalFailures(): Record<string, ProjectRenewalFailure> {
  try {
    const target = getProjectRenewalPath();
    if (!fs.existsSync(target)) return {};
    const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as { failures?: unknown };
    if (typeof parsed?.failures !== "object" || parsed.failures === null) return {};

    const out: Record<string, ProjectRenewalFailure> = {};
    for (const [ref, raw] of Object.entries(parsed.failures as Record<string, unknown>)) {
      const r = raw as Record<string, unknown>;
      if (typeof r?.status !== "number") continue;
      out[ref] = {
        at: typeof r.at === "string" ? r.at : "",
        status: r.status,
        code: typeof r.code === "string" ? r.code : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

const REFUSAL_REASONS: Record<string, string> = {
  not_a_member: "you are no longer a member of this organization",
  project_not_found: "the project was archived or deleted",
  device_not_found: "the server no longer knows this device",
  invalid_credential: "the server rejected the credential",
};

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  failure?: ProjectRenewalFailure
): { ok: boolean; message: string } {
  const reconnect = `run \`agentboard connect ${binding.abs_dir}\` again`;

  switch (status.kind) {
    case "missing":
      return { ok: false, message: `credential missing — ${reconnect}` };
    case "unknown":
      return { ok: true, message: "credential without an expiry" };
    case "expired":
      return { ok: false, message: `expired on ${day(status.expiresAt)} — ${reconnect}` };
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
        const why =
          (failure.code && REFUSAL_REASONS[failure.code]) ||
          `HTTP ${failure.status}${failure.code ? ` ${failure.code}` : ""}`;
        return {
          ok: false,
          message: `renewal refused (${why}); stops working on ${day(status.expiresAt)}`,
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
 * The rows `status` and `doctor` print. Refusals recorded for refs that no
 * longer belong to a connection are ignored — a disconnect does not clean the
 * record, and a stale warning about a connection that is gone would mislead.
 */
export function reportProjectCredentials(
  bindings: Binding[],
  loadCredential: (ref: string) => string | null,
  nowMs: number = Date.now()
): ProjectCredentialRow[] {
  const failures = readProjectRenewalFailures();
  return bindings.map((b) => {
    const status = describeProjectCredential(loadCredential(b.credential_ref), nowMs);
    const { ok, message } = formatProjectCredential(b, status, failures[b.credential_ref]);
    const where = b.server.label ?? b.server.app_base_url;
    return { label: `${b.project_label ?? b.abs_dir} -> ${where}`, ok, message };
  });
}
