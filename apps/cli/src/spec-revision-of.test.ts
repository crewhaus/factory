import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specRevision } from "@crewhaus/ir/policy";
import { specRevisionOf } from "./spec-revision-of";

const dir = mkdtempSync(join(tmpdir(), "crewhaus-spec-revision-of-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("specRevisionOf", () => {
  test("a spec file's revision is the revision of its text", () => {
    const text = "name: demo\ntarget: cli\nagent:\n  model: claude-sonnet-5\n";
    const path = join(dir, "crewhaus.yaml");
    writeFileSync(path, text);
    expect(specRevisionOf(path)).toBe(specRevision(text));
    expect(specRevisionOf(path)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("an unreadable spec has no revision", () => {
    expect(specRevisionOf(join(dir, "missing.yaml"))).toBeUndefined();
    expect(specRevisionOf(dir)).toBeUndefined();
  });
});
