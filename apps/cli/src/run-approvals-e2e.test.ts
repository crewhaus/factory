/**
 * Loop contract 0.4 (Batch C, G11) — the INTERPRETER half of the pending
 * approval seam, at the CLI subprocess boundary.
 *
 * `packages/runtime-core/src/approvals.test.ts` already pins the park/resume
 * state machine itself, but every case there hand-injects `askMode` +
 * `approvals` into `runChatLoop`. Nothing pinned that a caller ever PASSES
 * them — which is exactly how `permissions.ask_mode` came to be parsed,
 * lowered into the IR, honoured by the runtime, documented in
 * `crewhaus runs resume --help`, and still a total no-op on every
 * `crewhaus run`: the interpreter never threaded either option, so a headless
 * `ask` always took runtime-core's collapse-to-deny branch and
 * `createPendingApprovalStore` had no production caller in the repo.
 *
 * These tests therefore assert the THREADING, through the real CLI:
 *   - `ask_mode: pause`  → the run PARKS (exit 36) and the pending approval is
 *     visible to `crewhaus approvals list --json` — i.e. the run and the verbs
 *     agree on where the store lives, so the remediation the runtime prints
 *     ("grant … then rerun") actually resolves.
 *   - `ask_mode` OMITTED → identical, pinning the documented default.
 *   - `ask_mode: deny`   → denies in place, run completes (exit 0), and the
 *     denial names `ask_mode: "deny"` rather than "no approvals store wired".
 *     That last assertion is what makes the deny case a real bug-catcher: the
 *     pre-fix behaviour also denied, but for the WRONG reason, and only the
 *     wording distinguishes "the operator asked for this" from "nothing was
 *     wired".
 *   - `CREWHAUS_SESSION_DIR` → the park follows the session root rather than
 *     the cwd, and the verbs resolve the same root. Without this, the store
 *     root work is a free mutant: deleting it leaves everything else green.
 *   - the full park → grant → rerun ROUND TRIP, ending in the tool actually
 *     executing and the one-shot grant stamped consumed.
 *   - `runs resume --ask-mode`, which reaches runRunCli through synthesized
 *     args and would otherwise silently rot.
 *   - `serve --mcp`, whose daemon turn must park and REPORT rather than die.
 *   - the BROWSER target, via a virtual `playwright` module (see
 *     fake-playwright-preload.ts). That shape reaches its loop options only
 *     after `driver.connect()`, so faking the browser is the only way to
 *     observe the wiring without a real chromium — which the main `ci` job
 *     never installs, so a skip-if-missing test would skip 100% of the time.
 *
 * Each of the above is mutation-checked: removing the corresponding production
 * hunk fails at least one case. All three call sites are covered — an earlier
 * revision could have had its browser AND serve spreads deleted with the whole
 * 2882-test suite still green.
 *
 * NO live model calls: the spec's model is `local/<m>@<url>` (credential-free
 * through the OpenAI-compatible adapter) pointed at an in-test Bun.serve stub
 * that answers with a streamed `tool_calls` chunk, so a REAL turn reaches the
 * REAL permission engine. Following advice-pipeline-e2e.test.ts's posture,
 * assertions are on exit codes and on-disk artifacts, never on captured
 * stdout (Bun 1.3.x spawn-pipe capture is unreliable under `bun test`).
 *
 * BOOBY TRAP, deliberately avoided: `Read` is `alwaysAllow` in
 * BUILTIN_DEFAULT_RULES, so without the explicit `alwaysAsk` rule below the
 * tool simply executes and every one of these tests passes vacuously.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-run-approvals-"));
  TMP_ROOTS.push(dir);
  return dir;
}

// -------- deterministic OpenAI-compatible SSE stub that calls a tool --------

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Which tool the stub asks for. The cli cases want `Read`; the browser case
 * wants `Navigate`, since a browser bundle registers no `Read` and an unknown
 * tool never reaches the permission gate at all (it fails earlier, which would
 * make the test vacuously green). Bun runs a file's tests sequentially, so a
 * module-level switch is safe here.
 */
let stubToolCall: { name: string; args: string } = {
  name: "Read",
  args: '{"path":"secret.txt"}',
};

// Reset per test. The browser case switches this to `Navigate`, and a leaked
// switch makes a LATER cli case ask for a tool its spec never registers —
// which fails BEFORE the permission gate, so the case goes red for a reason
// that has nothing to do with what it is testing.
beforeEach(() => {
  stubToolCall = { name: "Read", args: '{"path":"secret.txt"}' };
});

/**
 * One streamed assistant turn whose only content is a tool call, in OpenAI
 * chunk-stream wire format (id+name first, arguments as a later delta,
 * `finish_reason: "tool_calls"`), mirroring adapter-openai/src/stream.test.ts.
 */
function toolCallSse(): string {
  const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub" };
  return [
    sseChunk({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
    }),
    sseChunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: stubToolCall.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sseChunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: stubToolCall.args } }],
          },
          finish_reason: null,
        },
      ],
    }),
    sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({
      ...base,
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

/** A plain text turn, for the follow-up turn after a denial. */
function textSse(text: string): string {
  const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub" };
  return [
    sseChunk({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }),
    sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({
      ...base,
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

/**
 * A tool-result message already in the transcript. The adapter PRETTY-PRINTS
 * its request body, so this must tolerate whitespace — a naive
 * `includes('"role":"tool"')` never matches and the stub then asks for the
 * tool forever, which re-parks every run and looks exactly like a broken fix.
 */
const TOOL_RESULT_IN_BODY = /"role"\s*:\s*"tool"/;

// Ask for the tool until the transcript already carries a tool RESULT, then
// answer with text so the run can terminate. Keyed off the request body rather
// than a call counter so it behaves correctly across the multi-process
// park → grant → resume round trip below.
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.method === "POST" && new URL(req.url).pathname.endsWith("/chat/completions")) {
      const body = await req.text();
      const answered = TOOL_RESULT_IN_BODY.test(body);
      return new Response(answered ? textSse("the phrase is mango") : toolCallSse(), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  stub.stop(true);
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const STUB_MODEL = `local/stub@http://127.0.0.1:${stub.port}/v1`;

/**
 * A cli spec whose only tool is `Read`, explicitly ruled `alwaysAsk` so the
 * permission engine lands on `ask` (the builtin default would ALLOW it).
 */
function seedSpec(root: string, askModeLine: string): void {
  writeFileSync(join(root, "secret.txt"), "the phrase is mango\n");
  writeFileSync(
    join(root, "crewhaus.yaml"),
    [
      "name: ask-mode-e2e",
      "target: cli",
      "agent:",
      `  model: ${STUB_MODEL}`,
      "  instructions: Read secret.txt and report it.",
      "tools:",
      "  - read",
      "permissions:",
      ...(askModeLine === "" ? [] : [`  ${askModeLine}`]),
      "  rules:",
      "    - type: alwaysAsk",
      "      pattern: Read",
      "",
    ].join("\n"),
  );
}

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Concatenated tool_result contents from the run's session event log. */
function toolResults(root: string): string {
  const dir = join(root, ".crewhaus", "sessions");
  if (!existsSync(dir)) return "";
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl") && n.startsWith("sess_"))) {
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const ev = JSON.parse(line) as { kind?: string; payload?: { content?: unknown } };
        if (ev.kind === "tool_result") out.push(String(ev.payload?.content ?? ""));
      } catch {
        // partial write — ignore
      }
    }
  }
  return out.join("\n");
}

const APPROVAL_PENDING_EXIT = 36;

describe("crewhaus run — permissions.ask_mode threading (G11)", () => {
  test("ask_mode: pause parks the run and the park is visible to `approvals list`", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "ask_mode: pause");

    const run = await runCli(["run", "crewhaus.yaml", "--prompt", "read the file"], root);
    expect(run.exitCode).toBe(APPROVAL_PENDING_EXIT);

    // Parked into the same store the verbs read — the whole point of the
    // documented "grant … then rerun" remediation.
    const listed = await runCli(["approvals", "list", "--json"], root);
    expect(listed.exitCode).toBe(0);
    const records = JSON.parse(listed.stdout) as Array<{
      toolName: string;
      decision?: string;
      id: string;
    }>;
    expect(records.length).toBe(1);
    expect(records[0]?.toolName).toBe("Read");
    expect(records[0]?.decision).toBeUndefined();
    expect(records[0]?.id).toMatch(/^appr_[0-9a-f]{16}$/);
  }, 60_000);

  test("ask_mode omitted parks too — the documented default is `pause`", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "");

    const run = await runCli(["run", "crewhaus.yaml", "--prompt", "read the file"], root);
    expect(run.exitCode).toBe(APPROVAL_PENDING_EXIT);
    expect(existsSync(join(root, ".crewhaus", "sessions", "approvals.jsonl"))).toBe(true);
  }, 60_000);

  test('ask_mode: deny denies in place, and says so — not "no approvals store wired"', async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "ask_mode: deny");

    const run = await runCli(["run", "crewhaus.yaml", "--prompt", "read the file"], root);
    // Denied in place → the turn continues and the run completes normally.
    expect(run.exitCode).toBe(0);

    const results = toolResults(root);
    expect(results).toContain("tool denied");
    // The operator ASKED for deny. Pre-fix this same denial appeared with
    // "(no approvals store wired)" because nothing was ever threaded.
    expect(results).toContain('ask_mode: "deny"');
    expect(results).not.toContain("no approvals store wired");
    // deny must never create the store it does not use.
    expect(existsSync(join(root, ".crewhaus", "sessions", "approvals.jsonl"))).toBe(false);
  }, 60_000);

  test("--ask-mode deny overrides a spec that says pause", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "ask_mode: pause");

    const run = await runCli(
      ["run", "crewhaus.yaml", "--prompt", "read the file", "--ask-mode", "deny"],
      root,
    );
    expect(run.exitCode).toBe(0);
    expect(toolResults(root)).toContain('ask_mode: "deny"');
  }, 60_000);

  test("an invalid --ask-mode is rejected, by VALUE, before the run starts", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "");
    const run = await runCli(
      ["run", "crewhaus.yaml", "--prompt", "x", "--ask-mode", "sometimes"],
      root,
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.exitCode).not.toBe(APPROVAL_PENDING_EXIT);
    // Assert WHY it failed. Without this, deleting `--ask-mode` from
    // RUN_SCHEMA would also pass — parseArgs rejects an unknown flag, and the
    // two failures are indistinguishable by exit code alone.
    expect(run.stderr).toContain("--ask-mode");
    expect(run.stderr).toContain("pause, deny");
    // Rejected BEFORE the run booted: nothing was written.
    expect(existsSync(join(root, ".crewhaus", "sessions"))).toBe(false);
  }, 60_000);

  test("the park lands under CREWHAUS_SESSION_DIR, and `approvals` finds it there", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "ask_mode: pause");
    const sessionDir = join(newTempRoot(), "elsewhere");
    mkdirSync(sessionDir, { recursive: true });

    const run = await runCli(["run", "crewhaus.yaml", "--prompt", "read the file"], root, {
      CREWHAUS_SESSION_DIR: sessionDir,
    });
    expect(run.exitCode).toBe(APPROVAL_PENDING_EXIT);

    // The park follows the session root, NOT the cwd — a tenant-rebased root
    // must not pool one tenant's approvals (which embed the tool input) into
    // another's directory.
    expect(existsSync(join(sessionDir, "approvals.jsonl"))).toBe(true);
    expect(existsSync(join(root, ".crewhaus", "sessions", "approvals.jsonl"))).toBe(false);

    // …and the verbs resolve the same root, or the remediation the runtime
    // prints ("grant … then rerun") points at an empty file.
    const listed = await runCli(["approvals", "list", "--json"], root, {
      CREWHAUS_SESSION_DIR: sessionDir,
    });
    const records = JSON.parse(listed.stdout) as Array<{ toolName: string }>;
    expect(records.length).toBe(1);
    expect(records[0]?.toolName).toBe("Read");
  }, 60_000);
});

describe("the documented park → grant → resume round trip", () => {
  test("a granted approval is consumed on the next run and the tool actually executes", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "ask_mode: pause");

    // 1. park
    const parked = await runCli(["run", "crewhaus.yaml", "--prompt", "read it"], root);
    expect(parked.exitCode).toBe(APPROVAL_PENDING_EXIT);

    // 2. the operator sees it
    const listed = await runCli(["approvals", "list", "--json"], root);
    const records = JSON.parse(listed.stdout) as Array<{ id: string }>;
    const id = records[0]?.id ?? "";
    expect(id).toMatch(/^appr_[0-9a-f]{16}$/);

    // 3. grant it out of band
    const granted = await runCli(["approvals", "grant", id, "--by", "tester"], root);
    expect(granted.exitCode).toBe(0);

    // 4. rerun: the grant is found by (toolName, inputHash) and consumed, the
    //    call runs pre-approved, and the turn completes normally.
    const resumed = await runCli(["run", "crewhaus.yaml", "--prompt", "read it"], root);
    expect(resumed.exitCode).toBe(0);
    expect(toolResults(root)).toContain("mango");

    // The grant was ONE-SHOT: the record is stamped consumed.
    const after = JSON.parse(
      (await runCli(["approvals", "list", "--json"], root)).stdout,
    ) as Array<{ id: string; decision?: string; consumedAt?: string }>;
    expect(after.find((r) => r.id === id)?.consumedAt).toBeDefined();
  }, 120_000);

  test("`runs resume` accepts --ask-mode and forwards it to the resumed run", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "ask_mode: pause");

    const parked = await runCli(["run", "crewhaus.yaml", "--prompt", "read it"], root);
    expect(parked.exitCode).toBe(APPROVAL_PENDING_EXIT);
    const sessionId =
      readdirSync(join(root, ".crewhaus", "sessions"))
        .find((f) => f.startsWith("sess_") && f.endsWith(".json"))
        ?.replace(/\.json$/, "") ?? "";
    expect(sessionId).toMatch(/^sess_[0-9a-f]{16}$/);

    // Resuming with --ask-mode deny must NOT park again: the flag has to reach
    // runRunCli through the synthesized args, and the denial must name the
    // operator's choice. A refactor that stopped forwarding args.flags would
    // silently make the documented resume knob inert — the same class of
    // defect this whole change exists to fix.
    const resumed = await runCli(
      ["runs", "resume", sessionId, "--prompt", "again", "--ask-mode", "deny"],
      root,
    );
    expect(resumed.exitCode).toBe(0);
    expect(toolResults(root)).toContain('ask_mode: "deny"');
  }, 120_000);
});

describe("crewhaus run — browser target ask_mode threading (G11)", () => {
  /**
   * The browser shape reaches its `runChatLoop` options only AFTER
   * `driver.connect()`, so nothing about the threading is observable until a
   * browser has launched — which is why this was the one call site left
   * uncovered. A virtual `playwright` module (see fake-playwright-preload.ts)
   * removes the BROWSER without removing the code path: the run still goes
   * driver → Navigate → permission engine, with no binary anywhere. The repo's
   * established posture for browser tests is a faked playwright rather than a
   * skipped test, and a chromium-gated skip would skip in CI 100% of the time
   * (the main `ci` job never runs `playwright install`).
   */
  test("a browser run parks on an unruled `ask` — no chromium required", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    stubToolCall = { name: "Navigate", args: '{"url":"https://example.com/"}' };
    // `alwaysAsk` on Navigate, and NO ask_mode declared: the documented
    // default is pause, so a threaded run parks here.
    writeFileSync(
      join(root, "crewhaus.yaml"),
      [
        "name: ask-mode-browser-e2e",
        "target: browser",
        "agent:",
        `  model: ${STUB_MODEL}`,
        "  instructions: Navigate somewhere.",
        "permissions:",
        "  rules:",
        "    - type: alwaysAsk",
        "      pattern: Navigate",
        "",
      ].join("\n"),
    );

    const proc = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(SRC_DIR, "fake-playwright-preload.ts"),
        CLI_PATH,
        "run",
        "crewhaus.yaml",
        "--prompt",
        "go to example.com",
      ],
      {
        cwd: root,
        env: { PATH: process.env["PATH"] ?? "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    // Un-threaded, this shape is identical to `--ask-mode deny`: exit 0, a
    // `browser_done` line, and no approvals file. Both assertions therefore
    // flip the moment the `...approvalRunOptions(...)` spread is removed from
    // runRunBrowser.
    expect(exitCode).toBe(APPROVAL_PENDING_EXIT);
    expect(existsSync(join(root, ".crewhaus", "sessions", "approvals.jsonl"))).toBe(true);
    const listed = await runCli(["approvals", "list", "--json"], root);
    const records = JSON.parse(listed.stdout) as Array<{ toolName: string }>;
    expect(records.some((r) => r.toolName === "Navigate")).toBe(true);
  }, 90_000);
});

describe("crewhaus serve --mcp — ask_mode threading (G11)", () => {
  test("a daemon turn parks instead of denying in place, and the daemon survives", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    seedSpec(root, "ask_mode: pause");

    // One stdio MCP session: initialize → tools/list (to learn the projected
    // tool name) → tools/call, which trips the `ask`. A daemon never closes
    // stdout, so read it incrementally rather than awaiting the whole body.
    const proc = Bun.spawn([process.execPath, CLI_PATH, "serve", "--mcp", "crewhaus.yaml"], {
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const rpc = (o: unknown): void => {
      proc.stdin?.write(`${JSON.stringify(o)}\n`);
      proc.stdin?.flush?.();
    };
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    /** Read line-delimited JSON until `match` accepts one, or time out. */
    async function until(
      match: (msg: Record<string, unknown>) => boolean,
      ms: number,
    ): Promise<Record<string, unknown> | undefined> {
      const deadline = Date.now() + ms;
      for (;;) {
        const idx = buffered.indexOf("\n");
        if (idx !== -1) {
          const line = buffered.slice(0, idx);
          buffered = buffered.slice(idx + 1);
          if (line.trim() !== "") {
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (match(msg)) return msg;
            } catch {
              // non-JSON chatter on stdout — skip
            }
          }
          continue;
        }
        if (Date.now() > deadline) return undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(
              () => r({ done: true, value: undefined }),
              Math.max(0, deadline - Date.now()),
            ),
          ),
        ]);
        if (chunk.value === undefined) {
          if (Date.now() > deadline) return undefined;
          continue;
        }
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    }

    try {
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      });
      rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

      const listMsg = await until((m) => m["id"] === 2, 30_000);
      expect(listMsg).toBeDefined();
      const tools = (listMsg?.["result"] as { tools?: Array<{ name: string }> } | undefined)?.tools;
      expect(tools?.length).toBeGreaterThan(0);
      const toolName = tools?.[0]?.name ?? "";

      rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: toolName, arguments: { message: "read the file" } },
      });
      const callMsg = await until((m) => m["id"] === 3, 45_000);

      // The daemon answered rather than dying, and the park is reported to the
      // CALLER as a tool error naming the approval.
      expect(callMsg).toBeDefined();
      const result = callMsg?.["result"] as { isError?: boolean } | undefined;
      expect(result?.isError).toBe(true);
      expect(JSON.stringify(callMsg)).toContain("appr_");

      // …and it is persisted where `crewhaus approvals grant` will find it.
      const listed = await runCli(["approvals", "list", "--json"], root);
      const records = JSON.parse(listed.stdout) as Array<{ toolName: string }>;
      expect(records.some((r) => r.toolName === "Read")).toBe(true);
    } finally {
      await reader.cancel().catch(() => {});
      proc.kill();
    }
  }, 120_000);
});
