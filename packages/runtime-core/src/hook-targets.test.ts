/**
 * The files a harness's own hooks name directly are floor roots, exactly those files,
 * and the spec record of a spec kept in another directory is one too.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUILTIN_DEFAULT_RULES, emptyRuleSet, evaluate } from "@crewhaus/permission-engine";
import { protectedRootHolding } from "@crewhaus/tool-safety/fs";
import {
  filesNamedBy,
  filesNamedByArgv,
  hookTargetFiles,
  managerHookArgv,
  splitShellCommand,
} from "./hook-targets";
import { runSpecDirScope, runtimeStateRoots } from "./state-roots";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = "hook-targets-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TMP.push(dir);
  return dir;
}

function settings(cwd: string, root: unknown): void {
  mkdirSync(join(cwd, ".crewhaus"), { recursive: true });
  writeFileSync(join(cwd, ".crewhaus", "settings.json"), JSON.stringify(root));
}

describe("the files a hook names directly", () => {
  test("manager hooks and runtime hooks name exactly their scripts", () => {
    const cwd = tempDir();
    settings(cwd, {
      manager: { hooks: { preSpawn: "./prep.sh", postCompile: ["bun", "scripts/post.ts"] } },
      hooks: [{ event: "stop", command: "FOO=1 sh ./hooks/check.sh -v && ./bin/y | grep x" }],
    });
    expect(hookTargetFiles(cwd).sort()).toEqual(
      [
        join(cwd, "prep.sh"),
        join(cwd, "scripts", "post.ts"),
        join(cwd, "hooks", "check.sh"),
        join(cwd, "bin", "y"),
      ].sort(),
    );
  });

  test("a word that is only known once it runs names nothing", () => {
    const cwd = tempDir();
    expect(filesNamedBy("echo $X", cwd)).toEqual([]);
    expect(filesNamedBy("./*.sh", cwd)).toEqual([]);
    expect(filesNamedBy("sh ~other/x.sh", cwd)).toEqual([]);
    expect(filesNamedBy("$(./z)", cwd)).toEqual([]);
    expect(filesNamedBy("./a.sh `./z`", cwd)).toEqual([]);
    expect(filesNamedBy("./a.sh 'unbalanced", cwd)).toEqual([]);
    expect(filesNamedBy('./a.sh "unbalanced', cwd)).toEqual([]);
    expect(filesNamedBy("sh .", cwd)).toEqual([]);
    expect(filesNamedBy("sh ..", cwd)).toEqual([]);
    expect(splitShellCommand("a 'b")).toBeUndefined();
  });

  test("quotes and escapes are read as a shell reads them", () => {
    const cwd = tempDir();
    expect(filesNamedBy("'./a b.sh' --flag", cwd)).toEqual([join(cwd, "a b.sh")]);
    expect(filesNamedBy('"./c d.sh"', cwd)).toEqual([join(cwd, "c d.sh")]);
    expect(filesNamedBy("./e\\ f.sh", cwd)).toEqual([join(cwd, "e f.sh")]);
    expect(splitShellCommand("a;b||c|d&e\nf")).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
  });

  test("an interpreter names its script, after one leading run for bun and deno", () => {
    const cwd = tempDir();
    expect(filesNamedBy("bun run prep.ts", cwd)).toEqual([join(cwd, "prep.ts")]);
    expect(filesNamedBy("deno run -A tool.ts", cwd)).toEqual([join(cwd, "tool.ts")]);
    expect(filesNamedBy("python3 -u gen.py out", cwd)).toEqual([join(cwd, "gen.py")]);
    expect(filesNamedBy(". ./env.sh", cwd)).toEqual([join(cwd, "env.sh")]);
    expect(filesNamedBy("env -i A=1 node lib/run.js", cwd)).toEqual([join(cwd, "lib", "run.js")]);
    // A name looked up on PATH that is no interpreter names nothing.
    expect(filesNamedBy("make build", cwd)).toEqual([]);
    expect(filesNamedByArgv(["make", "./x"], cwd)).toEqual([]);
  });

  test("an argv is never split, and a path that is a directory names nothing", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "tools"));
    expect(filesNamedByArgv(["./run me.sh"], cwd)).toEqual([join(cwd, "run me.sh")]);
    expect(filesNamedByArgv(["bash", "tools"], cwd)).toEqual([]);
    expect(filesNamedByArgv(["./tools"], cwd)).toEqual([]);
  });

  test("a malformed settings file, a wrong type and a bad entry each read as nothing", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".crewhaus"));
    writeFileSync(join(cwd, ".crewhaus", "settings.json"), "{ torn");
    expect(hookTargetFiles(cwd)).toEqual([]);
    settings(cwd, { manager: { hooks: { preSpawn: 7 } }, hooks: [{ command: 3 }, "x"] });
    expect(hookTargetFiles(cwd)).toEqual([]);
    settings(cwd, { manager: [], hooks: {} });
    expect(hookTargetFiles(cwd)).toEqual([]);
  });

  test("a Write to a hook's script is refused by the floor, and to its neighbour it is not", () => {
    const cwd = tempDir();
    settings(cwd, { manager: { hooks: { preSpawn: "./prep.sh" } } });
    const roots = runtimeStateRoots(undefined, undefined, cwd, {}, undefined);
    const write = (path: string) =>
      evaluate(
        {
          toolName: "Write",
          input: { path },
          operativeValues: [{ kind: "path", canonical: [path] }],
          readOnly: false,
          destructive: true,
        },
        "default",
        {
          ...emptyRuleSet,
          settings: [{ type: "alwaysAllow", pattern: "Write", source: "settings" }],
          builtin: BUILTIN_DEFAULT_RULES,
        },
        { protectedRoots: roots },
      );
    expect(write("prep.sh")).toBe("deny");
    expect(write("prep.sh.bak")).toBe("allow");
  });

  test("the hooks a run loaded add their files", () => {
    const cwd = tempDir();
    const roots = runtimeStateRoots(undefined, undefined, cwd, {}, undefined, {
      hookCommands: ["./spec-hook.sh --check"],
    });
    expect(protectedRootHolding(join(cwd, "spec-hook.sh"), roots, cwd)).toBeDefined();
    expect(
      protectedRootHolding(
        join(cwd, "spec-hook.sh"),
        runtimeStateRoots(undefined, undefined, cwd, {}, undefined),
        cwd,
      ),
    ).toBeUndefined();
  });
});

describe("the forms a hook names its script in", () => {
  /** A harness with `scripts/prep.sh`, `prep.sh` and `hooks/check.sh` on disk. */
  function harness(): string {
    const cwd = tempDir();
    mkdirSync(join(cwd, "scripts"));
    mkdirSync(join(cwd, "hooks"));
    for (const file of ["prep.sh", join("scripts", "prep.sh"), join("hooks", "check.sh")]) {
      writeFileSync(join(cwd, file), "#!/bin/sh\n");
    }
    return cwd;
  }

  function writeVerdict(cwd: string, path: string): string {
    const roots = runtimeStateRoots(undefined, undefined, cwd, {}, undefined);
    return evaluate(
      {
        toolName: "Write",
        input: { path },
        operativeValues: [{ kind: "path", canonical: [path] }],
        readOnly: false,
        destructive: true,
      },
      "default",
      {
        ...emptyRuleSet,
        settings: [{ type: "alwaysAllow", pattern: "Write", source: "settings" }],
        builtin: BUILTIN_DEFAULT_RULES,
      },
      { protectedRoots: roots },
    );
  }

  const SHELL_FORMS: readonly (readonly [string, string])[] = [
    ["cd scripts && ./prep.sh", "scripts/prep.sh"],
    ["cd hooks; ./check.sh", "hooks/check.sh"],
    ["exec ./prep.sh", "prep.sh"],
    ["command ./prep.sh", "prep.sh"],
    ["builtin . ./prep.sh", "prep.sh"],
    ["time ./prep.sh", "prep.sh"],
    ["nohup ./prep.sh", "prep.sh"],
    ["nice -n 5 sh scripts/prep.sh", "scripts/prep.sh"],
    ["timeout 30 ./prep.sh", "prep.sh"],
    ["timeout -s KILL 30 ./prep.sh", "prep.sh"],
    ["sudo -u ci ./prep.sh", "prep.sh"],
    ["xargs -n 1 ./prep.sh", "prep.sh"],
    ["if true; then ./prep.sh; fi", "prep.sh"],
    ["if true; then sh ./scripts/prep.sh; fi", "scripts/prep.sh"],
    ["while false; do ./prep.sh; done", "prep.sh"],
    ["( ./prep.sh )", "prep.sh"],
    ["(sh ./scripts/prep.sh)", "scripts/prep.sh"],
    ["{ ./prep.sh; }", "prep.sh"],
    ["! ./prep.sh", "prep.sh"],
    ["./prep.sh>/dev/null", "prep.sh"],
    ["./prep.sh 2>&1 >>out.log", "prep.sh"],
    ["./prep.sh &>/dev/null", "prep.sh"],
    ["sh <./scripts/prep.sh", "scripts/prep.sh"],
    ["bash < scripts/prep.sh", "scripts/prep.sh"],
    ["bash -o pipefail scripts/prep.sh", "scripts/prep.sh"],
    ["bash -eo pipefail scripts/prep.sh", "scripts/prep.sh"],
    ["env -u DEBUG sh scripts/prep.sh", "scripts/prep.sh"],
    ["/usr/bin/env bash ./scripts/prep.sh", "scripts/prep.sh"],
    ["env -C scripts ./prep.sh", "scripts/prep.sh"],
    ["bash -c './prep.sh && ./scripts/prep.sh'", "scripts/prep.sh"],
    ["sh -c 'cd hooks && ./check.sh'", "hooks/check.sh"],
    ["npx tsx scripts/a.ts", "scripts/a.ts"],
    ["bunx tsx scripts/a.ts", "scripts/a.ts"],
    ["bun x tsx scripts/a.ts", "scripts/a.ts"],
    ["bun --bun run scripts/a.ts", "scripts/a.ts"],
    ["bun --cwd scripts run ./a.ts", "scripts/a.ts"],
    ["node -r dotenv/config scripts/a.js", "scripts/a.js"],
    ["# a comment\n./prep.sh", "prep.sh"],
  ];

  for (const [command, target] of SHELL_FORMS) {
    test(`a Write to the script \`${command}\` runs is refused by the floor`, () => {
      const cwd = harness();
      settings(cwd, { hooks: [{ event: "stop", command }] });
      expect(filesNamedBy(command, cwd)).toContain(join(cwd, target));
      expect(writeVerdict(cwd, target)).toBe("deny");
    });
  }

  test("a manager argv through env names the script env runs", () => {
    for (const first of ["/usr/bin/env", "env"]) {
      const cwd = harness();
      settings(cwd, { manager: { hooks: { preSpawn: [first, "bash", "scripts/prep.sh"] } } });
      expect(writeVerdict(cwd, "scripts/prep.sh")).toBe("deny");
    }
    const cwd = harness();
    expect(filesNamedByArgv(["nice", "-n", "5", "bash", "-c", "./prep.sh"], cwd)).toEqual([
      join(cwd, "prep.sh"),
    ]);
    expect(filesNamedByArgv(["env", "-u", "X", "A=1", "node", "lib/a.js"], cwd)).toEqual([
      join(cwd, "lib", "a.js"),
    ]);
  });

  test("a cd resolves later words in its own shell only, and an unknown one names nothing", () => {
    const cwd = harness();
    expect(filesNamedBy("(cd hooks && ./check.sh); ./prep.sh", cwd).sort()).toEqual(
      [join(cwd, "hooks", "check.sh"), join(cwd, "prep.sh")].sort(),
    );
    expect(filesNamedBy("cd scripts | ./prep.sh", cwd)).toEqual([join(cwd, "prep.sh")]);
    expect(filesNamedBy("cd $DIR && ./prep.sh", cwd)).toEqual([]);
    expect(filesNamedBy("cd - && ./prep.sh /abs/x.sh", cwd)).toEqual([]);
    expect(filesNamedBy("cd $DIR && /opt/hook.sh", cwd)).toEqual(["/opt/hook.sh"]);
    expect(filesNamedBy("cd ~ && ./x.sh", cwd)).toEqual([join(homedir(), "x.sh")]);
    expect(filesNamedBy("sh ~/x.sh", cwd)).toEqual([join(homedir(), "x.sh")]);
  });

  test("a redirection's target is not a word, and a here-document names nothing", () => {
    const cwd = harness();
    expect(filesNamedBy("./prep.sh > ./out/log.txt 2> ./err.txt", cwd)).toEqual([
      join(cwd, "prep.sh"),
    ]);
    expect(filesNamedBy("grep x < ./data/in.txt", cwd)).toEqual([]);
    expect(filesNamedBy("sh <<EOF\n./prep.sh\nEOF", cwd)).toEqual([]);
  });
});

describe("a subcommand, a module or a package script is not a file", () => {
  const cases: readonly string[] = [
    "bun test",
    "bun run test",
    "bun run lint",
    "bun lint",
    "bun install",
    "bun x prettier --check .",
    "deno task check",
    "deno test",
    "python -m pytest",
    "python3 -um pytest tests",
    "python -c 'import x'",
    "node -e 'process.exit(0)'",
    "node --test",
    "bun -e 'console.log(1)'",
    "npx prettier --check .",
    "node build",
  ];

  for (const command of cases) {
    test(`\`${command}\` names no file, and a Write under its words is not floor-held`, () => {
      const cwd = tempDir();
      settings(cwd, { hooks: [{ event: "stop", command }] });
      expect(filesNamedBy(command, cwd)).toEqual([]);
      const roots = runtimeStateRoots(undefined, undefined, cwd, {}, undefined);
      for (const word of ["test", "lint", "task", "check", "pytest", "x", "run", "build"]) {
        expect(protectedRootHolding(join(cwd, word, "a.test.ts"), roots, cwd)).toBeUndefined();
      }
    });
  }

  test("a package script word that is an existing file is that file", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "gen"), "x");
    expect(filesNamedBy("bun run gen", cwd)).toEqual([join(cwd, "gen")]);
    expect(filesNamedBy("bun run gen.ts", cwd)).toEqual([join(cwd, "gen.ts")]);
  });
});

describe("the manager-hook reading", () => {
  test("a string is one word, an array keeps its non-empty strings, and a path resolves", () => {
    const h = "/h";
    expect(managerHookArgv("  ./prep.sh --x ", h)).toEqual([resolve(h, "./prep.sh --x")]);
    expect(managerHookArgv(["../tools/p.sh", " a ", "", 3], h)).toEqual([
      resolve(h, "../tools/p.sh"),
      "a",
    ]);
    expect(managerHookArgv(["make", "x"], h)).toEqual(["make", "x"]);
    expect(managerHookArgv("", h)).toBeUndefined();
    expect(managerHookArgv([], h)).toBeUndefined();
    expect(managerHookArgv({ argv: [] }, h)).toBeUndefined();
  });
});

describe("the spec record of a spec kept elsewhere", () => {
  const record = (dir: string) => join(dir, ".crewhaus", "run", "spec");

  test("is a root when the spec's directory is not the working directory", () => {
    const cwd = tempDir();
    const specDir = tempDir("spec-dir-");
    const roots = runtimeStateRoots(undefined, undefined, cwd, {}, undefined, { specDir });
    for (const name of ["surfaces.json", "commits.jsonl", join("drafts", "x"), "lock"]) {
      expect(protectedRootHolding(join(record(specDir), name), roots, cwd)).toBeDefined();
    }
    expect(roots).toContain(record(specDir));
  });

  test("adds nothing in the spec's own directory, reached through a link or not", () => {
    const cwd = tempDir();
    const link = join(tempDir("spec-link-"), "via");
    symlinkSync(cwd, link);
    const plain = runtimeStateRoots(undefined, undefined, cwd, {}, undefined);
    expect(runtimeStateRoots(undefined, undefined, cwd, {}, undefined, { specDir: cwd })).toEqual(
      plain,
    );
    expect(runtimeStateRoots(undefined, undefined, cwd, {}, undefined, { specDir: link })).toEqual(
      plain,
    );
  });

  test("the run's scope supplies the spec's directory when no caller names it", () => {
    const cwd = tempDir();
    const specDir = tempDir("spec-scope-");
    const roots = runSpecDirScope.run(specDir, () =>
      runtimeStateRoots(undefined, undefined, cwd, {}, undefined),
    );
    expect(roots).toContain(record(specDir));
    expect(runtimeStateRoots(undefined, undefined, cwd, {}, undefined)).not.toContain(
      record(specDir),
    );
  });
});
