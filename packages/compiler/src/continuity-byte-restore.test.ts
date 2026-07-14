/**
 * v0.3.0 PR 11 — the release's compat contract, byte-diff-pinned
 * (design §1 principle 3, §12):
 *
 *   (a) a pre-0.3.0 spec WITHOUT a `continuity:` key now compiles
 *       DIFFERENTLY on the five agent-loop shapes (default-on) — the new
 *       output is itself pinned;
 *   (b) the same spec with `continuity: false` compiles BYTE-IDENTICAL to
 *       the pre-PR-11 output (fixtures under `__fixtures__/pre-continuity/`
 *       — see its README for provenance + regeneration);
 *   (c) the carried shapes (workflow/batch/voice/browser) get NO default-on
 *       — an unmodified spec stays byte-identical — and print the
 *       0.2.3-convention ignored-note when continuity IS declared;
 *   (d) the excluded shapes (graph/pipeline/eval/onchain/onchain-game)
 *       reject the key loudly at parse time (strict union).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SpecParseError } from "@crewhaus/spec";
import { compile } from "./index";

const FIX_DIR = join(import.meta.dir, "__fixtures__", "pre-continuity");

function fixtureSpec(key: string): string {
  return readFileSync(join(FIX_DIR, `${key}.spec.yaml`), "utf-8");
}

function pinnedFile(key: string, file: string): string {
  const safe = file.replace(/[^A-Za-z0-9_.-]/g, "_");
  return readFileSync(join(FIX_DIR, `${key}.${safe}.txt`), "utf-8");
}

/** Compile and assert EVERY bundle file matches its pinned bytes. */
function expectByteIdentical(key: string, specYaml: string): void {
  const bundle = compile(specYaml, { readme: false });
  for (const file of bundle.files) {
    expect(`${file.path}:${file.content}`).toBe(`${file.path}:${pinnedFile(key, file.path)}`);
  }
}

/** Strip the trailing `memory:` block (the daemon-shape fixtures declare one,
 *  but memory became emit-wired on those shapes in 0.3.0 — a separate,
 *  documented delta; the byte-restore contract is about continuity). */
function withoutMemory(specYaml: string): string {
  return specYaml.replace(/\nmemory:[\s\S]*$/, "\n");
}

describe("continuity: false — byte-restore (the 0.3.0 opt-out contract)", () => {
  test("cli without memory restores pre-PR-11 bytes exactly", () => {
    expectByteIdentical("cli-plain", `${fixtureSpec("cli-plain")}continuity: false\n`);
  });

  test("cli WITH memory restores the PR 10 wireMemory emission exactly", () => {
    expectByteIdentical("cli-memory", `${fixtureSpec("cli-memory")}continuity: false\n`);
  });

  test("the object-form opt-out ({enabled: false}) restores bytes too", () => {
    expectByteIdentical("cli-plain", `${fixtureSpec("cli-plain")}continuity:\n  enabled: false\n`);
  });

  for (const key of ["channel", "managed", "research", "crew"] as const) {
    test(`${key} (memory-free) restores pre-PR-11 bytes exactly`, () => {
      expectByteIdentical(key, `${withoutMemory(fixtureSpec(key))}continuity: false\n`);
    });
  }
});

describe("default-on continuity — the sanctioned behavior change", () => {
  test("a continuity-less cli spec now compiles DIFFERENTLY (default-on)", () => {
    const bundle = compile(fixtureSpec("cli-plain"), { readme: false });
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).not.toBe(pinnedFile("cli-plain", "agent.ts"));
    expect(agent).toContain("wireMemory");
  });

  test("the new default-on cli output is pinned byte-for-byte", () => {
    const bundle = compile(fixtureSpec("cli-plain"), { readme: false });
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toBe(readFileSync(join(FIX_DIR, "cli-plain.agent.default-on.txt"), "utf-8"));
  });

  test("`continuity: true` (boolean shorthand) compiles identically to absent", () => {
    const absent = compile(fixtureSpec("cli-plain"), { readme: false });
    const explicit = compile(`${fixtureSpec("cli-plain")}continuity: true\n`, { readme: false });
    expect(explicit.files).toEqual(absent.files);
  });

  for (const key of ["channel", "managed", "research", "crew"] as const) {
    test(`${key}: default-on wires the memory fabric (wireMemory in the bundle)`, () => {
      const bundle = compile(withoutMemory(fixtureSpec(key)), { readme: false });
      const all = bundle.files.map((f) => f.content).join("\n");
      expect(all).toContain("wireMemory");
      expect(all).toContain('"continuity":{"plan":true,"proof":"ladder"');
    });
  }
});

describe("carried shapes — no default-on, ignored-note when declared", () => {
  for (const key of ["workflow", "batch", "voice", "browser"] as const) {
    test(`${key}: a continuity-less spec stays byte-identical (no default-on)`, () => {
      expectByteIdentical(key, fixtureSpec(key));
    });

    test(`${key}: declared continuity is carried with the ignored-note comment`, () => {
      const bundle = compile(`${fixtureSpec(key)}continuity: true\n`, { readme: false });
      const all = bundle.files.map((f) => f.content).join("\n");
      expect(all).toContain(`// note: continuity configured but ignored on ${key} in 0.3.0`);
      expect(all).not.toContain("wireMemory");
    });

    test(`${key}: continuity: false emits neither wiring nor the note`, () => {
      expectByteIdentical(key, `${fixtureSpec(key)}continuity: false\n`);
    });
  }
});

describe("excluded shapes — the strict union rejects continuity loudly", () => {
  const EXCLUDED: ReadonlyArray<[string, string]> = [
    [
      "graph",
      `name: x-graph
target: graph
model: m
entry: a
nodes:
  a:
    instructions: do a
`,
    ],
    [
      "pipeline",
      `name: x-pipeline
target: pipeline
agent:
  model: m
  instructions: i
retrieve:
  embedderModel: mock/deterministic
indexing:
  documents:
    - id: d1
      text: hello
`,
    ],
    [
      "eval",
      `name: x-eval
target: eval
agent:
  model: m
  instructions: i
dataset:
  name: d
  version: "1"
graders:
  - name: g
`,
    ],
    [
      "onchain",
      `name: x-onchain
target: onchain
agent:
  model: m
  instructions: i
chains:
  - id: c1
    kind: evm
    rpcUrls: ["https://rpc.test"]
    finality: { kind: finalized }
triggers:
  - kind: block
    chainId: c1
    scanIntervalMs: 60000
`,
    ],
    [
      "onchain-game",
      `name: x-game
target: onchain-game
agent:
  model: m
  instructions: i
chain:
  id: c1
  kind: evm
  rpcUrls: ["https://rpc.test"]
  finality: { kind: finalized }
wallet:
  id: w1
  chainId: c1
  custody: user-controlled
game:
  contract:
    id: g1
    chainId: c1
    address: "0x1"
    abiRef: abi://erc20
  stateReader: readState
`,
    ],
  ];

  for (const [shape, spec] of EXCLUDED) {
    test(`${shape}: continuity is rejected at parse time`, () => {
      // The shape itself must parse…
      expect(() => compile(spec, { readme: false })).not.toThrow(SpecParseError);
      // …and adding continuity must fail loudly (never silent dead config).
      expect(() => compile(`${spec}continuity: true\n`, { readme: false })).toThrow(SpecParseError);
    });
  }
});
