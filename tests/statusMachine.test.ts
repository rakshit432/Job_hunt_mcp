import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  isStatus,
} from "../src/services/statusMachine.js";

describe("statusMachine", () => {
  it("allows the normal flow", () => {
    expect(canTransition("new", "drafted")).toBe(true);
    expect(canTransition("drafted", "sent")).toBe(true);
    expect(canTransition("sent", "replied")).toBe(true);
    expect(canTransition("sent", "no_response")).toBe(true);
  });

  it("blocks skipping steps", () => {
    expect(canTransition("new", "sent")).toBe(false);
    expect(canTransition("new", "replied")).toBe(false);
    expect(canTransition("drafted", "replied")).toBe(false);
  });

  it("treats rejected as final", () => {
    expect(canTransition("rejected", "drafted")).toBe(false);
    expect(canTransition("rejected", "new")).toBe(false);
  });

  it("allows rejecting from any active state", () => {
    for (const s of ["new", "drafted", "sent", "replied", "no_response", "skipped"] as const) {
      expect(canTransition(s, "rejected")).toBe(true);
    }
  });

  it("throws a readable error on a bad change", () => {
    expect(() => assertTransition("new", "replied")).toThrow(/Invalid status change/);
  });

  it("validates status strings", () => {
    expect(isStatus("sent")).toBe(true);
    expect(isStatus("banana")).toBe(false);
  });
});

