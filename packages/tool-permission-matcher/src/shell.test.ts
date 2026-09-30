/**
 * 0.7.1 — a scoped rule on a shell command line reads each simple command.
 *
 * `alwaysAllow Bash(git *)` used to allow `git status && rm -rf build`, and
 * `alwaysDeny Bash(rm -rf **)` missed an `rm` that came second, because the
 * glob was matched against the whole line. See `./shell.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OperativeValue,
  type ShellWork,
  compilePattern,
  linesRunBy,
  matchesPattern,
  readShellLine,
  shellRestrictReading,
  shellRestrictSpellings,
} from "./index";

// ---------------------------------------------------------------------------
// Reading a line
// ---------------------------------------------------------------------------

describe("readShellLine: the simple commands a line runs", () => {
  const SPLIT: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["git status", ["git status"]],
    ["git status && rm -rf build", ["git status", "rm -rf build"]],
    ["a || b", ["a", "b"]],
    ["a; b;", ["a", "b"]],
    ["a | b |& c", ["a", "b", "c"]],
    ["npm run dev & git status", ["npm run dev", "git status"]],
    ["a\nb", ["a", "b"]],
    ["(a; b) && { c; }", ["a", "b", "c"]],
    ["if a; then b; else c; fi", ["a", "b", "c"]],
    ["while a; do b; done", ["a", "b"]],
    ["! a", ["a"]],
    // Quotes, escapes and comments hide an operator; they do not split.
    ['git commit -m "a && b; c"', ['git commit -m "a && b; c"']],
    ["echo 'a | b'", ["echo 'a | b'"]],
    ["git status \\&\\& rm x", ["git status \\&\\& rm x"]],
    ["git status # && rm -rf x", ["git status"]],
    ["git status #it's\nrm -rf x", ["git status", "rm -rf x"]],
    ["echo ${x:-a;b}", ["echo ${x:-a;b}"]],
    // A redirection is part of its command, `&` in it included.
    ["git log 2>&1 | head -5", ["git log 2>&1", "head -5"]],
    ["git status &>/dev/null", ["git status &>/dev/null"]],
    ["make >| out <> in 2>&- && b", ["make >| out <> in 2>&-", "b"]],
    ["cat <<< 'x; y'", ["cat <<< 'x; y'"]],
    // A line continuation joins, a carriage return is just a character.
    ["git \\\nstatus", ["git \\\nstatus"]],
    ["git status\rrm -rf x", ["git status\rrm -rf x"]],
    // Nothing runs.
    ["", []],
    ["   # only a comment", []],
  ];

  test("splits at every control operator, and nowhere else", () => {
    for (const [line, commands] of SPLIT) {
      expect({ line, reading: readShellLine(line) }).toEqual({ line, reading: { commands } });
    }
    expect(SPLIT.length).toBe(25);
  });

  const OPAQUE: ReadonlyArray<readonly [string, string]> = [
    ["echo $(rm -rf x)", "a command substitution"],
    ["echo `rm -rf x`", "a command substitution"],
    ['echo "$(rm -rf x)"', "a command substitution"],
    ["echo ${x:-$(rm y)}", "a command substitution"],
    ["echo $((1 + 2))", "an arithmetic expansion"],
    ["diff <(a) >(b)", "a process substitution"],
    ["cat <<EOF\nrm -rf x\nEOF", "a here-document"],
    ["echo 'unterminated; rm -rf x", "an unterminated quote"],
    ['echo "unterminated; rm -rf x', "an unterminated quote"],
    ["echo $'a\\';rm x;'", "a $'…' string, which sh and bash read differently"],
    ["for f in *; do rm $f; done", "a `for` loop"],
    ["case $x in a) rm y;; esac", "a `case` statement"],
    ["f() { rm -rf x; }; f", "a function definition"],
    ["[[ -f a && -f b ]] && rm x", "a `[[ … ]]` test"],
    ["((x++))", "an arithmetic command"],
    ["a )", "an unmatched `)`"],
    ["(a", "an unclosed `(`"],
    ["a\u0000; b", "a NUL byte"],
  ];

  test("says why a line whose commands it cannot read out of its text is opaque", () => {
    for (const [line, why] of OPAQUE) {
      expect({ line, opaque: readShellLine(line).opaque }).toEqual({ line, opaque: why });
    }
    expect(OPAQUE.length).toBe(18);
  });
});

describe("shellRestrictSpellings: what a deny or ask also reads", () => {
  const READS: ReadonlyArray<readonly [string, string]> = [
    ["git status && rm -rf build", "rm -rf build"],
    ["FOO=1 rm -rf build", "rm -rf build"],
    ["FOO=\"a b\" BAR='c' rm -rf build", "rm -rf build"],
    ["2>/dev/null rm -rf build", "rm -rf build"],
    ['"r"m -rf build', "rm -rf build"],
    ["r\\m -rf build", "rm -rf build"],
    ["env -i PATH=/bin rm -rf build", "rm -rf build"],
    ["sudo -u root rm -rf build", "rm -rf build"],
    ["ls | xargs -0 rm -rf build", "rm -rf build"],
    ["timeout -s KILL 10 rm -rf build", "rm -rf build"],
    ["nice -n 5 nohup rm -rf build", "rm -rf build"],
    ["command rm -rf build", "rm -rf build"],
    ["exec rm -rf build", "rm -rf build"],
    ["eval 'rm -rf build'", "rm -rf build"],
    ['bash -o pipefail -c "true; rm -rf build"', "rm -rf build"],
    ["sh -lc 'rm -rf build'", "rm -rf build"],
    ["env -S 'rm -rf build'", "rm -rf build"],
    ["echo $(rm -rf build)", "rm -rf build"],
    ["echo `rm -rf build`", "rm -rf build"],
    ["cat <(rm -rf build)", "rm -rf build"],
    ["cat <<EOF | sh\nrm -rf build\nEOF", "rm -rf build"],
    // bash reads `$'…'` as one word; dash reads the `;` after it.
    ["echo $'a\\';rm -rf build;'", "rm -rf build"],
    ["echo 'x\nrm -rf build", "rm -rf build"],
    ['eval "eval \'sh -c \\"rm -rf build\\"\'"', "rm -rf build"],
    // The variables the line sets to plain text are put in.
    ["x=rm; $x -rf build", "rm -rf build"],
    ["x=r; y=m; ${x}$y -rf build", "rm -rf build"],
    ["x=build; rm -rf $x", "rm -rf build"],
    ["export X='rm -rf build'; eval \"$X\"", "rm -rf build"],
    ['x=rm; sh -c "$x -rf build"', "rm -rf build"],
    // Bash spreads a brace list.
    ["{rm,-rf,build}", "rm -rf build"],
    ["{env,rm} -rf build", "rm -rf build"],
  ];

  test("each simple command, from its program on, unquoted, through wrappers and nesting", () => {
    for (const [line, spelling] of READS) {
      expect({ line, reads: shellRestrictSpellings(line).includes(spelling) }).toEqual({
        line,
        reads: true,
      });
    }
    expect(READS.length).toBe(31);
  });

  test("a program the text does not name is unknown, and every deny then fires", () => {
    const unread = "a program named by a variable the line sets from something it cannot read";
    const UNKNOWN: ReadonlyArray<readonly [string, string]> = [
      ["$(echo rm) -rf build", "a program named by a command substitution"],
      ["`echo rm` -rf build", "a program named by a command substitution"],
      ["x=$(cat f); $x -rf build", unread],
      ["read x <<< rm; $x -rf build", unread],
      ['set -- rm -rf build; "$@"', unread],
      ["for x in rm; do $x -rf build; done", unread],
      ["printf -v x rm; $x -rf build", unread],
      [
        "${x:-rm} -rf build",
        "a program named by a parameter expansion with a default, a trim or a length",
      ],
      ["IFS=,; x=rm,-rf,build; $x", "a program named by a variable split on an IFS the line sets"],
      ["/bin/r? -rf build", "a program named by a pathname pattern"],
      ["/bin/[r]m -rf build", "a program named by a pathname pattern"],
      ["eval '$(echo rm) -rf build'", "a program named by a command substitution"],
    ];
    for (const [line, why] of UNKNOWN) {
      expect({ line, why: shellRestrictReading(line).unknownProgram }).toEqual({ line, why });
    }
    expect(UNKNOWN.length).toBe(12);
    // Expanded, the line would be far longer than written: read no further.
    expect(shellRestrictReading(`x=${"a".repeat(1000)}; ${"$x ".repeat(300)}`).unknownProgram).toBe(
      "a line whose variables expand past what is read",
    );
    // The harness's own variables, a test and a quoted pattern are known.
    for (const line of [
      "$HOME/bin/tool x",
      '"$PYTHON" script.py',
      "[ -f x ] && rm x",
      // A `[` nothing closes is no pattern: bash's `[[` names itself.
      "[[ -f x ]]",
      "[[ -d node_modules ]] || npm install",
      "if [[ -f crewhaus.yaml ]]; then bunx crewhaus compile crewhaus.yaml; fi",
      "echo *.ts",
      "'/bin/r?' x",
      "x=$(pwd); unset x; git status",
    ]) {
      expect({ line, why: shellRestrictReading(line).unknownProgram }).toEqual({
        line,
        why: undefined,
      });
    }
  });

  test("an ordinary command is not read as another program", () => {
    for (const line of [
      "git rm build",
      'echo "rm -rf build"',
      "grep -rn rm .",
      "command -v rm",
      "git commit -m 'rm -rf build'",
    ]) {
      const reads = shellRestrictSpellings(line).filter((s) => /^rm\b/.test(s));
      expect({ line, reads }).toEqual({ line, reads: [] });
    }
  });

  test("linesRunBy: the line an argv hands a shell, an eval or an env -S", () => {
    expect(linesRunBy(["sh", "-c", "git status && rm -rf x"])).toEqual(["git status && rm -rf x"]);
    expect(linesRunBy(["/usr/bin/env", "A=1", "bash", "-o", "pipefail", "-c", "a; b"])).toEqual([
      "a; b",
    ]);
    expect(linesRunBy(["sudo", "-u", "root", "zsh", "-ec", "x"])).toEqual(["x"]);
    expect(linesRunBy(["env", "-S", "rm -rf x", "y"])).toEqual(["rm -rf x y"]);
    expect(linesRunBy(["git", "status"])).toEqual([]);
    expect(linesRunBy(["sh", "script.sh"])).toEqual([]);
  });
});

describe("the reader costs the length of the line", () => {
  // Counted, not timed: sixteen times the input is at most sixteen times
  // the work. Before the reader stopped looking for an end once one was
  // missing, each unterminated `"$(` scanned the rest of the line again.
  const CASES: ReadonlyArray<readonly [string, (k: number) => string]> = [
    ['unterminated "$(', (k) => '"$('.repeat(k)],
    ["unterminated $(", (k) => "$(".repeat(k)],
    ["unterminated backtick", (k) => `\`${"a;".repeat(k)}`],
    ["unterminated ${", (k) => "${".repeat(k)],
    ["unterminated $'", (k) => "$'\\'".repeat(k)],
    ["nested $(", (k) => `${"echo $(".repeat(k)}${")".repeat(k)}`],
    ["framing words", (k) => `${"! ".repeat(k)}x`],
    ["eval chain", (k) => `${"eval ".repeat(k)}x`],
    ["wrapper chain", (k) => `${"env ".repeat(k)}x`],
    ["quoted substitutions", (k) => '"$(echo ")")"; '.repeat(k)],
    ["one variable used often", (k) => `x=${"a".repeat(k)}; ${"$x ".repeat(k)}`],
    ["a long brace list", (k) => `{${"a,".repeat(k)}`],
    ["many assignments", (k) => `${"x=$x$x; ".repeat(k)}$x`],
  ];

  test("readShellLine and shellRestrictSpellings are linear on crafted lines", () => {
    for (const [name, make] of CASES) {
      const small: ShellWork = { steps: 0 };
      const large: ShellWork = { steps: 0 };
      readShellLine(make(500), small);
      shellRestrictSpellings(make(500), small);
      readShellLine(make(8000), large);
      shellRestrictSpellings(make(8000), large);
      expect(small.steps).toBeGreaterThan(0);
      expect({ name, linear: large.steps / small.steps < 17 }).toEqual({ name, linear: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Against a real shell
// ---------------------------------------------------------------------------

/**
 * Lines are run by every shell here with PATH holding only stub programs
 * that log their names, so what really runs can be compared with what the
 * reader says. Only the stubs `p1`–`p4` are on PATH; everything else the
 * lines name is a builtin or an absolute path to a harmless program.
 */
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/dash", "/usr/bin/dash"].filter((s) => {
  try {
    return process.platform !== "win32" && Bun.file(s).size > 0;
  } catch {
    return false;
  }
});

let stubDir = "";
beforeAll(() => {
  if (SHELLS.length === 0) return;
  stubDir = mkdtempSync(join(tmpdir(), "shell-oracle-"));
  for (const name of ["p1", "p2", "p3", "p4"]) {
    const path = join(stubDir, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "\${0##*/}" >> "$LOG"\n`);
    chmodSync(path, 0o755);
  }
});
afterAll(() => {
  if (stubDir !== "") rmSync(stubDir, { recursive: true, force: true });
});

/**
 * The programs one run of `line` started. Each run logs to a file of its
 * own: a program a line leaves running in the background (`p1 &` in dash)
 * may write after the shell exits, and must not land in the next run's log.
 */
let runs = 0;
function programsRun(shell: string, line: string): string[] {
  const log = join(stubDir, `log-${runs++}`);
  writeFileSync(log, "");
  Bun.spawnSync([shell, "-c", line], {
    cwd: stubDir,
    env: { PATH: stubDir, LOG: log },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: 10_000,
  });
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "");
}

/** The program of a simple command: its first word after the variables it sets. */
function programOf(command: string): string {
  const words = command.split(/\s+/).filter((w) => w !== "");
  return words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
}

describe.skipIf(SHELLS.length === 0)("what a real shell runs", () => {
  // Lines the reader splits: every program that runs is the program of a
  // command it names, so an allow that must match each command saw it.
  const SPLITTABLE = [
    "p1 && p2",
    "p1 || p2",
    "false || p2",
    "p1; p2",
    "p1 | p2",
    "p1 & p2; wait",
    "p1\np2",
    "(p1; p2)",
    "{ p1; p2; }",
    "if p1; then p2; else p3; fi",
    "while false; do p1; done; p2",
    "! p1 && p2",
    "p1 # ; p2",
    "p1 '; p2'",
    'p1 "a && p2"',
    "p1 \\; p2",
    "X=1 p1",
    "p1 2>&1 | p2",
    "p1 >/dev/null; p2",
    "p1 &>/dev/null; p2",
    "p1 &&\\\np2",
    "p1 |& p2",
    "p1 >| out; p2",
    "p1 2>/dev/null && p3",
    "p1\rp2",
    "p1 #it's\np2",
  ];
  // Lines the reader cannot split: a deny still reads every program they run.
  const OPAQUE = [
    "p1 $(p2)",
    "p1 `p2`",
    'p1 "$(p2)"',
    "echo ${x:-$(p1)}",
    "p1 <<EOF\nx\nEOF\np2",
    "p1 <(p2)",
    "for x in a; do p1; done",
    "f() { p1; }; f",
    "[[ -n x ]] && p1",
    "echo $'\\'' ; p2",
    "echo 'x\np2",
  ];
  // Lines that run a program through another: a deny reads it.
  const WRAPPED = [
    'eval "p1; p2"',
    "/bin/sh -c 'p1 && p2'",
    "/usr/bin/env X=1 p1",
    "command p1",
    "exec p1",
    "/usr/bin/nice -n 1 p1",
    "echo x | /usr/bin/xargs p1",
    '"p"1',
    "p\\1",
    "/usr/bin/nohup p1 >/dev/null 2>&1",
    "X=1 /usr/bin/env p1",
    "x=p1; $x",
    "x=p; ${x}1 a",
    'x=p1; eval "$x"',
    "{p1,a}",
    'set -- p1; "$@"',
    "read x <<EOF\np1\nEOF\n$x",
    "IFS=,; x=p1,a; $x",
    "$(printf p1)",
    "${x:-p1}",
    "X=\"a b\" Y='c' p1",
  ];

  test("every program a splittable line runs is the program of one of its commands", () => {
    let chains = 0;
    for (const shell of SHELLS) {
      for (const line of SPLITTABLE) {
        const reading = readShellLine(line);
        expect({ line, opaque: reading.opaque }).toEqual({ line, opaque: undefined });
        const programs = new Set(reading.commands.map(programOf));
        const ran = programsRun(shell, line);
        if (new Set(ran).size > 1) chains++;
        for (const program of ran) {
          expect({ shell, line, program, named: programs.has(program) }).toEqual({
            shell,
            line,
            program,
            named: true,
          });
        }
      }
    }
    // The corpus really runs more than one program per line in most shells —
    // the case the whole-line reading got wrong.
    expect(chains).toBeGreaterThanOrEqual(12 * SHELLS.length);
  }, 60_000);

  test("every program any line runs is read by a deny", () => {
    let seen = 0;
    for (const shell of SHELLS) {
      for (const line of [...SPLITTABLE, ...OPAQUE, ...WRAPPED]) {
        const reading = shellRestrictReading(line);
        const spellings = [line, ...reading.spellings];
        for (const program of programsRun(shell, line)) {
          seen++;
          // An unknown program fires every deny.
          const read =
            reading.unknownProgram !== undefined ||
            spellings.some((s) => s === program || s.startsWith(`${program} `));
          expect({ shell, line, program, read }).toEqual({ shell, line, program, read: true });
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(40 * SHELLS.length);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// A shell value in the matcher
// ---------------------------------------------------------------------------

const bash = (command: string): OperativeValue[] => [
  { kind: "command", canonical: [command], shell: true },
];
const allowed = (pattern: string, command: string): boolean =>
  matchesPattern(compilePattern(pattern), "Bash", {}, { operativeValues: bash(command) });
const fires = (pattern: string, command: string): boolean =>
  matchesPattern(
    compilePattern(pattern),
    "Bash",
    {},
    { polarity: "restrict", operativeValues: bash(command) },
  );

describe("a shell value: an allow covers every command, a deny fires on any", () => {
  test("a scoped allow must match each simple command", () => {
    expect(allowed("Bash(git *)", "git status && rm -rf build")).toBe(false);
    expect(allowed("Bash(git *)", "git status; git log")).toBe(true);
    expect(allowed("Bash(git *)", "git status | head")).toBe(false);
    expect(allowed("Bash(git *)", "git status\nrm -rf build")).toBe(false);
    expect(allowed("Bash(git *)", "(git status) && { git log; }")).toBe(true);
    expect(allowed("Bash(git status)", "git status;")).toBe(true);
    expect(allowed("Bash(npm *)", "npm install 2>&1 | tail -5")).toBe(false);
    // Quoting still hides an operator, as the shell reads it.
    expect(allowed("Bash(git *)", 'git commit -m "fix && tidy"')).toBe(true);
  });

  test("no scoped allow covers a line it cannot split", () => {
    expect(allowed("Bash(git *)", "git log $(rm -rf build)")).toBe(false);
    expect(allowed("Bash(git *)", "git log `rm -rf build`")).toBe(false);
    expect(allowed("Bash(cat *)", "cat <<EOF\nx\nEOF")).toBe(false);
    expect(allowed("Bash(git *)", "git log 'oops")).toBe(false);
    expect(allowed("Bash(echo *)", "echo $'a\\';rm x;'")).toBe(false);
  });

  test("a bare allow, `*` and `**` grant what they always did", () => {
    const bare = compilePattern("Bash");
    for (const line of ["git status && rm -rf build", "echo $(date)", "cat /etc/hosts | wc"]) {
      expect(matchesPattern(bare, "Bash", {}, { operativeValues: bash(line) })).toBe(true);
      expect(allowed("Bash(**)", line)).toBe(true);
    }
    expect(allowed("Bash(*)", "git status && rm -rf build")).toBe(true);
    expect(allowed("Bash(*)", "echo $(date)")).toBe(true);
    // `*` never crossed a `/`, split or not.
    expect(allowed("Bash(*)", "cat /etc/hosts")).toBe(false);
  });

  test("an allow with no wildcard grants the exact line it spells", () => {
    expect(allowed("Bash(cd build && make)", "cd build && make")).toBe(true);
    expect(allowed("Bash(cd build && make)", "cd build && make && rm -rf ~")).toBe(false);
    expect(allowed("Bash(echo $\\(date\\))", "echo $(date)")).toBe(true);
    // A wildcard makes it a pattern again, read command by command.
    expect(allowed("Bash(cd build && make *)", "cd build && make all")).toBe(true);
    expect(allowed("Bash(cd build && make *)", "cd build && rm -rf ~")).toBe(false);
  });

  test("an allow written as a chain grants a line joined the same way, piece by piece", () => {
    // The harness-designer starter's rule: validate from inside the
    // generated directory, which varies.
    const cd = "Bash(cd ** && bunx crewhaus compile**)";
    for (const line of [
      "cd gen/foo && bunx crewhaus compile crewhaus.yaml",
      "cd gen/foo && bunx crewhaus compile crewhaus.yaml --emit-ir",
      "cd gen/foo&&bunx crewhaus compile crewhaus.yaml --strict",
    ]) {
      expect({ line, allowed: allowed(cd, line) }).toEqual({ line, allowed: true });
    }
    for (const line of [
      // Each piece reads only the command in its place.
      "cd gen/foo && rm -rf ~",
      "rm -rf ~ && bunx crewhaus compile x",
      // Another arrangement is another chain: a `**` cannot reach past an
      // operator the line has and the rule does not.
      "cd gen/foo && bunx crewhaus compile x && rm -rf ~",
      "cd a; rm -rf ~; cd b && bunx crewhaus compile x",
      "cd gen/foo; bunx crewhaus compile x",
      "cd gen/foo || bunx crewhaus compile x",
      "cd gen/foo & bunx crewhaus compile x",
      // A line it cannot split, or whose program it cannot name, still asks.
      "cd $(rm -rf ~) && bunx crewhaus compile x",
      "cd x && bunx crewhaus compile `rm -rf ~`",
      "cd x && $y crewhaus compile x",
    ]) {
      expect({ line, allowed: allowed(cd, line) }).toEqual({ line, allowed: false });
    }
    // The other chained lines that starter runs, each written as a chain.
    expect(
      allowed("Bash(git fetch** && git pull --ff-only**)", "git fetch && git pull --ff-only"),
    ).toBe(true);
    expect(allowed("Bash(mkdir -p ** && cp **)", "mkdir -p a && cp b a/")).toBe(true);
    expect(allowed("Bash(test -f ** || echo missing)", "test -f x || echo missing")).toBe(true);
    expect(allowed("Bash(test -f ** || echo missing)", "test -f x || echo gone")).toBe(false);
    // The words that frame a compound command are part of the arrangement.
    const framed = "Bash(if test -f **; then make *; fi)";
    expect(allowed(framed, "if test -f x; then make all; fi")).toBe(true);
    expect(allowed(framed, "if test -f x; then make all; rm -rf ~; fi")).toBe(false);
    expect(allowed(framed, "while test -f x; do make all; done")).toBe(false);
    // Quoting still hides an operator, in the line as in the rule.
    expect(allowed(cd, 'cd "a && b" && bunx crewhaus compile x')).toBe(true);
  });

  test("a deny or ask fires on the whole line and on any command in it", () => {
    expect(fires("Bash(rm -rf **)", "git status && rm -rf build")).toBe(true);
    expect(fires("Bash(rm -rf **)", "git status; FOO=1 rm -rf build")).toBe(true);
    expect(fires("Bash(rm -rf **)", "git log $(rm -rf build)")).toBe(true);
    expect(fires("Bash(rm -rf **)", "bash -c 'rm -rf build'")).toBe(true);
    expect(fires("Bash(rm -rf **)", "RM -RF build")).toBe(true);
    // A deny written for a whole line keeps firing on it.
    expect(fires("Bash(git status && rm*)", "git status && rm -rf build")).toBe(true);
    // And one naming the first command still fires.
    expect(fires("Bash(git status)", "git status && ls")).toBe(true);
    // Through the variables the line sets.
    expect(fires("Bash(rm -rf **)", "x=rm; $x -rf build")).toBe(true);
    expect(fires("Bash(rm -rf build)", "x=build; rm -rf $x")).toBe(true);
    // A program the text does not name fires every deny and ask; no allow
    // but one that names every command grants it.
    expect(fires("Bash(curl **)", "$(echo rm) -rf build")).toBe(true);
    expect(fires("Bash(curl **)", "read x <<< rm; $x -rf build")).toBe(true);
    expect(allowed("Bash(* *)", "read x; $x -rf build")).toBe(false);
    expect(allowed("Bash(* *)", "x=rm; $x -rf build")).toBe(false);
    expect(allowed("Bash(ls *)", "ls src/*.ts")).toBe(false);
    expect(allowed("Bash(ls **)", "ls src/*.ts")).toBe(true);
    expect(allowed("Bash(* *)", "/bin/r? -rf build")).toBe(false);
    expect(allowed("Bash(**)", "read x; $x -rf build")).toBe(true);
    expect(fires("Bash(curl **)", '"$PYTHON" script.py')).toBe(false);
    expect(fires("Bash(rm -rf **)", "git rm -rf build")).toBe(false);
    expect(fires("Bash(rm -rf **)", 'echo "rm -rf build"')).toBe(false);
  });

  test("a `[[ … ]]` test sets off only the denies it matches, as on 0.7.0", () => {
    // `[[` is bash's reserved word, not a pattern: an unrelated deny stays
    // quiet, so a deny-first spec reaches its catch-all ask or bare allow.
    for (const line of [
      "[[ -f x ]]",
      "[[ -d node_modules ]] || npm install",
      "if [[ -f crewhaus.yaml ]]; then bunx crewhaus compile crewhaus.yaml; fi",
    ]) {
      expect({ line, fires: fires("Bash(**rm -rf **)", line) }).toEqual({ line, fires: false });
      expect({ line, fires: fires("Bash(**sudo **)", line) }).toEqual({ line, fires: false });
    }
    // A deny that names a command in it still fires.
    expect(fires("Bash(npm install)", "[[ -d node_modules ]] || npm install")).toBe(true);
    // A pattern that a `]` closes still names an unknown program.
    expect(fires("Bash(**sudo **)", "/bin/[r]m -rf build")).toBe(true);
  });

  test("a value only a deny reads never widens or narrows an allow", () => {
    const values: OperativeValue[] = [
      { kind: "command", canonical: ["sh -c x && rm -rf build"] },
      {
        kind: "command",
        canonical: [],
        spellings: ["x && rm -rf build"],
        shell: true,
        restrictOnly: true,
      },
    ];
    const p = compilePattern("RunCommand(sh -c *)");
    expect(matchesPattern(p, "RunCommand", {}, { operativeValues: values })).toBe(true);
    expect(
      matchesPattern(
        compilePattern("RunCommand(rm -rf **)"),
        "RunCommand",
        {},
        {
          polarity: "restrict",
          operativeValues: values,
        },
      ),
    ).toBe(true);
  });

  test("a tool named Bash that declares nothing reads its command the same way", () => {
    const p = compilePattern("Bash(git *)");
    expect(matchesPattern(p, "Bash", { command: "git status && rm -rf build" })).toBe(false);
    expect(
      matchesPattern(
        compilePattern("Bash(rm **)"),
        "Bash",
        { command: "git status && rm -rf build" },
        { polarity: "restrict" },
      ),
    ).toBe(true);
    // Another tool's text is not a shell line.
    expect(
      matchesPattern(compilePattern("Other(git *)"), "Other", { text: "git status && rm" }),
    ).toBe(true);
  });
});
