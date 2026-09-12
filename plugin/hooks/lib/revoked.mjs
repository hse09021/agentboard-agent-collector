/**
 * Recognizing a device that was revoked from the dashboard.
 *
 * The server answers the whole batch with 403 and `code: "revoked_device"`
 * before the per-event loop runs, so this is a transport-level condition, not
 * a per-event reject reason. It is permanent: `upsertDevice` refuses to
 * re-register a revoked device id, by design.
 *
 * Hooks must NOT recover from it on their own. `device_not_found` (404) is a
 * server that lost its database and re-registering is the right answer there;
 * 403 is a person deliberately cutting this machine off. A hook that quietly
 * enrolled itself under a fresh device id would undo the revoke — which is the
 * one thing revoke exists to prevent. Reconnecting requires `agentboard login`,
 * where a human re-authenticates.
 *
 * So the only correct behaviour here is to fail with a message that says what
 * happened and what to do about it.
 */

/**
 * @param {unknown} err error thrown by uploadEvents
 * @returns {boolean}
 */
export function isRevokedDeviceError(err) {
  const message = err && typeof err.message === 'string' ? err.message : '';
  return /HTTP 403/.test(message) && /revoked_device/.test(message);
}

/**
 * One line, because hook stderr competes with the agent's own output and a
 * paragraph gets scrolled away. Names the command that fixes it.
 *
 * @param {string} hookName prefix identifying which hook is reporting
 * @returns {string}
 */
export function revokedDeviceMessage(hookName) {
  return (
    `${hookName}: this device was disconnected in AgentBoard — ` +
    'usage is no longer being recorded. Run `agentboard login` to reconnect.\n'
  );
}
