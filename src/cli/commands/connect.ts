import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";
import { logger } from "../../core/logger";
import { COLLECTOR_VERSION } from "../../core/usage-event";
import { decodeJwtClaims, type JwtClaims } from "../../core/jwt";
import { generateDeviceId } from "../../core/device-id";
import { detectOS } from "../../platform/os";
import {
  addBinding,
  findDeviceIdForServer,
  generateCredentialRef,
  loadConfigV2,
  removeBinding,
  saveConfigV2,
} from "../../core/bindings";
import { saveCredential, deleteCredential } from "../../platform/credential-store";
import { retireBinding, type RetireOutcome } from "../../core/retire-binding";
import type { Binding, CollectorConfigV2 } from "../../core/config-schema";
import { ApiError, extractErrorCode } from "../../api/client";

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * An enrollment ticket decides where a directory's telemetry goes, and the
 * collector cannot verify its signature — it holds no key. So anything that
 * looks wrong is refused before the address is shown, the address is put in
 * front of the user before anything is written, and the server has to accept
 * the ticket before a binding exists.
 */
function validateTicket(claims: JwtClaims | null): { api: string; app: string } | string {
  if (!claims) return "That does not look like an enrollment token.";

  if (claims.typ && claims.typ !== "agentboard-enroll") {
    return `Wrong token type (${claims.typ}). Use the enrollment token shown when you were added to the project.`;
  }

  const api = typeof claims.api === "string" ? claims.api : undefined;
  const app = typeof claims.iss === "string" ? claims.iss : undefined;
  if (!api) return "The token does not say which server to send data to.";

  let parsed: URL;
  try {
    parsed = new URL(api);
  } catch {
    return `The server address in the token is not a valid URL: ${api}`;
  }

  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLocal) {
    return `Refusing to send usage data over ${parsed.protocol} — the server address must use https.`;
  }

  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
    return "This enrollment token has expired. Generate a new one from the project page.";
  }

  return {
    api: api.replace(/\/+$/, ""),
    app: (app ?? parsed.origin).replace(/\/+$/, ""),
  };
}

/**
 * Reports whether the old device was revoked on its server. When the notice did
 * not land, the device is still listed as connected there, so say where to
 * revoke it by hand rather than implying the server knows.
 */
function reportRetired(binding: Binding, notice: RetireOutcome, what: string): void {
  const server = binding.server.label ?? binding.server.app_base_url;
  if ("kept" in notice) {
    const n = notice.sharedWith;
    logger.plain(
      `  Kept this machine's device on ${server}: ${n} connection${n === 1 ? "" : "s"} here still use${n === 1 ? "s" : ""} it.`
    );
    return;
  }
  if (notice.ok) {
    logger.plain(`  Revoked ${what} on ${server}.`);
    return;
  }
  logger.warn(
    `Could not tell ${server} to revoke ${what} (${notice.reason}). ` +
      `It still shows as connected there — revoke it under Settings → Devices at ` +
      `${binding.server.app_base_url}, or ask an organization admin.`
  );
}

export interface EnrollResponse {
  credential: string;
  device_id?: string;
  server?: { api_base_url?: string; app_base_url?: string; label?: string };
  project?: { id?: string; display_name?: string };
}

async function enroll(
  apiBaseUrl: string,
  ticket: string,
  deviceId: string
): Promise<EnrollResponse> {
  const response = await fetch(`${apiBaseUrl}/v1/collector/enroll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ticket}`,
      "User-Agent": `agentboard-collector/${COLLECTOR_VERSION}`,
    },
    body: JSON.stringify({
      device_id: deviceId,
      collector_version: COLLECTOR_VERSION,
      os: detectOS(),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(response.status, body, extractErrorCode(body));
  }

  return (await response.json()) as EnrollResponse;
}

export interface Enrollment {
  result: EnrollResponse;
  deviceId: string;
  /** Set when the id this machine used on the server had been revoked there. */
  revokedDeviceId?: string;
}

/**
 * Enrolls under the device id this machine already uses on the ticket's server,
 * so every directory connected to one server is one device there. Only a
 * server this machine has no connection to gets a fresh id — ids still differ
 * across servers, so two server operators cannot correlate the machine.
 *
 * A reused id may have been revoked (by an admin, or by an older collector's
 * disconnect), and the server refuses a revoked id for good. As in `login`, a
 * person has just presented a fresh ticket, which is what entitles us to come
 * back as a new device — once.
 */
export async function enrollDevice(
  apiBaseUrl: string,
  ticket: string,
  config: CollectorConfigV2,
  enrollImpl: typeof enroll = enroll
): Promise<Enrollment> {
  const existing = findDeviceIdForServer(config, apiBaseUrl);
  if (!existing) {
    const deviceId = generateDeviceId();
    return { result: await enrollImpl(apiBaseUrl, ticket, deviceId), deviceId };
  }

  try {
    return { result: await enrollImpl(apiBaseUrl, ticket, existing), deviceId: existing };
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "revoked_device") throw err;
    const deviceId = generateDeviceId();
    return {
      result: await enrollImpl(apiBaseUrl, ticket, deviceId),
      deviceId,
      revokedDeviceId: existing,
    };
  }
}

export async function connectCommand(
  dir: string,
  options: { yes?: boolean } = {}
): Promise<void> {
  const absDir = path.resolve(dir ?? ".");
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    logger.error(`Not a directory: ${absDir}`);
    process.exit(1);
  }

  logger.plain("");
  logger.plain(chalk.bold("Connect a project"));
  logger.plain("-".repeat(60));
  logger.plain("");
  logger.plain(`Directory: ${chalk.cyan(absDir)}`);
  logger.plain("");
  logger.plain("Paste the enrollment token from your project page.");
  logger.plain("");

  const ticket = await prompt("Enrollment token: ");
  if (!ticket) {
    logger.error("No token provided. Nothing was changed.");
    process.exit(1);
  }

  const claims = decodeJwtClaims(ticket);
  const validated = validateTicket(claims);
  if (typeof validated === "string") {
    logger.error(validated);
    process.exit(1);
  }

  const ticketProject = typeof claims?.prj === "string" ? claims.prj : undefined;

  // The consent moment. What this server will and will not receive is stated
  // here, in full, because a setting buried anywhere else is one nobody reads.
  logger.plain("");
  logger.plain("  This directory will be connected to:");
  logger.plain("");
  logger.plain(`      ${chalk.bold.cyan(validated.app)}`);
  logger.plain("");
  logger.plain(chalk.bold("  Sent to this server"));
  logger.plain("    - Token counts, model names and timestamps for sessions run in this directory");
  logger.plain("    - Your subscription limit usage, measured while you work in this directory");
  logger.plain(
    chalk.yellow(
      "      ! Limits are per-account, so that figure also reflects usage from elsewhere."
    )
  );
  logger.plain("");
  logger.plain(chalk.bold("  Never sent"));
  logger.plain("    - Your code, prompts, file paths or repository names, to any server");
  logger.plain("    - Usage from sessions outside this directory");
  logger.plain("    - Limit readings taken while you work outside this directory");
  logger.plain("");

  if (!options.yes) {
    const answer = await prompt("Continue? [y/N]: ");
    if (!/^y(es)?$/i.test(answer)) {
      logger.plain("Cancelled. Nothing was changed.");
      return;
    }
  }

  let enrollment: Enrollment;
  try {
    enrollment = await enrollDevice(validated.api, ticket, loadConfigV2());
  } catch (err) {
    // Nothing has been written yet. A ticket the server does not accept proves
    // neither the server nor the project, so no binding is created.
    const reason =
      err instanceof ApiError
        ? `server rejected the enrollment (HTTP ${err.status}) ${err.body.slice(0, 200)}`
        : (err as Error).message;
    logger.error(`Could not connect: ${reason}`);
    process.exit(1);
  }
  const { result, deviceId, revokedDeviceId } = enrollment;

  if (!result || !result.credential) {
    logger.error("The server did not return a credential. Nothing was changed.");
    process.exit(1);
  }

  const credentialRef = generateCredentialRef();

  // Credential first, binding last: an interrupted connect then leaves an
  // unused credential file (harmless, and reported by `agentboard doctor`)
  // rather than a binding pointing at a credential that does not exist.
  saveCredential(credentialRef, result.credential);

  let replaced: Binding | undefined;
  let remaining: Binding[] = [];
  try {
    const config = loadConfigV2();
    const added = addBinding(config, {
      dir: absDir,
      server: {
        api_base_url: result.server?.api_base_url ?? validated.api,
        app_base_url: result.server?.app_base_url ?? validated.app,
        label: result.server?.label,
        device_id: result.device_id ?? deviceId,
      },
      credentialRef,
      projectLabel: result.project?.display_name ?? ticketProject,
    });
    saveConfigV2(added.config);
    replaced = added.replaced ?? undefined;
    remaining = added.config.bindings;
  } catch (err) {
    deleteCredential(credentialRef);
    logger.error(`Could not save the connection: ${(err as Error).message}`);
    process.exit(1);
  }

  logger.plain("");
  logger.success(
    `Connected ${chalk.cyan(absDir)} to ${chalk.bold(result.server?.label ?? validated.app)}`
  );
  if (result.project?.display_name) {
    logger.plain(`  Project: ${result.project.display_name}`);
  }

  // The new connection is saved, so the one it replaced is gone locally. Tell
  // its server now (it may be a different server). Doing this inside the save
  // above would roll back a successful connect whenever the notice failed.
  if (revokedDeviceId) warnRevokedSiblings(revokedDeviceId, remaining);

  if (replaced) {
    const notice = await retireBinding(replaced, remaining);
    reportRetired(replaced, notice, "the previous device for this directory");
  }
  logger.plain("");
  logger.plain("Sessions run in this directory now go to that server.");
  logger.plain("Everything else keeps going to the community server.");
  logger.plain("");
}

/**
 * Other directories connected to the same server still hold the revoked id, so
 * their uploads are being refused. Their credentials are bound to that id on
 * the server, so swapping in the new id locally would not help — each needs a
 * `connect` of its own.
 */
function warnRevokedSiblings(revokedId: string, bindings: Binding[]): void {
  const stale = bindings.filter((b) => b.server.device_id === revokedId);
  logger.warn("This device had been disconnected on that server. Connected as a new device.");
  if (stale.length === 0) return;
  logger.plain(
    `  ${stale.length} other director${stale.length === 1 ? "y" : "ies"} connected there still use the old device and cannot upload:`
  );
  for (const b of stale) logger.plain(`    ${b.abs_dir}`);
  logger.plain("  Run `agentboard connect` in each to reconnect them.");
}

export async function disconnectCommand(dir: string): Promise<void> {
  const absDir = path.resolve(dir ?? ".");
  const config = loadConfigV2();
  const { config: next, removed } = removeBinding(config, absDir);

  if (!removed) {
    logger.warn(`No connection found for ${absDir}`);
    return;
  }

  // Local first: once this is saved, no hook routes to that server any more.
  saveConfigV2(next);

  logger.success(
    `Disconnected ${chalk.cyan(absDir)} from ${
      removed.server.label ?? removed.server.app_base_url
    }`
  );
  const notice = await retireBinding(removed, next.bindings);
  reportRetired(removed, notice, "this device");
  logger.plain("");
  // Sessions are pinned to the route of their first successful upload, so an
  // in-flight session keeps going where it started rather than splitting its
  // cumulative total across two servers.
  logger.plain("Sessions already in flight stay with their original server;");
  logger.plain("new sessions in this directory go to the community server.");
}
