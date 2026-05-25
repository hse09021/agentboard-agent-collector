import { describe, it, expect } from "vitest";
import { generateEventId, generateSessionId } from "../../src/core/event-id";
import { generateDeviceId } from "../../src/core/device-id";

describe("generateEventId", () => {
  it("returns a string starting with evt_", () => {
    const id = generateEventId();
    expect(id).toMatch(/^evt_[a-f0-9]{32}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateEventId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateSessionId", () => {
  it("returns a string starting with ses_", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^ses_[a-f0-9]{32}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateDeviceId", () => {
  it("returns a string starting with dev_", () => {
    const id = generateDeviceId();
    expect(id).toMatch(/^dev_[a-f0-9]{32}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateDeviceId()));
    expect(ids.size).toBe(100);
  });
});
