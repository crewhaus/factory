/**
 * The tools against real servers.
 *
 * Every test here stands up an actual `Bun.serve` on 127.0.0.1 with an
 * ephemeral port, impersonating the two APIs closely enough to exercise the
 * paths that matter, and drives the tools at it. Nothing is mocked: a stubbed
 * `fetch` would prove nothing about whether a redirect really drops the
 * token, whether a deadline really fires, whether a byte cap really cancels a
 * read, or whether pagination really follows a Link header — which is most of
 * what this package has to get right.
 *
 * No public address is ever contacted. Reaching 127.0.0.1 means lifting the
 * loopback refusal, which is what `__setPrivateHostsAllowedForTest` is for:
 * test-only, off by default, reset after every test, and the refusal itself
 * is proved with the flag in its production position.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  CODEHOST_TOOLS,
  __setPrivateHostsAllowedForTest,
  _resetCodehostConfig,
  _setDnsLookup,
  checkRuns,
  compareRefs,
  issueComment,
  issueCreate,
  issueGet,
  issueList,
  issueUpdate,
  prComment,
  prComments,
  prCreate,
  prFiles,
  prGet,
  prList,
  prReviewSubmit,
  prReviews,
  prUpdate,
  rateLimitStatus,
  registerCodehostConfig,
  releaseCreate,
  releaseGet,
  releaseList,
  repoGet,
  searchCode,
  searchIssues,
  workflowRunLogs,
  workflowRunRerun,
  workflowRuns,
} from "./index";

/** The token the fixture expects. Long enough that the redactor engages. */
const TOKEN = "ghp_fixture_token_0123456789abcdef";
const TOKEN_VAR = "CREWHAUS_TEST_CODEHOST_TOKEN";

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: RegisteredTool, input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** Input for a GitHub call against the fixture; config supplies base URL and token. */
function gh(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { owner: "acme", repo: "widget", ...extra };
}

/** Input for a GitLab call against the fixture. */
function gl(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { host: "gitlab", baseUrl: `${origin}/api/v4`, owner: "acme", repo: "widget", ...extra };
}

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------

type Server = ReturnType<typeof Bun.serve>;

let main: Server;
let other: Server;
let blocked: Server;
let origin = "";
let otherOrigin = "";
let blockedOrigin = "";

/** Every request the fixture saw, so a test can assert what was sent. */
let seen: Array<{ method: string; path: string; auth: string | null; body: string }> = [];
/** Whether the second origin ever received a credential header. */
let otherSawCredential = false;

const jsonRes = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

const textRes = (text: string, init: ResponseInit = {}): Response =>
  new Response(text, {
    ...init,
    headers: { "content-type": "text/plain", ...(init.headers ?? {}) },
  });

const PR_7 = {
  number: 7,
  title: "Add the codehost tools",
  state: "open",
  draft: false,
  user: { login: "maxm" },
  head: { ref: "feat/codehost", sha: "abc123" },
  base: { ref: "main" },
  labels: [{ name: "tooling" }, { name: "area:cli" }],
  requested_reviewers: [{ login: "zoe" }],
  assignees: [{ login: "maxm" }],
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  html_url: "https://github.test/acme/widget/pull/7",
  mergeable: null,
  mergeable_state: "unknown",
  merged: false,
};

const PR_6 = { ...PR_7, number: 6, title: "Earlier", updated_at: "2026-08-01T10:00:00Z" };
const PR_5 = {
  ...PR_7,
  number: 5,
  title: "Merged one",
  state: "closed",
  merged: true,
  merged_at: "2026-07-05T10:00:00Z",
};

const ACTIONS_LOG = [
  "2026-09-01T10:00:00.0000000Z ##[group]Run actions/checkout@v4",
  "2026-09-01T10:00:01.0000000Z done",
  "2026-09-01T10:00:02.0000000Z ##[endgroup]",
  "2026-09-01T10:00:03.0000000Z ##[group]Run bun test",
  "2026-09-01T10:00:04.0000000Z (fail) parses a ref",
  "2026-09-01T10:00:05.0000000Z error: expected 3 to be 4",
  "2026-09-01T10:00:06.0000000Z ##[error]Process completed with exit code 1.",
  "2026-09-01T10:00:07.0000000Z ##[endgroup]",
].join("\n");

async function mainHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // `pathname` keeps %2F encoded, which is how GitLab addresses a project.
  const p = url.pathname;
  const auth = req.headers.get("authorization") ?? req.headers.get("private-token");
  const body = req.method === "GET" ? "" : await req.text();
  seen.push({ method: req.method, path: p, auth, body });

  // --- GitLab dialect -----------------------------------------------------
  if (p.startsWith("/api/v4/")) return gitlabHandler(req, p, body);

  // --- GitHub dialect -----------------------------------------------------
  if (p === "/rate_limit") {
    return jsonRes({
      resources: {
        core: { limit: 5000, remaining: 4321, used: 679, reset: 1_790_000_000 },
        search: { limit: 30, remaining: 29, used: 1, reset: 1_790_000_060 },
      },
    });
  }
  if (p === "/search/code") {
    return jsonRes({
      total_count: 2,
      items: [
        { path: "src/b.ts", sha: "s2", repository: { full_name: "acme/widget" } },
        { path: "src/a.ts", sha: "s1", repository: { full_name: "acme/widget" } },
      ],
    });
  }
  if (p === "/search/issues") {
    return jsonRes({
      total_count: 1,
      items: [{ number: 9, title: "Found", state: "open", user: { login: "zoe" } }],
    });
  }

  if (p === "/repos/acme/slow") {
    await Bun.sleep(400);
    return jsonRes({ full_name: "acme/slow" });
  }
  if (p === "/repos/acme/huge") {
    return jsonRes({ full_name: "acme/huge", filler: "x".repeat(300_000) });
  }
  if (p === "/repos/acme/loop") {
    // Same origin, forever: what the redirect cap is for.
    return new Response(null, { status: 302, headers: { location: `${origin}/repos/acme/loop` } });
  }
  if (p === "/repos/acme/forbidden") {
    return jsonRes({ message: "Must have admin rights to Repository." }, { status: 403 });
  }
  if (p === "/repos/acme/leaky") {
    // An API that echoes the credential back into its own payload. It should
    // never happen; the redactor exists because "should never" is not a
    // guarantee anybody can make about somebody else's server.
    return jsonRes({
      full_name: "acme/leaky",
      default_branch: "main",
      description: `configured with ${TOKEN}`,
      private: true,
    });
  }
  if (p === "/repos/acme/widget") {
    return jsonRes({
      full_name: "acme/widget",
      default_branch: "main",
      private: false,
      topics: ["z-topic", "a-topic"],
      size: 1024,
      open_issues_count: 3,
      stargazers_count: 12,
      html_url: "https://github.test/acme/widget",
    });
  }

  if (p === "/repos/acme/widget/pulls" && req.method === "GET") {
    const page = url.searchParams.get("page") ?? "1";
    if (page === "1") {
      return jsonRes([PR_7, PR_5], {
        headers: {
          link: `<${origin}/repos/acme/widget/pulls?page=2&per_page=50>; rel="next", <${origin}/repos/acme/widget/pulls?page=2&per_page=50>; rel="last"`,
        },
      });
    }
    return jsonRes([PR_6]);
  }
  if (p === "/repos/acme/widget/pulls" && req.method === "POST") {
    return jsonRes({ ...PR_7, number: 8, title: JSON.parse(body).title }, { status: 201 });
  }
  if (p === "/repos/acme/widget/pulls/7" && req.method === "GET") return jsonRes(PR_7);
  if (p === "/repos/acme/widget/pulls/7" && req.method === "PATCH") {
    return jsonRes({ ...PR_7, ...JSON.parse(body) });
  }
  if (p === "/repos/acme/widget/pulls/7/files") {
    return jsonRes([
      { filename: "src/z.ts", status: "modified", additions: 4, deletions: 1, patch: "@@ z" },
      { filename: "src/a.ts", status: "added", additions: 10, deletions: 0, patch: "@@ a" },
    ]);
  }
  if (p === "/repos/acme/widget/pulls/7/reviews" && req.method === "GET") {
    return jsonRes([
      {
        id: 100,
        user: { login: "zoe" },
        state: "CHANGES_REQUESTED",
        body: "needs a test",
        submitted_at: "2026-09-02T09:00:00Z",
      },
    ]);
  }
  if (p === "/repos/acme/widget/pulls/7/reviews" && req.method === "POST") {
    return jsonRes({ id: 101, state: "APPROVED", user: { login: "bot" } }, { status: 200 });
  }
  if (p === "/repos/acme/widget/pulls/7/comments") {
    return jsonRes([
      { id: 10, user: { login: "zoe" }, body: "root", path: "src/a.ts", line: 3 },
      { id: 11, user: { login: "maxm" }, body: "reply", path: "src/a.ts", in_reply_to_id: 10 },
      { id: 12, user: { login: "zoe" }, body: "other", path: "src/b.ts" },
    ]);
  }
  if (p === "/repos/acme/widget/pulls/7/requested_reviewers") {
    return jsonRes({ ...PR_7 });
  }
  if (p === "/repos/acme/widget/issues" && req.method === "GET") {
    return jsonRes([
      {
        number: 9,
        title: "Real issue",
        state: "open",
        user: { login: "zoe" },
        labels: [{ name: "bug" }],
      },
      {
        number: 7,
        title: "A PR",
        state: "open",
        user: { login: "maxm" },
        pull_request: { url: "x" },
      },
    ]);
  }
  if (p === "/repos/acme/widget/issues" && req.method === "POST") {
    return jsonRes({ number: 20, title: JSON.parse(body).title, state: "open" }, { status: 201 });
  }
  if (p === "/repos/acme/widget/issues/9" && req.method === "GET") {
    return jsonRes({
      number: 9,
      title: "Real issue",
      state: "open",
      body: "the body",
      user: { login: "zoe" },
      labels: [{ name: "bug" }],
      comments: 2,
    });
  }
  if (p === "/repos/acme/widget/issues/9" && req.method === "PATCH") {
    return jsonRes({ number: 9, title: "Real issue", ...JSON.parse(body) });
  }
  if (p.match(/^\/repos\/acme\/widget\/issues\/\d+\/comments$/) !== null) {
    if (req.method === "POST") {
      return jsonRes(
        { id: 77, user: { login: "bot" }, body: JSON.parse(body).body },
        { status: 201 },
      );
    }
    return jsonRes([
      { id: 2, user: { login: "maxm" }, body: "second", created_at: "2026-09-02T00:00:00Z" },
      { id: 1, user: { login: "zoe" }, body: "first", created_at: "2026-09-01T00:00:00Z" },
    ]);
  }
  if (p === "/repos/acme/widget/issues/7/labels") return jsonRes([{ name: "tooling" }]);

  if (p === "/repos/acme/widget/commits/abc123/check-runs") {
    return jsonRes({
      check_runs: [
        {
          id: 501,
          name: "test",
          status: "completed",
          conclusion: "failure",
          app: { slug: "github-actions" },
          output: { title: "1 failing" },
        },
        {
          id: 502,
          name: "build",
          status: "completed",
          conclusion: "success",
          app: { slug: "github-actions" },
        },
      ],
    });
  }
  if (p === "/repos/acme/widget/commits/abc123/status") {
    return jsonRes({
      statuses: [
        { context: "codecov", state: "success", description: "ok", target_url: "https://x.test" },
      ],
    });
  }
  if (p === "/repos/acme/widget/actions/jobs/501") {
    return jsonRes({
      id: 501,
      name: "test",
      conclusion: "failure",
      steps: [
        { number: 1, name: "checkout", conclusion: "success" },
        { number: 2, name: "bun test", conclusion: "failure" },
      ],
    });
  }
  if (p === "/repos/acme/widget/actions/runs") {
    return jsonRes({
      total_count: 2,
      workflow_runs: [
        {
          id: 42,
          name: "ci",
          status: "completed",
          conclusion: "failure",
          head_branch: "main",
          run_number: 9,
        },
        {
          id: 41,
          name: "ci",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          run_number: 8,
        },
      ],
    });
  }
  if (p === "/repos/acme/widget/actions/runs/42/jobs") {
    return jsonRes({
      jobs: [
        { id: 502, name: "build", conclusion: "success", steps: [] },
        {
          id: 503,
          name: "test",
          conclusion: "failure",
          steps: [{ number: 2, name: "bun test", conclusion: "failure" }],
        },
      ],
    });
  }
  if (p === "/repos/acme/widget/actions/runs/43/jobs") {
    return jsonRes({ jobs: [{ id: 504, name: "test", conclusion: "failure", steps: [] }] });
  }
  if (p === "/repos/acme/widget/actions/runs/44/jobs") {
    return jsonRes({ jobs: [{ id: 505, name: "test", conclusion: "failure", steps: [] }] });
  }
  if (p === "/repos/acme/widget/actions/jobs/503/logs") return textRes(ACTIONS_LOG);
  if (p === "/repos/acme/widget/actions/jobs/504/logs") {
    // What GitHub really does: hand back a redirect to signed storage.
    return new Response(null, { status: 302, headers: { location: `${otherOrigin}/log-blob` } });
  }
  if (p === "/repos/acme/widget/actions/jobs/505/logs") {
    return new Response(null, { status: 302, headers: { location: `${blockedOrigin}/log-blob` } });
  }
  if (p.match(/^\/repos\/acme\/widget\/actions\/runs\/\d+\/rerun(-failed-jobs)?$/) !== null) {
    return new Response(null, { status: 201 });
  }

  if (p === "/repos/acme/widget/releases" && req.method === "GET") {
    return jsonRes([
      {
        id: 2,
        tag_name: "v1.1.0",
        name: "1.1.0",
        published_at: "2026-08-01T00:00:00Z",
        assets: [
          { name: "b.tgz", size: 20 },
          { name: "a.tgz", size: 10 },
        ],
      },
      {
        id: 1,
        tag_name: "v1.0.0",
        name: "1.0.0",
        published_at: "2026-07-01T00:00:00Z",
        assets: [],
      },
    ]);
  }
  if (p === "/repos/acme/widget/releases" && req.method === "POST") {
    return jsonRes({ id: 3, tag_name: JSON.parse(body).tag_name, assets: [] }, { status: 201 });
  }
  if (p === "/repos/acme/widget/releases/latest") {
    return jsonRes({ id: 2, tag_name: "v1.1.0", body: "notes here", assets: [] });
  }
  if (p === "/repos/acme/widget/releases/tags/v1.0.0") {
    return jsonRes({ id: 1, tag_name: "v1.0.0", body: "old notes", assets: [] });
  }
  if (p === "/repos/acme/widget/compare/main...feature") {
    return jsonRes({
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      commits: [
        {
          sha: "c1",
          commit: { message: "first\n\nbody", author: { name: "Max", date: "2026-09-01" } },
        },
        { sha: "c2", commit: { message: "second", author: { name: "Max", date: "2026-09-02" } } },
      ],
      files: [
        { filename: "src/z.ts", status: "modified", additions: 1, deletions: 1, patch: "@@" },
        { filename: "src/a.ts", status: "added", additions: 5, deletions: 0, patch: "@@" },
      ],
    });
  }

  return jsonRes({ message: `Not Found: ${p}` }, { status: 404 });
}

function gitlabHandler(req: Request, p: string, body: string): Response {
  const project = "/api/v4/projects/acme%2Fwidget";
  if (p === "/api/v4/version") {
    return jsonRes(
      { version: "17.0.0" },
      { headers: { "ratelimit-limit": "600", "ratelimit-remaining": "598" } },
    );
  }
  if (p === project) {
    return jsonRes({
      path_with_namespace: "acme/widget",
      default_branch: "main",
      visibility: "private",
      tag_list: ["b", "a"],
      statistics: { repository_size: 4096 },
      web_url: "https://gitlab.test/acme/widget",
    });
  }
  if (p === `${project}/merge_requests` && req.method === "GET") {
    return jsonRes([
      {
        iid: 12,
        title: "MR twelve",
        state: "opened",
        author: { username: "maxm" },
        source_branch: "feat/x",
        target_branch: "main",
        labels: ["b", "a"],
        reviewers: [{ username: "zoe" }],
        detailed_merge_status: "can_be_merged",
        web_url: "https://gitlab.test/mr/12",
      },
    ]);
  }
  if (p === `${project}/merge_requests` && req.method === "POST") {
    return jsonRes({ iid: 13, title: JSON.parse(body).title, state: "opened" }, { status: 201 });
  }
  if (p === `${project}/merge_requests/12` && req.method === "GET") {
    return jsonRes({
      iid: 12,
      title: "MR twelve",
      state: "opened",
      author: { username: "maxm" },
      source_branch: "feat/x",
      target_branch: "main",
      detailed_merge_status: "can_be_merged",
      head_pipeline: { id: 77, status: "failed" },
    });
  }
  if (p === `${project}/merge_requests/12/notes`) {
    if (req.method === "POST")
      return jsonRes({ id: 5, body: JSON.parse(body).body }, { status: 201 });
    return jsonRes([
      {
        id: 1,
        author: { username: "zoe" },
        body: "human note",
        created_at: "2026-09-01T00:00:00Z",
      },
      {
        id: 2,
        author: { username: "maxm" },
        body: "changed the description",
        system: true,
        created_at: "2026-09-02T00:00:00Z",
      },
    ]);
  }
  if (p === `${project}/merge_requests/12/approvals`) {
    return jsonRes({
      approvals_required: 2,
      approvals_left: 1,
      approved_by: [{ user: { username: "zoe" } }],
    });
  }
  if (p === `${project}/merge_requests/12/discussions`) {
    return jsonRes([
      {
        id: "d1",
        individual_note: false,
        notes: [
          {
            id: 9,
            author: { username: "zoe" },
            body: "inline",
            resolvable: true,
            resolved: false,
            position: { new_path: "src/a.ts" },
            created_at: "2026-09-01T00:00:00Z",
          },
        ],
      },
    ]);
  }
  if (p === `${project}/merge_requests/12/approve`) return jsonRes({ id: 12, state: "approved" });
  if (p === `${project}/pipelines`) {
    return jsonRes([{ id: 77, status: "failed", ref: "main", sha: "abc123", source: "push" }]);
  }
  if (p === `${project}/pipelines/77/jobs`) {
    return jsonRes([
      { id: 88, name: "test", stage: "test", status: "failed", allow_failure: false },
      { id: 89, name: "build", stage: "build", status: "success" },
    ]);
  }
  if (p === `${project}/pipelines/77/retry`) return jsonRes({ id: 77, status: "pending" });
  if (p === `${project}/jobs/88/trace`) {
    return textRes(
      [
        "section_start:1:test_script",
        "$ bun test",
        "error: boom",
        "section_end:2:test_script",
      ].join("\n"),
    );
  }
  if (p === `${project}/repository/commits/abc123/statuses`) {
    return jsonRes([
      { id: 1, name: "lint", status: "failed", target_url: "https://gitlab.test/j/1" },
      { id: 2, name: "build", status: "success" },
    ]);
  }
  if (p === `${project}/releases`) {
    if (req.method === "POST")
      return jsonRes({ tag_name: JSON.parse(body).tag_name }, { status: 201 });
    return jsonRes([
      {
        tag_name: "v1.1.0",
        name: "1.1.0",
        released_at: "2026-08-01T00:00:00Z",
        description: "gl notes",
        assets: { links: [{ name: "a", url: "https://gitlab.test/a" }] },
      },
    ]);
  }
  if (p === `${project}/issues` && req.method === "GET") {
    return jsonRes([
      { iid: 4, title: "GL issue", state: "opened", author: { username: "zoe" }, labels: ["bug"] },
    ]);
  }
  if (p === `${project}/issues` && req.method === "POST") {
    return jsonRes({ iid: 5, title: JSON.parse(body).title, state: "opened" }, { status: 201 });
  }
  if (p === `${project}/issues/4` && req.method === "GET") {
    return jsonRes({ iid: 4, title: "GL issue", state: "opened", description: "gl body" });
  }
  if (p === `${project}/issues/4` && req.method === "PUT") {
    return jsonRes({ iid: 4, title: "GL issue", state: "closed" });
  }
  if (p === `${project}/issues/4/notes`) {
    if (req.method === "POST")
      return jsonRes({ id: 6, body: JSON.parse(body).body }, { status: 201 });
    return jsonRes([
      { id: 1, author: { username: "zoe" }, body: "note", created_at: "2026-09-01T00:00:00Z" },
    ]);
  }
  if (p === `${project}/search`) {
    return jsonRes([{ path: "src/a.ts", ref: "main", startline: 12, data: "match" }]);
  }
  if (p === "/api/v4/search") {
    return jsonRes([{ iid: 4, title: "GL issue", state: "opened" }]);
  }
  if (p === `${project}/repository/compare`) {
    return jsonRes({
      commits: [{ id: "c1", title: "first", author_name: "Max", authored_date: "2026-09-01" }],
      diffs: [{ new_path: "src/a.ts", diff: "+one\n-two\n" }],
    });
  }
  return jsonRes({ message: `404 Not Found: ${p}` }, { status: 404 });
}

beforeAll(() => {
  main = Bun.serve({ port: 0, fetch: mainHandler });
  other = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (req.headers.get("authorization") !== null || req.headers.get("private-token") !== null) {
        otherSawCredential = true;
      }
      return textRes(ACTIONS_LOG);
    },
  });
  blocked = Bun.serve({ port: 0, fetch: () => textRes("should never be reached") });
  origin = `http://127.0.0.1:${main.port}`;
  otherOrigin = `http://127.0.0.1:${other.port}`;
  blockedOrigin = `http://127.0.0.1:${blocked.port}`;
});

afterAll(() => {
  main.stop(true);
  other.stop(true);
  blocked.stop(true);
});

beforeEach(() => {
  seen = [];
  otherSawCredential = false;
  process.env[TOKEN_VAR] = TOKEN;
  registerCodehostConfig({
    allowed_origins: [origin, otherOrigin],
    base_url: origin,
    token_env: TOKEN_VAR,
  });
  __setPrivateHostsAllowedForTest(true);
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _resetCodehostConfig();
  _setDnsLookup(undefined);
  delete process.env[TOKEN_VAR];
});

// ---------------------------------------------------------------------------
// the safety contract
// ---------------------------------------------------------------------------

describe("the token never leaves in a result", () => {
  test("it IS sent, as a header, so the rest of the claim means something", async () => {
    await run(repoGet, gh());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("a server that echoes the token back gets it redacted out of the record", async () => {
    const result = await run(repoGet, gh({ repo: "leaky" }));
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("<redacted>");
  });

  test("no tool's result contains the token, across every tool in the package", async () => {
    const calls: Array<[RegisteredTool, unknown]> = [
      [checkRuns, gh({ ref: "abc123" })],
      [compareRefs, gh({ base: "main", head: "feature" })],
      [issueComment, gh({ number: 9, body: "hi" })],
      [issueCreate, gh({ title: "t" })],
      [issueGet, gh({ number: 9 })],
      [issueList, gh({})],
      [issueUpdate, gh({ number: 9, state: "closed" })],
      [prComment, gh({ number: 7, body: "hi" })],
      [prComments, gh({ number: 7 })],
      [prCreate, gh({ title: "t", sourceBranch: "feat/x", targetBranch: "main" })],
      [prFiles, gh({ number: 7 })],
      [prGet, gh({ number: 7 })],
      [prList, gh({})],
      [prReviewSubmit, gh({ number: 7, event: "approve" })],
      [prReviews, gh({ number: 7 })],
      [prUpdate, gh({ number: 7, title: "new" })],
      [rateLimitStatus, {}],
      [releaseCreate, gh({ tag: "v2.0.0" })],
      [releaseGet, gh({})],
      [releaseList, gh({})],
      [repoGet, gh({ repo: "leaky" })],
      [searchCode, { query: "repo:acme/widget x" }],
      [searchIssues, { query: "is:open" }],
      [workflowRunRerun, gh({ runId: 42 })],
      [workflowRunLogs, gh({ runId: 42 })],
      [workflowRuns, gh({})],
    ];
    // Every registered tool must appear above; a new one without a call here
    // would otherwise go unchecked.
    expect(calls.map(([tool]) => tool.name).sort()).toEqual(
      CODEHOST_TOOLS.map((tool) => tool.name).sort(),
    );
    for (const [tool, input] of calls) {
      const out = await tool.execute(input);
      expect({ tool: tool.name, leaked: String(out).includes(TOKEN) }).toEqual({
        tool: tool.name,
        leaked: false,
      });
    }
  });

  test("a token pasted into tokenEnv is refused, and the refusal does not repeat it", async () => {
    // Split so the SOURCE never carries a secret-shaped literal: GitHub push
    // protection matches on shape rather than on whether a value is real, and
    // a repo whose own tools scan for these patterns should not ship one. The
    // runtime value is unchanged.
    const pasted = `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`;
    process.env[pasted] = TOKEN;
    try {
      const result = await run(repoGet, gh({ tokenEnv: pasted }));
      expect(String(result)).not.toContain(pasted);
      expect(result).toContain("NAME of an environment variable");
      expect(seen).toHaveLength(0);
    } finally {
      delete process.env[pasted];
    }
  });

  test("an unset token variable is a readable refusal, not a crash", async () => {
    delete process.env[TOKEN_VAR];
    const result = await run(repoGet, gh());
    expect(result).toContain(TOKEN_VAR);
    expect(result).toContain("unset or empty");
    expect(seen).toHaveLength(0);
  });

  test("the token is dropped when a redirect crosses an origin", async () => {
    const result = await run(workflowRunLogs, gh({ runId: 43 }));
    expect(result.tokenDroppedAtRedirect).toBe(true);
    expect(otherSawCredential).toBe(false);
    expect(result.excerpt.failingStep).toBe("Run bun test");
  });
});

describe("the gate refuses what it should", () => {
  test("an origin outside the allow-list is refused by name", async () => {
    registerCodehostConfig({ allowed_origins: ["https://api.github.com"], token_env: TOKEN_VAR });
    const result = await run(repoGet, gh({ baseUrl: origin }));
    expect(result).toContain("not in allowed_origins");
    expect(seen).toHaveLength(0);
  });

  test("an empty allow-list denies everything, including the default base URL", async () => {
    registerCodehostConfig({ token_env: TOKEN_VAR });
    const result = await run(repoGet, gh({ baseUrl: origin }));
    expect(result).toContain("empty allow-list = deny all");
  });

  test("a redirect to an origin that is not allow-listed is refused at the hop", async () => {
    const result = await run(workflowRunLogs, gh({ runId: 44 }));
    expect(result).toContain("not in allowed_origins");
  });

  test("loopback is refused with the test flag in its production position", async () => {
    __setPrivateHostsAllowedForTest(false);
    const result = await run(repoGet, gh());
    expect(result).toContain("SSRF");
  });

  test("a URL carrying userinfo is refused rather than dialled", async () => {
    const result = await run(repoGet, gh({ baseUrl: `http://user:pass@127.0.0.1:${main.port}` }));
    expect(result).toContain("userinfo");
    expect(seen).toHaveLength(0);
  });

  test("a non-http base URL is refused", async () => {
    const result = await run(repoGet, gh({ baseUrl: "file:///etc" }));
    expect(String(result)).toMatch(/scheme|absolute URL|http/);
    expect(seen).toHaveLength(0);
  });

  test("a base URL carrying a fragment is refused instead of silently hitting the root", async () => {
    // Without the check this answers 200 from `/` and reports it as the
    // repository that was asked for.
    const result = await run(repoGet, gh({ baseUrl: `${origin}/#` }));
    expect(result).toContain("query string or a fragment");
    expect(seen).toHaveLength(0);
  });

  test("a base URL carrying a query string is refused", async () => {
    const result = await run(repoGet, gh({ baseUrl: `${origin}/?spy=1` }));
    expect(result).toContain("API ROOT");
    expect(seen).toHaveLength(0);
  });

  test("a redirect loop stops at the cap rather than spinning", async () => {
    const result = await run(repoGet, gh({ repo: "loop" }));
    expect(result).toContain("too many redirects");
    // Six requests: the first plus the five hops the cap allows.
    expect(seen.filter((entry) => entry.path === "/repos/acme/loop")).toHaveLength(6);
  });

  // 30s, not the 5s default: this is the one test that goes through the REAL
  // system resolver (every other DNS path is injected), and under a full-repo
  // run with hundreds of test files in flight that lookup has been measured
  // taking over five seconds. The tool's own deadline is what bounds the call;
  // this budget only stops a loaded machine reporting a flake as a failure.
  test("a hostname is dialled at the IP the gate vetted, keeping its Host header", async () => {
    // 127.0.0.1 as a literal short-circuits the pinning path, so this is the
    // only way to prove the pinned socket actually works.
    registerCodehostConfig({
      allowed_origins: [`http://localhost:${main.port}`],
      base_url: `http://localhost:${main.port}`,
      token_env: TOKEN_VAR,
    });
    const result = await run(repoGet, gh());
    expect(result.repository.fullName).toBe("acme/widget");
    expect(seen).toHaveLength(1);
  }, 30_000);

  test("a resolver that never answers cannot outlive the deadline", async () => {
    // node:dns takes neither a timeout nor a signal, so without the bound the
    // call hangs forever with its deadline already elapsed.
    registerCodehostConfig({
      allowed_origins: ["https://wedged.example"],
      base_url: "https://wedged.example",
      token_env: TOKEN_VAR,
    });
    _setDnsLookup(() => new Promise(() => {}));
    const startedAt = Date.now();
    const result = await run(repoGet, gh({ timeoutMs: 150 }));
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result).toContain("deadline elapsed while resolving");
    expect(seen).toHaveLength(0);
  });
});

describe("argument injection", () => {
  test("an owner that is a traversal never reaches the network", async () => {
    const result = await run(repoGet, gh({ owner: "..", repo: "widget" }));
    expect(result).toContain("path traversal");
    expect(seen).toHaveLength(0);
  });

  test("a repo that tries to add path parts is refused", async () => {
    const result = await run(repoGet, gh({ repo: "widget/../../user/repos" }));
    expect(result).toContain("characters no host allows");
    expect(seen).toHaveLength(0);
  });

  test('a ref of "-D" is refused, the shape that once deleted a branch', async () => {
    const result = await run(checkRuns, gh({ ref: "-D" }));
    expect(result).toContain('starts with "-"');
    expect(seen).toHaveLength(0);
  });

  test("a ref with a traversal is refused before the URL is built", async () => {
    const result = await run(compareRefs, gh({ base: "main", head: "../../etc/passwd" }));
    expect(result).toContain("traversal");
    expect(seen).toHaveLength(0);
  });

  test("a label carrying the host's own list separator is refused, not split", async () => {
    const result = await run(issueUpdate, gl({ number: 4, labels: ["needs review, urgent"] }));
    expect(result).toContain("two entries");
    expect(seen).toHaveLength(0);
  });

  test("the same label is fine on GitHub, where the list is an array", async () => {
    const result = await run(issueUpdate, gh({ number: 9, labels: ["needs review, urgent"] }));
    expect(result.updated).toEqual(["labels"]);
    expect(JSON.parse(seen[0]?.body ?? "{}").labels).toEqual(["needs review, urgent"]);
  });

  test("a legitimate slashed ref still works", async () => {
    const result = await run(workflowRuns, gh({ branch: "release/1.2" }));
    expect(result.count).toBe(2);
    expect(seen[0]?.path).toBe("/repos/acme/widget/actions/runs");
  });
});

describe("bounds", () => {
  test("a deadline fires and says so", async () => {
    const result = await run(repoGet, gh({ repo: "slow", timeoutMs: 60 }));
    expect(result).toContain("deadline elapsed");
  });

  test("a response past the byte cap is refused rather than parsed", async () => {
    const result = await run(repoGet, gh({ repo: "huge", maxBytes: 2048 }));
    expect(result).toContain("2048-byte cap");
    expect(result).toContain("maxBytes");
  });

  test("the page cap stops a walk and says more pages remain", async () => {
    const result = await run(prList, gh({ state: "all", maxPages: 1 }));
    expect(result.morePages).toBe(true);
    expect(result.pagesRead).toBe(1);
    expect(result.count).toBe(2);
  });

  test("pagination follows the Link header when the cap allows it", async () => {
    const result = await run(prList, gh({ state: "all", maxPages: 3 }));
    expect(result.morePages).toBe(false);
    expect(result.count).toBe(3);
    expect(seen.filter((entry) => entry.path === "/repos/acme/widget/pulls")).toHaveLength(2);
  });

  test("an HTTP error comes back as the host's own message", async () => {
    const result = await run(repoGet, gh({ repo: "forbidden" }));
    expect(result).toContain("HTTP 403");
    expect(result).toContain("admin rights");
  });
});

// ---------------------------------------------------------------------------
// the read tools
// ---------------------------------------------------------------------------

describe("pull requests", () => {
  test("PrList normalises, filters and sorts", async () => {
    const result = await run(prList, gh({ state: "all" }));
    expect(result.pullRequests.map((pr: { number: number }) => pr.number)).toEqual([7, 6, 5]);
    expect(result.pullRequests[0].labels).toEqual(["area:cli", "tooling"]);
  });

  test("PrList state merged keeps only the merged ones", async () => {
    const result = await run(prList, gh({ state: "merged" }));
    expect(result.pullRequests.map((pr: { number: number }) => pr.number)).toEqual([5]);
  });

  test("PrList sorted by updated is deterministic", async () => {
    const a = await prList.execute(gh({ state: "all", sort: "updated" }));
    const b = await prList.execute(gh({ state: "all", sort: "updated" }));
    expect(a).toBe(b);
  });

  test("PrGet reports a pending mergeability honestly and summarises checks", async () => {
    const result = await run(prGet, gh({ number: 7 }));
    expect(result.pullRequest.mergeable).toBe("computing");
    expect(result.checks.total).toBe(2);
    expect(result.checks.failing).toEqual(["test"]);
  });

  test("PrGet can skip the check request", async () => {
    await run(prGet, gh({ number: 7, includeChecks: false }));
    expect(seen).toHaveLength(1);
  });

  test("PrFiles sorts by path, totals the counts and clips the patch", async () => {
    const result = await run(prFiles, gh({ number: 7, maxPatchChars: 2 }));
    expect(result.files.map((f: { path: string }) => f.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(result.additions).toBe(14);
    expect(result.files[0].patch).toContain("clipped");
  });

  test("PrFiles can drop patches entirely", async () => {
    const result = await run(prFiles, gh({ number: 7, includePatch: false }));
    expect(result.files[0].patch).toBeUndefined();
  });

  test("PrComments returns the conversation oldest first", async () => {
    const result = await run(prComments, gh({ number: 7 }));
    expect(result.comments.map((comment: { body: string }) => comment.body)).toEqual([
      "first",
      "second",
    ]);
  });

  test("PrReviews groups inline comments into threads", async () => {
    const result = await run(prReviews, gh({ number: 7 }));
    expect(result.reviews[0].state).toBe("changes_requested");
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0].path).toBe("src/a.ts");
    expect(result.threads[0].commentCount).toBe(2);
  });
});

describe("issues", () => {
  test("IssueList filters out the pull requests GitHub mixes in", async () => {
    const result = await run(issueList, gh({}));
    expect(result.issues).toHaveLength(1);
    expect(result.pullRequestsFiltered).toBe(1);
  });

  test("IssueGet returns the body and the comments", async () => {
    const result = await run(issueGet, gh({ number: 9 }));
    expect(result.issue.body).toBe("the body");
    expect(result.comments).toHaveLength(2);
  });

  test("IssueGet can skip the comment request", async () => {
    await run(issueGet, gh({ number: 9, includeComments: false }));
    expect(seen).toHaveLength(1);
  });
});

describe("checks and CI", () => {
  test("CheckRuns merges check runs with commit statuses and names the failing step", async () => {
    const result = await run(checkRuns, gh({ ref: "abc123" }));
    expect(result.total).toBe(3);
    expect(result.failing).toEqual(["test"]);
    const failing = result.checks.find((check: { name: string }) => check.name === "test");
    expect(failing.failedSteps[0].name).toBe("bun test");
  });

  test("CheckRuns can skip the per-job step lookup", async () => {
    await run(checkRuns, gh({ ref: "abc123", includeFailingSteps: false }));
    expect(seen.filter((entry) => entry.path.includes("/actions/jobs/"))).toHaveLength(0);
  });

  test("WorkflowRuns unwraps the host's envelope and sorts newest first", async () => {
    const result = await run(workflowRuns, gh({}));
    expect(result.runs.map((entry: { id: number }) => entry.id)).toEqual([42, 41]);
  });

  test("WorkflowRunLogs picks the failed job and excerpts its log", async () => {
    const result = await run(workflowRunLogs, gh({ runId: 42 }));
    expect(result.jobId).toBe(503);
    expect(result.excerpt.failingStep).toBe("Run bun test");
    expect(result.excerpt.exitCode).toBe(1);
    expect(result.excerpt.firstError.text).toContain("expected 3 to be 4");
  });

  test("WorkflowRunLogs honours an explicit jobId", async () => {
    const result = await run(workflowRunLogs, gh({ runId: 42, jobId: 503 }));
    expect(seen).toHaveLength(1);
    expect(result.jobId).toBe(503);
  });
});

describe("releases, repository, comparison, search, quota", () => {
  test("ReleaseList sorts newest first with assets sorted by name", async () => {
    const result = await run(releaseList, gh({}));
    expect(result.releases[0].tag).toBe("v1.1.0");
    expect(result.releases[0].assets.map((a: { name: string }) => a.name)).toEqual([
      "a.tgz",
      "b.tgz",
    ]);
  });

  test("ReleaseGet reads the latest and a specific tag", async () => {
    expect((await run(releaseGet, gh({}))).release.tag).toBe("v1.1.0");
    const tagged = await run(releaseGet, gh({ tag: "v1.0.0" }));
    expect(tagged.release.notes).toBe("old notes");
  });

  test("RepoGet returns the default branch and sorted topics", async () => {
    const result = await run(repoGet, gh({}));
    expect(result.repository.defaultBranch).toBe("main");
    expect(result.repository.topics).toEqual(["a-topic", "z-topic"]);
  });

  test("CompareRefs returns commits and files, files sorted by path", async () => {
    const result = await run(compareRefs, gh({ base: "main", head: "feature" }));
    expect(result.aheadBy).toBe(2);
    expect(result.commits[0].title).toBe("first");
    expect(result.files.map((f: { path: string }) => f.path)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  test("SearchCode keeps relevance order by default and sorts on request", async () => {
    const relevance = await run(searchCode, { query: "x" });
    expect(relevance.matches.map((m: { path: string }) => m.path)).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
    const sorted = await run(searchCode, { query: "x", order: "path" });
    expect(sorted.matches.map((m: { path: string }) => m.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("SearchIssues marks which results are pull requests", async () => {
    const result = await run(searchIssues, { query: "is:open" });
    expect(result.issues[0].isPullRequest).toBe(false);
    expect(result.totalCount).toBe(1);
  });

  test("RateLimitStatus reports each resource with the host's own reset second", async () => {
    const result = await run(rateLimitStatus, {});
    expect(result.resources.core.remaining).toBe(4321);
    expect(result.resources.core.resetAt).toBe(1_790_000_000);
    expect(Object.keys(result.resources)).toEqual(["core", "search"]);
  });
});

// ---------------------------------------------------------------------------
// the write tools
// ---------------------------------------------------------------------------

describe("writes", () => {
  test("PrCreate posts the host's field names", async () => {
    const result = await run(
      prCreate,
      gh({ title: "New", sourceBranch: "feat/x", targetBranch: "main" }),
    );
    expect(result.created).toBe(true);
    const sent = JSON.parse(seen[0]?.body ?? "{}");
    expect(sent).toMatchObject({ title: "New", head: "feat/x", base: "main", draft: false });
  });

  test("PrCreate refuses a branch that starts with a dash", async () => {
    const result = await run(
      prCreate,
      gh({ title: "New", sourceBranch: "-D", targetBranch: "main" }),
    );
    expect(result).toContain('starts with "-"');
    expect(seen).toHaveLength(0);
  });

  test("PrUpdate splits core fields, labels and reviewers into their endpoints", async () => {
    const result = await run(
      prUpdate,
      gh({ number: 7, title: "Renamed", labels: ["b", "a"], reviewers: ["zoe"] }),
    );
    expect(result.updated).toEqual(["labels", "reviewers", "title"]);
    expect(seen.map((entry) => entry.method)).toEqual(["PATCH", "PUT", "POST"]);
    expect(JSON.parse(seen[1]?.body ?? "{}").labels).toEqual(["b", "a"]);
  });

  test("PrUpdate with nothing to change says so instead of calling", async () => {
    expect(await run(prUpdate, gh({ number: 7 }))).toContain("nothing to update");
    expect(seen).toHaveLength(0);
  });

  test("PrComment posts and returns the created comment", async () => {
    const result = await run(prComment, gh({ number: 7, body: "from the harness" }));
    expect(result.posted).toBe(true);
    expect(result.comment.body).toBe("from the harness");
  });

  test("PrReviewSubmit maps the event to the host's verb", async () => {
    await run(prReviewSubmit, gh({ number: 7, event: "approve" }));
    expect(JSON.parse(seen[0]?.body ?? "{}").event).toBe("APPROVE");
  });

  test("PrReviewSubmit refuses a review with no body where a body is the point", async () => {
    const result = await run(prReviewSubmit, gh({ number: 7, event: "request-changes" }));
    expect(result).toContain("needs a body");
    expect(seen).toHaveLength(0);
  });

  test("IssueCreate and IssueUpdate use the host's field names", async () => {
    await run(issueCreate, gh({ title: "Filed", labels: ["b", "a"] }));
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ title: "Filed", labels: ["a", "b"] });
    seen = [];
    const updated = await run(issueUpdate, gh({ number: 9, state: "closed" }));
    expect(updated.updated).toEqual(["state"]);
  });

  test("IssueComment posts a comment", async () => {
    const result = await run(issueComment, gh({ number: 9, body: "note" }));
    expect(result.posted).toBe(true);
  });

  test("ReleaseCreate sends the tag and defaults the name to it", async () => {
    await run(releaseCreate, gh({ tag: "v2.0.0" }));
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ tag_name: "v2.0.0", name: "v2.0.0" });
  });

  test("WorkflowRunRerun chooses the endpoint the flag asks for", async () => {
    await run(workflowRunRerun, gh({ runId: 42 }));
    expect(seen[0]?.path).toBe("/repos/acme/widget/actions/runs/42/rerun");
    seen = [];
    await run(workflowRunRerun, gh({ runId: 42, failedOnly: true }));
    expect(seen[0]?.path).toBe("/repos/acme/widget/actions/runs/42/rerun-failed-jobs");
  });
});

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

describe("the GitLab dialect", () => {
  test("the token goes in PRIVATE-TOKEN and the project path is encoded", async () => {
    await run(repoGet, gl());
    expect(seen[0]?.auth).toBe(TOKEN);
    expect(seen[0]?.path).toBe("/api/v4/projects/acme%2Fwidget");
  });

  test("PrList reads merge requests into the same record shape", async () => {
    const result = await run(prList, gl());
    expect(result.pullRequests[0]).toMatchObject({
      number: 12,
      state: "open",
      sourceBranch: "feat/x",
      labels: ["a", "b"],
    });
  });

  test("PrGet summarises the head pipeline's jobs", async () => {
    const result = await run(prGet, gl({ number: 12 }));
    expect(result.checks.pipelineId).toBe(77);
    expect(result.checks.failing).toEqual(["test"]);
  });

  test("PrComments drops system notes unless asked for them", async () => {
    expect((await run(prComments, gl({ number: 12 }))).comments).toHaveLength(1);
    const withSystem = await run(prComments, gl({ number: 12, includeSystem: true }));
    expect(withSystem.comments).toHaveLength(2);
  });

  test("PrReviews reports approvals and says what GitLab cannot express", async () => {
    const result = await run(prReviews, gl({ number: 12 }));
    expect(result.reviews[0]).toMatchObject({ author: "zoe", state: "approved" });
    expect(result.threads[0].path).toBe("src/a.ts");
    expect(result.note).toContain("no request-changes");
  });

  test("PrReviewSubmit refuses request-changes rather than downgrading it", async () => {
    const result = await run(
      prReviewSubmit,
      gl({ number: 12, event: "request-changes", body: "no" }),
    );
    expect(result).toContain("no request-changes review state");
    expect(seen).toHaveLength(0);
  });

  test("PrUpdate refuses reviewers rather than silently skipping them", async () => {
    const result = await run(prUpdate, gl({ number: 12, reviewers: ["zoe"] }));
    expect(result).toContain("numeric user ids");
    expect(seen).toHaveLength(0);
  });

  test("WorkflowRunLogs reads a job trace and finds the section", async () => {
    const result = await run(workflowRunLogs, gl({ runId: 77 }));
    expect(result.jobId).toBe(88);
    expect(result.excerpt.failingStep).toBe("test_script");
    expect(result.excerpt.firstError.text).toContain("boom");
  });

  test("CheckRuns reads commit statuses and says they carry no steps", async () => {
    const result = await run(checkRuns, gl({ ref: "abc123" }));
    expect(result.failing).toEqual(["lint"]);
    expect(result.note).toContain("no step list");
  });

  test("ReleaseGet explains how it found the latest release", async () => {
    const result = await run(releaseGet, gl({}));
    expect(result.latestVia).toContain("no latest endpoint");
    expect(result.release.tag).toBe("v1.1.0");
  });

  test("RateLimitStatus reads the headers because there is no endpoint", async () => {
    const result = await run(rateLimitStatus, {
      host: "gitlab",
      baseUrl: `${origin}/api/v4`,
    });
    expect(result).toMatchObject({ source: "response headers", limit: 600, remaining: 598 });
  });

  test("SearchCode requires a project and says why", async () => {
    const result = await run(searchCode, {
      host: "gitlab",
      baseUrl: `${origin}/api/v4`,
      query: "x",
    });
    expect(result).toContain("project-scoped");
    const scoped = await run(searchCode, gl({ query: "x" }));
    expect(scoped.matches[0]).toMatchObject({ path: "src/a.ts", startLine: 12 });
  });

  test("CompareRefs derives the line counts GitLab does not state", async () => {
    const result = await run(compareRefs, gl({ base: "main", head: "feature" }));
    expect(result.files[0]).toMatchObject({ additions: 1, deletions: 1, countsDerived: true });
    expect(result.aheadBy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the package's own contract
// ---------------------------------------------------------------------------

describe("the tool contract", () => {
  test("names are PascalCase and unique", () => {
    const names = CODEHOST_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every description's second sentence tells a caller when to use it", () => {
    for (const tool of CODEHOST_TOOLS) {
      const sentences = tool.description.split(". ");
      expect({ tool: tool.name, second: sentences[1]?.startsWith("Use ") }).toEqual({
        tool: tool.name,
        second: true,
      });
    }
  });

  test("every tool declares the network boundary it crosses", () => {
    for (const tool of CODEHOST_TOOLS) {
      expect({ tool: tool.name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        tool: tool.name,
        scope: "external",
        io: "network",
      });
    }
    expect(auditToolScopes([...CODEHOST_TOOLS])).toEqual([]);
  });

  test("every write is destructive and requires a justification; every read is neither", () => {
    const writes = new Set([
      "PrCreate",
      "PrUpdate",
      "PrComment",
      "PrReviewSubmit",
      "IssueCreate",
      "IssueUpdate",
      "IssueComment",
      "ReleaseCreate",
      "WorkflowRunRerun",
    ]);
    for (const tool of CODEHOST_TOOLS) {
      const isWrite = writes.has(tool.name);
      expect({
        tool: tool.name,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        justified: tool.requireJustification,
      }).toEqual({
        tool: tool.name,
        readOnly: !isWrite,
        destructive: isWrite,
        justified: isWrite,
      });
    }
  });

  test("no tool declares its own justification field", () => {
    // The runtime injects a REQUIRED `justification` on every tool whose
    // `requireJustification` is true, but only when the schema does not
    // already declare one. Declaring an optional one here would take over
    // that contract and make the intent gate optional.
    for (const tool of CODEHOST_TOOLS) {
      const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
      expect({
        tool: tool.name,
        declares: shape !== undefined && Object.hasOwn(shape, "justification"),
      }).toEqual({ tool: tool.name, declares: false });
    }
  });

  test("the exported array is frozen and sorted by name", () => {
    expect(Object.isFrozen(CODEHOST_TOOLS)).toBe(true);
    const names = CODEHOST_TOOLS.map((tool) => tool.name);
    expect([...names].sort()).toEqual(names);
  });

  test("results are compact JSON, not pretty-printed", async () => {
    const out = await repoGet.execute(gh());
    expect(String(out).includes("\n  ")).toBe(false);
  });

  test("the same read twice gives the same bytes", async () => {
    const a = await prFiles.execute(gh({ number: 7 }));
    const b = await prFiles.execute(gh({ number: 7 }));
    expect(a).toBe(b);
  });
});
