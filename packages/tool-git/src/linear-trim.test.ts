/**
 * Trailing runs are stripped in one pass.
 *
 * `/\n+$/` and `/\t.*$/` try every start inside a run (of newlines, of tabs)
 * and, when the run is not at the end, rescan the rest of it from each before
 * giving the start up: quadratic in the run's length. A commit or tag message
 * kept verbatim holds whatever run of blank lines its author chose, and a
 * patch is whatever the model passed, so both strips are loops.
 *
 * Counted, not timed. While a call runs, every regular expression run over a
 * string holding a long run is refused on the spot and recorded, so a pattern
 * that would rescan the run fails the test at once instead of being waited
 * out. How fast git or the machine is decides nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeTrailingTab, symlinksCreatedByPatch } from "./git-run";
import { gitShow } from "./index";
import { COMMIT_FORMAT, parseCommits, withoutTrailingNewlines } from "./lib/parse";

/**
 * Every regular expression run over a string holding `run` while `body` runs.
 * Each is recorded; one not in `allowed` is refused instead of run.
 */
async function regexRunsOver<T>(
  run: string,
  body: () => T | Promise<T>,
  allowed: ReadonlyArray<string> = [],
): Promise<{ runs: string[]; outcome: T | Error }> {
  const runs: string[] = [];
  const realExec = RegExp.prototype.exec;
  let last: string | undefined;
  let holds = false;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (input !== last) {
      last = input;
      holds = typeof input === "string" && input.includes(run);
    }
    if (holds) {
      runs.push(`/${this.source}/ over ${input.length} characters`);
      if (!allowed.includes(this.source)) throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { runs, outcome: await body() };
  } catch (err) {
    return { runs, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

/** Every string up to `max` characters long over `alphabet`. */
function allStrings(alphabet: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    out.push(...layer);
  }
  return out;
}

const NEWLINES = "\n".repeat(100_000);
const TABS = "\t".repeat(100_000);

describe("the strips return what the regex forms returned", () => {
  test("withoutTrailingNewlines and /\\n+$/", () => {
    for (const text of [...allStrings(["\n", "\r", "a"], 5), "body\n", "é\n\n", "\u{1F600}\n"]) {
      expect(`${JSON.stringify(text)} -> ${JSON.stringify(withoutTrailingNewlines(text))}`).toBe(
        `${JSON.stringify(text)} -> ${JSON.stringify(text.replace(/\n+$/, ""))}`,
      );
    }
  });

  test("beforeTrailingTab and /\\t.*$/", () => {
    for (const text of [
      ...allStrings(["\t", "\r", "a", "\u2028"], 5),
      ...allStrings(["\t", "\n", "\u2029", "b"], 4),
      "b/link\t2026-01-01 00:00:00",
      "b/a\tb\tc",
      "é\t\u{1F600}",
    ]) {
      expect(`${JSON.stringify(text)} -> ${JSON.stringify(beforeTrailingTab(text))}`).toBe(
        `${JSON.stringify(text)} -> ${JSON.stringify(text.replace(/\t.*$/, ""))}`,
      );
    }
  });
});

describe("no pattern runs over a long run", () => {
  test("a commit body with a run of blank lines before its last line", async () => {
    // Control: the count sees a pattern String#replace runs over the run.
    const body = `${NEWLINES}end\n\n`;
    expect((await regexRunsOver(NEWLINES, () => body.replace(/\n+$/, ""))).runs).toEqual([
      `/\\n+$/ over ${body.length} characters`,
    ]);
    const fields = ["a".repeat(40), "a".repeat(7), "A", "a@x", "d", "C", "c@x", "d", "subject"];
    const stdout = `\x1e${fields.join("\0")}\0${body}\0`;
    const parsed = await regexRunsOver(NEWLINES, () => parseCommits(stdout));
    expect(parsed.runs).toEqual([]);
    expect((parsed.outcome as ReturnType<typeof parseCommits>)[0]?.body).toBe(`${NEWLINES}end`);
  });

  test("a +++ header with a run of tabs before a stray carriage return", async () => {
    const field = `b/link${TABS}\rz\tq`;
    expect((await regexRunsOver(TABS, () => field.replace(/\t.*$/, ""))).runs).toEqual([
      `/\\t.*$/ over ${field.length} characters`,
    ]);
    const patch = [
      "diff --git a/link b/link",
      "new file mode 120000",
      "--- /dev/null",
      `+++ ${field}`,
      "@@ -0,0 +1 @@",
      "+target",
    ].join("\n");
    const found = await regexRunsOver(TABS, () => symlinksCreatedByPatch(patch, 1));
    expect(found.runs).toEqual([]);
    expect(found.outcome).toEqual([{ path: `link${TABS}\rz`, target: "target" }]);
  });
});

describe("GitShow, against a real repository", () => {
  let workspace: string;
  let originalCwd: string;
  const saved = {
    global: process.env["GIT_CONFIG_GLOBAL"],
    system: process.env["GIT_CONFIG_SYSTEM"],
  };
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "A U Thor",
    GIT_COMMITTER_EMAIL: "author@example.com",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
  };
  const git = (args: string[], cwd: string): void => {
    const ran = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (ran.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${ran.stderr.toString()}`);
  };

  beforeAll(() => {
    originalCwd = process.cwd();
    process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
    process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-git-trim-")));
    const repo = join(workspace, "repo");
    git(["init", "-q", "-b", "main", repo], workspace);
    // A message kept verbatim, with the blank lines in the middle of its body.
    writeFileSync(join(workspace, "message"), `subject\n\nfirst${NEWLINES}end\n\n`);
    git(["commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F", "../message"], repo);
    git(["tag", "-a", "v1", "--cleanup=verbatim", "-F", "../message"], repo);
    process.chdir(workspace);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(workspace, { recursive: true, force: true });
    if (saved.global === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
    else process.env["GIT_CONFIG_GLOBAL"] = saved.global;
    if (saved.system === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_SYSTEM");
    else process.env["GIT_CONFIG_SYSTEM"] = saved.system;
  });

  test("an annotated tag whose message holds a run of blank lines", async () => {
    // git prints a tag's own text before its commit's patch, so the run
    // reaches the patch strip and, through the commit, the body strip. The
    // leading strip is anchored at the start: it looks at one position.
    expect(COMMIT_FORMAT).toContain("%b");
    const shown = await regexRunsOver(NEWLINES, () => gitShow.execute({ cwd: "repo", ref: "v1" }), [
      "^\\n+",
    ]);
    expect(shown.runs).toEqual([expect.stringMatching(/^\/\^\\n\+\/ over \d+ characters$/)]);
    const result = JSON.parse(String(shown.outcome)) as {
      commit: { subject: string; body: string };
      patch: string;
    };
    expect(result.commit.subject).toBe("subject");
    expect(result.commit.body).toBe(`first${NEWLINES}end`);
    expect(result.patch.startsWith("tag v1\n")).toBe(true);
    expect(result.patch.endsWith(`\n\nfirst${NEWLINES}end`)).toBe(true);
  }, 20_000);
});
