/**
 * Where an API request's free text can reach a model, every operation says so
 * (`modelBound`), and what it says holds.
 *
 * - A static walk: every operation whose request has a free-text field (a string after
 *   unwrapping optional, default and nullable, checked by length only) declares that
 *   field, and a planted undeclared field is caught.
 * - Every declaration that a field reaches a model at an origin is driven with a canary
 *   through Home's real handler and the run's real entry: the canary is classified at the
 *   declared origin before the turn runs (a managed daemon's follower) or before the first
 *   model call (a cli job's seed check).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoundaryResult, classifyBoundary } from "@crewhaus/boundary-classifier";
import { OPERATIONS, type OperationRow } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { controlPaths } from "@crewhaus/control-records";
import {
  _setManagedClassifierForTest,
  createManagedRuns,
} from "@crewhaus/gateway-server/managed-runs";
import {
  _resetInputOriginForTest,
  _setInputOriginClassifierForTest,
  runChatLoop,
} from "@crewhaus/runtime-core";
import { type V1Home, v1Home } from "../__test__/v1-home";

/** A zod schema as this walk reads it: by its type name, so this suite imports no zod. */
type Node = {
  readonly _def: {
    readonly typeName?: string;
    readonly innerType?: Node;
    readonly schema?: Node;
    readonly checks?: readonly { readonly kind: string }[];
    readonly options?: readonly Node[];
  };
  readonly shape?: Readonly<Record<string, Node>>;
};

function unwrap(node: Node): Node {
  let t = node;
  for (;;) {
    const name = t._def.typeName;
    const inner = t._def.innerType;
    if (
      (name === "ZodOptional" || name === "ZodNullable" || name === "ZodDefault") &&
      inner !== undefined
    ) {
      t = inner;
    } else {
      return t;
    }
  }
}

/** A string checked by length only: no refine, regex, enum or format. */
function isFreeText(t: Node): boolean {
  if (t._def.typeName !== "ZodString") return false;
  return (t._def.checks ?? []).every((check) => ["min", "max", "length"].includes(check.kind));
}

function objectsOf(schema: Node | undefined): Node[] {
  if (schema === undefined) return [];
  const t = unwrap(schema);
  const name = t._def.typeName;
  if (name === "ZodEffects" && t._def.schema !== undefined) return objectsOf(t._def.schema);
  if (name === "ZodObject") return [t];
  if (name === "ZodUnion" || name === "ZodDiscriminatedUnion") {
    return [...(t._def.options ?? [])].flatMap(objectsOf);
  }
  return [];
}

/** Each operation's free-text request fields that it does not declare. */
function undeclared(rows: readonly OperationRow[]): {
  readonly checked: number;
  readonly missing: string[];
} {
  let checked = 0;
  const missing: string[] = [];
  for (const op of rows) {
    const fields = new Set<string>();
    for (const object of objectsOf(SCHEMAS[op.request] as unknown as Node | undefined)) {
      // A ZodObject's shape is a getter on its definition.
      const shape = (object as unknown as { shape: Readonly<Record<string, Node>> }).shape;
      for (const [name, field] of Object.entries(shape)) {
        if (isFreeText(unwrap(field))) fields.add(name);
      }
    }
    if (fields.size > 0) checked += 1;
    for (const field of fields) {
      if (op.modelBound?.[field] === undefined) missing.push(`${op.id}.${field}`);
    }
  }
  return { checked, missing };
}

describe("every free-text request field says whether it reaches a model", () => {
  test("the walk finds every such row, and each declares every such field", () => {
    const walked = undeclared(OPERATIONS);
    expect(walked.missing).toEqual([]);
    expect(walked.checked).toBe(15);
  });

  test("a planted undeclared field is caught", () => {
    const create = OPERATIONS.find((op) => op.id === "runs.create") as OperationRow;
    const { input: _gone, ...rest } = create.modelBound ?? {};
    expect(undeclared([{ ...create, modelBound: rest }]).missing).toEqual(["runs.create.input"]);
    expect(undeclared([{ ...create, modelBound: undefined } as OperationRow]).missing).toEqual([
      "runs.create.input",
      "runs.create.subject",
    ]);
  });

  test("the only fields that reach a model are the run input, at api on the run's entry", () => {
    const bound = OPERATIONS.flatMap((op) =>
      Object.entries(op.modelBound ?? {})
        .filter(([, decl]) => "origin" in decl)
        .map(([field, decl]) => `${op.id}.${field} ${JSON.stringify(decl)}`),
    );
    expect(bound).toEqual([`runs.create.input {"origin":"api","at":"run-entry"}`]);
  });
});

describe("the canary: a run's input is classified at api before it reaches a model", () => {
  let home: V1Home;
  const scratch: string[] = [];
  beforeAll(async () => {
    home = await v1Home();
  }, 60_000);
  afterAll(async () => {
    _setManagedClassifierForTest(undefined);
    _resetInputOriginForTest();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    await home?.t.stop();
  });

  /** A benign canary, unique per test, so a sighting is this test's own. */
  const canaryOf = () => `canary ${crypto.randomUUID()} please summarise`;

  test("a managed run queued through Home: its follower classifies it before the turn", async () => {
    const canary = canaryOf();
    const h = await home.harness("canary-managed", { target: "managed" });
    // A build that follows queued runs (compiled with 0.9.0 or later).
    mkdirSync(join(h.dir, "dist"), { recursive: true });
    writeFileSync(join(h.dir, "dist", "daemon.ts"), "// bundle\n");
    writeFileSync(
      join(h.dir, "dist", "package.json"),
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: "x", compiledWith: "0.9.0" },
      }),
    );
    const res = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: canary, admission: "queue" },
    });
    expect(res.status).toBe(202);
    const order: string[] = [];
    _setManagedClassifierForTest(async (text, opts): Promise<BoundaryResult> => {
      if (text === canary) order.push(`classified ${opts?.origin}`);
      return classifyBoundary(text, opts);
    });
    const tenantsRoot = mkdtempSync(join(tmpdir(), "canary-tenants-"));
    scratch.push(tenantsRoot);
    const runs = createManagedRuns({
      harnessDir: h.dir,
      tenantsRoot,
      getAuditLog: async () =>
        ({ append: async () => undefined, read: async function* () {} }) as never,
      recordUsage: async () => undefined,
      executeTurn: async ({ input }) => {
        order.push(input === canary ? "turn" : "other turn");
        return { reply: "done" };
      },
      env: {},
      log: () => undefined,
    });
    await runs.claimQueued();
    runs.stop();
    expect(order).toEqual(["classified api", "turn"]);
  });

  test("a cli run started through Home: its seed check classifies the record's input before the first model call", async () => {
    const canary = canaryOf();
    const h = await home.harness("canary-cli");
    const bin = join(h.dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "crewhaus"), 0o755);
    const res = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: canary },
    });
    expect(res.status).toBe(202);
    const runId = String((res.body["run"] as Record<string, unknown>)["id"]);
    const record = JSON.parse(
      readFileSync(join(h.dir, controlPaths(h.dir).inputsDir, `${runId}.json`), "utf8"),
    ) as { input: string };
    // The job runs `crewhaus run --input-file`, which seeds one turn with the record's input.
    const order: string[] = [];
    _resetInputOriginForTest();
    _setInputOriginClassifierForTest(async (text, opts) => {
      if (text === canary) order.push(`classified ${opts.origin}`);
      return classifyBoundary(text, opts);
    });
    type Adapter = NonNullable<Parameters<typeof runChatLoop>[0]["_adapter"]>;
    const adapter = {
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
        order.push("model call");
        return (async function* () {
          yield { kind: "message_start" } as const;
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          } as const;
          yield { kind: "message_stop" } as const;
        })();
      },
    } as unknown as Adapter;
    const ledger = mkdtempSync(join(tmpdir(), "canary-ledger-"));
    const sessions = mkdtempSync(join(tmpdir(), "canary-sessions-"));
    scratch.push(ledger, sessions);
    const previous = process.env["CREWHAUS_INPUT_ORIGIN"];
    process.env["CREWHAUS_INPUT_ORIGIN"] = "api";
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "canary",
        singleTurn: true,
        seedMessages: [{ role: "user", content: record.input }],
        permissionMode: "bypass",
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
        settingsDir: null,
        sessionRootDir: sessions,
        runLedgerDir: ledger,
        _adapter: adapter,
      });
    } catch {
      // The order is the assertion; how the stub turn ends is not.
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_INPUT_ORIGIN");
      else process.env["CREWHAUS_INPUT_ORIGIN"] = previous;
      _resetInputOriginForTest();
    }
    expect(order[0]).toBe("classified api");
    expect(order.indexOf("model call")).toBeGreaterThan(-1);
    expect(order.indexOf("classified api")).toBeLessThan(order.indexOf("model call"));
  });
});
