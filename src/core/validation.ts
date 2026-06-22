import { UsageEvent, SUPPORTED_SOURCES } from "./usage-event";
import { assertNoForbiddenFields, ForbiddenDataError } from "./forbidden-data-guard";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateUsageEvent(event: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof event !== "object" || event === null) {
    return { valid: false, errors: ["Event must be a non-null object"] };
  }

  const e = event as Record<string, unknown>;

  if ("cached_tokens" in e) {
    errors.push("cached_tokens is not supported; use cache_read_tokens");
  }

  if (e.schema_version !== "1.0") {
    errors.push(`schema_version must be "1.0", got: ${String(e.schema_version)}`);
  }

  if (!e.event_id || typeof e.event_id !== "string") {
    errors.push("event_id must be a non-empty string");
  }

  if (!e.device_id || typeof e.device_id !== "string") {
    errors.push("device_id must be a non-empty string");
  }

  if (!e.source || !SUPPORTED_SOURCES.includes(e.source as UsageEvent["source"])) {
    errors.push(`source must be one of: ${SUPPORTED_SOURCES.join(", ")}`);
  }

  if (!e.session_id || typeof e.session_id !== "string") {
    errors.push("session_id must be a non-empty string");
  }

  if (!e.started_at || typeof e.started_at !== "string") {
    errors.push("started_at must be a non-empty string");
  } else {
    const date = new Date(e.started_at as string);
    if (isNaN(date.getTime())) {
      errors.push("started_at must be a valid ISO 8601 date string");
    }
  }

  if (
    typeof e.total_tokens !== "number" ||
    !Number.isInteger(e.total_tokens) ||
    e.total_tokens <= 0
  ) {
    errors.push("total_tokens must be a positive integer");
  }

  for (const field of [
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
  ] as const) {
    if (e[field] !== undefined) {
      const val = e[field];
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
        errors.push(`${field} must be a non-negative integer if provided`);
      }
    }
  }

  try {
    assertNoForbiddenFields(event);
  } catch (err) {
    if (err instanceof ForbiddenDataError) {
      errors.push(`Forbidden field detected: "${err.forbiddenKey}"`);
    } else {
      errors.push("Forbidden data guard check failed");
    }
  }

  return { valid: errors.length === 0, errors };
}
