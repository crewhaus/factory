/**
 * `SpecPatchApply` and `DoctorFix` write the spec through the spec commit
 * helper, against the revision of the text the call read (or "absent" for a
 * spec the call creates): a spec changed between that read and the write is
 * left as it is, and the new document is kept as a draft whose path the tool
 * result names.
 *
 * The change is made through the commit helper's `afterRead` seam, wrapped in
 * here; the real module is restored after the file.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as commitModule from "@crewhaus/spec-patch/commit";
import * as fx from "./fixtures";

const real = { ...commitModule };
let meanwhile: (() => void) | undefined;
mock.module("@crewhaus/spec-patch/commit", () => ({
  ...real,
  commitSpec: (
    target: Parameters<typeof real.commitSpec>[0],
    change: Parameters<typeof real.commitSpec>[1],
    opts: Parameters<typeof real.commitSpec>[2],
  ) => real.commitSpec(target, change, { ...opts, hooks: { afterRead: () => meanwhile?.() } }),
}));
afterAll(() => {
  mock.module("@crewhaus/spec-patch/commit", () => real);
});

const { doctorFix, specPatchApply } = await import("./index");

let previousCwd = process.cwd();
let workspace = "";
beforeEach(() => {
  previousCwd = process.cwd();
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "specops-commit-")));
  process.chdir(workspace);
});
afterEach(() => {
  meanwhile = undefined;
  process.chdir(previousCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("SpecPatchApply writes through the guarded commit", () => {
  it("a spec changed between the read and the write is kept, and the patch is a draft", async () => {
    const specPath = join(workspace, "crewhaus.yaml");
    writeFileSync(specPath, fx.CLI_SPEC_YAML);
    const edited = `${fx.CLI_SPEC_YAML}# edited meanwhile\n`;
    meanwhile = () => writeFileSync(specPath, edited);
    const out = JSON.parse(
      String(
        await specPatchApply.execute({
          path: "crewhaus.yaml",
          dryRun: false,
          patches: [{ path: ["agent", "max_tokens"], value: 16384 }],
        }),
      ),
    ) as Record<string, unknown>;
    expect(out["ok"]).toBe(false);
    expect(out["code"]).toBe("conflict");
    expect(out["wrote"]).toBe(false);
    expect(readFileSync(specPath, "utf8")).toBe(edited);
    const draft = String(out["draft"]);
    expect(draft.startsWith(".crewhaus/run/spec/drafts/")).toBe(true);
    expect(existsSync(join(workspace, draft))).toBe(true);
    expect(readFileSync(join(workspace, draft), "utf8")).toContain("16384");
  }, 30_000); // real file I/O on a loaded runner

  it("an unchanged spec is written", async () => {
    const specPath = join(workspace, "crewhaus.yaml");
    writeFileSync(specPath, fx.CLI_SPEC_YAML);
    const out = JSON.parse(
      String(
        await specPatchApply.execute({
          path: "crewhaus.yaml",
          dryRun: false,
          patches: [{ path: ["agent", "max_tokens"], value: 16384 }],
        }),
      ),
    ) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(readFileSync(specPath, "utf8")).toContain("16384");
  }, 30_000); // real file I/O on a loaded runner
});

describe("DoctorFix writes the spec through the guarded commit", () => {
  const fix = async (input: Record<string, unknown>) =>
    JSON.parse(String(await doctorFix.execute(input))) as Record<string, unknown>;

  it("a spec changed between the fixers' read and the write is kept, and the fix is a draft", async () => {
    const specPath = join(workspace, "crewhaus.yaml");
    writeFileSync(specPath, fx.CLI_SPEC_YAML);
    const edited = `${fx.CLI_SPEC_YAML}# edited meanwhile\n`;
    meanwhile = () => writeFileSync(specPath, edited);
    const out = await fix({ fixes: ["tool-scope"], toolNames: ["Fetch"], dryRun: false });
    expect(out["ok"]).toBe(false);
    expect(out["code"]).toBe("conflict");
    expect(out["wrote"]).toBe(false);
    expect(readFileSync(specPath, "utf8")).toBe(edited);
    const draft = String(out["draft"]);
    expect(draft.startsWith(".crewhaus/run/spec/drafts/")).toBe(true);
    expect(readFileSync(join(workspace, draft), "utf8")).toContain("scope: external");
  }, 30_000); // real file I/O on a loaded runner

  it("a spec that appears before a scaffold is written is kept, and the scaffold is a draft", async () => {
    const specPath = join(workspace, "crewhaus.yaml");
    meanwhile = () => writeFileSync(specPath, fx.CLI_SPEC_YAML);
    const out = await fix({ fixes: ["scaffold-spec"], specName: "hello", dryRun: false });
    expect(out["ok"]).toBe(false);
    expect(out["code"]).toBe("conflict");
    expect(readFileSync(specPath, "utf8")).toBe(fx.CLI_SPEC_YAML);
    expect(readFileSync(join(workspace, String(out["draft"])), "utf8")).toContain("name: hello");
  }, 30_000); // real file I/O on a loaded runner

  it("an unchanged spec is written", async () => {
    const specPath = join(workspace, "crewhaus.yaml");
    writeFileSync(specPath, fx.CLI_SPEC_YAML);
    const out = await fix({ fixes: ["tool-scope"], toolNames: ["Fetch"], dryRun: false });
    expect(out["ok"]).toBe(true);
    expect(readFileSync(specPath, "utf8")).toContain("scope: external");
  }, 30_000); // real file I/O on a loaded runner
});
