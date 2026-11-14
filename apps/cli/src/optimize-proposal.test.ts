/**
 * `crewhaus changes propose --from opt_<id>`: a proposal from an optimize run applies
 * only settings the optimizer may tune, from a run the CLI recorded, and a refusal
 * files nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readChangeContent, readChanges } from "@crewhaus/quality-service";
import { applySpecPatch } from "@crewhaus/spec-patch";
import { runChangesCommand } from "./changes-cmd";
import { readOptimizeCandidate } from "./optimize-proposal";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const SPEC = `name: shop
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: Help the customer.
`;
const TUNED = {
  target: "cli",
  path: ["agent", "instructions"],
  op: "replace",
  value: "Help the customer, briefly.",
};
const TOOLS = { target: "cli", path: ["tools"], op: "add", value: ["Bash", "WebFetch"] };
const RUN = "opt_ab12";

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function harness(): { dir: string; root: string; env: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "optimize-proposal-")));
  roots.push(root);
  const dir = join(root, "harness");
  put(dir, "crewhaus.yaml", SPEC);
  put(dir, "eval/graders.yaml", "graders:\n  - name: exact\n    type: exact_match\n");
  return {
    dir,
    root,
    env: {
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
      CREWHAUS_HANGAR_ROOT: join(root, "hangar"),
      CREWHAUS_NO_REGISTRY: "1",
    },
  };
}

const runRel = (name: string): string => join(".crewhaus", "optimize", RUN, name);

function report(dir: string, fields: Record<string, unknown> = {}): void {
  put(dir, runRel("report.json"), JSON.stringify({ runId: RUN, target: "cli", ...fields }));
}

/** Nothing was filed: no change row and no proposals directory. */
function expectNothingFiled(dir: string): void {
  const read = readChanges(dir);
  expect(read.state === "present" ? read.rows : []).toEqual([]);
  expect(existsSync(join(dir, ".crewhaus", "proposals"))).toBe(false);
  expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
}

const propose = (dir: string, env: Record<string, string>, ...extra: string[]) =>
  runChangesCommand(["propose", "--from", RUN, ...extra], { cwd: dir, env });

describe("a proposal from an optimize run", () => {
  test("a patch outside the optimizable paths is refused, naming its path, and nothing is filed", async () => {
    const { dir, env } = harness();
    report(dir);
    put(dir, runRel("patches.json"), JSON.stringify([TUNED, TOOLS]));
    await expect(propose(dir, env)).rejects.toThrow(
      /patch 2 is not one the optimizer may make: .*path tools /,
    );
    expectNothingFiled(dir);
  });

  test("patches with no report.json are refused as a run the CLI did not record", async () => {
    const { dir, env } = harness();
    put(dir, runRel("patches.json"), JSON.stringify([TUNED]));
    await expect(propose(dir, env)).rejects.toThrow(
      /no optimize run opt_ab12 recorded under \.crewhaus\/optimize/,
    );
    expectNothingFiled(dir);
  });

  test("a report.json naming another run is refused the same way", async () => {
    const { dir, env } = harness();
    report(dir, { runId: "opt_ffff" });
    put(dir, runRel("patches.json"), JSON.stringify([TUNED]));
    await expect(propose(dir, env)).rejects.toThrow(/no optimize run opt_ab12 recorded/);
    expectNothingFiled(dir);
  });

  test("a report.json for another target is refused the same way", async () => {
    const { dir, env } = harness();
    report(dir, { target: "channel" });
    put(dir, runRel("patches.json"), JSON.stringify([TUNED]));
    await expect(propose(dir, env)).rejects.toThrow(/no optimize run opt_ab12 recorded/);
    expectNothingFiled(dir);
  });

  test("a report.json that is a link is refused", async () => {
    const { dir, root, env } = harness();
    put(root, "elsewhere/report.json", JSON.stringify({ runId: RUN, target: "cli" }));
    put(dir, runRel("patches.json"), JSON.stringify([TUNED]));
    symlinkSync(join(root, "elsewhere", "report.json"), join(dir, runRel("report.json")));
    await expect(propose(dir, env)).rejects.toThrow(/no optimize run opt_ab12 recorded/);
    expectNothingFiled(dir);
  });

  test("a patches.json that is a link is refused", async () => {
    const { dir, root, env } = harness();
    report(dir);
    put(root, "elsewhere/patches.json", JSON.stringify([TUNED]));
    symlinkSync(join(root, "elsewhere", "patches.json"), join(dir, runRel("patches.json")));
    await expect(propose(dir, env)).rejects.toThrow(/no optimize run opt_ab12 recorded/);
    expectNothingFiled(dir);
  });

  test("a link inside the run directory pointing at a sibling file is refused too", async () => {
    const { dir, env } = harness();
    report(dir);
    put(dir, runRel("real.json"), JSON.stringify(TUNED));
    symlinkSync(join(dir, runRel("real.json")), join(dir, runRel("patch.json")));
    await expect(propose(dir, env)).rejects.toThrow(/no optimize run opt_ab12 recorded/);
    expectNothingFiled(dir);
  });

  test("a recorded run with an optimizable patch proposes exactly that patch applied", async () => {
    const { dir, env } = harness();
    report(dir);
    put(dir, runRel("patch.json"), JSON.stringify(TUNED));
    const out = await propose(dir, env);
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toMatch(/^proposed chg_/);
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    const chg = read.rows[0]?.id as string;
    const expected = applySpecPatch(SPEC, TUNED as Parameters<typeof applySpecPatch>[1]).yaml;
    expect(readChangeContent(dir, chg, "proposed.yaml")).toBe(expected);
    expect(readOptimizeCandidate(dir, RUN, "crewhaus.yaml")).toBe(expected);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
  });

  test("patches.json is preferred over patch.json, and every patch in it is applied in order", async () => {
    const { dir } = harness();
    report(dir);
    put(dir, runRel("patch.json"), JSON.stringify(TOOLS));
    const second = { ...TUNED, value: "Help the customer, kindly." };
    put(dir, runRel("patches.json"), JSON.stringify([TUNED, second]));
    expect(readOptimizeCandidate(dir, RUN, "crewhaus.yaml")).toContain(
      "Help the customer, kindly.",
    );
  });

  test("an optimize run is proposed only as a spec change", async () => {
    const { dir, env } = harness();
    report(dir);
    put(dir, runRel("patch.json"), JSON.stringify(TUNED));
    await expect(propose(dir, env, "--kind", "graders")).rejects.toThrow(
      /an optimize run proposes a spec change/,
    );
    expectNothingFiled(dir);
  });

  test("who may adopt a change follows what it touches, whatever source it names", async () => {
    const { dir, env } = harness();
    put(dir, "proposed.yaml", SPEC.replace("Help the customer.", "Help the customer, briefly."));
    for (const source of ["optimize", "manual"]) {
      const out = await runChangesCommand(
        ["propose", "--from", "proposed.yaml", "--source", source],
        { cwd: dir, env },
      );
      expect(out.exitCode).toBe(0);
    }
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows).toHaveLength(2);
    expect(read.rows.map((r) => r.source).sort()).toEqual(["manual", "optimize"]);
    expect(read.rows[0]?.touches).toEqual(read.rows[1]?.touches);
  });
});
