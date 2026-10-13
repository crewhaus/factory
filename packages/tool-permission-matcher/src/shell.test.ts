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
  MAX_SHELL_DIRS,
  type OperativeValue,
  type ShellWork,
  compilePattern,
  holdsUnexpanded,
  linesRunBy,
  matchesPattern,
  programWords,
  readShellChain,
  readShellLine,
  readsShellOnInput,
  shellProgramWords,
  shellRestrictReading,
  shellRestrictSpellings,
  withShellPwd,
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

  test("readShellChain: the commands, and what joins them with the blanks beside operators dropped", () => {
    expect(readShellChain("cd gen/foo  &&  bunx crewhaus compile x")).toEqual({
      commands: ["cd gen/foo", "bunx crewhaus compile x"],
      joins: ["", "&&", ""],
    });
    expect(readShellChain("if test -f x;  then make all ; fi")).toEqual({
      commands: ["test -f x", "make all"],
      joins: ["if", ";then", ";fi"],
    });
    expect(readShellChain("( a | b ) || c")?.joins).toEqual(["(", "|", ")||", ""]);
    // A line it cannot split has no chain.
    expect(readShellChain("echo $(date) && ls")).toBeUndefined();
  });

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
    ["many joins", (k) => "a  &&  ;  ".repeat(k)],
  ];

  test("readShellLine, readShellChain and shellRestrictSpellings are linear on crafted lines", () => {
    for (const [name, make] of CASES) {
      const small: ShellWork = { steps: 0 };
      const large: ShellWork = { steps: 0 };
      readShellLine(make(500), small);
      readShellChain(make(500), small);
      shellRestrictSpellings(make(500), small);
      readShellLine(make(8000), large);
      readShellChain(make(8000), large);
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

// critic8 (0.7.1): the words of a command that name code it runs are the ones
// the gate reads where the kernel finds them. A program is found by its path
// when it has a `/`; an interpreter opens the files it is handed.
describe("programWords: the words of a command that name code it runs", () => {
  const read = (...words: string[]) => {
    const got = programWords(words);
    return {
      programs: got.programs.map((i) => words[i]),
      operands: got.operands.map((i) => words[i]),
    };
  };

  test("the program, and the one each wrapper on the way runs", () => {
    expect(read("./x.sh", "a/../b")).toEqual({ programs: ["./x.sh"], operands: [] });
    expect(read("timeout", "5", "./x.sh")).toEqual({
      programs: ["timeout", "./x.sh"],
      operands: [],
    });
    expect(read("sudo", "-u", "root", "env", "A=1", "./x.sh").programs).toEqual([
      "sudo",
      "env",
      "./x.sh",
    ]);
    expect(read("caffeinate", "-t", "60", "./x.sh").programs).toEqual(["caffeinate", "./x.sh"]);
    // An argument is the program's to read, not code the OS runs.
    expect(read("git", "diff", "a/../b")).toEqual({ programs: ["git"], operands: [] });
  });

  test("every operand an interpreter is handed that is not an option", () => {
    expect(read("sh", "x.sh", "arg").operands).toEqual(["x.sh", "arg"]);
    expect(read("node", "-r", "./hook.js", "app.js").operands).toEqual(["./hook.js", "app.js"]);
    expect(read("bun", "./x.ts").operands).toEqual(["./x.ts"]);
    expect(read("python3.12", "-u", "x.py").operands).toEqual(["x.py"]);
    expect(read("bash", "--", "-x.sh").operands).toEqual(["-x.sh"]);
    expect(read("bash", "-o", "pipefail", "x.sh").operands).toEqual(["x.sh"]);
    expect(read("env", "FOO=1", "sh", "link/../run.sh").operands).toEqual(["link/../run.sh"]);
    // A shell given a line, an eval: the line is read by linesRunBy, not here.
    expect(read("sh", "-c", "./a/../b", "x").operands).toEqual([]);
    expect(read("bash", "-lc", "./a/../b").operands).toEqual([]);
    // Not an interpreter.
    expect(read("python3x", "x.py").operands).toEqual([]);
  });

  test("code written in an argument, a module by name, or a script on the input: no file is handed", () => {
    expect(read("python3", "-c", "print('a/../b')", "a/../b").operands).toEqual([]);
    expect(read("python3", "-Bc", "x", "y/z").operands).toEqual([]);
    expect(read("python3", "-m", "pytest", "tests/x.py").operands).toEqual([]);
    expect(read("node", "-e", "x", "a/b").operands).toEqual([]);
    expect(read("node", "--eval=x", "a/b").operands).toEqual([]);
    expect(read("perl", "-pe", "s/a/b/", "f/g").operands).toEqual([]);
    expect(read("bash", "-s", "./x").operands).toEqual([]);
    // What comes before the code is still handed: `-r` loads a module file.
    expect(read("node", "-r", "./hook.js", "-e", "x").operands).toEqual(["./hook.js"]);
  });

  // critic9 (0.7.1): node and `bun run` fold a `..` as text before they
  // open their script; a shell, Python 3, Perl and Ruby hand it to the
  // kernel as written. Measured with a link and a `..` and a marker each
  // script wrote.
  test("the script of an interpreter that opens it through the kernel, and no other", () => {
    const script = (...words: string[]) => {
      const at = programWords(words).kernelScript;
      return at === undefined ? undefined : words[at];
    };
    for (const shell of ["sh", "bash", "dash", "zsh", "ksh", "csh", "tcsh"]) {
      expect({ shell, script: script(shell, "-e", "x.sh", "arg") }).toEqual({
        shell,
        script: "x.sh",
      });
    }
    expect(script(".", "x.sh")).toBe("x.sh");
    expect(script("source", "x.sh")).toBe("x.sh");
    expect(script("python3", "-u", "x.py", "y")).toBe("x.py");
    expect(script("python3.12", "x.py")).toBe("x.py");
    expect(script("/usr/bin/perl", "-w", "x.pl")).toBe("x.pl");
    expect(script("env", "A=1", "ruby", "x.rb")).toBe("x.rb");
    // Folded as text first, or never measured: none.
    for (const words of [
      ["node", "x.mjs"],
      ["nodejs", "x.mjs"],
      ["bun", "run", "x.mjs"],
      ["bun", "x.mjs"],
      ["deno", "run", "x.ts"],
      ["tsx", "x.ts"],
      ["ts-node", "x.ts"],
      ["python", "x.py"],
      ["pypy3", "x.py"],
      ["fish", "x.fish"],
      ["php", "x.php"],
    ]) {
      expect({ words, script: script(...words) }).toEqual({ words, script: undefined });
    }
    // No script among the operands: code in an argument, a module by name,
    // a script on the input, a line.
    expect(script("python3", "-c", "x", "y.py")).toBeUndefined();
    expect(script("python3", "-m", "pytest", "t.py")).toBeUndefined();
    expect(script("perl", "-e", "1", "x.pl")).toBeUndefined();
    expect(script("bash", "-s", "x.sh")).toBeUndefined();
    expect(script("sh", "-c", "x.sh")).toBeUndefined();
    expect(script("sh")).toBeUndefined();
  });

  // interp review (0.7.1): the first word after an interpreter's options may
  // be an option's argument, not its script. `ruby -r ./lnk/../evil.rb
  // safe/ok.rb` loads ./evil.rb — `require` folds the `..` as text — so only
  // the word after the argument is opened where the kernel walks. Measured
  // with `interp OPT a b`, each file writing its name to a marker.
  test("an option's argument is never the kernel's script", () => {
    const script = (...words: string[]) => {
      const at = programWords(words).kernelScript;
      return at === undefined ? undefined : words[at];
    };
    // The argument in the next word, or in the rest of the option's word.
    expect(script("ruby", "-r", "./x.rb", "y.rb")).toBe("y.rb");
    expect(script("ruby", "-wr", "./x.rb", "y.rb")).toBe("y.rb");
    expect(script("ruby", "-r./x.rb", "y.rb")).toBe("y.rb");
    expect(script("ruby", "-I", "lib", "-r", "x", "y.rb")).toBe("y.rb");
    expect(script("ruby", "-E", "UTF-8", "y.rb")).toBe("y.rb");
    expect(script("ruby", "--disable", "gems", "y.rb")).toBe("y.rb");
    expect(script("ruby", "--disable=gems", "--verbose", "y.rb")).toBe("y.rb");
    expect(script("perl", "-I", "lib", "x.pl")).toBe("x.pl");
    expect(script("perl", "-wIlib", "x.pl")).toBe("x.pl");
    expect(script("python3", "-W", "ignore", "x.py")).toBe("x.py");
    expect(script("python3", "-bWignore", "-X", "dev", "x.py")).toBe("x.py");
    expect(script("python3", "--check-hash-based-pycs", "always", "x.py")).toBe("x.py");
    expect(script("bash", "-o", "pipefail", "x.sh")).toBe("x.sh");
    expect(script("bash", "-eO", "extglob", "x.sh")).toBe("x.sh");
    expect(script("bash", "--rcfile", "rc", "x.sh")).toBe("x.sh");
    expect(script("zsh", "-oerrexit", "x.sh")).toBe("x.sh");
    expect(script("zsh", "--emulate", "sh", "x.sh")).toBe("x.sh");
    expect(script("sh", "--", "x.sh")).toBe("x.sh");
    // An option that may take the next word, or moves where the script is
    // opened from, or looks it up on PATH: no word is the script.
    for (const words of [
      ["ruby", "-W", "x.rb"],
      ["ruby", "-C", "dir", "x.rb"],
      ["ruby", "-x", "x.rb"],
      ["ruby", "-S", "x.rb"],
      ["ruby", "-Q", "x.rb"],
      ["ruby", "--backtrace-limit", "1", "x.rb"],
      ["perl", "-Mstrict", "x.pl"],
      ["perl", "-x", "dir", "x.pl"],
      ["python3", "-Z", "x.py"],
      // bash's `-oe pipefail`: `-o` takes the next word whatever follows it.
      ["bash", "-oe", "pipefail", "x.sh"],
      ["bash", "-Z", "x.sh"],
      ["zsh", "-b", "-x", "x.sh"],
      ["csh", "-b", "x.sh"],
      [".", "-p", "dir", "x.sh"],
      ["python3", "-", "x.py"],
    ]) {
      expect({ words, script: script(...words) }).toEqual({ words, script: undefined });
    }
  });

  test("the directory each wrapper moves to, and the PATH each sets, from the word it applies to", () => {
    const words = ["env", "-C", "sub", "PATH=bin", "sudo", "--chdir=deep", "./x.sh"];
    const got = programWords(words);
    expect(got.chdirs).toEqual([
      { from: 4, dir: "sub" },
      { from: 6, dir: "deep" },
    ]);
    expect(got.paths).toEqual([{ from: 4, path: "bin" }]);
    expect(programWords(["sudo", "-D", "sub", "./x.sh"]).chdirs).toEqual([{ from: 3, dir: "sub" }]);
    expect(programWords(["env", "-P", "bin", "x"]).paths).toEqual([{ from: 3, path: "bin" }]);
    expect(programWords(["env", "-u", "C", "./x.sh"]).chdirs).toEqual([]);
    // A PATH the line sets for the command is looked up from its program on.
    expect(programWords(["x"], "bin").paths).toEqual([{ from: 0, path: "bin" }]);
  });
});

describe("shellProgramWords: each simple command of a line, unquoted, at every level", () => {
  const read = (line: string) =>
    shellProgramWords(line).map((c) => ({
      words: c.words,
      programs: c.programs.programs.map((i) => c.words[i]),
      operands: c.programs.operands.map((i) => c.words[i]),
    }));
  /** Each command's program and the directories it may run in (`?`: not told). */
  const dirs = (line: string) =>
    shellProgramWords(line).map((c) => [
      c.words.join(" "),
      c.dirs === undefined
        ? "?"
        : c.dirs.map((d) => (d.physical === "" ? d.logical : `${d.logical}|${d.physical}`)),
    ]);

  test("the line's own commands, with variables put in and quoting taken off", () => {
    expect(read("FOO=1 './scripts/../x.sh' a && sh \"link/../run.sh\"")).toEqual([
      { words: ["./scripts/../x.sh", "a"], programs: ["./scripts/../x.sh"], operands: [] },
      { words: ["sh", "link/../run.sh"], programs: ["sh"], operands: ["link/../run.sh"] },
    ]);
    expect(read("p=./a/../b; $p").map((c) => c.programs)).toEqual([["./a/../b"]]);
  });

  test("the commands of a line it hands a shell, and of a substitution", () => {
    expect(read("sh -c './a/../b x'").map((c) => c.programs)).toEqual([["sh"], ["./a/../b"]]);
    expect(read("echo $(./c/../d)").map((c) => c.programs)).toEqual([["echo"], ["./c/../d"]]);
  });

  test("a command after a `cd` runs where it moved, joined as text the way cd does", () => {
    expect(dirs("./a.sh; cd sub && ./b.sh")).toEqual([
      ["./a.sh", [""]],
      ["cd sub", [""]],
      ["./b.sh", ["sub"]],
    ]);
    expect(dirs("cd a && cd .. && cd b/c && ./x")).toEqual([
      ["cd a", [""]],
      ["cd ..", ["a"]],
      ["cd b/c", ["a/.."]],
      ["./x", ["a/../b/c"]],
    ]);
    expect(dirs("cd /abs && ./x").at(-1)).toEqual(["./x", ["/abs"]]);
    expect(dirs('cd "$PWD/sub" && ./x').at(-1)).toEqual(["./x", ["./sub"]]);
    expect(dirs("pushd sub && ./x").at(-1)).toEqual(["./x", ["sub"]]);
    expect(dirs("pushd -n sub && ./x").at(-1)).toEqual(["./x", [""]]);
  });

  test("where a `cd` may not have run, the command may run in either place", () => {
    expect(dirs("cd a; ./x").at(-1)).toEqual(["./x", ["", "a"]]);
    expect(dirs("cd a || ./x").at(-1)).toEqual(["./x", ["", "a"]]);
    expect(dirs("cd a | ./x").at(-1)).toEqual(["./x", ["", "a"]]);
    expect(dirs("! cd a && ./x").at(-1)).toEqual(["./x", ["", "a"]]);
    // `(cd a || cd b) && x`: x runs after cd a (b skipped) or after cd b.
    expect(dirs("cd a || cd b && ./x").at(-1)).toEqual(["./x", ["", "a", "b", "a/b"]]);
    // A subshell's cd is gone after it.
    expect(dirs("(cd a && ./x) && ./y")).toEqual([
      ["cd a", [""]],
      ["./x", ["a"]],
      ["./y", ["", "a"]],
    ]);
  });

  test("a physical cd, and a wrapper's directory, are walked as the kernel walks them", () => {
    expect(dirs("cd -P link/.. && ./run.sh").at(-1)).toEqual(["./run.sh", ["|link/.."]]);
    expect(dirs("set -P; cd link/..; ./run.sh").at(-1)).toEqual(["./run.sh", ["", "|link/.."]]);
    // A line a wrapper hands a shell starts where the wrapper moved; a cd
    // walked after a physical step stays physical.
    expect(dirs("env -C link sh -c 'cd .. && ./run.sh'").at(-1)).toEqual([
      "./run.sh",
      ["|link/.."],
    ]);
    // …unless a `..` follows a name, which the shell folds as text.
    expect(dirs("cd -P x && cd sub/.. && ./y").at(-1)).toEqual(["./y", "?"]);
  });

  test("where a command runs cannot be told after a cd to an unknown place, or inside a loop", () => {
    const where = (line: string) => dirs(line).find(([w]) => w === "./run.sh")?.[1];
    for (const line of [
      "cd $X && ./run.sh",
      "cd ~/x && ./run.sh",
      "cd - && ./run.sh",
      "cd && ./run.sh",
      "cd a b && ./run.sh",
      "cd s* && ./run.sh",
      "popd && ./run.sh",
      "pushd +1 && ./run.sh",
      "CDPATH=/x; cd sub && ./run.sh",
      "eval 'cd secrets'; ./run.sh",
      'eval "$x"; ./run.sh',
    ]) {
      expect({ line, dirs: where(line) }).toEqual({ line, dirs: "?" });
    }
    // A loop or a function may run its cd more than once, or later.
    expect(dirs("while true; do cd a; ./x; done").map(([, d]) => d)).toEqual(["?", "?", "?"]);
    expect(dirs("f() { cd a; }; f; ./x").at(-1)).toEqual(["./x", "?"]);
    // A loop with no cd in it moves nothing.
    expect(dirs("while true; do ./x; done").at(-1)).toEqual(["./x", [""]]);
    // A directory a substitution runs in is anywhere its command may be.
    expect(dirs("cd a; echo $(./q)").at(-1)).toEqual(["./q", ["", "a"]]);
  });

  test("past the most directories one command is read in, where it runs is not told", () => {
    const cds = Array.from({ length: 3 }, (_, i) => `cd d${i}`).join("; ");
    expect((dirs(`${cds}; ./x`).at(-1)?.[1] as string[]).length).toBe(8);
    const more = Array.from({ length: 4 }, (_, i) => `cd d${i}`).join("; ");
    expect(dirs(`${more}; ./x`).at(-1)?.[1]).toBe("?");
    expect(MAX_SHELL_DIRS).toBe(8);
  });

  test("a pattern the shell expands, a script on the input, and a PATH the line sets", () => {
    const [sh] = shellProgramWords("sh l*/../run.sh 'q*'");
    expect(sh?.patterns).toEqual([1]);
    expect(shellProgramWords("x='*'; sh $x").at(-1)?.patterns).toEqual([1]);
    expect(shellProgramWords("sh < link/../run.sh")[0]?.stdinScript).toBe("link/../run.sh");
    expect(shellProgramWords("node < 'x.js'")[0]?.stdinScript).toBe("x.js");
    // An interpreter with a script, or code, of its own reads data there.
    expect(shellProgramWords("sh x.sh < data")[0]?.stdinScript).toBeUndefined();
    expect(shellProgramWords("python3 -c 'x' < data")[0]?.stdinScript).toBeUndefined();
    expect(shellProgramWords("PATH=link/.. run.sh")[0]?.programs.paths).toEqual([
      { from: 0, path: "link/.." },
    ]);
    expect(shellProgramWords("export PATH=bin; run.sh").at(-1)?.programs.paths).toEqual([
      { from: 0, path: "bin" },
    ]);
    expect(shellProgramWords("PATH=$(x) run.sh")[0]?.programs.paths).toEqual([]);
  });
});

describe("a shell that reads the commands it runs on its input", () => {
  test("from a pipe, which no reader has: every deny fires", () => {
    for (const line of ["echo rm -f v | sh", "cat x | bash -s", "curl -s u |& env sh"]) {
      expect({ line, why: shellRestrictReading(line).unknownProgram }).toEqual({
        line,
        why: "a shell reading the commands it runs from a pipe",
      });
    }
    // A shell handed a script, a line, or a here-document of its own does not.
    for (const line of ["echo y | sh ./install.sh", "echo y | sh -c 'read a'", "x || sh"]) {
      expect({ line, why: shellRestrictReading(line).unknownProgram }).toEqual({
        line,
        why: undefined,
      });
    }
  });

  test("a here-string is the line it runs", () => {
    expect(shellRestrictSpellings("sh <<< 'rm -f v'")).toContain("rm -f v");
  });

  test("an argv that runs one, after any wrappers", () => {
    expect(readsShellOnInput(["sh"])).toBe(true);
    expect(readsShellOnInput(["bash", "-s", "x"])).toBe(true);
    expect(readsShellOnInput(["env", "A=1", "sh", "-"])).toBe(true);
    expect(readsShellOnInput(["sh", "x.sh"])).toBe(false);
    expect(readsShellOnInput(["sh", "-c", "x"])).toBe(false);
    expect(readsShellOnInput(["python3"])).toBe(false);
  });
});

describe("withShellPwd and holdsUnexpanded: what a shell word says of where it lands", () => {
  test("$PWD is the directory the command runs in", () => {
    expect(withShellPwd("$PWD/link/../run.sh")).toBe("./link/../run.sh");
    expect(withShellPwd("${PWD}")).toBe(".");
    expect(withShellPwd("$PWDX/run.sh")).toBe("$PWDX/run.sh");
  });

  test("a variable the line does not set, or a `~`, is the harness's", () => {
    expect(holdsUnexpanded("$HOME/x")).toBe(true);
    expect(holdsUnexpanded("${X}/x")).toBe(true);
    expect(holdsUnexpanded("~/x")).toBe(true);
    expect(holdsUnexpanded("./a-$1")).toBe(true);
    expect(holdsUnexpanded("./$(x)/b")).toBe(true);
    expect(holdsUnexpanded("./a/b")).toBe(false);
    expect(holdsUnexpanded("./price$")).toBe(false);
  });
});
