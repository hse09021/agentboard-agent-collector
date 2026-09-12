/**
 * Tests for plugin/hooks/lib/revoked.mjs — telling "this device was cut off"
 * apart from every other upload failure.
 *
 * The distinction matters because the two 4xx the server emits want opposite
 * responses: 404 device_not_found means re-register (the server lost its
 * database), 403 revoked_device means stop (a person cut this machine off).
 * Getting them backwards would let a revoked machine re-enroll itself.
 */

import { describe, it, expect } from 'vitest';
import { isRevokedDeviceError, revokedDeviceMessage } from '../../plugin/hooks/lib/revoked.mjs';

describe('isRevokedDeviceError', () => {
  it('recognizes the 403 the server sends for a revoked device', () => {
    const err = new Error('HTTP 403: {"error":"Device is revoked","code":"revoked_device"}');
    expect(isRevokedDeviceError(err)).toBe(true);
  });

  it('does not claim a missing device — that one is recoverable by re-registering', () => {
    const err = new Error('HTTP 404: {"error":"Device not found","code":"device_not_found"}');
    expect(isRevokedDeviceError(err)).toBe(false);
  });

  it('does not fire on an unrelated 403', () => {
    expect(isRevokedDeviceError(new Error('HTTP 403: Forbidden'))).toBe(false);
  });

  it('does not fire on transient failures', () => {
    expect(isRevokedDeviceError(new Error('HTTP 503: upstream down'))).toBe(false);
    expect(isRevokedDeviceError(new Error('connect ECONNREFUSED'))).toBe(false);
  });

  it('survives a thrown value that is not an Error', () => {
    expect(isRevokedDeviceError(null)).toBe(false);
    expect(isRevokedDeviceError(undefined)).toBe(false);
    expect(isRevokedDeviceError('HTTP 403 revoked_device')).toBe(false);
  });
});

describe('revokedDeviceMessage', () => {
  it('names the hook and the command that fixes it', () => {
    const message = revokedDeviceMessage('agentboard-worker');
    expect(message).toContain('agentboard-worker');
    expect(message).toContain('agentboard login');
    expect(message.endsWith('\n')).toBe(true);
  });

  it('stays on one line so hook stderr does not scroll it away', () => {
    expect(revokedDeviceMessage('agentboard-codex').trimEnd()).not.toContain('\n');
  });
});
