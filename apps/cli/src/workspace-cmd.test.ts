/**
 * `crewhaus workspace list|show`: a harness's workspaces from its records alone. Both read
 * with Home stopped, ask no code host, change no file, and print no control character a
 * check or a judge wrote.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { EXIT_FOR_ERROR, mintId } from "@crewhaus/control-contract";
// The package's own test set-up: a fake code host with a real git server half.
import { writeBindings } from "../../../packages/tool-work/src/workspace/bindings";
import { appendOutcome } from "../../../packages/tool-work/src/workspace/records";
import {
  type Bench,
  HARNESS,
  bench,
  hostRunner,
  judgeThat,
} from "../../../packages/tool-work/src/workspace/test-helpers";
import { attemptWords, pullWords, runWorkspaceCommand } from "./workspace-cmd";

const SLOW = 60_000; // real git children and a loopback host
const ESC = String.fromCodePoint(27);
const dirs: string[] = [];
const benches: Bench[] = [];
afterEach(async () => {
  for (const b of benches.splice(0)) await b.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function world() {
  const harness = realpathSync(mkdtempSync(join(tmpdir(), "workspace-cmd-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "workspace-cmd-home-")));
  dirs.push(harness, home);
  writeFileSync(
    join(harness, "crewhaus.yaml"),
    "name: steward\ntarget: cli\ntools: [workspaceOpen]\n",
  );
  const env = { CREWHAUS_REGISTRY_ROOT: join(home, "registry"), HOME: home };
  const run = (argv: readonly string[]) =>
    runWorkspaceCommand([...argv, "--harness", harness], { env, cwd: harness });
  return { harness, run };
}

async function delivering() {
  const w = await world();
  const b = await bench(w.harness);
  benches.push(b);
  b.bindings = {
    ...b.bindings,
    repositories: [
      b.binding({
        checks: [["printf", `${ESC}[31mred${ESC}[0m`]],
        pullRequests: { require: ["checks", "acceptance"] } as never,
      }),
    ],
  };
  writeBindings(w.harness, b.bindings);
  const engine = b.engine({ checkRunner: hostRunner() });
  const wi = await b.item();
  const opened = await engine.open(wi, { actor: HARNESS });
  if (!opened.ok) throw new Error(opened.message);
  b.write(opened.worktree, "src/dates.ts", "export const parse = 2;\n");
  return { ...w, b, engine, wi, branch: opened.branch };
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stats = statSync(path, { throwIfNoEntry: false });
      if (stats === undefined) continue;
      if (stats.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

describe("crewhaus workspace", () => {
  test(
    "an empty list says which: nothing declared, or nothing opened yet",
    async () => {
      const w = await world();
      expect((await w.run(["list"])).lines[0]).toContain("delivers no work to a repository");
      const b = await bench(w.harness);
      benches.push(b);
      writeBindings(w.harness, b.bindings);
      expect(await w.run(["list"])).toEqual({
        lines: ["No workspace yet. A run opens one when it starts on an accepted item."],
        exitCode: 0,
      });
      const wi = await b.item();
      const none = await w.run(["show", wi]);
      expect(none.exitCode).toBe(EXIT_FOR_ERROR.not_found);
      expect(none.lines[0]).toContain("has no workspace yet");
      const unknown = await w.run(["show", mintId("wi")]);
      expect(unknown.exitCode).toBe(EXIT_FOR_ERROR.not_found);
      expect(unknown.lines[0]).toContain("no work item");
      expect((await w.run(["show", "wi_nope"])).exitCode).toBe(EXIT_FOR_ERROR.invalid);
      expect((await w.run(["list", "stray"])).exitCode).toBe(EXIT_FOR_ERROR.invalid);
      await expect(w.run(["frobnicate"])).rejects.toThrow(/unknown workspace verb/);
      expect((await runWorkspaceCommand([])).lines[0]).toContain("usage: crewhaus workspace list");
    },
    SLOW,
  );

  test(
    "list and show say the branch, the checks, the attempts and the pull request",
    async () => {
      const t = await delivering();
      const before = await t.run(["list"]);
      expect(before.lines[0]).toContain(`${t.wi}  open    app  ${t.branch}  not published`);
      const reason = `It fits${ESC}]0;title${String.fromCodePoint(7)}`;
      expect(
        await t.b.publish(t.engine, t.wi, { judge: judgeThat("meets", false, reason).judge }),
      ).toMatchObject({ state: "done", pr: 1 });
      const had = tree(t.harness);
      const asked = t.b.fake.requests().length;
      const list = await t.run(["list"]);
      expect(list.lines[0]).toContain("pull request #1 in review");
      const shown = (await t.run(["show", t.wi])).lines.join("\n");
      expect(shown).toContain(`  branch ${t.branch}`);
      expect(shown).toContain("  Last verdict: checks pass, acceptance pass");
      expect(shown).toContain("It fits");
      expect(shown).toContain("published as pull request #1 (1 file, 2 lines)");
      expect(shown).toContain("    passed  printf ");
      // Nothing a check or a judge printed reaches the terminal as a control character.
      expect(shown).toContain("[31mred");
      expect(shown).not.toContain(ESC);
      const json = JSON.parse((await t.run(["show", t.wi, "--json"])).lines.join("\n")) as {
        workspace: { work: string; attempts: unknown[] };
      };
      expect(json.workspace).toMatchObject({ work: t.wi, pr: 1, prState: "open" });
      expect(tree(t.harness)).toEqual(had);
      expect(t.b.fake.requests().length).toBe(asked);
      await appendOutcome(
        t.harness,
        {
          v: 1,
          at: new Date().toISOString(),
          id: t.wi,
          pr: 1,
          state: "merged",
          changed: true,
          by: "sys:outcomes",
        },
        () => false,
        () => undefined,
      );
      expect((await t.run(["show", t.wi])).lines.join("\n")).toContain(
        "pull request #1 merged with changes by a maintainer",
      );
    },
    SLOW,
  );

  test("every pull request and attempt state has its words", () => {
    const at = "2026-11-25T00:00:00.000Z";
    expect(
      [
        { pr: 3, state: "open", at },
        { pr: 3, state: "open", at, review: "approved" },
        { pr: 3, state: "open", at, review: "changes-requested" },
        { pr: 3, state: "merged", at },
        { pr: 3, state: "closed", at },
        { pr: 3, state: "reverted", at },
      ].map((p) => pullWords(p as never)),
    ).toEqual([
      "pull request #3 in review",
      "pull request #3 approved, in review",
      "pull request #3 has changes requested",
      "pull request #3 merged",
      "pull request #3 closed without merging",
      "pull request #3 reverted",
    ]);
    const base = { id: "x", attempt: 1, at };
    expect(
      [
        { ...base, state: "started" },
        { ...base, state: "failed", code: "over_limits", files: 21, lines: 40 },
        { ...base, state: "unknown" },
        { ...base, state: "not-done" },
      ].map((a) => attemptWords(a as never)),
    ).toEqual([
      "being published",
      "not published: over_limits (21 files, 40 lines)",
      "not confirmed by the code host yet",
      "did not reach the code host",
    ]);
  });
});
