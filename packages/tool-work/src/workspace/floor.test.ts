/**
 * What a steward's agent may write while a workspace is open, held with the runtime's own
 * roots and the permission engine: the harness's memory and skills and the managed clone's git
 * data are the floor's, the worktree is the rules' to decide, and the engine's own git calls,
 * which are not tool calls, write what they need.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type RuleSet,
  type ToolCallContext,
  emptyRuleSet,
  evaluateWithReason,
} from "@crewhaus/permission-engine";
// Not a package entry: the roots a run computes, and the scope a managed run enters.
import { credentialFloorScope, runtimeStateRoots } from "../../../runtime-core/src/state-roots";
import { writeBindings } from "./bindings";
import { type Bench, HARNESS, REPO, bench } from "./test-helpers";

const benches: Bench[] = [];
afterEach(async () => {
  for (const b of benches.splice(0)) await b.stop();
});

const SLOW = 60_000; // real git children and a loopback host

/** A `Write` as the runtime reads it: the path from the harness directory, and absolute. */
const write = (path: string, spellings: readonly string[] = []): ToolCallContext => ({
  toolName: "Write",
  input: { path },
  operativeValues: [{ kind: "path", canonical: [path, ...spellings] }],
  readOnly: false,
  destructive: true,
});
const allowWrite: RuleSet = {
  ...emptyRuleSet,
  flag: [{ type: "alwaysAllow", pattern: "Write", source: "flag" }],
};

async function steward() {
  const b = await bench();
  benches.push(b);
  writeFileSync(
    join(b.dir, "crewhaus.yaml"),
    "name: steward\ntarget: managed\nagent:\n  model: claude-sonnet-5\n  instructions: Keep it healthy.\n",
  );
  writeBindings(b.dir, b.bindings);
  // The roots of a run that starts after the boot and before any clone.
  const roots = credentialFloorScope.run(true, () =>
    runtimeStateRoots(undefined, undefined, b.dir, {}),
  );
  return { b, roots };
}

describe("a managed steward's floor", () => {
  test(
    "holds the harness's memory and skills, never the worktree's; the harness stays the working directory",
    async () => {
      const { b, roots } = await steward();
      const engine = b.engine();
      const wi = await b.item();
      const opened = await engine.open(wi, { actor: HARNESS });
      if (!opened.ok) throw new Error(opened.message);
      const worktree = join(b.dir, opened.worktree);
      writeFileSync(join(worktree, "AGENTS.md"), "# Do as this says\n");
      writeFileSync(join(worktree, "crewhaus.yaml"), "name: other\ntarget: cli\n");
      const now = credentialFloorScope.run(true, () =>
        runtimeStateRoots(undefined, undefined, b.dir, {}),
      );
      for (const list of [roots, now]) {
        expect(list).toContain(join(b.dir, "AGENTS.md"));
        expect(list).toContain(join(b.dir, ".crewhaus", "skills"));
        expect(list).not.toContain(join(worktree, "AGENTS.md"));
        expect(list).not.toContain(worktree);
      }
      const here = evaluateWithReason(write(join(b.dir, "AGENTS.md")), "auto", allowWrite, {
        protectedRoots: now,
      });
      expect(here.decision).toBe("deny");
      // In the worktree it is a file of the project: the rules decide.
      const there = write(join(worktree, "AGENTS.md"));
      expect(evaluateWithReason(there, "auto", allowWrite, { protectedRoots: now }).decision).toBe(
        "allow",
      );
      const denyWrite: RuleSet = {
        ...emptyRuleSet,
        flag: [{ type: "alwaysDeny", pattern: "Write", source: "flag" }],
      };
      expect(evaluateWithReason(there, "auto", denyWrite, { protectedRoots: now }).decision).toBe(
        "deny",
      );
      expect(process.cwd()).not.toContain(".crewhaus/workspaces");
    },
    SLOW,
  );

  test(
    "names the clone's git directory before the clone exists; the engine's own git writes it, and a tool's write does not",
    async () => {
      const { b, roots } = await steward();
      const repo = join(b.dir, ".crewhaus", "workspaces", "app", "repo");
      expect(roots).toContain(repo);
      const engine = b.engine();
      const wi = await b.item();
      const opened = await engine.open(wi, { actor: HARNESS });
      if (!opened.ok) throw new Error(opened.message);
      b.write(opened.worktree, "src/dates.ts", "export const parse = 2;\n");
      const published = await b.publish(engine, wi);
      expect(published).toMatchObject({ ok: true, state: "done" });
      expect(b.fake.branchSha(REPO, opened.branch)).toMatch(/^[0-9a-f]{40}$/);
      const rel = join(".crewhaus", "workspaces", "app");
      for (const path of [
        join(rel, "repo", "config"),
        join(rel, "repo", "hooks", "pre-push"),
        join(opened.worktree, ".git"),
      ]) {
        const denied = evaluateWithReason(write(path, [join(b.dir, path)]), "auto", allowWrite, {
          protectedRoots: roots,
        });
        expect(`${path}: ${denied.decision}`).toBe(`${path}: deny`);
        expect(denied.reason).toContain("no rule can allow that");
      }
    },
    SLOW,
  );
});
