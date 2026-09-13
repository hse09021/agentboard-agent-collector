/**
 * Telling an organization server that this machine has left a project.
 *
 * Every `agentboard connect` mints a fresh device id per server, so that two
 * server operators cannot correlate the same machine. The price is that the
 * server cannot tell "the same machine reconnected" from "a second machine".
 * It must not revoke old devices on its own, or it would cut off a colleague's
 * second laptop. Only this machine knows the connection is gone, so it says so.
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
