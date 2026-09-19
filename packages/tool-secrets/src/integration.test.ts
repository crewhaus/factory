/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema before `execute` runs and turns a refusal into an error
 * result rather than a thrown stack.
 *
 * It also walks one full credential lifecycle — write it, look it up, rotate
 * it, look it up again — because each of these tools is only worth anything if
 * the next one can read what it wrote.
 *
 * ONE test at the bottom touches the real host, and asserts SHAPE only. Every
 * other test in this package runs off recorded fixtures: CI is Linux on bun
 * 1.3.11, this was written on macOS on 1.3.14, and a test that asks the
 * machine what is in its keychain gets two different answers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { OTHER_SECRET, SECRET } from "./fixtures";
import {
  SECRETS_TOOLS,
  _setClock,
  _setEnv,
  _setRandomBytes,
  _setRunner,
  fingerprint,
} from "./index";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of SECRETS_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-secrets-int-"));
  process.chdir(workspace);
  _setClock(() => NOW);
  _setEnv({});
  _setRandomBytes((size) => new Uint8Array(size).fill(11));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setClock(undefined);
  _setEnv(undefined);
  _setRunner(undefined);
  _setRandomBytes(undefined);
});

/** A tool result is arbitrary JSON; asserting on its fields is the point. */
// biome-ignore lint/suspicious/noExplicitAny: the shape under test is JSON the tool chose.
type Json = Record<string, any>;

async function run(name: string, input: unknown): Promise<Json> {
  const result = await executeTool(lookup(name), input, { toolUseId: name });
  expect({ name, isError: result.isError, content: result.content.slice(0, 300) }).toMatchObject({
    name,
    isError: false,
  });
  return JSON.parse(result.content) as Json;
}

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(SECRETS_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of SECRETS_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });

  test("the names are the ones the docs and the wiring expect", () => {
    expect(SECRETS_TOOLS.map((tool) => tool.name).sort()).toEqual([
      "EnvFileUpsert",
      "SecretLookup",
      "SecretRotate",
    ]);
  });
});

describe("dispatch through executeTool", () => {
  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("SecretLookup"),
      { refs: "env:A" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(true);
  });

  test("an empty list of references is refused by the schema, not by the tool", async () => {
    const result = await executeTool(lookup("SecretLookup"), { refs: [] }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
  });

  // A caller's mistake comes back as a readable SENTENCE, not an exception —
  // the convention `@crewhaus/tool-proc` and `@crewhaus/tool-git` set, because
  // a model recovers from a sentence far better than from a stack trace. So
  // these are successful dispatches carrying a refusal, and the assertion that
  // matters is that nothing happened and the reason is legible.
  test("a containment escape comes back as a refusal sentence, not a crash", async () => {
    const result = await executeTool(
      lookup("EnvFileUpsert"),
      { path: "../../etc/environment", entries: [{ key: "A", value: "1" }] },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("[EnvFileUpsert error]");
    expect(result.content).toContain("outside the workspace root");
  });

  test("a refusal carries the reason and the way out", async () => {
    const result = await executeTool(
      lookup("SecretRotate"),
      { ref: "keychain:acme", generate: { bytes: 32, encoding: "base64url" } },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("cannot be rotated");
    expect(result.content).toContain("Keychain Access");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    _setEnv({ SEED: SECRET });
    const inputs: Record<string, unknown> = {
      SecretLookup: { refs: ["env:SEED"] },
      EnvFileUpsert: { entries: [{ key: "SEED", valueFrom: "env:SEED" }] },
      SecretRotate: {
        ref: "envfile:.env#SEED",
        generate: { bytes: 32, encoding: "base64url" },
        dryRun: true,
      },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const result = await executeTool(lookup(name), input, { toolUseId: name });
      expect({ name, isError: result.isError }).toEqual({ name, isError: false });
    }
  });
});

describe("one credential lifecycle", () => {
  test("write it, look it up, rotate it, look it up again — and no value appears anywhere", async () => {
    const collected: string[] = [];
    const record = <T extends Record<string, unknown>>(value: T): T => {
      collected.push(JSON.stringify(value));
      return value;
    };

    _setEnv({ BOOTSTRAP_TOKEN: SECRET });
    writeFileSync(
      join(workspace, ".env"),
      ["# Acme harness", "", "LOG_LEVEL=debug", "# SLACK_BOT_TOKEN=", ""].join("\n"),
    );

    // 1. The value moves from the environment into the file without ever
    //    passing through the model's hands.
    const written = record(
      await run("EnvFileUpsert", {
        entries: [{ key: "SLACK_BOT_TOKEN", valueFrom: "env:BOOTSTRAP_TOKEN" }],
      }),
    );
    expect(written.entries[0].how).toBe("uncommented");
    expect(written.entries[0].fingerprint).toBe(fingerprint(SECRET));

    // 2. The lookup agrees with the write, by fingerprint.
    const first = record(await run("SecretLookup", { refs: ["envfile:.env#SLACK_BOT_TOKEN"] }));
    expect(first.results[0].fingerprint).toBe(written.entries[0].fingerprint);

    // 3. The same name, looked up bare, is now defined in two places — and
    //    the environment still wins. That is the shadowing report earning
    //    its place: the operator edited the file and changed nothing.
    const bare = record(await run("SecretLookup", { refs: ["SLACK_BOT_TOKEN"] }));
    expect(bare.results[0].wonBy).toBe("envfile:.env#SLACK_BOT_TOKEN");
    expect(bare.results[0].warning).toBeUndefined();
    // Now somebody exports it in their shell with a different value, which
    // is the situation that eats an afternoon.
    _setEnv({ SLACK_BOT_TOKEN: OTHER_SECRET });
    const shadowed = record(await run("SecretLookup", { refs: ["SLACK_BOT_TOKEN"] }));
    expect(shadowed.results[0].wonBy).toBe("env:SLACK_BOT_TOKEN");
    expect(shadowed.results[0].warning).toContain("different values");

    // 4. Rotate the file's copy. The old one is kept until the new one has
    //    been read back.
    const rotated = record(
      await run("SecretRotate", {
        ref: "envfile:.env#SLACK_BOT_TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
      }),
    );
    expect(rotated.ok).toBe(true);
    expect(rotated.fingerprint.before).toBe(fingerprint(SECRET));
    expect(rotated.previousKeptAs).toBe("envfile:.env#SLACK_BOT_TOKEN_PREVIOUS");

    // 5. The lookup sees the new value, and the journal remembers when.
    const after = record(
      await run("SecretLookup", {
        refs: ["envfile:.env#SLACK_BOT_TOKEN", "envfile:.env#SLACK_BOT_TOKEN_PREVIOUS"],
      }),
    );
    expect(after.results[0].fingerprint).toBe(rotated.fingerprint.after);
    expect(after.results[0].lastRotatedAt).toBe("2026-09-18T12:00:00.000Z");
    expect(after.results[1].fingerprint).toBe(fingerprint(SECRET));

    // 6. The file a human maintains still looks like one.
    const text = readFileSync(join(workspace, ".env"), "utf8");
    expect(text.startsWith("# Acme harness\n\nLOG_LEVEL=debug\n")).toBe(true);

    // 7. Nothing that came back carried a secret.
    const generated = Buffer.from(new Uint8Array(32).fill(11)).toString("base64url");
    let scanned = 0;
    for (const payload of collected) {
      scanned += 1;
      for (const value of [SECRET, OTHER_SECRET, generated]) {
        expect(payload).not.toContain(value);
      }
    }
    expect(scanned).toBe(6);
    // The budget below is explicit: six dispatches, each a small synchronous
    // read-modify-write. CI is a loaded two-core Linux box on bun 1.3.11 and
    // this was measured on macOS on 1.3.14, so bun's 5s default is not a
    // margin worth trusting for work judged by what it does rather than by a
    // local stopwatch.
  }, 20_000);
});

describe("the one test that touches this machine", () => {
  test("SecretLookup reads the real process environment, and reports only shape", async () => {
    // The seams are restored, so this runs against the actual host.
    _setEnv(undefined);
    const result = await run("SecretLookup", {
      refs: ["env:PATH", "env:CREWHAUS_DEFINITELY_UNSET"],
    });

    // SHAPE ONLY. Not the length of PATH, not its contents, not which
    // backends this machine has — every one of those differs between a
    // laptop and CI, and asserting one would make this test a liar on the
    // other.
    expect(result.checked).toBe(2);
    expect(result.results[0].resolved).toBe(true);
    expect(result.results[0].fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(typeof result.results[0].length).toBe("number");
    expect(result.results[1].resolved).toBe(false);
    expect(result.results[1].status).toBe("absent");
    // The value itself is the one thing that must be true everywhere.
    expect(result.results[0].value).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(process.env["PATH"] as string);
  }, 10_000);
});
