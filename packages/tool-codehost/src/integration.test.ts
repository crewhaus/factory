/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before `execute` ever
 * runs.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately. It also
 * covers the one path `index.test.ts` cannot reach by calling `execute`
 * directly: a per-candidate `tool_config` block arriving through the
 * execution context, which is how a spec narrows — or widens — the origin
 * allow-list for one candidate.
 *
 * The server is a real one on 127.0.0.1, as in `index.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  CODEHOST_TOOLS,
  __setPrivateHostsAllowedForTest,
  _resetCodehostConfig,
  registerCodehostConfig,
} from "./index";

const TOKEN = "ghp_integration_token_0123456789";
const TOKEN_VAR = "CREWHAUS_INT_CODEHOST_TOKEN";

let catalog: ToolCatalog;
let server: ReturnType<typeof Bun.serve>;
let origin = "";

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

const jsonRes = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/**
 * A server that answers every endpoint the sweep below touches with a
 * plausible, minimal payload. The detailed shapes are exercised in
 * `index.test.ts`; what matters here is that every tool completes a real
 * round trip under the runtime's own dispatch.
 */
function handler(req: Request): Response {
  const path = new URL(req.url).pathname;
  if (req.method !== "GET") return jsonRes({ id: 1, number: 1, iid: 1, tag_name: "v1" });
  if (path === "/rate_limit") return jsonRes({ resources: { core: { limit: 1, remaining: 1 } } });
  if (path === "/search/code") return jsonRes({ total_count: 0, items: [] });
  if (path === "/search/issues") return jsonRes({ total_count: 0, items: [] });
  if (path.endsWith("/logs") || path.endsWith("/trace")) {
    return new Response("##[error]Process completed with exit code 1.", {
      headers: { "content-type": "text/plain" },
    });
  }
  if (path.endsWith("/check-runs")) return jsonRes({ check_runs: [] });
  if (path.endsWith("/status")) return jsonRes({ statuses: [] });
  if (path.endsWith("/actions/runs")) return jsonRes({ total_count: 0, workflow_runs: [] });
  if (path.endsWith("/jobs")) {
    return jsonRes({ jobs: [{ id: 9, name: "test", conclusion: "failure", steps: [] }] });
  }
  if (path.includes("/compare/")) return jsonRes({ ahead_by: 0, commits: [], files: [] });
  if (path.endsWith("/releases/latest")) return jsonRes({ tag_name: "v1", assets: [] });
  if (path.endsWith("/approvals")) return jsonRes({ approved_by: [] });
  if (/\/(pulls|merge_requests|issues)\/\d+$/.test(path)) {
    return jsonRes({
      number: 7,
      iid: 7,
      title: "T",
      state: "open",
      head: { ref: "f", sha: "abc" },
      base: { ref: "main" },
    });
  }
  if (/\/repos\/[^/]+\/[^/]+$/.test(path)) {
    return jsonRes({ full_name: "acme/widget", default_branch: "main" });
  }
  if (/\/projects\/[^/]+$/.test(path)) {
    return jsonRes({ path_with_namespace: "acme/widget", default_branch: "main" });
  }
  return jsonRes([]);
}

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: handler });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  process.env[TOKEN_VAR] = TOKEN;
  registerCodehostConfig({
    allowed_origins: [origin],
    base_url: origin,
    token_env: TOKEN_VAR,
  });
  __setPrivateHostsAllowedForTest(true);
  catalog = new ToolCatalog();
  for (const tool of CODEHOST_TOOLS) catalog.register(tool);
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _resetCodehostConfig();
  delete process.env[TOKEN_VAR];
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(CODEHOST_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of CODEHOST_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("RepoGet"),
      { owner: "acme", repo: "widget" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("acme/widget");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("PrGet"),
      { owner: "acme", repo: "widget", number: "seven" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("PrGet");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("PrFiles"), { owner: "acme" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("an out-of-range bound is rejected by the schema, not clamped", async () => {
    const result = await executeTool(
      lookup("PrList"),
      { owner: "acme", repo: "widget", perPage: 5000 },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("PrComment"),
      { owner: "acme", repo: "widget", number: 1, body: "hi" },
      { toolUseId: "t5", allowedPatterns: ["PrGet"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("RepoGet"),
      { owner: "acme", repo: "widget" },
      { toolUseId: "t6", allowedPatterns: ["RepoGet"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a refusal is a readable result, not a thrown error", async () => {
    const result = await executeTool(
      lookup("RepoGet"),
      { owner: "..", repo: "widget" },
      { toolUseId: "t7" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("path traversal");
  });
});

describe("the per-candidate tool_config block", () => {
  test("a candidate's own allow-list is what the call runs under", async () => {
    const result = await executeTool(
      lookup("RepoGet"),
      { owner: "acme", repo: "widget" },
      {
        toolUseId: "c1",
        toolConfig: {
          allowed_origins: ["https://api.github.com"],
          base_url: origin,
          token_env: TOKEN_VAR,
        },
      },
    );
    expect(result.content).toContain("not in allowed_origins");
  });

  test("a candidate block with no origins denies everything, ignoring the boot config", async () => {
    const result = await executeTool(
      lookup("RepoGet"),
      { owner: "acme", repo: "widget" },
      { toolUseId: "c2", toolConfig: { base_url: origin, token_env: TOKEN_VAR } },
    );
    expect(result.content).toContain("empty allow-list = deny all");
  });

  test("a candidate block can name the host and the token variable", async () => {
    const result = await executeTool(
      lookup("RepoGet"),
      { owner: "acme", repo: "widget" },
      {
        toolUseId: "c3",
        toolConfig: {
          allowed_origins: [origin],
          base_url: `${origin}/api/v4`,
          token_env: TOKEN_VAR,
          host: "gitlab",
        },
      },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"host":"gitlab"');
  });

  test("a non-object override is ignored rather than widening the gate", async () => {
    const result = await executeTool(
      lookup("RepoGet"),
      { owner: "acme", repo: "widget" },
      { toolUseId: "c4", toolConfig: "allow everything" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("acme/widget");
  });
});

describe("every tool completes a round trip under dispatch", () => {
  test("none throws out of execute", async () => {
    const repo = { owner: "acme", repo: "widget" };
    const calls: Record<string, unknown> = {
      CheckRuns: { ...repo, ref: "abc123" },
      CompareRefs: { ...repo, base: "main", head: "feature" },
      IssueComment: { ...repo, number: 1, body: "b" },
      IssueCreate: { ...repo, title: "t" },
      IssueGet: { ...repo, number: 1 },
      IssueList: repo,
      IssueUpdate: { ...repo, number: 1, state: "closed" },
      PrComment: { ...repo, number: 1, body: "b" },
      PrComments: { ...repo, number: 1 },
      PrCreate: { ...repo, title: "t", sourceBranch: "f", targetBranch: "main" },
      PrFiles: { ...repo, number: 1 },
      PrGet: { ...repo, number: 1 },
      PrList: repo,
      PrReviewSubmit: { ...repo, number: 1, event: "approve" },
      PrReviews: { ...repo, number: 1 },
      PrUpdate: { ...repo, number: 1, title: "t" },
      RateLimitStatus: {},
      ReleaseCreate: { ...repo, tag: "v1.0.0" },
      ReleaseGet: repo,
      ReleaseList: repo,
      RepoGet: repo,
      SearchCode: { query: "x" },
      SearchIssues: { query: "x" },
      WorkflowRunLogs: { ...repo, runId: 1 },
      WorkflowRunRerun: { ...repo, runId: 1 },
      WorkflowRuns: repo,
    };
    expect(Object.keys(calls).sort()).toEqual(CODEHOST_TOOLS.map((tool) => tool.name).sort());
    for (const tool of CODEHOST_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
      expect(String(result.content).includes(TOKEN)).toBe(false);
    }
    // Calls every tool in the package once.
  }, 20_000);

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = { owner: "acme", repo: "widget", number: 1 };
    const a = await executeTool(lookup("PrGet"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("PrGet"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });
});
