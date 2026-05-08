/**
 * Section 28 — `spec-registry` tests:
 *  - T1 file backend round-trip (put/get/list/pin/aliasFor)
 *  - T9 pin/aliasFor invariants
 *  - T8 cross-tenant pin isolation
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpecRegistryError, createFileBackedRegistry } from "./index";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "spec-registry-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("spec-registry — T1 file backend", () => {
  test("put + get + list round-trip", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello-cli", "v1", "name: hello\ntarget: cli\n");
    await reg.put("hello-cli", "v2", "name: hello\ntarget: cli\nmodel: claude-opus-4-7\n");
    expect(await reg.list("hello-cli")).toEqual(["v1", "v2"]);
    expect(await reg.get("hello-cli", "v1")).toContain("target: cli");
    expect(await reg.get("hello-cli", "v2")).toContain("claude-opus-4-7");
  });

  test("get on missing version throws", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(reg.get("missing", "v1")).rejects.toBeInstanceOf(SpecRegistryError);
  });

  test("listSpecs returns all spec names", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("a", "v1", "x");
    await reg.put("b", "v1", "y");
    const specs = await reg.listSpecs();
    expect([...specs].sort()).toEqual(["a", "b"]);
  });

  test("delete removes a version and any pointing pins", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v2");
    await reg.delete("hello", "v2");
    expect(await reg.list("hello")).toEqual(["v1"]);
    expect(await reg.aliasFor("hello", "prod")).toBeUndefined();
  });

  test("rejects malformed names / versions / envs", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(reg.put("../etc/passwd", "v1", "")).rejects.toBeInstanceOf(SpecRegistryError);
    expect(reg.put("ok", "../v1", "")).rejects.toBeInstanceOf(SpecRegistryError);
    await reg.put("ok", "v1", "");
    expect(reg.pin("ok", "../prod", "v1")).rejects.toBeInstanceOf(SpecRegistryError);
  });
});

describe("spec-registry — T9 pin/aliasFor invariants", () => {
  test("pin requires the version to be in the registry", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello", "v1", "x");
    expect(reg.pin("hello", "prod", "v999")).rejects.toBeInstanceOf(SpecRegistryError);
  });

  test("aliasFor returns undefined for unknown env", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello", "v1", "x");
    expect(await reg.aliasFor("hello", "prod")).toBeUndefined();
  });

  test("re-pinning overwrites the previous pin", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v1");
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
    await reg.pin("hello", "prod", "v2");
    expect(await reg.aliasFor("hello", "prod")).toBe("v2");
  });

  test("multiple environments coexist", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v2");
    await reg.pin("hello", "staging", "v1");
    const m = await reg.manifest("hello");
    expect(m.pins).toEqual({ prod: "v2", staging: "v1" });
  });
});

describe("spec-registry — T8 cross-tenant isolation", () => {
  test("tenant pin overrides global pin only for that tenant", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v1");
    await reg.pinForTenant("tenant-a", "hello", "prod", "v2");
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
    expect(await reg.aliasForTenant("tenant-a", "hello", "prod")).toBe("v2");
    // Tenant B has no overlay → falls through to global pin.
    expect(await reg.aliasForTenant("tenant-b", "hello", "prod")).toBe("v1");
  });

  test("pinForTenant requires version exists in the registry", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello", "v1", "x");
    expect(reg.pinForTenant("tenant-a", "hello", "prod", "v2")).rejects.toBeInstanceOf(
      SpecRegistryError,
    );
  });

  test("rejects malformed tenant ids", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("hello", "v1", "x");
    expect(reg.pinForTenant("../bad", "hello", "prod", "v1")).rejects.toBeInstanceOf(
      SpecRegistryError,
    );
  });
});
