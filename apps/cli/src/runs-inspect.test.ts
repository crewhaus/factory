/**
 * `crewhaus runs inspect` over records the real writers wrote: a run that parked on an
 * approval which then expired, and a run whose tool returned a harness credential and
 * terminal control sequences. The output names the trigger, the tool and the
 * approval's outcomes; nothing it prints carries the credential or a control
 * character; and it writes nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { mintRunId } from "@crewhaus/control-contract";
import { createRunContext } from "@crewhaus/run-context";
import { createPendingApprovalStore, runChatLoop } from "@crewhaus/runtime-core";
import { expireOpenApprovals } from "@crewhaus/session-store";
import { REDACTED_VALUE } from "@crewhaus/spec-patch";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { runRunsCommand } from "./runs-cmd";
import { SHOWN_MAX, maskedView } from "./runs-inspect";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Built from parts so no credential-shaped literal is committed.
const SECRET_VALUE = ["inspect", "fixture", "value", "4d2a9c"].join("-");
// A second harness env value, of letters that appear nowhere else in the output, so a
// test can look for any piece of it.
const EDGE_VALUE = ["Qv7", "kW9m", "Pq2R", "v8Lx4T"].join("");
/** What the token-shape masker leaves in a token's place (`MASKED_TOKEN`, not exported). */
const MASKED_TOKEN = "***";

const LOOP = {
  model: "test-model",
  instructions: "inspect test",
  singleTurn: true,
  seedMessages: [{ role: "user" as const, content: "go" }],
  installSigintHandler: false,
  spinner: false,
  stdout: () => {},
  settingsDir: null,
} as const;

/** A model that calls `tool` once, then answers in text. */
function scriptedAdapter(tool: string, input: unknown = { x: 1 }): ProviderAdapter {
  let calls = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: () => {
      calls += 1;
      const first = calls === 1;
      return (async function* () {
        yield { kind: "message_start" } as const;
        if (first) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "tu_1", name: tool, input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
          } as const;
        } else {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "all done" },
          } as const;
        }
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: first ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

function harness(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-runs-inspect-")));
  made.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), "name: inspect-fixture\ntarget: cli\n");
  writeFileSync(join(dir, ".env"), `SERVICE_PASSWORD=${SECRET_VALUE}\nEDGE_SECRET=${EDGE_VALUE}\n`);
  return dir;
}

/** Every path under `root` with its size and mtime. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stats = statSync(path);
      out.push(`${relative(root, path)} ${stats.size} ${stats.mtimeMs}`);
      if (stats.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out.sort();
}

const env = (dir: string) => ({
  CREWHAUS_HANGAR_ROOT: join(dir, "..", "no-hangar"),
  CREWHAUS_REGISTRY_ROOT: join(dir, "..", "no-registry"),
  CREWHAUS_NO_REGISTRY: "1",
});

describe("crewhaus runs inspect", () => {
  test("a run parked on an approval that later expired: the trigger, the tool, and parked then expired", async () => {
    const dir = harness();
    const sessions = join(dir, ".crewhaus", "sessions");
    const store = createPendingApprovalStore({ rootDir: sessions });
    const danger = buildTool({
      name: "danger",
      description: "must be approved",
      inputSchema: z.object({ x: z.number() }).strict(),
      readOnly: false,
      destructive: false,
      concurrencySafe: false,
      execute: async () => "did it",
    });
    const context = createRunContext();
    await runChatLoop({
      ...LOOP,
      runContext: context,
      sessionRootDir: sessions,
      runLedgerDir: dir,
      permissionMode: "default",
      tools: [danger],
      approvals: { store },
      _adapter: scriptedAdapter("danger"),
    }).catch((err: unknown) => {
      expect((err as { report?: { class?: string } }).report?.class).toBe("approval_pending");
    });
    const expired = await expireOpenApprovals(sessions, {
      reason: "retired",
      now: () => new Date(),
    });
    expect(expired.expired.length).toBe(1);

    const before = tree(dir);
    const out = await runRunsCommand(["inspect", context.runId], { cwd: dir, env: env(dir) });
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("Started from the command line");
    // The run waited on the approval; once it expired, the run reads failed.
    expect(text).toContain("Failed (approval_expired)");
    expect(text).toContain("Used danger: parked");
    expect(text).toContain("Approval: parked");
    expect(text).toContain("Approval expired");
    expect(text).toContain('What was asked   "go"');
    expect(text).toContain("Asked for approval once; it expired later.");

    // Why, for the parked call: its checks read parked, then expired.
    const toolLine = out.lines.find((line) => line.includes("why: tool:"));
    const action = toolLine?.match(/why: (tool:[0-9a-f]{16})/)?.[1];
    expect(action).toBeDefined();
    const why = await runRunsCommand(["inspect", context.runId, "--why", action as string], {
      cwd: dir,
      env: env(dir),
    });
    expect(why.exitCode).toBe(0);
    expect(why.lines.join("\n")).toContain("approval: parked, then expired");
    expect(why.lines.join("\n")).toContain(
      "This shows the record, not the model's private reasoning.",
    );

    // --json parses, and is the view object.
    const json = await runRunsCommand(["inspect", context.runId, "--json"], {
      cwd: dir,
      env: env(dir),
    });
    const parsed = JSON.parse(json.lines.join("\n")) as {
      summary: { subject: { run: string } };
      timeline: { entries: Array<{ kind: string; title: string }> };
    };
    expect(parsed.summary.subject.run).toBe(context.runId);
    expect(parsed.timeline.entries.map((e) => e.title)).toContain("Approval expired");

    // By session id, the same run.
    const bySession = await runRunsCommand(["inspect", context.sessionId], {
      cwd: dir,
      env: env(dir),
    });
    expect(bySession.lines.join("\n")).toContain(`Run ${context.runId}`);

    // Refusals exit by their code, and name what helps.
    const bad = await runRunsCommand(["inspect", context.runId, "--why", "tool:nothex"], {
      cwd: dir,
      env: env(dir),
    });
    expect(bad.exitCode).toBe(55);
    const missingStep = await runRunsCommand(
      ["inspect", context.runId, "--why", "tool:00000000000000ff"],
      { cwd: dir, env: env(dir) },
    );
    expect(missingStep.exitCode).toBe(56);
    const unknown = await runRunsCommand(["inspect", mintRunId()], { cwd: dir, env: env(dir) });
    expect(unknown.exitCode).toBe(56);
    expect(unknown.lines.join("\n")).toContain("try: crewhaus runs inspect");
    const both = await runRunsCommand(
      ["inspect", context.runId, "--timeline", "full", "--context", "1"],
      { cwd: dir, env: env(dir) },
    );
    expect(both.exitCode).toBe(55);
    const badRef = await runRunsCommand(["inspect", "nope"], { cwd: dir, env: env(dir) });
    expect(badRef.exitCode).toBe(55);
    const context1 = await runRunsCommand(["inspect", context.runId, "--context", "1"], {
      cwd: dir,
      env: env(dir),
    });
    expect(context1.exitCode).toBe(0);
    expect(context1.lines.join("\n")).toContain("Context for model call 1");

    // It wrote nothing.
    expect(tree(dir)).toEqual(before);
  }, 20_000); // a parked run, an expiry and eight inspections over real files

  test("a tool result holding a harness credential and control sequences prints scrubbed and inert, in text and JSON", async () => {
    const dir = harness();
    const sessions = join(dir, ".crewhaus", "sessions");
    const leaky = buildTool({
      name: "leaky",
      description: "returns hostile text",
      inputSchema: z.object({ x: z.number() }).strict(),
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      execute: async () => `value=${SECRET_VALUE} \u001b]0;x\u0007 title \u009b2J end`,
    });
    const context = createRunContext();
    await runChatLoop({
      ...LOOP,
      runContext: context,
      sessionRootDir: sessions,
      runLedgerDir: dir,
      permissionMode: "bypass",
      tools: [leaky],
      _adapter: scriptedAdapter("leaky"),
    });
    const before = tree(dir);
    for (const argv of [
      ["inspect", context.runId],
      ["inspect", context.runId, "--timeline", "full"],
      ["inspect", context.runId, "--json"],
      ["inspect", context.runId, "--timeline", "full", "--json"],
    ]) {
      const out = await runRunsCommand(argv, { cwd: dir, env: env(dir) });
      expect([argv.join(" "), out.exitCode]).toEqual([argv.join(" "), 0]);
      const text = out.lines.join("\n");
      expect(text).toContain("Used leaky");
      expect(text).toContain("SERVICE_PASSWORD");
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u009b");
      expect(text).not.toContain("\u0007");
      if (argv.includes("--json")) {
        // Taken out before masking, so not even escaped.
        expect(text).not.toContain("\\u009b");
        expect(text).not.toContain("\\u001b");
        expect(() => JSON.parse(text)).not.toThrow();
      }
    }
    // The tool's Why prints its result the same way.
    const full = await runRunsCommand(["inspect", context.runId, "--timeline", "full"], {
      cwd: dir,
      env: env(dir),
    });
    const action = full.lines.join("\n").match(/why: (tool:[0-9a-f]{16})/)?.[1];
    const why = await runRunsCommand(["inspect", context.runId, "--why", action as string], {
      cwd: dir,
      env: env(dir),
    });
    const whyText = why.lines.join("\n");
    expect(whyText).toContain("Result");
    expect(whyText).not.toContain(SECRET_VALUE);
    expect(whyText).not.toContain("\u001b");
    expect(tree(dir)).toEqual(before);
  }, 20_000); // a full run and six inspections over real files
  test("content is masked before it is cut short: a secret across the cut, a token shape and a credential-named input field never print", async () => {
    const dir = harness();
    const sessions = join(dir, ".crewhaus", "sessions");
    const password = ["pw", "short", "7q1"].join("-");
    const bearer = "q".repeat(24);
    // One harness env value across the 2000th character, one across the last one shown,
    // and a token shape that is in no env file.
    const head = `${"y".repeat(1990)}${EDGE_VALUE} Bearer ${bearer} `;
    const result = `${head}${"z".repeat(SHOWN_MAX - 6 - head.length)}${EDGE_VALUE} end`;
    const probe = buildTool({
      name: "probe",
      description: "returns long text",
      inputSchema: z.object({ x: z.number(), password: z.string(), body: z.string() }).strict(),
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      execute: async () => result,
    });
    const context = createRunContext();
    await runChatLoop({
      ...LOOP,
      runContext: context,
      sessionRootDir: sessions,
      runLedgerDir: dir,
      permissionMode: "bypass",
      tools: [probe],
      // Long enough that its JSON is longer than anything shown whole.
      _adapter: scriptedAdapter("probe", { x: 1, password, body: "b".repeat(SHOWN_MAX + 1000) }),
    });
    const run = (argv: readonly string[]) =>
      runRunsCommand(["inspect", context.runId, ...argv], { cwd: dir, env: env(dir) });
    const full = await run(["--timeline", "full"]);
    const action = full.lines.join("\n").match(/why: (tool:[0-9a-f]{16})/)?.[1];
    expect(action).toBeDefined();
    const pieces = Array.from({ length: EDGE_VALUE.length - 4 }, (_, i) =>
      EDGE_VALUE.slice(0, i + 5),
    );
    const outputs = new Map<string, string>();
    for (const argv of [
      [],
      ["--json"],
      ["--timeline", "full"],
      ["--timeline", "full", "--json"],
      ["--why", action as string],
      ["--why", action as string, "--json"],
    ]) {
      const out = await run(argv);
      expect([argv.join(" "), out.exitCode]).toEqual([argv.join(" "), 0]);
      const text = out.lines.join("\n");
      outputs.set(argv.join(" "), text);
      const leaked = pieces.filter((piece) => text.includes(piece));
      expect([argv.join(" "), leaked]).toEqual([argv.join(" "), []]);
      expect(text).not.toContain(bearer);
      expect(text).not.toContain(password);
    }
    // In JSON both copies of the env value are named, and the token shape is masked.
    const timeline = JSON.parse(outputs.get("--timeline full --json") as string) as {
      entries: Array<{ title: string; detail?: string }>;
    };
    const detail = timeline.entries.find((e) => e.title.startsWith("Used probe"))?.detail ?? "";
    expect(detail.split("EDGE_SECRET").length - 1).toBe(2);
    expect(detail).toContain(`Bearer ${MASKED_TOKEN}`);
    // The Why keeps the input an object, so its credential-named field is replaced, and
    // its long body is cut only after masking.
    const why = JSON.parse(outputs.get(`--why ${action} --json`) as string) as {
      did: { value: { input: { password: string; body: string } } };
    };
    expect(why.did.value.input.password).toBe(REDACTED_VALUE);
    expect(why.did.value.input.body).toBe(`${"b".repeat(SHOWN_MAX)}…`);
  }, 20_000); // a full run and seven inspections over real files

  test("a credential split by a control character, and a short one inside a JSON tool result, never print whole", async () => {
    const dir = harness();
    const sessions = join(dir, ".crewhaus", "sessions");
    const split = `${SECRET_VALUE.slice(0, 9)}\u0007${SECRET_VALUE.slice(9)}`;
    const password = ["pw", "7q1"].join("-");
    const apiKey = ["k", "ab9"].join("");
    const body = JSON.stringify({ password, api_key: apiKey, note: "fine" });
    const tool = buildTool({
      name: "splitter",
      description: "returns a split value and a JSON body",
      inputSchema: z.object({ x: z.number() }).strict(),
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      execute: async () => `value=${split} body=${body}`,
    });
    const jsonTool = buildTool({
      name: "jsonbody",
      description: "returns a JSON body",
      inputSchema: z.object({ x: z.number() }).strict(),
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      execute: async () => body,
    });
    for (const [one, name] of [
      [tool, "splitter"],
      [jsonTool, "jsonbody"],
    ] as const) {
      const context = createRunContext();
      await runChatLoop({
        ...LOOP,
        runContext: context,
        sessionRootDir: sessions,
        runLedgerDir: dir,
        permissionMode: "bypass",
        tools: [one],
        _adapter: scriptedAdapter(name),
      });
      for (const argv of [
        ["inspect", context.runId, "--timeline", "full"],
        ["inspect", context.runId, "--timeline", "full", "--json"],
      ]) {
        const out = await runRunsCommand(argv, { cwd: dir, env: env(dir) });
        expect([argv.join(" "), out.exitCode]).toEqual([argv.join(" "), 0]);
        const text = out.lines.join("\n");
        expect(text).toContain(`Used ${name}`);
        expect(text).not.toContain(SECRET_VALUE);
        expect(text).not.toContain(SECRET_VALUE.slice(9));
        if (name === "jsonbody") {
          expect(text).not.toContain(password);
          expect(text).not.toContain(apiKey);
          expect(text).toContain("fine");
        }
      }
    }
  }, 20_000); // two full runs and four inspections over real files

  test("an operator wake's reason holding a newline and a direction override prints on one line", async () => {
    const dir = harness();
    const sessions = join(dir, ".crewhaus", "sessions");
    const session = "sess_00000000000000b7";
    const run = mintRunId();
    const at = Date.parse("2026-11-14T12:00:00.000Z");
    const line = (kind: string, payload: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ ts: at, version: 1, kind, payload, ...extra });
    const root = "0000000000000101";
    const log = [
      line("user_message", {
        content: "wake",
        synthetic: true,
        control: {
          lane: "heartbeat",
          synthetic: true,
          reason: "first\nsecond \u202Ethird",
          by: "max",
        },
      }),
      line(
        "run_stamp",
        { v: 1, run, trigger: { kind: "heartbeat", lane: "heartbeat", synthetic: true } },
        { run, span: root },
      ),
      line("user_message", { content: "check the queue" }, { run, span: root }),
    ];
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `${session}.jsonl`), `${log.join("\n")}\n`);
    for (const argv of [
      ["inspect", session],
      ["inspect", session, "--timeline", "full"],
    ]) {
      const out = await runRunsCommand(argv, { cwd: dir, env: env(dir) });
      expect([argv.join(" "), out.exitCode]).toEqual([argv.join(" "), 0]);
      const printed = out.lines.flatMap((l) => l.split("\n"));
      const hits = printed.filter((l) => l.includes("third"));
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit).toContain("first second third");
      expect(out.lines.join("\n")).not.toContain("\u202E");
    }
  }, 20_000); // two inspections over real files
});

describe("maskedView", () => {
  test("a value under a credential's key name, a token shape and a harness env value are each hidden", () => {
    const dir = harness();
    // In no env file and shaped like no token: only its key name gives it away.
    const keyed = ["kv", "short", "77q"].join("-");
    const slack = `${"xox"}${"b-"}${"1234567890"}-abcdefghij`;
    const view = {
      did: { input: { apiToken: keyed, nested: [{ password: keyed }], url: "https://x.test" } },
      detail: `got ${slack} and ${SECRET_VALUE}`,
    };
    const masked = maskedView(view, dir) as {
      did: { input: { apiToken: string; nested: Array<{ password: string }>; url: string } };
      detail: string;
    };
    expect(masked.did.input.apiToken).toBe(REDACTED_VALUE);
    expect(masked.did.input.nested[0]?.password).toBe(REDACTED_VALUE);
    expect(masked.did.input.url).toBe("https://x.test");
    expect(masked.detail).toContain(MASKED_TOKEN);
    expect(masked.detail).toContain("SERVICE_PASSWORD");
    const text = JSON.stringify(masked);
    for (const raw of [keyed, slack, SECRET_VALUE]) expect(text).not.toContain(raw);
  });
});
