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

describe("a path allow on a tool that walks directories (final review)", () => {
  test("a guard beneath the allowed directory is overridden too", () => {
    // Settings `alwaysAllow RemovePath(build)` decides `RemovePath build`
    // (recursive) ahead of the spec, and the runtime reads that call with
    // everything under build/, so the spec's deny on build/keep/** is one it
    // overrides.
    const beneath = yaml("alwaysDeny", "RemovePath(build/keep/**)");
    const beside = yaml("alwaysDeny", "RemovePath(src/**)");
    const allow = { toolName: "RemovePath", scopedValue: "build", valueKind: "path" as const };
    expect(guardsOverridden(allow, [beneath, beside], "/ws")).toEqual([beneath]);
    // A tool that reads one file has nothing beneath it.
    const read = { toolName: "Read", scopedValue: "build", valueKind: "path" as const };
    expect(guardsOverridden(read, [yaml("alwaysDeny", "Read(build/keep/**)")], "/ws")).toEqual([]);
    // Grep's walk skips hidden names: a deny on one is not overridden.
    const grep = { toolName: "Grep", scopedValue: "src", valueKind: "path" as const };
    expect(
      guardsOverridden(
        grep,
        [yaml("alwaysDeny", "Grep(src/.env)"), yaml("alwaysDeny", "Grep(src/secrets/**)")],
        "/ws",
      ).map((g) => g.pattern),
    ).toEqual(["Grep(src/secrets/**)"]);
  });
});

describe("an allow of a shell line (0.7.1)", () => {
  test("overrides a guard that fires on any command in the line", () => {
    // Settings `alwaysAllow Bash(git status && rm -rf build)` decides that
    // line before the builtin floor's `alwaysAsk Bash(rm**)`, which reads the
    // `rm` that comes second — so the proposal must say it overrides it.
    const floor: PermissionRule = { type: "alwaysAsk", pattern: "Bash(rm**)", source: "builtin" };
    const other = yaml("alwaysDeny", "Bash(curl**)");
    const allow = {
      toolName: "Bash",
      scopedValue: "git status && rm -rf build",
      valueKind: "command" as const,
    };
    expect(guardsOverridden(allow, [floor, other], "/ws")).toEqual([floor]);
    // A command no shell reads is one command.
    expect(
      guardsOverridden(
        { ...allow, toolName: "RunCommand", scopedValue: "git status && rm -rf build" },
        [{ ...floor, pattern: "RunCommand(rm**)" }],
        "/ws",
      ),
    ).toEqual([]);
  });
});
