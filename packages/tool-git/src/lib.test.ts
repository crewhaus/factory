/**
 * The pure half of the package, tested against captured git output.
 *
 * These fixtures are the shapes git actually emits — including the awkward
 * ones (a rename's second path in a separate NUL field, a binary file's "-"
 * line count, an unterminated conflict marker) — so a parser regression shows
 * up here rather than as a confusing tool result.
 */
import { describe, expect, test } from "bun:test";
import {
  gitTimeToIso,
  locateConflicts,
  parseBatchCheck,
  parseBlamePorcelain,
  parseCommits,
  parseNameStatus,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseStashes,
  parseStatusV2,
  parseTags,
  parseWorktrees,
  splitLines,
  splitNul,
} from "./lib/parse";

const NUL = String.fromCharCode(0);
const RS = String.fromCharCode(0x1e);
/** Join records the way `-z` output arrives: every record NUL-terminated. */
const z = (...records: string[]): string => records.map((r) => `${r}${NUL}`).join("");

describe("splitting helpers", () => {
  test("splitNul drops only the empty tail, not an empty record in the middle", () => {
    expect(splitNul(`a${NUL}${NUL}b${NUL}`)).toEqual(["a", "", "b"]);
  });

  test("splitNul on empty output yields nothing", () => {
    expect(splitNul("")).toEqual([]);
  });

  test("splitLines drops blank lines", () => {
    expect(splitLines("a\n\nb\n")).toEqual(["a", "b"]);
  });
});

describe("gitTimeToIso", () => {
  test("keeps the author's own offset rather than converting to the host zone", () => {
    expect(gitTimeToIso(0, "+0000")).toBe("1970-01-01T00:00:00+00:00");
    expect(gitTimeToIso(0, "+0200")).toBe("1970-01-01T02:00:00+02:00");
    expect(gitTimeToIso(0, "-0500")).toBe("1969-12-31T19:00:00-05:00");
  });

  test("falls back to UTC when the offset is unparseable", () => {
    expect(gitTimeToIso(0, "nonsense")).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("parseStatusV2", () => {
  const branchHeaders = [
    "# branch.oid 1111111111111111111111111111111111111111",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
  ];

  test("reads the branch headers, including ahead/behind", () => {
    const out = parseStatusV2(z(...branchHeaders));
    expect(out.branch).toBe("main");
    expect(out.upstream).toBe("origin/main");
    expect(out.ahead).toBe(2);
    expect(out.behind).toBe(1);
    expect(out.detached).toBe(false);
    expect(out.clean).toBe(true);
  });

  test("a detached HEAD has no branch name", () => {
    const out = parseStatusV2(z("# branch.head (detached)"));
    expect(out.detached).toBe(true);
    expect(out.branch).toBe(null);
  });

  test("splits the XY code into index and worktree status", () => {
    const out = parseStatusV2(
      z(
        ...branchHeaders,
        "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
        "1 .M N... 100644 100644 100644 aaa bbb unstaged.txt",
        "1 MM N... 100644 100644 100644 aaa bbb both.txt",
      ),
    );
    expect(out.staged.map((e) => e.path)).toEqual(["both.txt", "staged.txt"]);
    expect(out.unstaged.map((e) => e.path)).toEqual(["both.txt", "unstaged.txt"]);
    expect(out.clean).toBe(false);
  });

  test("a rename takes its original path from the following NUL field", () => {
    const out = parseStatusV2(
      z("2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt", "old name.txt", "? later.txt"),
    );
    expect(out.staged).toEqual([
      { path: "new name.txt", index: "R", worktree: ".", from: "old name.txt" },
    ]);
    // The record after the original path must still be read as a record.
    expect(out.untracked).toEqual(["later.txt"]);
  });

  test("unmerged entries land in conflicted with their code", () => {
    const out = parseStatusV2(z("u UU N... 100644 100644 100644 100644 a b c conflict.txt"));
    expect(out.conflicted).toEqual([{ path: "conflict.txt", code: "UU" }]);
    expect(out.clean).toBe(false);
  });

  test("untracked and ignored are separated and sorted", () => {
    const out = parseStatusV2(z("? b.txt", "? a.txt", "! dist/x.js"));
    expect(out.untracked).toEqual(["a.txt", "b.txt"]);
    expect(out.ignored).toEqual(["dist/x.js"]);
    // An ignored file alone does not make the tree dirty.
    expect(out.clean).toBe(false);
  });

  test("paths containing spaces survive, because -z never quotes them", () => {
    const out = parseStatusV2(z("1 .M N... 100644 100644 100644 aaa bbb a file with spaces.txt"));
    expect(out.unstaged[0]?.path).toBe("a file with spaces.txt");
  });
});

describe("parseCommits", () => {
  const record = (fields: string[]): string => `${RS}${fields.join(NUL)}${NUL}`;
  const fields = [
    "1111111111111111111111111111111111111111",
    "1111111",
    "A U Thor",
    "author@example.com",
    "2026-01-02T03:04:05+00:00",
    "C O Mitter",
    "committer@example.com",
    "2026-01-02T03:04:06+00:00",
    "subject with | a pipe and\ta tab",
    "body line one\nbody line two\n\n",
  ];

  test("a subject containing every plausible ad-hoc separator round-trips", () => {
    const [commit] = parseCommits(record(fields));
    expect(commit?.subject).toBe("subject with | a pipe and\ta tab");
    expect(commit?.body).toBe("body line one\nbody line two");
    expect(commit?.authorDate).toBe("2026-01-02T03:04:05+00:00");
    expect(commit?.changes).toBeUndefined();
  });

  test("multiple records are returned in git's order", () => {
    const second = [...fields];
    second[0] = "2222222222222222222222222222222222222222";
    second[8] = "second";
    const commits = parseCommits(record(fields) + record(second));
    expect(commits.map((c) => c.subject)).toEqual(["subject with | a pipe and\ta tab", "second"]);
  });

  test("withChanges reads the name-status block trailing each record", () => {
    const withBlock = `${record(fields)}\nM\tsrc/app.ts\nR100\told.ts\tnew.ts\n`;
    const [commit] = parseCommits(withBlock, true);
    expect(commit?.changes).toEqual([
      { status: "M", path: "src/app.ts" },
      { status: "R100", path: "new.ts", from: "old.ts" },
    ]);
  });

  test("empty output yields no commits", () => {
    expect(parseCommits("")).toEqual([]);
  });
});

describe("parseNameStatus", () => {
  test("renames and copies carry both paths, plain changes carry one", () => {
    expect(parseNameStatus("A\tadded.ts\nD\tgone.ts\nC75\tsrc.ts\tcopy.ts\n")).toEqual([
      { status: "A", path: "added.ts" },
      { status: "D", path: "gone.ts" },
      { status: "C75", path: "copy.ts", from: "src.ts" },
    ]);
  });
});

describe("parseNumstat", () => {
  test("counts ordinary files", () => {
    expect(parseNumstat(z("3\t1\tsrc/app.ts"))).toEqual([
      { added: 3, removed: 1, path: "src/app.ts" },
    ]);
  });

  test("a binary file's dashes become null rather than NaN", () => {
    expect(parseNumstat(z("-\t-\tlogo.png"))).toEqual([
      { added: null, removed: null, path: "logo.png" },
    ]);
  });

  test("a rename's two extra NUL fields are consumed, not mistaken for records", () => {
    const out = parseNumstat(z("1\t1\t", "old.ts", "new.ts", "2\t0\tafter.ts"));
    expect(out).toEqual([
      { added: 1, removed: 1, path: "new.ts", from: "old.ts" },
      { added: 2, removed: 0, path: "after.ts" },
    ]);
  });
});

describe("parseBlamePorcelain", () => {
  const block = (sha: string, line: number, text: string, summary: string): string =>
    [
      `${sha} ${line} ${line} 1`,
      "author A U Thor",
      "author-mail <author@example.com>",
      "author-time 0",
      "author-tz +0000",
      "committer A U Thor",
      `summary ${summary}`,
      "filename README.md",
      `\t${text}`,
    ].join("\n");

  test("each line gets its own commit, author and rendered date", () => {
    const stdout = `${block("a".repeat(40), 1, "hello", "first")}\n${block("b".repeat(40), 2, "world", "second")}\n`;
    const lines = parseBlamePorcelain(stdout);
    expect(lines).toEqual([
      {
        line: 1,
        sha: "a".repeat(40),
        author: "A U Thor",
        authorEmail: "author@example.com",
        date: "1970-01-01T00:00:00+00:00",
        summary: "first",
        content: "hello",
      },
      {
        line: 2,
        sha: "b".repeat(40),
        author: "A U Thor",
        authorEmail: "author@example.com",
        date: "1970-01-01T00:00:00+00:00",
        summary: "second",
        content: "world",
      },
    ]);
  });

  test("a content line that itself looks like a header is not misread", () => {
    // The tab prefix is what marks content, so a line of source code that
    // happens to be 40 hex characters cannot be mistaken for a blame header.
    const stdout = `${block("c".repeat(40), 1, `${"d".repeat(40)} 9 9 1`, "tricky")}\n`;
    const lines = parseBlamePorcelain(stdout);
    expect(lines.length).toBe(1);
    expect(lines[0]?.line).toBe(1);
    expect(lines[0]?.sha).toBe("c".repeat(40));
  });
});

describe("parseRefs and parseTags", () => {
  test("branches keep an absent upstream as null", () => {
    const stdout = [
      [
        "main",
        "refs/heads/main",
        "a".repeat(40),
        "origin/main",
        "2026-01-02T03:04:05+00:00",
        "s1",
      ].join(NUL),
      ["topic", "refs/heads/topic", "b".repeat(40), "", "2026-01-03T03:04:05+00:00", "s2"].join(
        NUL,
      ),
    ].join("\n");
    const refs = parseRefs(stdout);
    expect(refs.map((r) => r.upstream)).toEqual(["origin/main", null]);
    expect(refs[1]?.sha).toBe("b".repeat(40));
  });

  test("an annotated tag reports the commit it dereferences to", () => {
    const stdout = [
      ["v1.0", "refs/tags/v1.0", "a".repeat(40), "", "2026-01-02T03:04:05+00:00", ""].join(NUL),
      [
        "v2.0",
        "refs/tags/v2.0",
        "b".repeat(40),
        "c".repeat(40),
        "2026-01-03T03:04:05+00:00",
        "release",
      ].join(NUL),
    ].join("\n");
    const tags = parseTags(stdout);
    expect(tags[0]).toMatchObject({
      annotated: false,
      sha: "a".repeat(40),
      commit: "a".repeat(40),
    });
    expect(tags[1]).toMatchObject({ annotated: true, sha: "b".repeat(40), commit: "c".repeat(40) });
  });
});

describe("parseRemotes", () => {
  test("folds the fetch and push lines of one remote together, sorted by name", () => {
    const stdout = [
      "upstream\thttps://example.invalid/up.git (fetch)",
      "upstream\thttps://example.invalid/up.git (push)",
      "origin\tgit@example.invalid:me/x.git (fetch)",
      "origin\tgit@example.invalid:me/x-push.git (push)",
    ].join("\n");
    expect(parseRemotes(stdout)).toEqual([
      {
        name: "origin",
        fetch: "git@example.invalid:me/x.git",
        push: "git@example.invalid:me/x-push.git",
      },
      {
        name: "upstream",
        fetch: "https://example.invalid/up.git",
        push: "https://example.invalid/up.git",
      },
    ]);
  });
});

describe("parseWorktrees", () => {
  test("reads each stanza and sorts by path", () => {
    const stdout = [
      "worktree /w/second",
      `HEAD ${"b".repeat(40)}`,
      "detached",
      "",
      "worktree /w/first",
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
      "",
    ].join("\n");
    const out = parseWorktrees(stdout);
    expect(out.map((w) => w.path)).toEqual(["/w/first", "/w/second"]);
    expect(out[0]?.branch).toBe("refs/heads/main");
    expect(out[1]?.detached).toBe(true);
    expect(out[1]?.branch).toBe(null);
  });
});

describe("parseStashes", () => {
  test("reads ref, sha, message and date per entry", () => {
    const stdout =
      `${RS}stash@{0}${NUL}${"a".repeat(40)}${NUL}On main: wip${NUL}2026-01-02T03:04:05+00:00\n` +
      `${RS}stash@{1}${NUL}${"b".repeat(40)}${NUL}On main: earlier${NUL}2026-01-01T03:04:05+00:00\n`;
    expect(parseStashes(stdout)).toEqual([
      {
        ref: "stash@{0}",
        sha: "a".repeat(40),
        subject: "On main: wip",
        date: "2026-01-02T03:04:05+00:00",
      },
      {
        ref: "stash@{1}",
        sha: "b".repeat(40),
        subject: "On main: earlier",
        date: "2026-01-01T03:04:05+00:00",
      },
    ]);
  });
});

describe("locateConflicts", () => {
  test("locates a complete region with both labels", () => {
    const text = ["a", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "b"].join(
      "\n",
    );
    expect(locateConflicts(text)).toEqual([
      {
        startLine: 2,
        separatorLine: 4,
        endLine: 6,
        oursLabel: "HEAD",
        theirsLabel: "feature",
      },
    ]);
  });

  test("an unterminated region is reported rather than dropped", () => {
    const regions = locateConflicts("<<<<<<< HEAD\nours\n=======\ntheirs\n");
    expect(regions).toEqual([
      { startLine: 1, separatorLine: 3, endLine: null, oursLabel: "HEAD", theirsLabel: "" },
    ]);
  });

  test("prose that merely mentions the markers mid-line is not a conflict", () => {
    expect(locateConflicts("the marker <<<<<<< appears mid-sentence\n")).toEqual([]);
  });

  test("two regions in one file are both found", () => {
    const text = [
      "<<<<<<< HEAD",
      "1",
      "=======",
      "2",
      ">>>>>>> b",
      "middle",
      "<<<<<<< HEAD",
      "3",
      "=======",
      "4",
      ">>>>>>> b",
    ].join("\n");
    expect(locateConflicts(text).map((r) => r.startLine)).toEqual([1, 7]);
  });
});

describe("parseBatchCheck", () => {
  test("pairs each answer with the ref that was asked about", () => {
    const stdout = `${"a".repeat(40)} commit\nnope missing\n${"b".repeat(40)} tag\n`;
    expect(parseBatchCheck(stdout, ["HEAD", "nope", "v1.0"])).toEqual([
      { ref: "HEAD", sha: "a".repeat(40), type: "commit", missing: false },
      { ref: "nope", sha: null, type: null, missing: true },
      { ref: "v1.0", sha: "b".repeat(40), type: "tag", missing: false },
    ]);
  });
});
