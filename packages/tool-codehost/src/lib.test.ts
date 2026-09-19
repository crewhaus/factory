/**
 * The pure logic, tested without a socket.
 *
 * Everything in `src/lib` and the classifying half of `src/net` is a function
 * over values: a ref validator, a Link-header parser, a record normaliser, a
 * log excerpter, an IP classifier. Testing them here means the network tests
 * in `index.test.ts` only have to prove the parts that genuinely need a
 * server, and it means the rules that keep a caller's string out of a URL are
 * checked one at a time.
 */
import { describe, expect, test } from "bun:test";
import { baseUrlProblem, normalizeBaseUrl } from "./api";
import { excerptLog, failureRule, looksLikeFailure, normalizeLogLine } from "./lib/logs";
import { nextPageFrom, parseLinkHeader, rateHeadersFrom } from "./lib/page";
import {
  buildQuery,
  checkId,
  checkOwner,
  checkRef,
  checkSegment,
  encodePathRef,
  githubRepoPath,
  gitlabProjectPath,
  joinCommaList,
} from "./lib/refs";
import {
  apiErrorMessage,
  clip,
  compact,
  diffCounts,
  isPullRequestEntry,
  labels,
  normalizeCheckRun,
  normalizeComment,
  normalizeCommit,
  normalizeFile,
  normalizeIssue,
  normalizeJob,
  normalizePr,
  normalizeRelease,
  normalizeRepo,
  normalizeReview,
  normalizeWorkflowRun,
  prState,
} from "./lib/shape";
import {
  assertNotSsrf,
  buildCodehostConfig,
  canonicalizeOrigin,
  expandIpv6,
  isPrivateIp,
  normalizeIpv4,
  redactorFor,
  resolveToken,
} from "./net";

// ---------------------------------------------------------------------------
// refs — the rule that keeps a caller's string out of a URL path
// ---------------------------------------------------------------------------

describe("checkSegment", () => {
  test("accepts the names both hosts allow", () => {
    for (const name of ["factory", "tool-codehost", "dot.github", "a_b", "x1"]) {
      expect(checkSegment("repo", name)).toBeNull();
    }
  });

  test('refuses "." and ".." outright — they are traversal, not names', () => {
    expect(checkSegment("repo", "..")).toContain("path traversal");
    expect(checkSegment("repo", ".")).toContain("path traversal");
  });

  test("refuses a slash, so a value cannot add a path part", () => {
    expect(checkSegment("repo", "widget/../../user")).toContain("characters no host allows");
  });

  test("refuses the characters that would end the path or start a query", () => {
    for (const bad of ["a?b", "a#b", "a%2fb", "a b", "a\nb"]) {
      expect(checkSegment("repo", bad)).not.toBeNull();
    }
  });

  test("refuses empty and over-long", () => {
    expect(checkSegment("repo", "")).toContain("empty");
    expect(checkSegment("repo", "x".repeat(101))).toContain("longer than 100");
  });
});

describe("checkOwner", () => {
  test("accepts a GitLab group path", () => {
    expect(checkOwner("group/subgroup")).toBeNull();
  });

  test("refuses a traversal hidden in the middle of a group path", () => {
    expect(checkOwner("group/../../admin")).toContain("path traversal");
  });

  test("refuses a leading or trailing slash", () => {
    expect(checkOwner("/group")).toContain("leading or trailing");
    expect(checkOwner("group/")).toContain("leading or trailing");
  });
});

describe("checkRef", () => {
  test("accepts ordinary branches, tags and shas", () => {
    for (const ref of ["main", "release/1.2", "v0.6.0", "a1b2c3d4", "user:branch"]) {
      expect(checkRef("ref", ref)).toBeNull();
    }
  });

  test('refuses a ref that starts with "-", the option-injection shape', () => {
    expect(checkRef("branch", "-D")).toContain('starts with "-"');
    expect(checkRef("branch", "--force")).toContain('starts with "-"');
  });

  test("refuses traversal parts even though slashes are legal", () => {
    expect(checkRef("ref", "release/../../etc")).toContain("traversal");
    expect(checkRef("ref", "a//b")).toContain("empty or traversal");
  });

  test("refuses whitespace, control characters and revision operators", () => {
    expect(checkRef("ref", "a b")).toContain("control character");
    expect(checkRef("ref", "a\nb")).toContain("control character");
    expect(checkRef("ref", "main@{yesterday}")).toContain("revision operator");
    expect(checkRef("ref", "main^")).toContain("revision operator");
    expect(checkRef("ref", "main~1")).toContain("revision operator");
  });

  test("refuses the .lock suffix git itself reserves", () => {
    expect(checkRef("ref", "main.lock")).toContain(".lock");
  });
});

describe("joinCommaList", () => {
  test("joins a plain list the way the host reads it", () => {
    expect(joinCommaList("labels", ["a", "b"])).toEqual({ ok: true, value: "a,b" });
    expect(joinCommaList("labels", [])).toEqual({ ok: true, value: "" });
  });

  test("refuses an entry whose own name carries the separator", () => {
    // "needs review, urgent" is one label on both hosts and two after a join.
    const joined = joinCommaList("labels", ["bug", "needs review, urgent"]);
    expect(joined.ok).toBe(false);
    if (!joined.ok) {
      expect(joined.message).toContain("needs review, urgent");
      expect(joined.message).toContain("two entries");
    }
  });
});

describe("checkId", () => {
  test("accepts a positive integer and refuses everything else", () => {
    expect(checkId("number", 7)).toBeNull();
    expect(checkId("number", 0)).toContain("positive");
    expect(checkId("number", -3)).toContain("positive");
    expect(checkId("number", 1.5)).toContain("positive");
  });
});

describe("encoding", () => {
  test("a path ref keeps its slashes and encodes the rest", () => {
    expect(encodePathRef("release/1.2")).toBe("release/1.2");
    expect(encodePathRef("feature/a b")).toBe("feature/a%20b");
  });

  test("a GitLab project path encodes the separating slash", () => {
    expect(gitlabProjectPath("group/sub", "widget")).toBe("group%2Fsub%2Fwidget");
  });

  test("a GitHub repo path encodes each part", () => {
    expect(githubRepoPath("acme", "widget")).toBe("/repos/acme/widget");
  });

  test("a query string is sorted, so the same call is the same URL", () => {
    expect(buildQuery({ state: "open", per_page: 50, page: 1 })).toBe(
      "?page=1&per_page=50&state=open",
    );
  });

  test("undefined values are dropped rather than sent as the string undefined", () => {
    expect(buildQuery({ a: undefined, b: 1 })).toBe("?b=1");
    expect(buildQuery({})).toBe("");
  });

  test("a value with reserved characters is encoded, not pasted", () => {
    expect(buildQuery({ q: "repo:a/b is:open&x=1" })).toBe("?q=repo%3Aa%2Fb%20is%3Aopen%26x%3D1");
  });
});

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

describe("parseLinkHeader", () => {
  test("reads the rels GitHub sends", () => {
    const link = parseLinkHeader(
      '<https://api.example.com/x?page=2>; rel="next", <https://api.example.com/x?page=9>; rel="last"',
    );
    expect(link["next"]).toBe("https://api.example.com/x?page=2");
    expect(link["last"]).toBe("https://api.example.com/x?page=9");
  });

  test("a comma inside a search query does not split the header", () => {
    const link = parseLinkHeader('<https://api.example.com/search?q=a,b&page=2>; rel="next"');
    expect(link["next"]).toBe("https://api.example.com/search?q=a,b&page=2");
  });

  test("absent or malformed input yields nothing rather than throwing", () => {
    expect(parseLinkHeader(undefined)).toEqual({});
    expect(parseLinkHeader("")).toEqual({});
    expect(parseLinkHeader("garbage")).toEqual({});
  });
});

describe("nextPageFrom", () => {
  test("prefers a rel=next URL", () => {
    expect(nextPageFrom({ link: '<https://x.test/y>; rel="next"' })).toEqual({
      kind: "url",
      url: "https://x.test/y",
    });
  });

  test("reads GitLab's x-next-page number", () => {
    expect(nextPageFrom({ "x-next-page": "3" })).toEqual({ kind: "page", page: 3 });
  });

  test("an empty x-next-page is the end of the list, not a next page", () => {
    expect(nextPageFrom({ "x-next-page": "" })).toBeNull();
    expect(nextPageFrom({ "x-next-page": "  " })).toBeNull();
    expect(nextPageFrom({})).toBeNull();
  });
});

describe("rateHeadersFrom", () => {
  test("reads both hosts' spellings", () => {
    expect(rateHeadersFrom({ "x-ratelimit-remaining": "42", "x-ratelimit-reset": "170" })).toEqual({
      remaining: 42,
      resetAt: 170,
    });
    expect(rateHeadersFrom({ "ratelimit-remaining": "7", "ratelimit-limit": "600" })).toEqual({
      limit: 600,
      remaining: 7,
    });
  });

  test("an instance that publishes nothing reports nothing", () => {
    expect(rateHeadersFrom({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

const GITHUB_PR = {
  number: 452,
  title: "Add the service-setup tool",
  state: "open",
  draft: false,
  user: { login: "maxm" },
  head: { ref: "feat/service-setup", sha: "abc123" },
  base: { ref: "main" },
  labels: [{ name: "tooling" }, { name: "area:cli" }],
  requested_reviewers: [{ login: "zoe" }, { login: "adam" }],
  assignees: [{ login: "maxm" }],
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  html_url: "https://github.test/acme/widget/pull/452",
  mergeable: true,
  mergeable_state: "clean",
  merged: false,
  commits: 4,
  additions: 120,
  deletions: 8,
  changed_files: 6,
};

const GITLAB_MR = {
  iid: 12,
  title: "Add the service-setup tool",
  state: "opened",
  draft: true,
  author: { username: "maxm" },
  source_branch: "feat/service-setup",
  target_branch: "main",
  labels: ["tooling", "area:cli"],
  reviewers: [{ username: "zoe" }],
  assignees: [],
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  web_url: "https://gitlab.test/acme/widget/-/merge_requests/12",
  detailed_merge_status: "can_be_merged",
  sha: "abc123",
};

describe("normalizePr", () => {
  test("both hosts produce the same record shape", () => {
    const gh = normalizePr("github", GITHUB_PR) as Record<string, unknown>;
    const gl = normalizePr("gitlab", GITLAB_MR) as Record<string, unknown>;
    for (const key of ["number", "title", "state", "author", "sourceBranch", "targetBranch"]) {
      expect(typeof gh[key]).toBe(typeof gl[key]);
    }
    expect(gh["number"]).toBe(452);
    expect(gl["number"]).toBe(12);
    expect(gh["state"]).toBe("open");
    expect(gl["state"]).toBe("open");
  });

  test("labels and reviewers are sorted and de-duplicated", () => {
    const gh = normalizePr("github", GITHUB_PR) as Record<string, unknown>;
    expect(gh["labels"]).toEqual(["area:cli", "tooling"]);
    expect(gh["reviewers"]).toEqual(["adam", "zoe"]);
  });

  test("a merged GitHub PR reports merged, not closed", () => {
    const merged = normalizePr("github", {
      ...GITHUB_PR,
      state: "closed",
      merged: true,
      merged_at: "2026-09-03T10:00:00Z",
    }) as Record<string, unknown>;
    expect(merged["state"]).toBe("merged");
  });

  test('a null mergeable is "computing", not false', () => {
    const pending = normalizePr("github", { ...GITHUB_PR, mergeable: null }) as Record<
      string,
      unknown
    >;
    expect(pending["mergeable"]).toBe("computing");
    expect(normalizePr("github", GITHUB_PR)?.["mergeable"]).toBe(true);
  });

  test("a payload missing everything does not throw", () => {
    expect(normalizePr("github", {})).toBeDefined();
    expect(normalizePr("github", null)).toBeUndefined();
    expect(normalizePr("gitlab", "nonsense")).toBeUndefined();
  });

  test("prState maps every GitLab spelling", () => {
    expect(prState("gitlab", { state: "opened" })).toBe("open");
    expect(prState("gitlab", { state: "locked" })).toBe("open");
    expect(prState("gitlab", { state: "merged" })).toBe("merged");
    expect(prState("github", { state: "closed" })).toBe("closed");
  });
});

describe("normalizeIssue", () => {
  test("reads both hosts", () => {
    const gh = normalizeIssue("github", {
      number: 9,
      title: "Broken",
      state: "open",
      user: { login: "zoe" },
      labels: [{ name: "bug" }],
      comments: 3,
      html_url: "https://github.test/i/9",
    }) as Record<string, unknown>;
    expect(gh).toMatchObject({ number: 9, state: "open", author: "zoe", comments: 3 });
    const gl = normalizeIssue("gitlab", {
      iid: 4,
      title: "Broken",
      state: "opened",
      author: { username: "zoe" },
      labels: ["bug"],
      user_notes_count: 2,
    }) as Record<string, unknown>;
    expect(gl).toMatchObject({ number: 4, state: "open", author: "zoe", comments: 2 });
  });

  test("a GitHub issues entry carrying pull_request is recognised as a PR", () => {
    expect(isPullRequestEntry({ number: 1, pull_request: { url: "x" } })).toBe(true);
    expect(isPullRequestEntry({ number: 1 })).toBe(false);
  });
});

describe("comments, reviews, checks", () => {
  test("a comment body is clipped and says so", () => {
    const comment = normalizeComment("github", { id: 1, body: "x".repeat(50) }, 10) as Record<
      string,
      unknown
    >;
    expect(String(comment["body"])).toContain("clipped 40 chars");
  });

  test("a review state is lowercased so both hosts compare alike", () => {
    expect(normalizeReview({ id: 1, state: "CHANGES_REQUESTED" }, 100)?.["state"]).toBe(
      "changes_requested",
    );
  });

  test("a job reports only the steps that failed", () => {
    const job = normalizeJob({
      id: 5,
      name: "build",
      conclusion: "failure",
      steps: [
        { number: 1, name: "checkout", conclusion: "success" },
        { number: 2, name: "bun test", conclusion: "failure" },
      ],
    }) as Record<string, unknown>;
    expect(job["failedSteps"]).toEqual([{ number: 2, name: "bun test", conclusion: "failure" }]);
  });

  test("a check run keeps its conclusion and clips its summary", () => {
    const run = normalizeCheckRun({
      id: 1,
      name: "ci",
      status: "completed",
      conclusion: "failure",
      app: { slug: "github-actions" },
      output: { title: "t", summary: "s".repeat(2000) },
    }) as Record<string, unknown>;
    expect(run["conclusion"]).toBe("failure");
    expect(String(run["summary"]).length).toBeLessThan(1100);
  });

  test("a workflow run and a pipeline normalise to the same fields", () => {
    const gh = normalizeWorkflowRun("github", {
      id: 42,
      name: "ci",
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
    }) as Record<string, unknown>;
    const gl = normalizeWorkflowRun("gitlab", {
      id: 42,
      status: "failed",
      ref: "main",
    }) as Record<string, unknown>;
    expect(gh["conclusion"]).toBe("failure");
    expect(gl["conclusion"]).toBe("failed");
    expect(gl["status"]).toBe("completed");
    expect(gh["branch"]).toBe(gl["branch"]);
  });
});

describe("files and commits", () => {
  test("GitLab line counts are derived from the diff and marked as derived", () => {
    const file = normalizeFile(
      "gitlab",
      { new_path: "a.ts", diff: "--- a\n+++ b\n+one\n+two\n-three\n" },
      500,
    ) as Record<string, unknown>;
    expect(file).toMatchObject({ additions: 2, deletions: 1, countsDerived: true });
  });

  test("the file-header lines are not counted as changes", () => {
    expect(diffCounts("--- a/x\n+++ b/x\n")).toEqual({ additions: 0, deletions: 0 });
  });

  test("a GitHub file keeps the host's own counts", () => {
    const file = normalizeFile(
      "github",
      { filename: "a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@" },
      500,
    ) as Record<string, unknown>;
    expect(file).toMatchObject({ path: "a.ts", additions: 3, deletions: 1 });
    expect(file["countsDerived"]).toBeUndefined();
  });

  test("a commit title is the first line of the message", () => {
    const commit = normalizeCommit("github", {
      sha: "abc",
      commit: { message: "fix: thing\n\nlonger body", author: { name: "Max", date: "2026-01-01" } },
    }) as Record<string, unknown>;
    expect(commit["title"]).toBe("fix: thing");
  });
});

describe("releases and repositories", () => {
  test("assets are sorted by name", () => {
    const release = normalizeRelease("github", {
      tag_name: "v1",
      assets: [
        { name: "b.zip", size: 2 },
        { name: "a.zip", size: 1 },
      ],
    }) as Record<string, unknown>;
    expect((release["assets"] as Array<Record<string, unknown>>).map((a) => a["name"])).toEqual([
      "a.zip",
      "b.zip",
    ]);
  });

  test("a private GitHub repo without a visibility field still reports private", () => {
    const repo = normalizeRepo("github", {
      full_name: "acme/widget",
      private: true,
      topics: ["z", "a"],
    }) as Record<string, unknown>;
    expect(repo["visibility"]).toBe("private");
    expect(repo["topics"]).toEqual(["a", "z"]);
  });

  test("GitLab topics come from either key", () => {
    expect(normalizeRepo("gitlab", { tag_list: ["b", "a"] })?.["topics"]).toEqual(["a", "b"]);
  });
});

describe("helpers", () => {
  test("compact drops undefined but keeps false and zero", () => {
    expect(compact({ a: undefined, b: false, c: 0 })).toEqual({ b: false, c: 0 });
  });

  test("clip leaves a short string alone", () => {
    expect(clip("abc", 10)).toBe("abc");
    expect(clip(undefined, 10)).toBeUndefined();
  });

  test("labels accept objects or plain strings", () => {
    expect(labels([{ name: "b" }, "a", { name: "a" }])).toEqual(["a", "b"]);
  });
});

describe("apiErrorMessage", () => {
  test("reads GitHub's message and field errors", () => {
    const message = apiErrorMessage(
      422,
      JSON.stringify({
        message: "Validation Failed",
        errors: [{ resource: "PullRequest", code: "custom" }],
      }),
    );
    expect(message).toContain("HTTP 422");
    expect(message).toContain("Validation Failed");
    expect(message).toContain("PullRequest");
  });

  test("reads GitLab's message and error keys", () => {
    expect(apiErrorMessage(404, JSON.stringify({ message: "404 Project Not Found" }))).toContain(
      "Project Not Found",
    );
    expect(apiErrorMessage(401, JSON.stringify({ error: "invalid_token" }))).toContain(
      "invalid_token",
    );
  });

  test("a non-JSON body comes back clipped rather than dropped", () => {
    const message = apiErrorMessage(502, "<html>bad gateway</html>");
    expect(message).toContain("502");
    expect(message).toContain("bad gateway");
  });

  test("an empty body still says what happened", () => {
    expect(apiErrorMessage(204, "")).toContain("empty body");
  });
});

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

const ACTIONS_LOG = [
  "2026-09-01T10:00:00.0000000Z ##[group]Run actions/checkout@v4",
  "2026-09-01T10:00:01.0000000Z with:",
  "2026-09-01T10:00:02.0000000Z ##[endgroup]",
  "2026-09-01T10:00:03.0000000Z ##[group]Run bun test",
  "2026-09-01T10:00:04.0000000Z bun test v1.1.0",
  "2026-09-01T10:00:05.0000000Z (fail) parses a ref [2.00ms]",
  "2026-09-01T10:00:06.0000000Z error: expected 3 to be 4",
  "2026-09-01T10:00:07.0000000Z ##[error]Process completed with exit code 1.",
  "2026-09-01T10:00:08.0000000Z ##[endgroup]",
].join("\n");

describe("excerptLog", () => {
  test("names the step that was running when the first error appeared", () => {
    const excerpt = excerptLog(ACTIONS_LOG);
    expect(excerpt.failingStep).toBe("Run bun test");
  });

  test("the first error is the first failing line, not the last", () => {
    const excerpt = excerptLog(ACTIONS_LOG);
    expect(excerpt.firstError?.text).toContain("expected 3 to be 4");
  });

  test("the host's own annotations are kept with their level", () => {
    const excerpt = excerptLog(ACTIONS_LOG);
    expect(excerpt.annotations).toHaveLength(1);
    expect(excerpt.annotations[0]?.level).toBe("error");
    expect(excerpt.annotations[0]?.text).toContain("exit code 1");
  });

  test("a non-zero exit code is picked out", () => {
    expect(excerptLog(ACTIONS_LOG).exitCode).toBe(1);
  });

  test("timestamps and ANSI escapes are stripped from every line", () => {
    const esc = String.fromCharCode(27);
    expect(normalizeLogLine(`2026-09-01T10:00:00.0000000Z ${esc}[31mred${esc}[0m`)).toBe("red");
    expect(excerptLog(ACTIONS_LOG).tail.every((line) => !line.includes("2026-09-01T"))).toBe(true);
  });

  test("GitLab section markers name the step too", () => {
    const trace = [
      "section_start:1756723200:build_script[collapsed=true]",
      "$ npm run build",
      "npm ERR! code ELIFECYCLE",
      "section_end:1756723210:build_script",
      "ERROR: Job failed: exit code 1",
    ].join("\n");
    const excerpt = excerptLog(trace);
    expect(excerpt.failingStep).toBe("build_script");
    expect(excerpt.exitCode).toBe(1);
  });

  test("the tail is the last lines, capped", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const excerpt = excerptLog(log, { tailLines: 3 });
    expect(excerpt.tail).toEqual(["line 97", "line 98", "line 99"]);
    expect(excerpt.totalLines).toBe(100);
  });

  test("caps bound the excerpt and report what they dropped", () => {
    const log = Array.from({ length: 50 }, (_, i) => `error: failure ${i}`).join("\n");
    const excerpt = excerptLog(log, { maxErrorLines: 5 });
    expect(excerpt.errorLines).toHaveLength(5);
    expect(excerpt.droppedErrorLines).toBe(45);
  });

  test("a very long line is cut rather than returned whole", () => {
    const excerpt = excerptLog(`error: ${"x".repeat(5000)}`, { maxLineChars: 100 });
    expect((excerpt.firstError?.text.length ?? 0) <= 101).toBe(true);
  });

  test("a clean log reports no error and no exit code", () => {
    const excerpt = excerptLog("##[group]Run tests\nall good\n##[endgroup]");
    expect(excerpt.firstError).toBeNull();
    expect(excerpt.exitCode).toBeNull();
    expect(excerpt.errorLines).toEqual([]);
  });

  test("the same log excerpts to the same bytes every time", () => {
    expect(JSON.stringify(excerptLog(ACTIONS_LOG))).toBe(JSON.stringify(excerptLog(ACTIONS_LOG)));
  });

  test("an empty log has no lines, rather than one phantom line", () => {
    expect(excerptLog("").totalLines).toBe(0);
    expect(excerptLog("").tail).toEqual([]);
  });

  test("the trailing newline every real log ends with does not add a line", () => {
    // Counted by hand: three lines, terminated. The `split("\n")` spelling
    // reported four.
    expect(excerptLog("one\ntwo\nthree\n").totalLines).toBe(3);
    expect(excerptLog("one\ntwo\nthree").totalLines).toBe(3);
    expect(excerptLog("\n").totalLines).toBe(1);
  });

  test("a job that died mid-line still reports the partial line", () => {
    const excerpt = excerptLog("##[group]Run bun test\nerror: killed");
    expect(excerpt.totalLines).toBe(2);
    expect(excerpt.firstError?.text).toBe("error: killed");
    expect(excerpt.firstError?.line).toBe(2);
  });
});

describe("looksLikeFailure", () => {
  test("recognises the common shapes", () => {
    const cases: Array<[string, string]> = [
      ["error: boom", "prefix"],
      ["npm ERR! code 1", "npm"],
      ["src/x.ts(4,2): error TS2345: no", "typescript"],
      ["panic: runtime error", "go-panic"],
      ["FAIL src/a.test.ts", "test-fail"],
      ["Process completed with exit code 2.", "exit-code"],
    ];
    for (const [line, rule] of cases) {
      expect(looksLikeFailure(line)).toBe(true);
      expect(failureRule(line)).toBe(rule);
    }
  });

  test("does not fire on a line that merely mentions errors", () => {
    for (const line of [
      "Downloading error-handling@1.0.0",
      "0 errors, 0 warnings",
      "exit code 0",
    ]) {
      expect(looksLikeFailure(line)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// net — the classifying half, without a socket
// ---------------------------------------------------------------------------

describe("canonicalizeOrigin", () => {
  test("lowercases and drops the default port and the path", () => {
    expect(canonicalizeOrigin("HTTPS://API.GitHub.com:443/v3/")).toBe("https://api.github.com");
    expect(canonicalizeOrigin("http://x.test:8080/a")).toBe("http://x.test:8080");
  });

  test("refuses a non-http scheme and a malformed origin", () => {
    expect(() => canonicalizeOrigin("file:///etc/passwd")).toThrow();
    expect(() => canonicalizeOrigin("not a url")).toThrow();
  });
});

describe("buildCodehostConfig", () => {
  test("an empty block denies everything", () => {
    expect(buildCodehostConfig({}).allowedOrigins.size).toBe(0);
  });

  test("both key spellings are accepted and canonicalised", () => {
    expect(
      buildCodehostConfig({ allowed_origins: ["https://API.github.com"] }).allowedOrigins.has(
        "https://api.github.com",
      ),
    ).toBe(true);
    expect(
      buildCodehostConfig({ allowedOrigins: ["https://gitlab.test"] }).allowedOrigins.has(
        "https://gitlab.test",
      ),
    ).toBe(true);
  });

  test("a host value that is not one of the two is ignored rather than trusted", () => {
    expect(buildCodehostConfig({ host: "bitbucket" }).host).toBeUndefined();
    expect(buildCodehostConfig({ host: "gitlab" }).host).toBe("gitlab");
  });
});

describe("isPrivateIp", () => {
  test("refuses loopback, RFC1918, CGNAT and the metadata address", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.169.254",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test("refuses the alternative encodings of 127.0.0.1", () => {
    for (const ip of ["0177.0.0.1", "0x7f000001", "2130706433", "127.1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test("refuses every spelling of ::1 and the embedded-IPv4 ranges", () => {
    for (const ip of [
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "fc00::1",
      "2002:7f00:1::",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test("allows an ordinary public address", () => {
    expect(isPrivateIp("140.82.121.4")).toBe(false);
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
  });

  test("an IPv6-shaped string it cannot parse is refused by the gate", async () => {
    // `isPrivateIp` is a classifier, so a string that is not an address at all
    // is not private and it says so. Fail-closed belongs in the gate, which is
    // the thing that protects a socket: `assertNotSsrf` never hands back a
    // literal it could not parse.
    expect(isPrivateIp("::gg::1")).toBe(false);
    await expect(assertNotSsrf("::gg::1")).rejects.toThrow("not a valid IPv6 address");
  });

  // The 2026-09-18 SSRF audit matrix, kept as a test so the property is held
  // going forward. Three entries — `64:ff9b:1::a9fe:a9fe`,
  // `64:ff9b:1:0:0:0:a9fe:a9fe` and `::ffff:0:a9fe:a9fe` — were classified
  // PUBLIC by the classifier this package carried before the synchronised
  // block landed, so this list is not decoration.
  const AUDIT_MATRIX_PRIVATE = [
    "169.254.169.254",
    "2852039166",
    "0xA9FEA9FE",
    "0251.0376.0251.0376",
    "127.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "64:ff9b:1::a9fe:a9fe",
    "64:ff9b:1:0:0:0:a9fe:a9fe",
    "::a9fe:a9fe",
    "::ffff:0:a9fe:a9fe",
    "2002:a9fe:a9fe::",
    "127.0.0.1",
    "::1",
    "0:0:0:0:0:0:0:1",
    "64:ff9b::7f00:1",
    "fe80::1",
    "febf::1",
    "fd00::1",
    "::",
    "0:0:0:0:0:0:0:0",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "0.0.0.0",
  ] as const;

  const AUDIT_MATRIX_PUBLIC = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ] as const;

  test("refuses every spelling in the audit matrix", () => {
    // Assert the size too: a matrix test that silently lost its rows passes
    // while proving nothing.
    expect(AUDIT_MATRIX_PRIVATE.length).toBe(33);
    expect(AUDIT_MATRIX_PRIVATE.filter((ip) => !isPrivateIp(ip))).toEqual([]);
  });

  test("does not over-block the public addresses in the audit matrix", () => {
    expect(AUDIT_MATRIX_PUBLIC.length).toBe(5);
    expect(AUDIT_MATRIX_PUBLIC.filter((ip) => isPrivateIp(ip))).toEqual([]);
  });

  test("normalizeIpv4 and expandIpv6 report null for non-addresses", () => {
    expect(normalizeIpv4("github.com")).toBeNull();
    expect(expandIpv6("1.2.3.4")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the token
// ---------------------------------------------------------------------------

describe("resolveToken", () => {
  test("reads the named variable and never echoes the value", () => {
    const resolved = resolveToken("MY_TOKEN", { MY_TOKEN: "secret-value-123" });
    expect(resolved).toEqual({ ok: true, token: "secret-value-123" });
  });

  test("an unset variable is a readable refusal naming the variable only", () => {
    const resolved = resolveToken("MY_TOKEN", {});
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.message).toContain("MY_TOKEN");
      expect(resolved.message).toContain("unset or empty");
    }
  });

  test("no variable named at all says what to set", () => {
    const resolved = resolveToken(undefined, {});
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("tokenEnv");
  });

  test("an empty value counts as unset", () => {
    expect(resolveToken("T", { T: "" }).ok).toBe(false);
  });

  test("a token pasted into the NAME field is refused and never echoed back", () => {
    // The field most likely to receive a pasted secret is the one whose name
    // ends in `Env`, and the refusal for it is a tool result: a transcript, a
    // trace and usually an eval report.
    // Split so the SOURCE never carries secret-shaped literals: GitHub push
    // protection matches on shape rather than on whether a value is real, and
    // a repo whose own tools scan for these patterns should not ship them.
    // The runtime values are unchanged, so this still tests real token shapes.
    const ghp = `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`;
    for (const pasted of [
      ghp,
      `github_pat_${"11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ"}`,
      `glpat-${"sVx7yZq3Kb1nM8pQrTuV"}`,
      `Bearer ${ghp}`,
    ]) {
      const resolved = resolveToken(pasted, { [pasted]: "would-have-worked" });
      expect({ pasted, ok: resolved.ok }).toEqual({ pasted, ok: false });
      if (!resolved.ok) {
        expect({ pasted, echoed: resolved.message.includes(pasted) }).toEqual({
          pasted,
          echoed: false,
        });
        expect(resolved.message).toContain("NAME of an environment variable");
      }
    }
  });

  test("a value that is not shaped like a variable name is refused without quoting it", () => {
    for (const bad of ["MY TOKEN", "my-token", "../../etc/passwd", "9LIVES", "x".repeat(65)]) {
      const resolved = resolveToken(bad, { [bad]: "v" });
      expect({ bad, ok: resolved.ok }).toEqual({ bad, ok: false });
      if (!resolved.ok) expect(resolved.message.includes(bad)).toBe(false);
    }
  });

  test("an ordinary variable name is still quoted, because a name is not a secret", () => {
    const resolved = resolveToken("GITHUB_TOKEN", {});
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("GITHUB_TOKEN");
  });
});

describe("redactorFor", () => {
  test("replaces the secret wherever it appears", () => {
    const redact = redactorFor("ghp_abcdef123456");
    expect(redact('{"note":"token ghp_abcdef123456 used"}')).toBe(
      '{"note":"token <redacted> used"}',
    );
  });

  test("replaces the url-encoded and base64 forms too", () => {
    const secret = "glpat-a/b+c=1234";
    const redact = redactorFor(secret);
    expect(redact(encodeURIComponent(secret))).toBe("<redacted>");
    expect(redact(Buffer.from(secret, "utf8").toString("base64"))).toBe("<redacted>");
  });

  test("a very short secret is left alone rather than mangling the result", () => {
    expect(redactorFor("ab")("a cab")).toBe("a cab");
    expect(redactorFor(undefined)("anything")).toBe("anything");
  });
});

describe("baseUrlProblem", () => {
  test("an API root is accepted, with or without a trailing slash", () => {
    expect(baseUrlProblem("https://api.github.com")).toBeNull();
    expect(baseUrlProblem("https://gitlab.example.com/api/v4")).toBeNull();
    expect(baseUrlProblem(normalizeBaseUrl("https://ghe.example.com/api/v3/"))).toBeNull();
  });

  test("a fragment is refused — it would send every request to the root", () => {
    // `new URL("https://host/#").hash` is the EMPTY string, so the parsed
    // parts alone do not catch this one.
    const refusal = baseUrlProblem("https://api.github.com/#");
    expect(refusal).toContain("query string or a fragment");
  });

  test("a query string is refused — the path would land inside it", () => {
    expect(baseUrlProblem("https://api.github.com/?spy=1")).toContain("API ROOT");
  });

  test("something that is not a URL at all says so", () => {
    expect(baseUrlProblem("api.github.com")).toContain("absolute URL");
  });
});
