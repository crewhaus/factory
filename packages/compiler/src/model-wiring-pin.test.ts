/**
 * 0.6.0 PR 8a — the `wireModels` composition root wraps every emitter's
 * model-routing fragment BYTE-IDENTICALLY (plan §2 stance 4, §13 row 8a,
 * §17). One fixture per emitter that renders the quartet (`modelFallbacks` /
 * `circuitBreaker` / `modelTiers` / `modelPool`), each pinned to the bundle
 * bytes the pre-refactor tree produced — see `__fixtures__/model-wiring/README.md`
 * for provenance and the regeneration rule. The `pre-continuity` pins cover
 * specs that declare NO routing; these cover specs that DO.
 *
 * The `cli-new-keys` fixture is the plan's §17 guard: one NEW 0.6.0 key per
 * level (profile → candidate → pool) must be observable in the emitted
 * `modelPool` literal AND equal the object `wireModels` hands the interpreter's
 * `runChatLoop` — so a later PR cannot drop a key between the IR and the loop
 * on either path.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { IrV0 } from "@crewhaus/ir";
import { modelWiringFragmentFromIr, wireModels } from "@crewhaus/model-service";
import { compile, lower, parseSpec } from "./index";

const FIX_DIR = join(import.meta.dir, "__fixtures__", "model-wiring");

const KEYS = readdirSync(FIX_DIR)
  .filter((f) => f.endsWith(".spec.yaml"))
  .map((f) => f.replace(/\.spec\.yaml$/, ""))
  .sort();

/** Every emitter that renders the routing quartet has at least one fixture. */
const SHAPES_COVERED = [
  "cli",
  "channel",
  "managed",
  "workflow",
  "crew",
  "graph",
  "pipeline",
  "research",
  "batch",
  "browser",
] as const;

function fixtureSpec(key: string): string {
  return readFileSync(join(FIX_DIR, `${key}.spec.yaml`), "utf-8");
}

function pinnedFiles(key: string): ReadonlyMap<string, string> {
  const prefix = `${key}.`;
  const out = new Map<string, string>();
  for (const f of readdirSync(FIX_DIR)) {
    if (!f.startsWith(prefix) || !f.endsWith(".txt")) continue;
    out.set(f.slice(prefix.length, -".txt".length), readFileSync(join(FIX_DIR, f), "utf-8"));
  }
  return out;
}

/** Pull the ONE `modelPool: {...},` literal out of an emitted file. */
function emittedPoolLiteral(content: string): unknown {
  const lines = content.split("\n").filter((l) => /^\s*modelPool: \{/.test(l));
  expect(lines).toHaveLength(1);
  const json = (lines[0] ?? "").replace(/^\s*modelPool: /, "").replace(/,$/, "");
  return JSON.parse(json);
}

describe("model-wiring byte pins — every routed shape compiles to its pre-PR-8a bytes", () => {
  test("the fixture set covers every emitter that renders the routing quartet", () => {
    for (const shape of SHAPES_COVERED) {
      expect(KEYS.some((k) => parseSpec(fixtureSpec(k)).target === shape)).toBe(true);
    }
  });

  for (const key of KEYS) {
    test(`${key}: every bundle file matches its pin byte-for-byte`, () => {
      const bundle = compile(fixtureSpec(key), { readme: false });
      const pins = pinnedFiles(key);
      const emitted = bundle.files.map((f) => f.path.replace(/[^A-Za-z0-9_.-]/g, "_")).sort();
      expect(emitted).toEqual([...pins.keys()].sort());
      for (const file of bundle.files) {
        const safe = file.path.replace(/[^A-Za-z0-9_.-]/g, "_");
        expect(`${file.path}:${file.content}`).toBe(`${file.path}:${pins.get(safe) ?? ""}`);
      }
    });
  }
});

describe("one new IR key per level reaches BOTH runtime consumers (plan §17)", () => {
  const spec = parseSpec(fixtureSpec("cli-new-keys"));
  const ir = lower(spec) as IrV0;

  test("the interpreter's option object carries the profile / candidate / pool keys by reference", () => {
    const wired = wireModels(modelWiringFragmentFromIr(ir.agent), {});
    expect(wired.modelPool).toBe(ir.agent.modelPool);
    const pool = wired.modelPool as unknown as Record<string, unknown>;
    const candidates = pool["candidates"] as ReadonlyArray<Record<string, unknown>>;
    expect(candidates[0]?.["profile"]).toBe("fast");
    expect(candidates[0]?.["temperature"]).toBe(0.2);
    expect(candidates[1]?.["enabled"]).toBe(false);
    expect(pool["rules"]).toEqual([
      { id: "code-goes-strong", when: { message_matches: "refactor|stack ?trace" }, use: "strong" },
    ]);
  });

  test("the compiled bundle's modelPool literal is the SAME object — bundle and interpreter are one code path", () => {
    const bundle = compile(fixtureSpec("cli-new-keys"), { readme: false });
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    const literal = emittedPoolLiteral(agent);
    expect(literal).toEqual(wireModels(modelWiringFragmentFromIr(ir.agent), {}).modelPool);
    // The key-order byte contract: `model` then `tags` first, 0.6.0 keys after.
    expect(agent).toContain(
      '{"model":"claude-haiku-4-5","tags":["cheap"],"profile":"fast","temperature":0.2}',
    );
    expect(agent).toContain('"enabled":false');
    expect(agent).toContain('"rules":[{"id":"code-goes-strong"');
  });

  test("a --model override drops the pool on the interpreter path (the bundle has no override)", () => {
    expect(wireModels(modelWiringFragmentFromIr(ir.agent), { modelOverride: "x" })).toEqual({});
  });
});
