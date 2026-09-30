/**
 * 0.7.1 — a compiled cli bundle judges a justification with the judge its
 * spec names, as `crewhaus run` does.
 *
 * On 0.7.0 only the run path read `security.justification.judge`. Every
 * compiled bundle judged with runtime-core's rule-based default, which outside
 * tests denies every justification-gated call unless
 * CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1 is set — so a bundle whose spec
 * said `judge: claude` could never make an HttpRequest, EmailSend or
 * DownloadFile call at all.
 *
 * Here the bundle is compiled by the CLI, its imports resolved to THIS working
 * tree (the emitted manifest removed, the workspace packages linked, Bun run
 * with --no-install), and run as a subprocess — no NODE_ENV=test, no opt-in —
 * against a local fake of the Anthropic Messages API:
 *
 *   1. the model asks for one gated HttpRequest to an allow-listed local
 *      origin; the judge the spec names is asked about it (its request is
 *      recorded), allows it, and the call runs: the next model request carries
 *      the origin's answer. The verdict is on the durable, hash-chained audit
 *      log `crewhaus run` writes, and the chain verifies;
 *   2. `crewhaus run` on the same spec sends the judge the same request, byte
 *      for byte, so the two paths judge one way;
 *   3. the same spec without `security:` still gets the rule-based judge's
 *      fail-closed denial and asks no judge: a bundle that names no judge is
 *      unchanged.
 *
 * Tool-http refuses loopback addresses as it ships; a preload lifts that with
 * its test-only switch so the allowed call can reach the local origin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verify } from "@crewhaus/audit-log";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_PATH = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");

const JUDGE_MODEL = "claude-haiku-4-5";
const AGENT_MODEL = "claude-sonnet-4-6";
const JUSTIFICATION = "Check that the internal status API reports the service is up.";

const tempDirs: string[] = [];
function newTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let origin = "";
let target: ReturnType<typeof Bun.serve>;
let anthropic: ReturnType<typeof Bun.serve>;
/** Every Messages API request the fake received, in order. */
const requests: Array<Record<string, unknown>> = [];

type ToolUse = { readonly id: string; readonly name: string; readonly input: unknown };

/** One streamed assistant message, in the Messages API's SSE framing. */
function sse(block: ToolUse | string): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
  ];
  if (typeof block === "string") {
    events.push([
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ]);
    events.push([
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block } },
    ]);
  } else {
    events.push([
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      },
    ]);
    events.push([
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      },
    ]);
  }
  events.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: {
        stop_reason: typeof block === "string" ? "end_turn" : "tool_use",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

type Message = { readonly role: string; readonly content: unknown };

/** The tool_result blocks of a request's last message. */
function toolResults(body: Record<string, unknown>): string[] {
  const last = (body["messages"] as Message[] | undefined)?.at(-1);
  if (last === undefined || !Array.isArray(last.content)) return [];
  return (last.content as Array<{ type?: string; content?: unknown }>)
    .filter((b) => b.type === "tool_result")
    .map((b) =>
      typeof b.content === "string"
        ? b.content
        : (b.content as Array<{ text?: string }>).map((c) => c.text ?? "").join(""),
    );
}

beforeAll(() => {
  target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("status: up"),
  });
  origin = `http://127.0.0.1:${target.port}`;
  anthropic = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/messages")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as Record<string, unknown>;
      requests.push(body);
      const headers = { "content-type": "text/event-stream" };
      if (body["model"] === JUDGE_MODEL) {
        return new Response(
          sse('{"allow": true, "reason": "it checks the API the goal names", "confidence": 0.9}'),
          { headers },
        );
      }
      if (toolResults(body).length > 0) return new Response(sse("done"), { headers });
      return new Response(
        sse({
          id: "toolu_status",
          name: "HttpRequest",
          input: { url: `${origin}/status`, method: "GET", justification: JUSTIFICATION },
        }),
        { headers },
      );
    },
  });
});

afterAll(() => {
  target.stop(true);
  anthropic.stop(true);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function spec(security: string): string {
  return [
    "name: judged-http",
    "target: cli",
    "continuity: false",
    "agent:",
    `  model: ${AGENT_MODEL}`,
    "  instructions: Check the internal status API with HttpRequest to see that the service is up.",
    "tools: [httpRequest]",
    "tool_config:",
    "  http:",
    `    allowed_origins: ["${origin}"]`,
    "permissions:",
    "  mode: auto",
    "  rules:",
    "    - { type: alwaysAllow, pattern: HttpRequest }",
    security,
    "",
  ].join("\n");
}

const JUDGED = "security:\n  justification:\n    judge: claude";

/** Symlink every in-tree `@crewhaus/*` package beside the bundle, so its bare
 *  imports resolve to THIS working tree (paired with `--no-install`). */
function linkWorkspacePackages(bundleDir: string): void {
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(REPO_ROOT, "packages", entry.name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (name === undefined || !name.startsWith("@crewhaus/")) continue;
    const dest = join(bundleDir, "node_modules", name);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) symlinkSync(dir, dest, "dir");
  }
}

/** A preload that lifts tool-http's loopback refusal in the child. It names
 *  the file the linked package resolves to, so both see one module. */
function liftLoopback(dir: string): string {
  const file = join(dir, "lift-loopback.ts");
  writeFileSync(
    file,
    `import { __setPrivateHostsAllowedForTest } from ${JSON.stringify(
      join(REPO_ROOT, "packages", "tool-http", "src", "index.ts"),
    )};\n__setPrivateHostsAllowedForTest(true);\n`,
  );
  return file;
}

/** The child's whole environment: no NODE_ENV, no rule-based opt-in. */
function childEnv(sandbox: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: sandbox,
    ANTHROPIC_API_KEY: ["sk", "ant", "e2e", "0".repeat(12)].join("-"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropic.port}`,
    CREWHAUS_NO_REGISTRY: "1",
    CREWHAUS_REGISTRY_ROOT: join(sandbox, "registry"),
    CREWHAUS_SESSION_DIR: join(sandbox, "sessions"),
    CREWHAUS_WATCHME_ROOT: join(sandbox, "watchme"),
  };
}

async function drain(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<{ readonly code: number; readonly stderr: string }> {
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stderr };
}

/**
 * Compile `yaml` with the CLI and run the bundle once, one line on stdin.
 * Throws when it fails, unless `expectFailure` — then its stderr is returned.
 */
async function runBundle(
  yaml: string,
  opts: { readonly withoutAnthropicKey?: boolean; readonly expectFailure?: boolean } = {},
): Promise<{
  readonly sandbox: string;
  readonly agentTs: string;
  readonly requests: ReadonlyArray<Record<string, unknown>>;
  readonly code: number;
  readonly stderr: string;
}> {
  const sandbox = newTmp("crewhaus-judged-bundle-");
  const specPath = join(sandbox, "crewhaus.yaml");
  writeFileSync(specPath, yaml);
  const out = join(sandbox, "dist");
  const env = childEnv(sandbox);
  if (opts.withoutAnthropicKey === true) Reflect.deleteProperty(env, "ANTHROPIC_API_KEY");
  const compiled = Bun.spawnSync(
    [process.execPath, CLI_PATH, "compile", specPath, "--no-register", "-o", out],
    { cwd: sandbox, env },
  );
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
  rmSync(join(out, "package.json"), { force: true });
  linkWorkspacePackages(out);
  requests.length = 0;
  const proc = Bun.spawn(
    [process.execPath, "--no-install", "--preload", liftLoopback(sandbox), join(out, "agent.ts")],
    {
      cwd: sandbox,
      env,
      stdin: new TextEncoder().encode("check the status API\n"),
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const { code, stderr } = await drain(proc);
  if (code !== 0 && opts.expectFailure !== true) throw new Error(`exited ${code}: ${stderr}`);
  return {
    sandbox,
    agentTs: readFileSync(join(out, "agent.ts"), "utf8"),
    requests: [...requests],
    code,
    stderr,
  };
}

/** `crewhaus run` on `yaml`, one-shot. */
async function runInterpreter(yaml: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const sandbox = newTmp("crewhaus-judged-run-");
  writeFileSync(join(sandbox, "crewhaus.yaml"), yaml);
  requests.length = 0;
  const proc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      liftLoopback(sandbox),
      CLI_PATH,
      "run",
      "crewhaus.yaml",
      "--prompt",
      "check the status API",
    ],
    { cwd: sandbox, env: childEnv(sandbox), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const { code, stderr } = await drain(proc);
  if (code !== 0) throw new Error(`exited ${code}: ${stderr}`);
  return [...requests];
}

const judgeRequests = (rs: ReadonlyArray<Record<string, unknown>>) =>
  rs.filter((r) => r["model"] === JUDGE_MODEL);
const agentResults = (rs: ReadonlyArray<Record<string, unknown>>) =>
  rs.filter((r) => r["model"] === AGENT_MODEL).flatMap(toolResults);

/** Every audit record under `<dir>/.crewhaus/audit`, in chain order. */
function auditRecords(dir: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  const root = join(dir, ".crewhaus", "audit");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) =>
      readFileSync(join(root, f), "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> }),
    );
}

describe("a compiled cli bundle judges with the judge its spec names (0.7.1)", () => {
  test("a gated HttpRequest to an allow-listed origin is judged by the named judge, and runs", async () => {
    const run = await runBundle(spec(JUDGED));
    expect(run.agentTs).toContain(
      'const __justificationJudge = await createJustificationJudgeFromSlot({"judge":"claude"}).catch(',
    );

    // The judge the spec names was asked, about this call, on its default model.
    const judged = judgeRequests(run.requests);
    expect(judged).toHaveLength(1);
    const asked = JSON.stringify(judged[0]?.["messages"]);
    expect(asked).toContain("TOOL: HttpRequest");
    expect(asked).toContain(JUSTIFICATION);
    expect(JSON.stringify(judged[0]?.["system"])).toContain("security judge");

    // It allowed the call, and the call ran: the model got the origin's answer.
    const results = agentResults(run.requests);
    expect(results).toHaveLength(1);
    const answered = JSON.parse(results[0] as string) as { status: number; body: string };
    expect(answered.status).toBe(200);
    expect(answered.body).toBe("status: up");

    // The verdict is on the durable audit log, attributed to the judge, and
    // the chain verifies.
    const verdicts = auditRecords(run.sandbox).filter(
      (r) => r.kind === "permission_justification_evaluated",
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.payload).toMatchObject({
      toolName: "HttpRequest",
      justification: JUSTIFICATION,
      verdict: "allow",
      judgeModel: JUDGE_MODEL,
    });
    expect((await verify(join(run.sandbox, ".crewhaus", "audit"))).ok).toBe(true);

    // `crewhaus run` on the same spec asks the judge exactly the same thing.
    const interpreted = judgeRequests(await runInterpreter(spec(JUDGED)));
    expect(interpreted).toHaveLength(1);
    expect(interpreted[0]).toEqual(judged[0] as Record<string, unknown>);
  }, 180_000);

  test("without security:, the bundle is the 0.7.0 bundle: no judge is asked and the call is refused", async () => {
    const run = await runBundle(spec(""));
    expect(run.agentTs).not.toContain("justification");
    expect(run.agentTs).not.toContain("audit");
    expect(judgeRequests(run.requests)).toHaveLength(0);
    const results = agentResults(run.requests);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("justification denied (fail-closed)");
    expect(existsSync(join(run.sandbox, ".crewhaus", "audit"))).toBe(false);
  }, 120_000);

  test("a named judge whose provider has no key stops the bundle at start, with the reason", async () => {
    // The agent's own model needs no Anthropic key, so only the judge can stop it.
    const yaml = spec(JUDGED).replace(
      `  model: ${AGENT_MODEL}`,
      "  model: 'local/stub@http://127.0.0.1:1/v1'",
    );
    expect(yaml).toContain("local/stub");
    const run = await runBundle(yaml, { withoutAnthropicKey: true, expectFailure: true });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("no Anthropic credentials found");
    // Reported like a failed run, not as a stack trace, and before any turn.
    expect(run.stderr).toContain("run stopped");
    expect(run.stderr).not.toMatch(/\n\s+at /);
    expect(run.requests).toHaveLength(0);
  }, 120_000);
});
