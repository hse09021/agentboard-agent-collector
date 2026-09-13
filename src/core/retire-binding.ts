/**
 * Retiring a connection that no longer applies: after `agentboard disconnect`,
 * or when `connect` replaces an existing connection for the same directory.
 *
 * Before 0.10.0 both paths only deleted the local credential. The server kept
 * the old device as connected, so an organization saw one person as several
 * devices, and nothing but an admin could clean that up.
 *
 * Order matters and is the caller's responsibility: save the config without
 * this binding FIRST, then retire it. Local state is authoritative. If the
 * server were told first and the config write then failed, the hooks would
 * keep uploading with a credential the server has just revoked.
 */

import type { Binding } from "./config-schema";
import { deleteCredential, loadCredential } from "../platform/credential-store";
import { notifyDeviceDisconnected, type DisconnectNotice } from "../api/project-device";

export interface RetireDeps {
  loadCredential: (ref: string) => string | null;
  deleteCredential: (ref: string) => void;
  notify: (apiBaseUrl: string, credential: string, deviceId: string) => Promise<DisconnectNotice>;
}

const defaultDeps: RetireDeps = {
  loadCredential,
  deleteCredential,
  notify: (api, credential, deviceId) => notifyDeviceDisconnected(api, credential, deviceId),
};

/**
 * Tells the binding's server to revoke its device, then deletes the local
 * credential. The credential is deleted whether or not the notice landed —
 * it belongs to a connection that no longer exists. Never throws.
 */
export async function retireBinding(
  binding: Binding,
  deps: RetireDeps = defaultDeps
): Promise<DisconnectNotice> {
  let notice: DisconnectNotice;
  try {
    const credential = deps.loadCredential(binding.credential_ref);
    const deviceId = binding.server.device_id;
    if (!credential) {
      notice = { ok: false, reason: "the stored credential is missing" };
    } else if (!deviceId) {
      notice = { ok: false, reason: "this connection has no device id" };
    } else {
      notice = await deps.notify(binding.server.api_base_url, credential, deviceId);
    }
  } catch (err) {
    notice = { ok: false, reason: (err as Error).message };
  }

  try {
    deps.deleteCredential(binding.credential_ref);
  } catch {
    // An orphaned credential file is harmless and reported by `agentboard doctor`.
  }

  return notice;
}
