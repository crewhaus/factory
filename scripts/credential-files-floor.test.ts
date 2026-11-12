/**
 * On a `channel` or `managed` run, a tool call that names a credential file is
 * denied, whatever a rule says: a file named `.env`, `.env.<name>` or `.npmrc`
 * in any directory, a file `manager.envFiles` declares, and the names
 * `credentialFileRoots` lists. Held here through `runChatLoop` with a scripted
 * model and the real tools, from these sides:
 *
 * - the table: each way a call names a file, on both shapes, with a rule that
 *   allows the tool, and on a run with no target and on `cli`, where nothing
 *   moves;
 * - the loops a run starts: a real sub-agent, a nested loop, and two runs at
 *   once, each deciding its own;
 * - `StateExport`, `Grep`, `IndexSearch`, `GitAdd`, `GitStashPush`, `GitDiff` and
 *   `GitShow`, which leave those files out, and `GitApplyPatch` and `StateImport`,
 *   which refuse an input that names one;
 * - the names themselves, against the code that writes them.
 *
 * Values are built at runtime: nothing here is shaped like a real credential.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderAdapter } from "../packages/adapter-anthropic/src/index";
import { CONTROL_TOKEN_NAME, RUN_DIR_SEGMENTS } from "../packages/harness-supervisor/src/types";
import type { IrChannelV0, IrManagedV0 } from "../packages/ir/src/index";
import {
  type RuleSet,
  emptyRuleSet,
  evaluateWithReason,
} from "../packages/permission-engine/src/index";
import { createRunContext } from "../packages/run-context/src/index";
import { runChatLoop } from "../packages/runtime-core/src/index";
import { placeRecordingCanonicalizer } from "../packages/runtime-core/src/path-canonical";
import {
  credentialFileRoots,
  credentialFloorScope,
} from "../packages/runtime-core/src/state-roots";
import { spawnSubAgent } from "../packages/sub-agent-spawner/src/index";
import { emitChannelBot } from "../packages/target-channel-bot/src/index";
import { emitManaged } from "../packages/target-managed/src/index";
import type { RegisteredTool } from "../packages/tool-catalog/src/index";
import { datasetPut } from "../packages/tool-dataset/src/index";
import { pdfMerge } from "../packages/tool-docs/src/index";
import { operativeValuesOf } from "../packages/tool-executor/src/index";
import { grep, read, write } from "../packages/tool-fs/src/index";
import {
  archiveCreate,
  archiveList,
  concatFiles,
  copyPath,
  fileHash,
  frontmatterRead,
  notebookRead,
  readLines,
  stat,
  tailFile,
  tree,
} from "../packages/tool-fsx/src/index";
import {
  gitAdd,
  gitApplyPatch,
  gitBlame,
  gitDiff,
  gitShow,
  gitStashPush,
} from "../packages/tool-git/src/index";
import { invoiceRender } from "../packages/tool-ledger/src/index";
import { exifStrip } from "../packages/tool-media/src/index";
import { createMemoryTools } from "../packages/tool-memory/src/index";
import { emailCompose, emailSend } from "../packages/tool-notify/src/index";
import { waitForFile } from "../packages/tool-proc/src/index";
import { envFileUpsert, secretLookup, secretRotate } from "../packages/tool-secrets/src/index";
import { redactForExport } from "../packages/tool-secure/src/index";
import { importCsv } from "../packages/tool-sql/src/index";
import {
  indexBuild,
  indexSearch,
  stateExport,
  stateImport,
} from "../packages/tool-state/src/index";
import { createTaskTool } from "../packages/tool-task/src/index";
import { goldenCompare } from "../packages/tool-verify/src/index";

const ROOT = dirname(import.meta.dir);
/** What each held file carries, so a result that holds it is plain to see. */
const SENTINEL = ["held", "back", "3f9c"].join("-");
const REASON = "names a credential file this run keeps from its tools — no rule can allow that";

const HELD_TARGETS = ["channel", "managed"] as const;
const OTHER_TARGETS = [undefined, "cli"] as const;
type Target = (typeof HELD_TARGETS)[number] | (typeof OTHER_TARGETS)[number];

/** The files a call must not name on a held run. */
const HELD_FILES = [
  ".env",
  ".env.local",
  ".env.staging",
  "sub/.env",
  ".npmrc",
  ".crewhaus/secrets/api",
  ".crewhaus/identity.json",
  ".crewhaus/run/control-token",
  ".crewhaus/run/mcp-token",
  ".crewhaus/run/gateway-jwt-secret",
  ".crewhaus/run/logs/child.log",
  ".crewhaus/run/control/keys/lease",
];
/** Neighbours a call names freely. */
const OPEN_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  "notes.md",
  ".crewhaus/run/daemon.json",
  ".crewhaus/tool-results/part-1.txt",
];

let originalCwd: string;
let ws: string;
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), body);
}

beforeEach(() => {
  originalCwd = process.cwd();
  ws = tempDir("crewhaus-credential-floor-");
  for (const file of HELD_FILES) put(file, `K=${SENTINEL}\n`);
  for (const file of OPEN_FILES) put(file, "K=placeholder\n");
  symlinkSync(join(ws, ".env"), join(ws, "linked-env"));
  process.chdir(ws);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };
type Seen = Array<ReadonlyArray<{ readonly content: unknown }>>;

/**
 * A model that plays `scripts` in order, and the requests it was sent (`seen`).
 * `before` runs ahead of each reply, so two loops can be held at one point.
 */
function scriptedAdapter(
  scripts: ReadonlyArray<ReadonlyArray<Block>>,
  seen: Seen,
  before?: () => Promise<void>,
): ProviderAdapter {
  let i = 0;
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
    stream: (req) => {
      seen.push(req.messages as ReadonlyArray<{ readonly content: unknown }>);
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      const hasToolUse = content.some((b) => b.type === "tool_use");
      i++;
      return (async function* () {
        await before?.();
        yield { kind: "message_start" } as const;
        for (const [index, block] of content.entries()) {
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
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
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
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  } as ProviderAdapter;
}

/** The last tool_result the model was handed. */
function lastToolResult(seen: Seen): string | undefined {
  let found: string | undefined;
  for (const messages of seen) {
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as Array<{ type?: string; content?: unknown }>) {
        if (block.type !== "tool_result") continue;
        found = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      }
    }
  }
  return found;
}

/** Runs git in the workspace with a fixed identity, for a fixture a tool then reads. */
function repository(args: readonly string[]): string {
  const ran = Bun.spawnSync(
    ["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args],
    { cwd: ws, env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  );
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  return ran.stdout.toString();
}

/** A rule that allows each named tool, so a denial here is no rule's doing. */
const allowing = (...names: readonly string[]): RuleSet => ({
  ...emptyRuleSet,
  yaml: names.map((pattern) => ({
    type: "alwaysAllow" as const,
    pattern,
    source: "yaml" as const,
  })),
});

type Call = { readonly name: string; readonly input: Record<string, unknown> };
type Turn = { readonly decision?: string; readonly reason?: string; readonly result?: string };

/** One model turn that makes `call` on a run of `target`: the gate's decision, and what came back. */
async function turn(
  call: Call,
  tools: RegisteredTool[],
  target: Target,
  before?: () => Promise<void>,
): Promise<Turn> {
  const runContext = createRunContext();
  const events: Array<{ kind: string; toolName?: string; decision?: string; reason?: string }> = [];
  runContext.eventBus.subscribe((e) => events.push(e as (typeof events)[number]));
  const seen: Seen = [];
  await runChatLoop({
    model: "test-model",
    instructions: "credential files",
    runContext,
    sessionRootDir: tempDir("crewhaus-credential-sessions-"),
    // These checks compare the workspace before and after a call: the run's
    // own records would land in it, so this loop writes none.
    runLedgerDir: null,
    ...(target !== undefined ? { sessionTarget: target } : {}),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: "auto",
    permissionRules: allowing(call.name),
    tools,
    _adapter: scriptedAdapter(
      [
        [{ type: "tool_use", id: "tu_1", name: call.name, input: call.input }],
        [{ type: "text", text: "done" }],
      ],
      seen,
      before,
    ),
  });
  const first = events.find((e) => e.kind === "permission_decision" && e.toolName === call.name);
  const result = lastToolResult(seen);
  return {
    ...(first?.decision !== undefined ? { decision: first.decision } : {}),
    ...(first?.reason !== undefined ? { reason: first.reason } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

/** A real tool's shape with no declared fields, as an MCP or plugin tool has. */
function undeclaredTool(name: string, execute: (text: string) => Promise<string>): RegisteredTool {
  const { remember } = createMemoryTools({ specName: "floor", rootDir: tempDir("crewhaus-mem-") });
  const { operativeArgs: _declared, ...undeclared } = remember;
  return {
    ...undeclared,
    name,
    readOnly: true,
    destructive: false,
    execute: async (input: unknown) => execute((input as { readonly text: string }).text),
  } as RegisteredTool;
}

type Row = {
  readonly label: string;
  readonly tool: () => RegisteredTool;
  readonly input: Record<string, unknown>;
  /** Does more than read when allowed, so only a held run names it here. */
  readonly heldOnly?: boolean;
};

const MAIL = {
  from: { address: "ops@example.test" },
  to: [{ address: "team@example.test" }],
  subject: "notes",
  text: "see attached",
  date: "2026-11-07T00:00:00Z",
};

const ROWS: readonly Row[] = [
  // Declares the path it reads, or a field it only reads from.
  { label: "Grep path", tool: () => grep, input: { pattern: "K", path: ".env" } },
  {
    label: "GoldenCompare actualFile",
    tool: () => goldenCompare,
    input: { actualFile: ".env", golden: "notes.md" },
  },
  { label: "GitShow path", tool: () => gitShow, input: { ref: "HEAD", path: ".env" } },
  { label: "GitBlame path", tool: () => gitBlame, input: { path: ".env" } },
  {
    label: "CopyPath source",
    tool: () => copyPath,
    input: { source: ".env", destination: "copy.txt" },
  },
  {
    label: "ConcatFiles paths",
    tool: () => concatFiles,
    input: { paths: [".env"], destination: "joined.txt" },
  },
  {
    label: "ArchiveCreate source",
    tool: () => archiveCreate,
    input: { source: ".env", output: "out.tar" },
  },
  { label: "ExifStrip path", tool: () => exifStrip, input: { path: ".env", output: "out.jpg" } },
  {
    label: "ImportCsv file",
    tool: () => importCsv,
    input: { database: "out.sqlite", file: ".env", table: "t" },
  },
  {
    label: "PdfMerge inputs.path",
    tool: () => pdfMerge,
    input: { inputs: [{ path: ".env" }], output: "out.pdf" },
  },
  { label: "IndexBuild paths", tool: () => indexBuild, input: { name: "i", paths: [".env"] } },
  { label: "DatasetPut path", tool: () => datasetPut, input: { name: "d", path: ".env" } },
  // An attachment is read and sent with the message.
  {
    label: "EmailSend attachments.path",
    tool: () => emailSend,
    input: { ...MAIL, host: "smtp.example.test", attachments: [{ path: ".env" }] },
    heldOnly: true,
  },
  // A secret reference names the file it opens.
  {
    label: "EnvFileUpsert entries.valueFrom",
    tool: () => envFileUpsert,
    input: { path: "deploy.conf", entries: [{ key: "K", valueFrom: "envfile:.env#K" }] },
    heldOnly: true,
  },
  {
    label: "SecretRotate newValueFrom",
    tool: () => secretRotate,
    input: { ref: "envfile:deploy.conf#K", newValueFrom: "envfile:.env#K" },
    heldOnly: true,
  },
  { label: "SecretLookup refs", tool: () => secretLookup, input: { refs: ["envfile:.env#K"] } },
  // Declares nothing: the strings it carries are read as written.
  { label: "ReadLines", tool: () => readLines, input: { path: ".env" } },
  { label: "TailFile", tool: () => tailFile, input: { path: ".env" } },
  { label: "FileHash", tool: () => fileHash, input: { path: ".env" } },
  { label: "Stat", tool: () => stat, input: { path: ".env" } },
  { label: "WaitForFile", tool: () => waitForFile, input: { path: ".env", timeoutMs: 1 } },
  { label: "ArchiveList", tool: () => archiveList, input: { path: ".env" } },
  { label: "FrontmatterRead", tool: () => frontmatterRead, input: { path: ".env" } },
  { label: "NotebookRead", tool: () => notebookRead, input: { path: ".env" } },
  { label: "RedactForExport", tool: () => redactForExport, input: { path: ".env" } },
  {
    label: "EmailCompose",
    tool: () => emailCompose,
    input: { ...MAIL, attachments: [{ path: ".env" }] },
  },
  // A directory that holds a root.
  { label: "Grep on .crewhaus", tool: () => grep, input: { pattern: "K", path: ".crewhaus" } },
  { label: "Tree on .crewhaus", tool: () => tree, input: { path: ".crewhaus" } },
  { label: "StateExport on .crewhaus", tool: () => stateExport, input: { stateDir: ".crewhaus" } },
  // An MCP or plugin tool: strings as written.
  {
    label: "a tool that declares nothing",
    tool: () =>
      undeclaredTool("get_file_contents", async (text) => readFileSync(join(ws, text), "utf8")),
    input: { text: "sub/.env" },
  },
];

/** What a table asserts of one denied call. */
const refused = (t: Turn) => ({
  decision: t.decision,
  reason: t.reason?.includes(REASON) === true,
  sentinelInResult: t.result?.includes(SENTINEL) === true,
});
const REFUSED = { decision: "deny", reason: true, sentinelInResult: false };

for (const target of HELD_TARGETS) {
  describe(`on a ${target} run`, () => {
    test("Read of a held file, however the call spells it, is denied", async () => {
      for (const path of [
        "./.env",
        `${ws}/.env`,
        "sub/../.env",
        "linked-env",
        ".ENV",
        ...HELD_FILES,
      ]) {
        const t = await turn({ name: "Read", input: { path } }, [read], target);
        expect({ path, ...refused(t) }).toEqual({ path, ...REFUSED });
      }
    }, 20_000); // one full loop per spelling

    test("Read of a neighbour goes on, and hands the file back", async () => {
      for (const path of OPEN_FILES) {
        const t = await turn({ name: "Read", input: { path } }, [read], target);
        expect({ path, decision: t.decision }).toEqual({ path, decision: "allow" });
        expect(t.result).toContain(path === ".crewhaus/run/daemon.json" ? "K=" : "placeholder");
      }
    }, 20_000); // one full loop per file

    test("each way a call names a file is denied, with a rule allowing the tool", async () => {
      for (const row of ROWS) {
        const tool = row.tool();
        const t = await turn({ name: tool.name, input: row.input }, [tool], target);
        expect({ row: row.label, ...refused(t) }).toEqual({ row: row.label, ...REFUSED });
      }
    }, 20_000); // one full loop per row

    test("a secret reference that reads a held file is refused, by name or by variable", async () => {
      for (const ref of ["API_KEY", "env:API_KEY"]) {
        const t = await turn(
          { name: "SecretLookup", input: { refs: [ref] } },
          [secretLookup],
          target,
        );
        expect({ ref, ...refused(t) }).toEqual({ ref, ...REFUSED });
      }
    });

    test("a write to a held name is denied, and the write floor's reason stays first", async () => {
      const nested = await turn(
        { name: "Write", input: { path: "sub/.env", content: "x" } },
        [write],
        target,
      );
      expect(refused(nested)).toEqual(REFUSED);
      expect(readFileSync(join(ws, "sub", ".env"), "utf8")).toContain(SENTINEL);
      const top = await turn(
        { name: "Write", input: { path: ".env", content: "x" } },
        [write],
        target,
      );
      expect(top.decision).toBe("deny");
      expect(top.reason).toContain("is not read-only and names a path where");
      expect(readFileSync(join(ws, ".env"), "utf8")).toContain(SENTINEL);
    });

    test("a file manager.envFiles declares is held wherever it is named", async () => {
      put("config/app.conf", `K=${SENTINEL}\n`);
      put(
        ".crewhaus/settings.json",
        JSON.stringify({ manager: { envFiles: ["config/app.conf"] } }),
      );
      const t = await turn({ name: "Read", input: { path: "config/app.conf" } }, [read], target);
      expect(refused(t)).toEqual(REFUSED);
    });

    test("a tool that declares `[]` carries text, read-only or not", async () => {
      for (const readOnly of [true, false]) {
        const base = undeclaredTool("TodoNote", async () => "ran");
        const tool: RegisteredTool = { ...base, operativeArgs: [], readOnly };
        const t = await turn(
          { name: tool.name, input: { text: "update deploy/.env" } },
          [tool],
          target,
        );
        expect({ readOnly, decision: t.decision, result: t.result }).toEqual({
          readOnly,
          decision: "allow",
          result: "ran",
        });
      }
    });

    test("a sentence that names a file goes on", async () => {
      const tool = undeclaredTool("get_file_contents", async () => "ran");
      for (const text of [
        "the project keeps its region in .env for now",
        ".env.local is where the region goes",
        "see config/.env: it holds the region",
      ]) {
        const t = await turn({ name: tool.name, input: { text } }, [tool], target);
        expect({ text, decision: t.decision }).toEqual({ text, decision: "allow" });
      }
    });

    test("Grep at the top of the workspace leaves out a listed file with a visible name", async () => {
      put("config/prod.secrets", `K=${SENTINEL}\n`);
      put("prod.env", `K=${SENTINEL}\n`);
      put(
        ".crewhaus/settings.json",
        JSON.stringify({ manager: { envFiles: ["config/prod.secrets", "prod.env"] } }),
      );
      const spellings = [undefined, ".", "./", "sub/..", ".crewhaus/..", ws];
      for (const at of spellings) {
        const input = { pattern: "K=", ...(at !== undefined ? { path: at } : {}) };
        const t = await turn({ name: "Grep", input }, [grep], target);
        expect({ at, decision: t.decision }).toEqual({ at, decision: "allow" });
        expect(t.result).toContain("notes.md");
        expect(t.result).toContain("left out");
        expect(t.result).not.toContain(SENTINEL);
      }
    });

    test("IndexSearch gives no snippet of a held file a stored index names", async () => {
      put("visible.txt", `K=${SENTINEL}\n`);
      await turn(
        { name: "IndexBuild", input: { name: "x", paths: ["visible.txt"] } },
        [indexBuild],
        target,
      );
      const dir = join(ws, ".crewhaus", "state", "indexes");
      const file = join(dir, readdirSync(dir)[0] ?? "");
      const stored = readFileSync(file, "utf8");
      const search = () =>
        turn(
          {
            name: "IndexSearch",
            input: { name: "x", query: SENTINEL.split("-")[2] ?? "", snippetChars: 2000 },
          },
          [indexSearch],
          target,
        );
      // As built, the hit quotes its line, so the row below can tell.
      expect((await search()).result).toContain(SENTINEL);
      for (const held of HELD_FILES) {
        writeFileSync(file, stored.replaceAll("visible.txt", held));
        const t = await search();
        expect({ held, decision: t.decision }).toEqual({ held, decision: "allow" });
        expect(t.result).toContain('"file":"missing"');
        expect(t.result).not.toContain(SENTINEL);
      }
    }, 20_000); // one full loop per file

    test("StateImport refuses a document that names a held file, whole", async () => {
      for (const entry of [
        ".crewhaus/secrets/api",
        ".crewhaus/identity.json",
        "sub/.env",
        ".env.staging",
      ]) {
        const t = await turn(
          {
            name: "StateImport",
            input: {
              stateDir: ".",
              document: {
                version: 1,
                files: [
                  { path: "fine.txt", encoding: "utf8", content: "x" },
                  { path: entry, encoding: "utf8", content: "x" },
                ],
              },
            },
          },
          [stateImport],
          target,
        );
        expect(t.result).toContain("names a credential file");
        expect(readFileSync(join(ws, entry), "utf8")).toContain(SENTINEL);
        expect(existsSync(join(ws, "fine.txt"))).toBe(false);
      }
    });

    describe("in a git repository", () => {
      beforeEach(() => {
        put("sub/.npmrc", `K=${SENTINEL}\n`);
        put("visible.txt", "shown\n");
        repository(["init", "-q", "."]);
        repository(["add", "--", "notes.md"]);
        repository(["commit", "-q", "-m", "first"]);
      });

      const copyOf = (from: string, to: string, kind: "copy" | "rename"): string =>
        [
          `diff --git a/${from} b/${to}`,
          "similarity index 100%",
          `${kind} from ${from}`,
          `${kind} to ${to}`,
          "",
        ].join("\n");
      const linkTo = (target: string): string =>
        [
          "diff --git a/pub b/pub",
          "new file mode 120000",
          "--- /dev/null",
          "+++ b/pub",
          "@@ -0,0 +1 @@",
          `+${target}`,
          "\\ No newline at end of file",
          "",
        ].join("\n");
      const applying = (patch: string) =>
        turn({ name: "GitApplyPatch", input: { patch } }, [gitApplyPatch], target);

      test("GitApplyPatch refuses a copy or a rename that names a held file", async () => {
        for (const from of [
          ".crewhaus/secrets/api",
          ".crewhaus/identity.json",
          "sub/.env",
          ".env.staging",
          "sub/.npmrc",
        ]) {
          for (const kind of ["copy", "rename"] as const) {
            const t = await applying(copyOf(from, "copied.txt", kind));
            expect({ from, kind, refused: t.result?.includes("names a credential file") }).toEqual({
              from,
              kind,
              refused: true,
            });
            expect(existsSync(join(ws, "copied.txt"))).toBe(false);
            expect(readFileSync(join(ws, from), "utf8")).toContain(SENTINEL);
          }
        }
        const open = await applying(copyOf("notes.md", "copied.txt", "copy"));
        expect(open.result).toContain('"applied":true');
        expect(existsSync(join(ws, "copied.txt"))).toBe(true);
      }, 20_000); // one full loop per row

      test("GitApplyPatch refuses a link that leads to a held file or a directory holding one", async () => {
        for (const to of [".crewhaus/run", ".crewhaus", ".", "sub/.env", ".crewhaus/secrets/api"]) {
          const t = await applying(linkTo(to));
          expect({ to, refused: t.result?.includes("names a credential file") }).toEqual({
            to,
            refused: true,
          });
          expect(() => lstatSync(join(ws, "pub"))).toThrow();
        }
        const open = await applying(linkTo("notes.md"));
        expect(open.result).toContain('"applied":true');
        expect(lstatSync(join(ws, "pub")).isSymbolicLink()).toBe(true);
      });

      test("GitAdd leaves the held files out, and GitDiff shows the rest", async () => {
        const added = await turn({ name: "GitAdd", input: { paths: ["."] } }, [gitAdd], target);
        expect(added.result).toContain("stagedFiles");
        const t = await turn(
          { name: "GitDiff", input: { staged: true, mode: "patch" } },
          [gitDiff],
          target,
        );
        expect(t.result).toContain("visible.txt");
        expect(t.result).toContain(".env.example");
        expect(t.result).not.toContain(SENTINEL);
        const named = repository(["ls-files", "--cached"]).split("\n");
        expect(HELD_FILES.filter((file) => named.includes(file))).toEqual([]);
        expect(named).toContain(".env.example");
      });

      test("GitAdd takes a file the bullet calls fine, by name", async () => {
        const t = await turn(
          { name: "GitAdd", input: { paths: [".env.example"] } },
          [gitAdd],
          target,
        );
        expect(t.result).toContain('"stagedFiles":1');
      });

      test("GitStashPush leaves the held files where they are", async () => {
        // The run's own files beside them, and a link to one, are on the
        // runtime-state floor, and a stash that takes one is refused, so git is
        // told to leave them be.
        writeFileSync(
          join(ws, ".git", "info", "exclude"),
          ".crewhaus/run/daemon.json\n.crewhaus/tool-results/\nlinked-env\n",
        );
        const t = await turn(
          { name: "GitStashPush", input: { includeUntracked: true, message: "parked" } },
          [gitStashPush],
          target,
        );
        expect(t.result).toContain('"pushed":true');
        const shown = await turn(
          { name: "GitShow", input: { ref: "stash@{0}^3" } },
          [gitShow],
          target,
        );
        expect(shown.result).toContain("visible.txt");
        expect(shown.result).not.toContain(SENTINEL);
        for (const file of HELD_FILES) {
          expect(readFileSync(join(ws, file), "utf8")).toContain(SENTINEL);
        }
        expect(existsSync(join(ws, "visible.txt"))).toBe(false);
      });

      test("GitDiff and GitShow leave out a held file a commit carries", async () => {
        repository(["add", "-f", "--", "visible.txt", ".env", "sub/.env", ".crewhaus/secrets/api"]);
        repository(["commit", "-q", "-m", "second"]);
        for (const call of [
          { name: "GitShow", input: { ref: "HEAD" }, tool: gitShow },
          { name: "GitDiff", input: { ref: "HEAD~1", mode: "patch" }, tool: gitDiff },
        ]) {
          const t = await turn({ name: call.name, input: call.input }, [call.tool], target);
          expect({ call: call.name, shown: t.result?.includes("visible.txt") }).toEqual({
            call: call.name,
            shown: true,
          });
          expect(t.result).not.toContain(SENTINEL);
        }
        for (const ref of ["HEAD:.env", "HEAD:sub/.env", "HEAD:.crewhaus/secrets/api"]) {
          const t = await turn({ name: "GitShow", input: { ref } }, [gitShow], target);
          expect({ ref, shown: t.result?.includes(SENTINEL) }).toEqual({ ref, shown: false });
        }
      });
    });
  });
}

for (const target of OTHER_TARGETS) {
  describe(`on a run with ${target === undefined ? "no target" : "the cli target"}`, () => {
    test("on this target the rules decide a Read of the same names", async () => {
      for (const path of ["./.env", `${ws}/.env`, "sub/../.env", "linked-env", ...HELD_FILES]) {
        const t = await turn({ name: "Read", input: { path } }, [read], target);
        expect({ path, decision: t.decision }).toEqual({ path, decision: "allow" });
      }
    }, 20_000); // one full loop per spelling

    test("the same calls are the rules' to decide", async () => {
      for (const row of ROWS.filter((candidate) => candidate.heldOnly !== true)) {
        const tool = row.tool();
        const t = await turn({ name: tool.name, input: row.input }, [tool], target);
        expect({ row: row.label, decision: t.decision }).toEqual({
          row: row.label,
          decision: "allow",
        });
      }
    }, 20_000); // one full loop per row
  });
}

describe("a call the engine reads from the tool's real declaration", () => {
  const { canonicalizePath } = placeRecordingCanonicalizer();
  const call = (tool: RegisteredTool, input: Record<string, unknown>) => ({
    toolName: tool.name,
    input,
    operativeValues:
      operativeValuesOf(tool.operativeArgs, input, { canonicalizePath }) ?? ([] as const),
    floorValues: [],
    readOnly: tool.readOnly,
    destructive: tool.destructive,
  });

  test("an attachment: denied with the option, the rules' without it", () => {
    const attached = call(emailSend, {
      ...MAIL,
      host: "smtp.example.test",
      attachments: [{ path: ".env" }],
    });
    const held = evaluateWithReason(attached, "auto", emptyRuleSet, {
      credentialRoots: credentialFileRoots(),
    });
    expect(held.decision).toBe("deny");
    expect(held.reason).toContain(REASON);
    expect(evaluateWithReason(attached, "auto", emptyRuleSet, {}).decision).toBe("ask");
  });

  test("a template a render reads", () => {
    const rendered = call(invoiceRender, { templateFile: ".env" });
    const held = evaluateWithReason(rendered, "auto", emptyRuleSet, {
      credentialRoots: credentialFileRoots(),
    });
    expect(held.decision).toBe("deny");
    expect(held.reason).toContain(REASON);
  });
});

describe("the loops a run starts", () => {
  const TASK_INPUT = { description: "look", prompt: "read it", subagent_type: "planner" };
  /** A parent of `target` whose planner, on a replace-mode `allow: [Read]`, reads `path`. */
  const parentWithPlanner = async (target: Target, path: string): Promise<Turn> => {
    const def = {
      name: "planner",
      description: "plans",
      instructions: "plan",
      tools: ["Read"],
      permissions: { allow: ["Read"], deny: [] },
    };
    const subAgents = new Map([[def.name, def]]);
    const childSeen: Seen = [];
    const childClient = scriptedAdapter(
      [
        [{ type: "tool_use", id: "tu_child", name: "Read", input: { path } }],
        [{ type: "text", text: "child done" }],
      ],
      childSeen,
    );
    const parentSeen: Seen = [];
    await runChatLoop({
      model: "test-model",
      instructions: "delegate",
      runContext: createRunContext(),
      sessionRootDir: tempDir("crewhaus-credential-sessions-"),
      runLedgerDir: null,
      ...(target !== undefined ? { sessionTarget: target } : {}),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "auto",
      permissionRules: allowing("Task", "Read"),
      tools: [createTaskTool({ subAgents }), read],
      subAgents,
      spawnSubAgent: (parent, opts) => spawnSubAgent(parent, { ...opts, _client: childClient }),
      _adapter: scriptedAdapter(
        [
          [{ type: "tool_use", id: "tu_task", name: "Task", input: TASK_INPUT }],
          [{ type: "text", text: "done" }],
        ],
        parentSeen,
      ),
    });
    const result = lastToolResult(childSeen);
    return result !== undefined ? { result } : {};
  };

  for (const target of HELD_TARGETS) {
    test(`a real sub-agent of a ${target} run is held to the same files`, async () => {
      const denied = await parentWithPlanner(target, ".env");
      expect(denied.result).toContain(REASON);
      expect(denied.result).not.toContain(SENTINEL);
      const open = await parentWithPlanner(target, "notes.md");
      expect(open.result).toContain("placeholder");
    });
  }

  for (const target of OTHER_TARGETS) {
    test(`on target ${String(target)} the rules decide for a real sub-agent`, async () => {
      const decided = await parentWithPlanner(target, ".env");
      expect(decided.result).not.toContain(REASON);
    });
  }

  /** A tool that starts a loop of its own, as a consult or a committee does, with no target. */
  const nesting = (results: Turn[]): RegisteredTool =>
    undeclaredTool("ConsultNote", async () => {
      results.push(await turn({ name: "Read", input: { path: ".env" } }, [read], undefined));
      return "ran";
    });

  for (const target of HELD_TARGETS) {
    test(`a nested loop under a ${target} run keeps the scope`, async () => {
      const results: Turn[] = [];
      const outer = await turn(
        { name: "ConsultNote", input: { text: "weigh in" } },
        [nesting(results)],
        target,
      );
      expect(outer.result).toBe("ran");
      expect(results.length).toBe(1);
      expect(refused(results[0] ?? {})).toEqual(REFUSED);
    });
  }

  test("a nested loop under a run with no target is left to its rules", async () => {
    const results: Turn[] = [];
    await turn({ name: "ConsultNote", input: { text: "weigh in" } }, [nesting(results)], undefined);
    expect(results.length).toBe(1);
    expect(results[0]?.decision).toBe("allow");
  });

  /** Two parties wait here until both have come, so neither loop is done before the other starts. */
  const meeting = (): (() => Promise<void>) => {
    let arrived = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived >= 2) open();
      await gate;
    };
  };

  for (const order of [
    ["channel", "cli"],
    ["cli", "channel"],
    ["managed", undefined],
    [undefined, "managed"],
  ] as const) {
    test(`two runs at once decide their own: ${String(order[0])} and ${String(order[1])}`, async () => {
      const meet = meeting();
      const results = await Promise.all(
        order.map((target) =>
          turn({ name: "Read", input: { path: ".env" } }, [read], target, meet),
        ),
      );
      for (const [i, target] of order.entries()) {
        const t = results[i] ?? {};
        const held = target === "channel" || target === "managed";
        expect({ target, decision: t.decision }).toEqual({
          target,
          decision: held ? "deny" : "allow",
        });
        if (held) expect(t.result?.includes(SENTINEL)).toBe(false);
      }
      expect(credentialFloorScope.getStore()).toBeUndefined();
    });
  }
});

describe("StateExport", () => {
  const exportAt = async (target: Target) => {
    const t = await turn({ name: "StateExport", input: { stateDir: "." } }, [stateExport], target);
    expect(t.decision).toBe("allow");
    return { raw: t.result ?? "", doc: JSON.parse(t.result ?? "{}") };
  };

  for (const target of HELD_TARGETS) {
    test(`on a ${target} run its document leaves the held files out and counts them`, async () => {
      const { raw, doc } = await exportAt(target);
      expect(raw).not.toContain(SENTINEL);
      expect(doc.heldBack).toBe(HELD_FILES.length);
      const paths = doc.files.map((file: { path: string }) => file.path);
      expect(paths).toContain("notes.md");
      expect(paths).toContain(".env.example");
      expect(paths).toContain(".crewhaus/run/daemon.json");
      for (const file of HELD_FILES) expect(paths).not.toContain(file);
    });
  }

  for (const target of OTHER_TARGETS) {
    test(`no heldBack key on target ${String(target)}`, async () => {
      const { doc } = await exportAt(target);
      expect("heldBack" in doc).toBe(false);
    });
  }
});

describe("the names, against the code that writes them", () => {
  test("the control token's file, by the name the supervisor gives it", () => {
    expect(credentialFileRoots(ws)).toContain(join(...RUN_DIR_SEGMENTS, CONTROL_TOKEN_NAME));
    expect(join(...RUN_DIR_SEGMENTS)).toBe(join(".crewhaus", "run"));
  });

  test("the channel daemon's MCP token, by the path it writes", () => {
    const channel: IrChannelV0 = {
      version: 0,
      name: "guard",
      target: "channel",
      agent: { model: "claude-sonnet-4-6", instructions: "Answer." },
      tools: [],
      toolConfigs: {},
      channels: {
        slack: {
          botToken: { kind: "env", name: "SLACK_BOT_TOKEN" },
          signingSecret: { kind: "env", name: "SLACK_SIGNING_SECRET" },
        },
      },
      routing: { sessionKey: "thread" },
      mcp_servers: {},
      permissions: { rules: [] },
      subAgents: [],
      compaction: {},
      expose: { mcp: { transport: "sse", tools: "chat" } },
    };
    const daemon = emitChannelBot(channel).files.find((file) => file.path === "daemon.ts");
    expect(daemon?.content ?? "").toContain("/.crewhaus/run");
    expect(daemon?.content ?? "").toContain("/mcp-token");
    expect(credentialFileRoots(ws)).toContain(join(".crewhaus", "run", "mcp-token"));
  });

  test("the managed daemon's signing secret, by the path it writes", () => {
    const managed: IrManagedV0 = {
      version: 0,
      name: "guard",
      target: "managed",
      agent: { model: "claude-sonnet-4-6", instructions: "Answer." },
      tenants: [{ id: "tenant-a", budget: { maxInputTokens: 1, maxOutputTokens: 1 } }],
      permissions: { rules: [] },
      compaction: {},
    };
    const daemon = emitManaged(managed, { readme: false }).files.find(
      (file) => file.path === "daemon.ts",
    );
    expect(daemon?.content ?? "").toContain(".crewhaus/run/gateway-jwt-secret");
    expect(credentialFileRoots(ws)).toContain(join(".crewhaus", "run", "gateway-jwt-secret"));
  });

  test("both gates in runChatLoop hand the engine the option, and the bridge carries it", () => {
    const source = readFileSync(join(ROOT, "packages", "runtime-core", "src", "index.ts"), "utf8");
    const PASSED = "...(credentialRoots !== undefined ? { credentialRoots } : {})";
    const calls = [...source.matchAll(/\bevaluateWithReason\(/g)].map((match) => {
      const start = match.index ?? 0;
      let depth = 0;
      for (let at = start; at < source.length; at += 1) {
        if (source[at] === "(") depth += 1;
        if (source[at] === ")" && --depth === 0) return source.slice(start, at + 1);
      }
      return "";
    });
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toContain(PASSED);
    const bridge = source.slice(source.indexOf("const bridge: RuntimeBridge = {"));
    expect(bridge.slice(0, bridge.indexOf("permissionMode,"))).toContain(PASSED);
  });
});
