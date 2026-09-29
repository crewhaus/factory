/**
 * `guardsOverridden` — which of the spec's deny and ask rules a proposed
 * settings allow would decide ahead of. See permissions-override.ts.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "@crewhaus/permission-engine";
import { guardsOverridden } from "./permissions-override";

const yaml = (type: PermissionRule["type"], pattern: string): PermissionRule => ({
  type,
  pattern,
  source: "yaml",
});

describe("a key-scoped allow and a guard on the store the key lives in", () => {
  const storeDeny = yaml("alwaysDeny", "KvDelete(.crewhaus/state/**)");
  const otherDeny = yaml("alwaysDeny", "KvDelete(elsewhere/**)");
  const keyAllow = {
    toolName: "KvDelete",
    scopedValue: "prod/*",
    valueKind: "id" as const,
    relocatingDefaults: [{ kind: "path" as const, value: ".crewhaus/state" }],
  };

  test("the allow covers calls that leave stateDir out, so it overrides the store's deny", () => {
    // Settings `alwaysAllow KvDelete(prod/*)` decides {namespace: "prod", key}
    // — which deletes under .crewhaus/state — before the spec's deny is read.
    expect(guardsOverridden(keyAllow, [storeDeny, otherDeny], "/ws")).toEqual([storeDeny]);
  });

  test("a builtin's relocating defaults are read from the manifest when the caller passes none", () => {
    const { relocatingDefaults: _, ...bare } = keyAllow;
    expect(guardsOverridden(bare, [storeDeny], "/ws")).toEqual([storeDeny]);
    // An explicit empty list says the tool relocates nothing: no override.
    expect(guardsOverridden({ ...bare, relocatingDefaults: [] }, [storeDeny], "/ws")).toEqual([]);
  });

  test("a guard written against the absolute store is read too", () => {
    const absolute = yaml("alwaysAsk", "KvDelete(/ws/.crewhaus/state/**)");
    expect(guardsOverridden(keyAllow, [absolute], "/ws")).toEqual([absolute]);
  });
});
