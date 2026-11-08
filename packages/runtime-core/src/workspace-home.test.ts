/**
 * The `[workspace]` start line: a run whose working directory holds the home
 * directory says so once per process on stderr. A daemon's per-message loops
 * pass the same call, so the second run below stands for its second message.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderFeatures,
  ProviderId,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "./index";
import { __resetToolLimitReportsForTests } from "./tool-limit";

const FEATURES: ProviderFeatures = {
  caching: false,
  tool_use: true,
  vision: false,
  thinking: false,
  web_search: false,
};

function adapter(): ProviderAdapter {
  return {
    providerId: "openai" as ProviderId,
    features: FEATURES,
    estimateTokens: () => 0,
    stream(): AsyncIterable<StreamEvent> {
      return (async function* () {
        yield { kind: "message_start", usage: { input: 1, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "done" },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** One single-turn run; what it wrote on stderr. */
async function run(): Promise<string> {
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await runChatLoop({
      model: "openai/gpt-5",
      _adapter: adapter(),
      tools: [],
      instructions: "workspace test",
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
      permissionMode: "bypass",
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
    });
    return stderr.join("");
  } finally {
    process.stderr.write = write;
  }
}

const workspaceLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.startsWith("[workspace] "));

describe("the [workspace] start line", () => {
  const startCwd = process.cwd();
  const startHome = process.env["HOME"];
  const startSessions = process.env["CREWHAUS_SESSION_DIR"];
  let base = "";

  beforeEach(() => {
    __resetToolLimitReportsForTests();
    base = mkdtempSync(join(tmpdir(), "crewhaus-workspace-home-"));
    process.env["CREWHAUS_SESSION_DIR"] = join(base, "sessions");
    // `os.homedir()` ignores this assignment here, so the env candidate fires.
    process.env["HOME"] = base;
  });

  afterEach(() => {
    process.chdir(startCwd);
    if (startHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env["HOME"] = startHome;
    if (startSessions === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
    else process.env["CREWHAUS_SESSION_DIR"] = startSessions;
    rmSync(base, { recursive: true, force: true });
    __resetToolLimitReportsForTests();
  });

  test("a run in a directory holding the home directory prints one line across two runs", async () => {
    process.chdir(base);
    const first = await run();
    const second = await run();
    const lines = workspaceLines(first + second);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("holds your home directory");
    expect(lines[0]).toContain("a directory of its own");
    expect(workspaceLines(second)).toEqual([]);
  });

  test("a run in a directory of its own, under the home directory, prints none", async () => {
    const harness = join(base, "harness");
    mkdirSync(harness);
    process.chdir(harness);
    expect(workspaceLines(await run())).toEqual([]);
  });
});
