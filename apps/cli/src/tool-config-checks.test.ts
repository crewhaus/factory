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
import { TOOL_BOOT_REGISTRARS } from "@crewhaus/tool-categories";

const PROBE = `
const { TOOL_BOOT_REGISTRARS, toolConfigProblems } = await import("@crewhaus/tool-categories");
const regs = Object.entries(TOOL_BOOT_REGISTRARS).filter(([, r]) => r.source === "tool_config");
const keys = new Set();
for (const [, r] of regs) {
  for (const k of r.checks?.origins?.keys ?? []) keys.add(k);
  for (const k of r.checks?.refused?.keys ?? []) keys.add(k);
}
const VALUES = ["", "api.example.com", "https://a.example", [], ["https://a.example"],
  ["http://a.example"], ["api.example.com"], ["ftp://a.example"], ["https://"], [5], [null],
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
