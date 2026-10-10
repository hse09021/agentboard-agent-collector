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

export type RefreshRevokeNotice = { ok: true } | { ok: false; reason: string };

/**
 * Revokes a connected project's refresh token, and with it its whole family.
 *
 * Unauthenticated: the refresh token in the body is the credential. It goes to
 * the connection's own server only — it was issued there, and nowhere else has
 * any business seeing it.
 *
 * Best-effort, like the disconnect notice. A server without rotation has no
 * such endpoint and answers 404; it also never issued a refresh token, so a
 * connection holding one is not talking to such a server in practice.
 */
export async function revokeProjectRefresh(
  apiBaseUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<RefreshRevokeNotice> {
  try {
    const response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}/v1/collector/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `agentboard-collector/${COLLECTOR_VERSION}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
