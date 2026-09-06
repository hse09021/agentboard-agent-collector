/**
 * Directory to server bindings.
 *
 * A binding says "work done in this directory belongs to that server". It is
 * the only thing that ever routes data away from the community server, which
 * is why creating one is an explicit, confirmed act (see `connect`).
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Binding, CollectorConfigV2, ServerRef } from "./config-schema";
import { CONFIG_VERSION, migrateV1toV2, normalizeV2 } from "./config-schema";
import { getConfigPath, ensureConfigDir } from "./config";
import { writeJsonAtomic } from "./atomic-write";
import { normalizePath } from "./path-normalize";

export function loadConfigV2(): CollectorConfigV2 {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return migrateV1toV2(undefined);
  try {
    return migrateV1toV2(JSON.parse(fs.readFileSync(configPath, "utf-8")));
  } catch {
    return migrateV1toV2(undefined);
  }
}

export function saveConfigV2(config: CollectorConfigV2): void {
  ensureConfigDir();
  writeJsonAtomic(getConfigPath(), normalizeV2(config));
}

export function generateCredentialRef(): string {
  return crypto.randomBytes(8).toString("hex");
}

export interface AddBindingInput {
  dir: string;
  server: ServerRef;
  credentialRef: string;
  projectLabel?: string;
}

/**
 * Two directories may never map to different servers through the same path:
 * "one session resolves to exactly one server" is what lets the delta ledger
 * and the session lock stay keyed by session alone.
 */
export function findBindingForDir(
  config: CollectorConfigV2,
  dir: string
): Binding | undefined {
  const target = normalizePath(dir);
  return config.bindings.find(
    (b) => normalizePath(b.abs_dir) === target || normalizePath(b.real_dir) === target
  );
}

export function addBinding(
  config: CollectorConfigV2,
  input: AddBindingInput
): { config: CollectorConfigV2; binding: Binding; replaced?: Binding } {
  const absDir = path.resolve(input.dir);
  let realDir = absDir;
  try {
    realDir = fs.realpathSync(absDir);
  } catch {
    /* directory may be removed later; keep the literal */
  }

  const replaced = findBindingForDir(config, absDir);
  const binding: Binding = {
    abs_dir: absDir,
    real_dir: realDir,
    server: input.server,
    project_label: input.projectLabel,
    credential_ref: input.credentialRef,
    connected_at: new Date().toISOString(),
  };

  const bindings = config.bindings.filter((b) => b !== replaced);
  bindings.push(binding);

  return {
    config: { ...config, version: CONFIG_VERSION, bindings },
    binding,
    replaced,
  };
}

export function removeBinding(
  config: CollectorConfigV2,
  dir: string
): { config: CollectorConfigV2; removed?: Binding } {
  const removed = findBindingForDir(config, dir);
  if (!removed) return { config };
  return {
    config: { ...config, bindings: config.bindings.filter((b) => b !== removed) },
    removed,
  };
}

/**
 * Bindings whose credential file has gone missing, and credentials with no
 * binding. Either means `connect` was interrupted midway.
 */
export function findOrphans(
  config: CollectorConfigV2,
  credentialRefs: string[]
): { bindingsWithoutCredential: Binding[]; credentialsWithoutBinding: string[] } {
  const refs = new Set(credentialRefs);
  const bound = new Set(config.bindings.map((b) => b.credential_ref));

  return {
    bindingsWithoutCredential: config.bindings.filter((b) => !refs.has(b.credential_ref)),
    credentialsWithoutBinding: credentialRefs.filter((r) => !bound.has(r)),
  };
}
