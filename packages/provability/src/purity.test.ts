import { describe, expect, test } from "bun:test";
import { isPureTool } from "./purity";

const pure = {
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresSandbox: false,
  scope: "internal" as const,
};

describe("isPureTool", () => {
  test("read-only, concurrency-safe, internal and capability-free is pure", () => {
    expect(isPureTool(pure)).toBe(true);
  });

  test("any flag that can reach a network, a process or a write makes it impure", () => {
    expect(isPureTool({ ...pure, readOnly: false })).toBe(false);
    expect(isPureTool({ ...pure, concurrencySafe: false })).toBe(false);
    expect(isPureTool({ ...pure, destructive: true })).toBe(false);
    expect(isPureTool({ ...pure, requiresSandbox: true })).toBe(false);
    expect(isPureTool({ ...pure, scope: "external" })).toBe(false);
    expect(isPureTool({ ...pure, ioCapability: "network" })).toBe(false);
    expect(isPureTool({ ...pure, ioCapability: "process" })).toBe(false);
  });
});
