/**
 * The egress check against what real tools print: a value on a `NAME=value`
 * line is found in Grep's `path:line:` form, in a patch, in a file read at a
 * ref and in JSON, in one run and across a resume. And a state tool and a patch
 * refuse a write or a link that resolves into a run's own record. Real tools,
 * `runChatLoop`, a scripted adapter; no network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import { grep as grepTool, read as readTool } from "@crewhaus/tool-fs";
import { gitApplyPatch, gitDiff, gitShow } from "@crewhaus/tool-git";
import { journalAppend } from "@crewhaus/tool-state";
import { z } from "zod";

// Secret-shaped values are built from parts at runtime.
const GREP_VALUE = `${"gh"}${"p_"}${"a1B2c3D4".repeat(4)}`;
const DIFF_VALUE = `${"gh"}${"p_"}${"e5F6g7H8".repeat(4)}`;
const SHOW_VALUE = `${"gh"}${"p_"}${"i9J0k1L2".repeat(4)}`;
const FILE_VALUE = `${"gh"}${"p_"}${"m3N4o5P6".repeat(4)}`;
const COMMENT_VALUE = `${"sk_"}${"live_"}${"q7R8s9T0".repeat(3)}`;
const JSON_VALUE = `${"gh"}${"p_"}${"u1V2w3X4".repeat(4)}`;

const originalCwd = process.cwd();
let workspace: string;
let sessions: string;

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    cwd: workspace,
    stdio: "ignore",
  });
}

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-lineage-tools-")));
  sessions = join(workspace, ".crewhaus", "sessions");
  mkdirSync(sessions, { recursive: true });
  process.chdir(workspace);
  git("init", "-q");
  writeFileSync(join(workspace, ".gitignore"), ".crewhaus/\n");
  writeFileSync(join(workspace, "grep.conf"), `DEBUG=1\nGREP_PAT=${GREP_VALUE}\n`);
  writeFileSync(join(workspace, "commented.conf"), `#OLD_STRIPE=${COMMENT_VALUE}\n`);
  writeFileSync(join(workspace, "minified.json"), `{"JSON_PAT":"${JSON_VALUE}"}`);
  writeFileSync(join(workspace, "show.conf"), `DEBUG=1\nSHOW_PAT=${SHOW_VALUE}\n`);
  writeFileSync(join(workspace, "file.conf"), `DEBUG=1\nFILE_PAT=${FILE_VALUE}\n`);
  writeFileSync(join(workspace, "diff.conf"), "DEBUG=1\n");
  git("add", ".");
  git("commit", "-qm", "first");
  writeFileSync(join(workspace, "diff.conf"), `DEBUG=1\nDIFF_PAT=${DIFF_VALUE}\n`);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

function scripted(steps: ReadonlyArray<ReadonlyArray<Block>>): {
  adapter: ProviderAdapter;
  requests: unknown[];
} {
  const requests: unknown[] = [];
  let call = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req) {
      requests.push(JSON.parse(JSON.stringify(req.messages)));
      const blocks = steps[Math.min(call, steps.length - 1)] ?? [];
      call += 1;
      const at = call;
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (const [index, block] of blocks.entries()) {
          if (block.type === "text") {
            yield {
              kind: "content_block_start",
              index,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index,
              delta: { type: "text_delta", text: block.text },
            } as const;
          } else {
            yield {
              kind: "content_block_start",
              index,
              block: { type: "tool_use", id: `tu_${at}_${index}`, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            } as const;
          }
          yield { kind: "content_block_stop", index } as const;
        }
        yield {
          kind: "message_delta",
          stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
  return { adapter, requests };
}

const DONE: Block = { type: "text", text: "done" };
const use = (name: string, input: unknown): Block => ({ type: "tool_use", name, input });

const reads: ReadonlyArray<{
  readonly name: string;
  readonly call: Block;
  readonly value: string;
}> = [
  {
    name: "Grep's path:line: form",
    call: use("Grep", { pattern: "GREP_PAT", path: "." }),
    value: GREP_VALUE,
  },
  {
    name: "GitDiff's patch",
    call: use("GitDiff", { cwd: ".", mode: "patch" }),
    value: DIFF_VALUE,
  },
  {
    name: "GitShow's patch",
    call: use("GitShow", { cwd: "." }),
    value: SHOW_VALUE,
  },
  {
    name: "GitShow's file at a ref",
    call: use("GitShow", { cwd: ".", path: "file.conf" }),
    value: FILE_VALUE,
  },
  {
    name: "Read of a commented-out line",
    call: use("Read", { path: "commented.conf" }),
    value: COMMENT_VALUE,
  },
  {
    name: "Read of minified JSON",
    call: use("Read", { path: "minified.json" }),
    value: JSON_VALUE,
  },
];

function run(
  sends: string[],
  steps: ReadonlyArray<ReadonlyArray<Block>>,
  resume?: string,
): { promise: Promise<string>; sessionId: string; requests: unknown[] } {
  const send = buildTool({
    name: "Fetch",
    description: "sends text out",
    inputSchema: z.object({ body: z.string() }),
    scope: "external",
    execute: async (input: { body: string }) => {
      sends.push(input.body);
      return "sent";
    },
  });
  const { adapter, requests } = scripted(steps);
  const runContext = createRunContext(resume !== undefined ? { sessionId: resume } : {});
  const promise = runChatLoop({
    model: "test-model",
    instructions: "t",
    _adapter: adapter,
    runContext,
    tools: [readTool, grepTool, gitDiff, gitShow, gitApplyPatch, journalAppend, send],
    sessionRootDir: sessions,
    singleTurn: true,
    ...(resume !== undefined ? { resume: { sessionId: resume } } : {}),
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: "bypass",
    settingsDir: null,
    installSigintHandler: false,
    spinner: false,
    stdout: () => {},
  });
  return { promise, sessionId: runContext.sessionId, requests };
}

describe("a value on a NAME=value line, as a real tool prints it", () => {
  for (const { name, call, value } of reads) {
    test(`${name}: a send of the value in the same run is refused`, async () => {
      const sends: string[] = [];
      const done = run(sends, [[call], [use("Fetch", { body: value })], [DONE]]);
      await done.promise;
      expect(sends).toEqual([]);
      expect(JSON.stringify(done.requests.at(-1))).toContain("[egress denied]");
      expect(JSON.stringify(done.requests[1])).toContain(value);
    });

    test(`${name}: a send of the value after a resume is refused`, async () => {
      const sends: string[] = [];
      const first = run(sends, [[call], [DONE]]);
      await first.promise;
      const second = run(
        sends,
        [[use("Fetch", { body: `the value: ${value}` })], [DONE]],
        first.sessionId,
      );
      await second.promise;
      expect(sends).toEqual([]);
      expect(JSON.stringify(second.requests.at(-1))).toContain("[egress denied]");
    });
  }

  test("control: a value no tool read goes out", async () => {
    const sends: string[] = [];
    const never = `${"gh"}${"p_"}${"y5Z6a7B8".repeat(4)}`;
    await run(sends, [[use("Fetch", { body: never })], [DONE]]).promise;
    expect(sends).toEqual([never]);
  });
});

describe("a run's own record, against the tools that write under a directory", () => {
  const REFUSED = "where the runtime keeps its own record";

  async function logOf(): Promise<{ sessionId: string; path: string; bytes: string }> {
    const first = run([], [[DONE]]);
    await first.promise;
    const path = join(sessions, `${first.sessionId}.jsonl`);
    return { sessionId: first.sessionId, path, bytes: readFileSync(path, "utf8") };
  }

  test("GitApplyPatch refuses a link into it, through runChatLoop", async () => {
    const patch = [
      "diff --git a/.crewhaus/journal b/.crewhaus/journal",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/.crewhaus/journal",
      "@@ -0,0 +1 @@",
      "+sessions",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const done = run([], [[use("GitApplyPatch", { cwd: ".", patch })], [DONE]]);
    await done.promise;
    expect(JSON.stringify(done.requests.at(-1))).toContain(REFUSED);
    expect(existsSync(join(workspace, ".crewhaus", "journal"))).toBe(false);
  });

  test("JournalAppend refuses a stream that resolves into it, through runChatLoop", async () => {
    const earlier = await logOf();
    const link = join(workspace, ".crewhaus", "journal");
    symlinkSync("sessions", link);
    try {
      const done = run(
        [],
        [
          [
            use("JournalAppend", {
              stream: earlier.sessionId,
              kind: "sub_agent_start",
              entry: { a: 1 },
              stateDir: ".crewhaus",
            }),
          ],
          [DONE],
        ],
      );
      await done.promise;
      expect(JSON.stringify(done.requests.at(-1))).toContain(REFUSED);
      expect(readFileSync(earlier.path, "utf8")).toBe(earlier.bytes);
    } finally {
      rmSync(link);
    }
  });

  test("control: JournalAppend writes to its own stream", async () => {
    const done = run(
      [],
      [
        [use("JournalAppend", { stream: "runs", entry: { a: 1 }, stateDir: ".crewhaus/state" })],
        [DONE],
      ],
    );
    await done.promise;
    expect(JSON.stringify(done.requests.at(-1))).not.toContain(REFUSED);
    expect(existsSync(join(workspace, ".crewhaus", "state", "journal", "runs.jsonl"))).toBe(true);
  });
});
