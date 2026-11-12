/**
 * The CLI's spec writers commit against the revision of the text they read:
 * a spec changed between that read and the write is left as it is, the
 * result is kept as a draft, and the verb exits 53 naming the draft.
 *
 * The change is driven through the commit helper's `afterRead` seam (a
 * preload that installs it in the CLI's own process), never by a timer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OptimizeSpecError } from "@crewhaus/eval-optimizer-orchestrator";
import { commitCliSpec, exitOnOptimizeConflict, formatCommitRefusal, specRev } from "./spec-commit";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-spec-commit-"));
  roots.push(dir);
  return dir;
}

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
const deps = (lines: string[]) => ({
  stderr: (text: string) => {
    lines.push(text);
  },
  exit: (code: number): never => {
    throw new Exited(code);
  },
});

describe("commitCliSpec", () => {
  test("a spec changed since the read is left as it is, kept as a draft, and exits 53", async () => {
    const dir = tmp();
    const spec = join(dir, "crewhaus.yaml");
    writeFileSync(spec, "name: a\ntarget: cli\n");
    const lines: string[] = [];
    let code: number | undefined;
    try {
      await commitCliSpec(
        "lint --fix",
        spec,
        { kind: "text", text: "name: b\ntarget: cli\n" },
        { expectedRev: specRev("name: something-else\n"), writer: "cli.lint" },
        deps(lines),
      );
    } catch (err) {
      code = (err as Exited).code;
    }
    expect(code).toBe(53);
    expect(readFileSync(spec, "utf8")).toBe("name: a\ntarget: cli\n");
    const draft = /draft: (\S+\.json)\./.exec(lines.join(""))?.[1] ?? "";
    expect(existsSync(draft)).toBe(true);
    expect(lines.join("")).toContain("Run the same command again on the current spec.");
  });

  test("a write the YAML check refuses exits 1 and writes nothing", async () => {
    const dir = tmp();
    const spec = join(dir, "crewhaus.yaml");
    writeFileSync(spec, "name: a\n");
    const lines: string[] = [];
    let code: number | undefined;
    try {
      await commitCliSpec(
        "upgrade --write",
        spec,
        { kind: "text", text: "name: [unclosed\n" },
        { expectedRev: specRev("name: a\n"), writer: "cli.upgrade" },
        deps(lines),
      );
    } catch (err) {
      code = (err as Exited).code;
    }
    expect(code).toBe(1);
    expect(readFileSync(spec, "utf8")).toBe("name: a\n");
  });

  test("the refusal line names the draft and the next step", () => {
    const line = formatCommitRefusal("flywheel run", "/h/crewhaus.yaml", {
      ok: false,
      code: "conflict",
      reason: "changed",
      draft: { id: "x", path: "/h/.crewhaus/run/spec/drafts/x.json" },
    });
    expect(line).toBe(
      "crewhaus flywheel run: /h/crewhaus.yaml changed after this command read it, so nothing was written. Your result is kept as a draft: /h/.crewhaus/run/spec/drafts/x.json. Run the same command again on the current spec.",
    );
  });

  test("every optimize write-back names the same next step, never a command missing its flags", async () => {
    const failure = {
      ok: false as const,
      code: "conflict" as const,
      reason: "changed",
      draft: { id: "x", path: "/h/d.json" },
    };
    const staged = formatCommitRefusal("optimize --write-back", "/h/crewhaus.yaml", failure);
    const fromAdvice = formatCommitRefusal(
      "optimize --from-advice --write-back",
      "/h/crewhaus.yaml",
      failure,
    );
    const lines: string[] = [];
    try {
      await exitOnOptimizeConflict(
        "optimize --write-back",
        async () => {
          throw new OptimizeSpecError("the spec changed; kept as a draft at /h/d.json", undefined, {
            failure: "conflict",
            draftPath: "/h/d.json",
          });
        },
        deps(lines),
      );
    } catch {
      // exits
    }
    const single = lines.join("").trimEnd();
    expect(single).toBe(
      "crewhaus optimize --write-back: the spec changed; kept as a draft at /h/d.json. Run the same command again on the current spec.",
    );
    expect(staged).toBe(
      "crewhaus optimize --write-back: /h/crewhaus.yaml changed after this command read it, so nothing was written. Your result is kept as a draft: /h/d.json. Run the same command again on the current spec.",
    );
    expect(fromAdvice).toBe(
      "crewhaus optimize --from-advice --write-back: /h/crewhaus.yaml changed after this command read it, so nothing was written. Your result is kept as a draft: /h/d.json. Run the same command again on the current spec.",
    );
    for (const line of [single, staged, fromAdvice]) expect(line).not.toContain("Re-run `");
  });

  test("an optimizer write-back that found the spec changed exits 53; any other error is rethrown", async () => {
    const lines: string[] = [];
    let code: number | undefined;
    try {
      await exitOnOptimizeConflict(
        "optimize --write-back",
        async () => {
          throw new OptimizeSpecError("changed; kept as a draft at /d.json", undefined, {
            failure: "conflict",
            draftPath: "/d.json",
          });
        },
        deps(lines),
      );
    } catch (err) {
      code = (err as Exited).code;
    }
    expect(code).toBe(53);
    expect(lines.join("")).toContain("/d.json");
    await expect(
      exitOnOptimizeConflict("optimize --write-back", async () => {
        throw new OptimizeSpecError("other");
      }),
    ).rejects.toThrow("other");
  });
});

/** Run the CLI with a preload that edits `spec` between each writer's read and its write. */
async function runWithEditMeanwhile(
  cwd: string,
  args: readonly string[],
  spec: string,
  edited: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const preload = join(tmp(), "edit-meanwhile.ts");
  writeFileSync(
    preload,
    [
      'import { writeFileSync } from "node:fs";',
      `import { setSpecCommitTestHooks } from ${JSON.stringify(join(SRC_DIR, "spec-commit.ts"))};`,
      "setSpecCommitTestHooks({",
      `  afterRead: () => writeFileSync(${JSON.stringify(spec)}, ${JSON.stringify(edited)}),`,
      "});",
      "",
    ].join("\n"),
  );
  const proc = Bun.spawn([process.execPath, "--preload", preload, CLI_PATH, ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      ANTHROPIC_API_KEY: "test",
      CREWHAUS_NO_REGISTRY: "1",
      HOME: cwd,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function expectRefused(
  out: { exitCode: number; stderr: string },
  spec: string,
  edited: string,
): void {
  expect(`${out.exitCode}\n${out.stderr}`).toStartWith("53\n");
  expect(readFileSync(spec, "utf8")).toBe(edited);
  const draft = /draft: (\S+\.json)\./.exec(out.stderr)?.[1] ?? "";
  expect(existsSync(draft)).toBe(true);
}

describe("each CLI writer refuses a spec changed between its read and its write", () => {
  test("lint --fix", async () => {
    const dir = tmp();
    const spec = join(dir, "crewhaus.yaml");
    writeFileSync(
      spec,
      "name: t\ntarget: cli\nagent:\n  model: m\n  instructions: hi\ntools:\n  - Reed\n",
    );
    const edited =
      "name: t\ntarget: cli\nagent:\n  model: m\n  instructions: edited\ntools:\n  - Reed\n";
    const out = await runWithEditMeanwhile(dir, ["lint", spec, "--fix"], spec, edited);
    expectRefused(out, spec, edited);
  }, 30_000); // starts the CLI in a child process

  test("upgrade --write", async () => {
    const dir = tmp();
    const spec = join(dir, "crewhaus.yaml");
    const pooled = [
      "name: pooled",
      "target: cli",
      "agent:",
      "  model: claude-opus-4-8",
      "  instructions: Help.",
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5, tags: [cheap] }",
      "      - { model: claude-opus-4-8, tags: [strong] }",
      "    policy: learned",
      "",
    ].join("\n");
    writeFileSync(spec, pooled);
    const edited = pooled.replace("instructions: Help.", "instructions: Edited.");
    const out = await runWithEditMeanwhile(
      dir,
      ["upgrade", spec, "--hoist-models", "--write"],
      spec,
      edited,
    );
    expectRefused(out, spec, edited);
  }, 30_000); // starts the CLI in a child process

  test("doctor --fix never writes its scaffold over a spec created meanwhile", async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const spec = join(dir, "crewhaus.yaml");
    const edited = "name: created-meanwhile\ntarget: cli\n";
    const out = await runWithEditMeanwhile(dir, ["doctor", "--fix"], spec, edited);
    expectRefused(out, spec, edited);
  }, 30_000); // starts the CLI in a child process
});
