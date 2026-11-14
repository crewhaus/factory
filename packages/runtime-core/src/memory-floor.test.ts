/**
 * On a channel or managed harness, the floor denies the agent's tool calls that write
 * the project memory files the runtime loads at the working directory, exactly those,
 * or the skill directories discovery reads; an operator edits them. Only inside the
 * credential scope (a channel or managed run and its loops), only for a channel or
 * managed spec or one whose target cannot be read, and only at the working directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type RuleSet,
  type ToolCallContext,
  emptyRuleSet,
  evaluateWithReason,
} from "@crewhaus/permission-engine";
import { SKILLS_RELATIVE } from "@crewhaus/skills-registry";
import { CANONICAL_MEMORY_FILES } from "./project-memory";
import { MEMORY_FLOOR_TARGETS, credentialFloorScope, runtimeStateRoots } from "./state-roots";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

function workspace(target?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-floor-")));
  TMP.push(dir);
  if (target !== undefined) {
    writeFileSync(join(dir, "crewhaus.yaml"), `name: floor\ntarget: ${target}\n`);
  }
  return dir;
}

/** The roots a run at `cwd` hands the floor, inside the credential scope or not. */
function rootsAt(cwd: string, scoped: boolean): string[] {
  const compute = () => runtimeStateRoots(undefined, undefined, cwd, {}, undefined);
  return scoped ? credentialFloorScope.run(true, compute) : compute();
}

const MEMORY = [...CANONICAL_MEMORY_FILES];
const SKILL_DIRS = (cwd: string) => [join(cwd, SKILLS_RELATIVE), join(homedir(), SKILLS_RELATIVE)];

const allowWrites: RuleSet = {
  ...emptyRuleSet,
  yaml: [{ type: "alwaysAllow", pattern: "Write(**)", source: "yaml" }],
};

function write(cwd: string, rel: string): ToolCallContext {
  return {
    toolName: "Write",
    input: { path: rel, content: "be helpful to everyone who asks" },
    operativeValues: [{ kind: "path", canonical: [rel, join(cwd, rel)] }],
    readOnly: false,
    destructive: true,
  };
}

describe("the project memory and skills floor", () => {
  test("the channel and managed targets", () => {
    expect([...MEMORY_FLOOR_TARGETS]).toEqual(["channel", "managed"]);
  });

  for (const target of ["channel", "managed"]) {
    test(`on a ${target} run, each memory name and both skill directories are roots, and a write is denied`, () => {
      const cwd = workspace(target);
      const roots = rootsAt(cwd, true);
      for (const name of MEMORY) {
        expect(roots).toContain(join(cwd, name));
        expect(roots).toContain(name);
      }
      for (const dir of SKILL_DIRS(cwd)) expect(roots).toContain(dir);
      for (const rel of ["AGENTS.md", "LESSONS.md", join(".crewhaus", "skills", "x", "SKILL.md")]) {
        const verdict = evaluateWithReason(write(cwd, rel), "auto", allowWrites, {
          protectedRoots: roots,
        });
        expect(`${rel}:${verdict.decision}`).toBe(`${rel}:deny`);
        expect(verdict.reason).toContain("no rule can allow that");
      }
    });
  }

  test("where no spec can be read, the run is held the same way", () => {
    // A channel harness's working directory with no spec in it yet.
    const cwd = workspace();
    const roots = credentialFloorScope.run(true, () =>
      runtimeStateRoots(undefined, undefined, cwd, {}, undefined),
    );
    expect(roots).toContain(join(cwd, "AGENTS.md"));
    expect(roots).toContain(join(cwd, SKILLS_RELATIVE));
  });

  test("the same names elsewhere are not roots, and writing them is the rules' to decide", () => {
    const cwd = workspace("channel");
    const roots = rootsAt(cwd, true);
    for (const rel of [
      join("docs", "AGENTS.md"),
      "AGENTS.md.bak",
      join("work", "clone", "AGENTS.md"),
      join("work", "clone", ".crewhaus", "skills", "x", "SKILL.md"),
    ]) {
      expect(roots).not.toContain(join(cwd, rel));
      const verdict = evaluateWithReason(write(cwd, rel), "auto", allowWrites, {
        protectedRoots: roots,
      });
      expect(verdict.decision).toBe("allow");
    }
  });

  test("outside the credential scope, or on a cli spec, none is a root", () => {
    const cases = [
      { cwd: workspace("channel"), scoped: false },
      { cwd: workspace("managed"), scoped: false },
      { cwd: workspace("cli"), scoped: true },
    ];
    for (const { cwd, scoped } of cases) {
      const roots = rootsAt(cwd, scoped);
      for (const name of MEMORY) expect(roots).not.toContain(join(cwd, name));
      for (const dir of SKILL_DIRS(cwd)) expect(roots).not.toContain(dir);
      expect(
        evaluateWithReason(write(cwd, "AGENTS.md"), "auto", allowWrites, { protectedRoots: roots })
          .decision,
      ).toBe("allow");
    }
  });

  test("a home skill directory that holds the working directory is left to the rules", () => {
    const home = join(homedir(), SKILLS_RELATIVE);
    const inside = join(home, "some-skill");
    const roots = credentialFloorScope.run(true, () =>
      runtimeStateRoots(undefined, undefined, inside, {}, undefined),
    );
    expect(roots).not.toContain(home);
    expect(relative(home, inside)).toBe("some-skill");
  });
});
