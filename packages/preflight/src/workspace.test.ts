import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflight } from "./preflight";
import type { PreflightItem } from "./types";
import { workspaceItems } from "./workspace";

const SPEC = `
name: helper
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: Help briefly.
`;

const ID = "workspace.holds-home";
const checkPort = async (): Promise<{ free: true }> => ({ free: true });

const roots: string[] = [];
function tempBase(): string {
  const base = mkdtempSync(join(tmpdir(), "preflight-workspace-"));
  roots.push(base);
  return base;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const held = (items: readonly PreflightItem[]): PreflightItem | undefined =>
  items.find((item) => item.id === ID);

describe("workspaceItems", () => {
  test("names the directory and how to give the harness its own", () => {
    const base = tempBase();
    expect(workspaceItems(base, { HOME: base })).toEqual([
      {
        id: ID,
        area: "workspace",
        level: "blocking",
        message: `this harness's directory (${base}) holds the home directory`,
        remediation: "move the harness into a directory of its own, such as ~/harnesses/<name>",
      },
    ]);
  });

  test("a directory under the home directory reports nothing", () => {
    const base = tempBase();
    const below = join(base, "harnesses", "bot");
    mkdirSync(below, { recursive: true });
    expect(workspaceItems(below, { HOME: base })).toEqual([]);
  });
});

describe("runPreflight's workspace area", () => {
  test("a harness directory holding the home directory blocks the report", async () => {
    const base = tempBase();
    const report = await runPreflight({
      harnessDir: base,
      specYaml: SPEC,
      env: { HOME: base, ANTHROPIC_API_KEY: "present" },
      checkPort,
    });
    expect(held(report.items)?.level).toBe("blocking");
    expect(held(report.blocking)?.area).toBe("workspace");
    expect(report.ok).toBe(false);
  });

  test("the finding sits right after the spec area's items", async () => {
    const base = tempBase();
    writeFileSync(join(base, "crewhaus.yaml"), "name: [broken\n");
    const report = await runPreflight({ harnessDir: base, env: { HOME: base }, checkPort });
    const areas = report.items.map((item) => item.area);
    const at = areas.indexOf("workspace");
    expect(at).toBeGreaterThan(-1);
    expect(areas.slice(0, at).every((area) => area === "spec")).toBe(true);
    expect(areas[0]).toBe("spec");
  });

  test("a harness directory under the home directory has no such finding", async () => {
    const base = tempBase();
    const below = join(base, "bot");
    mkdirSync(below);
    const report = await runPreflight({
      harnessDir: below,
      specYaml: SPEC,
      env: { HOME: base },
      checkPort,
    });
    expect(held(report.items)).toBeUndefined();
  });

  test("a report with no harness directory has no such finding", async () => {
    const base = tempBase();
    const report = await runPreflight({ specYaml: SPEC, env: { HOME: base }, checkPort });
    expect(held(report.items)).toBeUndefined();
  });
});
