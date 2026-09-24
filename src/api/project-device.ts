/**
 * Telling an organization server that this machine has left a project.
 *
 * A machine has one device id per server, shared by every directory connected
 * to it, and a different one on each server so that two server operators
 * cannot correlate the same machine. The server still cannot tell "this
 * machine left" from "a second machine joined", so it must not revoke old
 * devices on its own, or it would cut off a colleague's second laptop. Only
 * this machine knows the connection is gone, so it says so — once its last
 * directory on that server is disconnected (see core/retire-binding).
 *
 * Best-effort by design. Disconnecting is the user's decision and must never
 * be blocked by a network problem or a server that predates this endpoint; the
 * caller finishes locally either way and points the user at the settings page
 * when the notice did not land.
 */

import { COLLECTOR_VERSION } from "../core/version";

export type DisconnectNotice =
  | { ok: true; revoked: number }
  | { ok: false; reason: string };

const TIMEOUT_MS = 10_000;

export async function notifyDeviceDisconnected(
  apiBaseUrl: string,
  credential: string,
  deviceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<DisconnectNotice> {
  try {
    const response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}/v1/collector/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential}`,
        "User-Agent": `agentboard-collector/${COLLECTOR_VERSION}`,
      },
      body: JSON.stringify({ device_id: deviceId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // A server older than this endpoint answers 404. That is "not told", not an
    // error worth failing the disconnect over.
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

    const body = (await response.json().catch(() => ({}))) as { revoked?: unknown };
    return { ok: true, revoked: typeof body.revoked === "number" ? body.revoked : 0 };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
