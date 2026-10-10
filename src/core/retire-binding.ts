/**
 * Retiring a connection that no longer applies: after `agentboard disconnect`,
 * or when `connect` replaces an existing connection for the same directory.
 *
 * Before 0.10.0 both paths only deleted the local credential. The server kept
 * the old device as connected, so an organization saw one person as several
 * devices, and nothing but an admin could clean that up.
 *
 * A device id is shared by every directory connected to the same server, so
 * the server is told only when the last of them goes. Revoking earlier would
 * cut off the directories still connected — including, when `connect`
 * replaces a connection, the one it has just made.
 *
 * A connection holding an access/refresh pair has its own refresh family on
 * top of that, and it is revoked every time: the family belongs to this one
 * connection, so no other directory is cut off by it, and a refresh token that
 * outlives its connection is a bearer nobody is watching.
 *
 * Order matters and is the caller's responsibility: save the config without
 * this binding FIRST, then retire it against what remains. Local state is authoritative. If the
 * server were told first and the config write then failed, the hooks would
 * keep uploading with a credential the server has just revoked.
 */

import type { Binding } from "./config-schema";
import { bindingsSharingDevice } from "./bindings";
import {
  deleteCredential,
  loadProjectCredential,
  type ProjectCredential,
} from "../platform/credential-store";
import {
  notifyDeviceDisconnected,
  revokeProjectRefresh,
  type DisconnectNotice,
  type RefreshRevokeNotice,
} from "../api/project-device";

export interface RetireDeps {
  loadCredential: (ref: string) => ProjectCredential | null;
  deleteCredential: (ref: string) => void;
  notify: (apiBaseUrl: string, credential: string, deviceId: string) => Promise<DisconnectNotice>;
  revokeRefresh: (apiBaseUrl: string, refreshToken: string) => Promise<RefreshRevokeNotice>;
}

const defaultDeps: RetireDeps = {
  loadCredential: loadProjectCredential,
  deleteCredential,
  notify: (api, credential, deviceId) => notifyDeviceDisconnected(api, credential, deviceId),
  revokeRefresh: (api, refreshToken) => revokeProjectRefresh(api, refreshToken),
};

/**
 * The device stayed connected on purpose: other directories here still use it.
 * Not a failure, so the caller must not tell the user to revoke it by hand.
 */
export interface DeviceKept {
  ok: true;
  kept: "shared";
  /** How many remaining connections still use the device. */
  sharedWith: number;
}

export type RetireOutcome = (DisconnectNotice | DeviceKept) & {
  /** Set when the connection held a refresh token: whether it was revoked. */
  refresh?: RefreshRevokeNotice;
};

/**
 * Tells the binding's server to revoke its device, unless a binding in
 * `remaining` still uses it, and to revoke the connection's refresh token if it
 * has one. Then deletes the local credential — either way, since it belongs to
 * a connection that no longer exists. Never throws.
 */
export async function retireBinding(
  binding: Binding,
  remaining: readonly Binding[],
  deps: RetireDeps = defaultDeps
): Promise<RetireOutcome> {
  let notice: RetireOutcome;
  let stored: ProjectCredential | null = null;
  try {
    stored = deps.loadCredential(binding.credential_ref);
    const deviceId = binding.server.device_id;
    const sharing = bindingsSharingDevice(remaining, binding);
    if (sharing.length > 0) {
      notice = { ok: true, kept: "shared", sharedWith: sharing.length };
    } else if (!stored) {
      notice = { ok: false, reason: "the stored credential is missing" };
    } else if (!deviceId) {
      notice = { ok: false, reason: "this connection has no device id" };
    } else {
      // The stored access token is the bearer even when it has expired; the
      // server accepts it for this.
      notice = await deps.notify(binding.server.api_base_url, stored.access, deviceId);
    }
  } catch (err) {
    notice = { ok: false, reason: (err as Error).message };
  }

  // After the device notice, not before: revoking the family first could
  // leave the server refusing the access token that notice is sent with.
  if (stored?.refresh) {
    try {
      notice.refresh = await deps.revokeRefresh(binding.server.api_base_url, stored.refresh);
    } catch (err) {
      notice.refresh = { ok: false, reason: (err as Error).message };
    }
  }

  try {
    deps.deleteCredential(binding.credential_ref);
  } catch {
    // An orphaned credential file is harmless and reported by `agentboard doctor`.
  }

  return notice;
}
