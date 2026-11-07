/**
 * A registry row outside the workspace, through the real chat loop, under a
 * rule that allows `HarnessRegister` without asking.
 *
 * The permission rule and the tool's own check are separate decisions, so this
 * drives both: the loop allows the call and the tool answers it. What the row
 * then does is read from the real start path, `createPrepareRunner`. The
 * moved-harness case is the control: the same call reaches the registry when
 * the row's old directory is gone, so the refusal below is the tool's and not a
 * call that never ran.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHangarRegistry } from "../packages/harness-registry/src/index";
import { createPrepareRunner, createProcessOps } from "../packages/harness-supervisor/src/index";
import { createRunContext } from "../packages/run-context/src/index";
import { runChatLoop } from "../packages/runtime-core/src/index";
import { harnessRegister } from "../packages/tool-fleet/src/index";

const RAN_HERE = "ran-here";
const originalCwd = process.cwd();
const originalRoot = process.env["CREWHAUS_REGISTRY_ROOT"];
let base: string;
let registryRoot: string;
let operatorDir: string;
let workspace: string;
let otherDir: string;

/** A harness directory whose preSpawn hook records where it ran. */
function hookedHarness(dir: string, name: string): void {
  mkdirSync(join(dir, ".crewhaus"), { recursive: true });
  writeFileSync(join(dir, "crewhaus.yaml"), `name: ${name}\ntarget: cli\n`);
  writeFileSync(
    join(dir, ".crewhaus", "settings.json"),
    JSON.stringify({ manager: { hooks: { preSpawn: ["sh", "-c", `pwd > ${RAN_HERE}`] } } }),
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-harness-rows-")));
  registryRoot = join(base, "registry");
  operatorDir = join(base, "operator", "bot");
  workspace = join(base, "workspace");
  otherDir = join(workspace, "other");
  hookedHarness(operatorDir, "operator-bot");
  hookedHarness(otherDir, "other");
  process.env["CREWHAUS_REGISTRY_ROOT"] = registryRoot;
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalRoot === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_REGISTRY_ROOT");
  else process.env["CREWHAUS_REGISTRY_ROOT"] = originalRoot;
  rmSync(base, { recursive: true, force: true });
});

/** The text of the last tool result in a model request. */
function lastToolResult(request: unknown): string {
  const { messages } = request as { messages: { content: unknown }[] };
  const blocks = messages.at(-1)?.content as { type: string; content: unknown }[];
  const result = blocks.findLast((block) => block.type === "tool_result");
  return String(result?.content);
}

/** A model that makes one tool call, then ends its turn. */
function scriptedModel(input: unknown, onResult: (text: string) => void): unknown {
  let turn = 0;
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
    stream: (request: unknown) => {
      const first = turn === 0;
      turn += 1;
      if (!first) onResult(lastToolResult(request));
      return (async function* () {
        yield { kind: "message_start" };
        if (first) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "tu_1", name: "HarnessRegister", input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
          };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          };
        }
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: first ? "tool_use" : "end_turn" };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** The call through the real loop; returns what the rules decided and the tool answered. */
async function throughTheLoop(
  input: unknown,
): Promise<{ decided: string | undefined; answer: string }> {
  const runContext = createRunContext({ mode: "headless", cwd: workspace } as never);
  const decisions: string[] = [];
  let answer = "";
  runContext.eventBus.subscribe((event: { kind: string; toolName?: string; decision?: string }) => {
    if (event.kind === "permission_decision" && event.toolName === "HarnessRegister") {
      decisions.push(String(event.decision));
    }
  });
  await runChatLoop({
    model: "test",
    instructions: "x",
    runContext,
    sessionRootDir: join(base, "sessions"),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: "default",
    permissionRules: {
      flag: [],
      cli: [],
      yaml: [{ type: "alwaysAllow", pattern: "HarnessRegister", source: "yaml" }],
      settings: [],
      hooks: [],
      builtin: [],
    },
    tools: [harnessRegister],
    _adapter: scriptedModel(input, (text) => {
      answer = text;
    }),
  } as never);
  return { decided: decisions[0], answer };
}

function operatorRow(): string {
  const registry = openHangarRegistry({ root: registryRoot });
  const { id } = registry.upsert({
    dir: operatorDir,
    specName: "operator-bot",
    target: "cli",
    origin: "manual",
    originDetail: "operator",
  });
  registry.setGroups(id, ["core"]);
  return id;
}

/** The operator's next start of `id`, as far as the prepare step. */
async function preSpawnFor(id: string): Promise<string> {
  const dir = openHangarRegistry({ root: registryRoot }).get(id)?.dir ?? "";
  const runner = createPrepareRunner({
    harnessDir: dir,
    target: "cli",
    ops: createProcessOps(),
    env: { ...process.env },
    crewhausBin: "crewhaus",
    compile: false,
  });
  const outcome = await runner.preSpawn();
  expect(outcome.ok).toBe(true);
  return dir;
}

const registryBytes = (): Buffer => readFileSync(join(registryRoot, "harnesses.json"));
const ranIn = (dir: string): string => readFileSync(join(dir, RAN_HERE), "utf8").trim();

// A chat loop and a spawned hook, on a loaded CI runner.
const BUDGET_MS = 20_000;

test(
  "a live row outside the workspace stays where it is, and its next start runs there",
  async () => {
    const id = operatorRow();
    const before = registryBytes();

    const { decided } = await throughTheLoop({
      action: "relocate",
      id,
      dir: "other",
      dryRun: false,
    });
    expect(decided).toBe("allow");
    expect(registryBytes().equals(before)).toBe(true);

    expect(await preSpawnFor(id)).toBe(operatorDir);
    expect(ranIn(operatorDir)).toBe(operatorDir);
    expect(existsSync(join(otherDir, RAN_HERE))).toBe(false);
  },
  BUDGET_MS,
);

test(
  "the row and its groups stay through a removal call too",
  async () => {
    const id = operatorRow();
    const before = registryBytes();

    const { decided } = await throughTheLoop({ action: "remove", id, dryRun: false });
    expect(decided).toBe("allow");
    expect(registryBytes().equals(before)).toBe(true);
    expect(openHangarRegistry({ root: registryRoot }).get(id)?.groups).toEqual(["core"]);
  },
  BUDGET_MS,
);

test(
  "a row whose directory is gone relocates under the same call",
  async () => {
    const id = operatorRow();
    rmSync(operatorDir, { recursive: true, force: true });

    const { decided, answer } = await throughTheLoop({
      action: "relocate",
      id,
      dir: "other",
      dryRun: false,
    });
    expect(decided).toBe("allow");
    expect(JSON.parse(answer).status).toBe("applied");

    const rows = openHangarRegistry({ root: registryRoot }).list();
    expect(rows.map((row) => row.id)).toEqual([id]);
    expect(rows[0]?.dir).toBe(otherDir);
  },
  BUDGET_MS,
);
