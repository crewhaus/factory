/**
 * The compile-time half of each boot registrar's validation
 * (`TOOL_BOOT_REGISTRARS[*].checks`, run by `toolConfigProblems`) must agree
 * with the registrar itself. The checks are data, so compile can run them
 * offline; the registrar is code, so only a test can hold the two together.
 *
 * Every `tool_config` registrar in the table is called with every probe
 * block — each allow-list and refused key any registrar declares, and the
 * spellings those keys come in, crossed with well-formed and malformed
 * values — and the two verdicts must match: the registrar throws exactly
 * when the checks report a problem. A registrar that starts refusing one of
 * these keys without a declared check fails here, and so does a check that
 * refuses what the registrar accepts. Keys no registrar declares (webFetch's
 * `allowed_domains`, defi's `rpc`, …) are checked at boot only.
 *
 * Registrars set process-wide state, so the probes run in a child process.
 */
import { describe, expect, test } from "bun:test";
import { compile, lower } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import { BUILTIN_TOOLS, TOOL_BOOT_REGISTRARS, checkBuiltinTool } from "@crewhaus/tool-categories";
import { emitCfWorkerBundle } from "./cf-worker-emit";

const PROBE = `
const { TOOL_BOOT_REGISTRARS, toolConfigProblems } = await import("@crewhaus/tool-categories");
const regs = Object.entries(TOOL_BOOT_REGISTRARS).filter(([, r]) => r.source === "tool_config");
const keys = new Set();
for (const [, r] of regs) {
  for (const k of r.checks?.origins?.keys ?? []) keys.add(k);
  for (const k of r.checks?.refused?.keys ?? []) keys.add(k);
}
const VALUES = ["", "api.example.com", "https://a.example", [], ["https://a.example"],
  ["http://a.example"], ["api.example.com"], ["localhost:8080"], ["ftp://a.example"], ["https://"], [5], [null],
  null, true, 7, { a: 1 }];
const out = [];
for (const [symbol, reg] of regs) {
  const mod = await import(reg.package);
  const registrar = mod[symbol];
  const blocks = [{}];
  for (const k of keys) for (const v of VALUES) blocks.push({ [k]: v });
  for (const a of keys) for (const b of keys) {
    if (a < b) blocks.push({ [a]: ["https://a.example"], [b]: ["https://b.example"] });
  }
  const mismatches = [];
  for (const block of blocks) {
    let threw;
    try { registrar(block); } catch (err) { threw = String(err?.message ?? err); }
    const found = toolConfigProblems({ key: "x", package: reg.package, initSymbol: symbol, config: block, where: "tool_config.x" });
    if ((threw !== undefined) !== (found.length > 0)) {
      mismatches.push({ block, registrar: threw ?? "accepted", checks: found.map((f) => f.message) });
    }
  }
  out.push({ symbol, probes: blocks.length, mismatches });
}
console.log(JSON.stringify(out));
`;

type ProbeResult = {
  readonly symbol: string;
  readonly probes: number;
  readonly mismatches: ReadonlyArray<unknown>;
};

describe("tool_config checks agree with the registrars they stand in for", () => {
  test("every registrar throws exactly when its compile-time checks report a problem", () => {
    const run = Bun.spawnSync(["bun", "-e", PROBE], { cwd: import.meta.dir, stderr: "pipe" });
    const stderr = new TextDecoder().decode(run.stderr);
    expect({ exitCode: run.exitCode, stderr: run.exitCode === 0 ? "" : stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const results = JSON.parse(new TextDecoder().decode(run.stdout)) as ProbeResult[];
    const expected = Object.values(TOOL_BOOT_REGISTRARS).filter(
      (r) => r.source === "tool_config",
    ).length;
    // Derived from the table, and asserted, so a sweep that reached nothing fails.
    expect(results).toHaveLength(expected);
    expect(results.every((r) => r.probes > 100)).toBe(true);
    const declared = Object.values(TOOL_BOOT_REGISTRARS).filter((r) => r.checks !== undefined);
    expect(declared.length).toBeGreaterThanOrEqual(8);
    expect(results.filter((r) => r.mismatches.length > 0)).toEqual([]);
  }, 30_000);
});

describe("a cf-worker bundle registers only blocks its registrars accept", () => {
  // Closeout review: `--emit-as cf-worker` (and the compiler-worker) skip
  // compile(), so `fetch.allowed_origins: ["api.example.com"]` emitted a
  // worker whose registerFetchConfig threw as the module loaded.
  test("every checked registrar the edge wires is refused at emit as compile refuses it", () => {
    const cases: Array<{ key: string; symbol: string; bad: object; good: object }> = [];
    for (const [key, entry] of Object.entries(BUILTIN_TOOLS)) {
      const symbol = entry.initSymbol;
      if (symbol === undefined || cases.some((c) => c.symbol === symbol)) continue;
      const checks = TOOL_BOOT_REGISTRARS[symbol]?.checks;
      if (TOOL_BOOT_REGISTRARS[symbol]?.source !== "tool_config" || checks === undefined) continue;
      const verdict = checkBuiltinTool(key, "cf-worker");
      if (verdict.kind !== "ok" && verdict.kind !== "inert") continue;
      const list = checks.origins?.keys[0];
      const refused = checks.refused?.keys[0];
      if (list !== undefined) {
        cases.push({
          key,
          symbol,
          bad: { [list]: ["api.example.com"] },
          good: { [list]: ["https://api.example.com"] },
        });
      } else if (refused !== undefined) {
        cases.push({ key, symbol, bad: { [refused]: true }, good: {} });
      }
    }
    // Derived from the tables, and asserted, so a sweep that reached nothing fails.
    expect(cases.map((c) => c.key)).toContain("fetch");
    const spec = (key: string, block: object) =>
      `name: t\ntarget: cli\nagent:\n  model: claude-haiku-4-5\n  instructions: hi\ntools: [${key}]\ntool_config:\n  ${key}: ${JSON.stringify(block)}\n`;
    const refusal = (run: () => unknown): string | undefined => {
      try {
        run();
      } catch (err) {
        return (err as Error).message;
      }
      return undefined;
    };
    for (const c of cases) {
      const host = refusal(() => compile(spec(c.key, c.bad)));
      const edge = refusal(() => emitCfWorkerBundle(lower(parseSpec(spec(c.key, c.bad)))));
      expect({ key: c.key, refused: host !== undefined, edge }).toEqual({
        key: c.key,
        refused: true,
        edge: host,
      });
      // The same block, well formed, is registered by the worker.
      const worker =
        emitCfWorkerBundle(lower(parseSpec(spec(c.key, c.good)))).files.find(
          (f) => f.path === "worker.js",
        )?.content ?? "";
      expect({ key: c.key, registers: worker.includes(`${c.symbol}(`) }).toEqual({
        key: c.key,
        registers: true,
      });
    }
  });
});
