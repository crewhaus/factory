/**
 * 0.8.0 §9.3 — `crewhaus advise` end to end over a gated harness: the
 * `provability_graded` lines say WHICH turns failed after retries, and the
 * driver reads the persisted bundles they point at so `ruleProvabilityPressure`
 * can key its advice to the dominant unmet reason. Asserts on the on-disk
 * suggestions.json (spawn-pipe capture is unreliable under `bun test` — see
 * advise-cli.test.ts). No model or credentials anywhere.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuggestionsFile } from "@crewhaus/harness-advice/advise-rules";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-advise-provability-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: ReadonlyArray<string>, cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

const SESSION = "sess_00000000000000af";
const line = (kind: string, payload: unknown): unknown => ({ ts: 1, version: 1, kind, payload });
const jsonl = (lines: unknown[]): string => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

/**
 * Five gated turns, `failing` of which end failing after one retry; each
 * failing standing pass points at a bundle with two never-fetched claims
 * and one uncited claim.
 */
function seedGatedHarness(root: string, failing: number, spec: string): void {
  const sessions = join(root, ".crewhaus", "sessions");
  const proofs = join(root, ".crewhaus", "proofs", "support", SESSION);
  mkdirSync(sessions, { recursive: true });
  mkdirSync(proofs, { recursive: true });
  const lines: unknown[] = [];
  for (let turn = 1; turn <= 5; turn++) {
    const fails = turn <= failing;
    const bundlePath = join(proofs, `turn-${turn}.json`);
    const graded = (retryIndex: number, verdict: string) =>
      line("provability_graded", {
        level: "grounded",
        verdict,
        score: verdict === "pass" ? 1 : 0,
        threshold: 1,
        achieved: verdict === "pass" ? "grounded" : "cited",
        claims: 2,
        met: verdict === "pass" ? 2 : 0,
        unmet: verdict === "pass" ? 0 : 2,
        assumptions: 0,
        retryIndex,
        maxRetries: 1,
        turnNumber: turn,
        bundleHash: `sha256:${turn}-${retryIndex}`,
        bundlePath,
      });
    if (fails) {
      lines.push(graded(0, "fail"), graded(1, "fail"));
      writeFileSync(
        bundlePath,
        JSON.stringify({
          version: 1,
          verdict: "fail",
          claims: [
            {
              index: 0,
              text: "The refund window is 14 days.",
              status: "unmet",
              bindings: [
                { ref: "[1]", kind: "source", rung: "cited", ok: false, reason: "not_fetched" },
              ],
            },
            {
              index: 1,
              text: "Returns are accepted in store.",
              status: "unmet",
              bindings: [
                { ref: "[2]", kind: "source", rung: "cited", ok: false, reason: "not_fetched" },
              ],
            },
            { index: 2, text: "Shipping is free.", status: "unmet", bindings: [] },
          ],
        }),
      );
    } else {
      lines.push(graded(0, "pass"));
    }
  }
  writeFileSync(join(sessions, `${SESSION}.jsonl`), jsonl(lines));
  writeFileSync(join(root, "crewhaus.yaml"), spec);
}

const SPEC = [
  "name: support",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: answer from the policy pages",
  "tools: [WebFetch]",
  "provability:",
  "  level: grounded",
  "  max_retries: 1",
  "",
].join("\n");

describe("crewhaus advise — provability pressure (design §9.3)", () => {
  test("turns failing after retries draw a max_retries patch keyed to the bundles' dominant reason", async () => {
    const root = newTempRoot();
    seedGatedHarness(root, 2, SPEC);
    expect((await runCli(["advise"], root)).exitCode).toBe(0);
    const file = JSON.parse(
      readFileSync(join(root, ".crewhaus", "advice", "suggestions.json"), "utf-8"),
    ) as SuggestionsFile;
    const entry = file.suggestions.find((s) => s.findingId === "provability-pressure");
    expect(entry?.patch).toMatchObject({
      path: ["provability", "max_retries"],
      op: "replace",
      value: 2,
    });
    // The reasons came from the bundle FILES the lines point at.
    expect(entry?.patch.rationale).toContain("dominant unmet reason not_fetched");
    const html = readFileSync(join(root, ".crewhaus", "advice", "report.html"), "utf-8");
    expect(html).toContain("Dominant unmet reason: not_fetched (4 claims)");
    expect(html).toContain("Lowering provability.level is never suggested");
  }, 30_000);

  test("a pruned bundle is skipped, never fatal — the finding still fires", async () => {
    const root = newTempRoot();
    seedGatedHarness(root, 3, SPEC);
    rmSync(join(root, ".crewhaus", "proofs"), { recursive: true, force: true });
    expect((await runCli(["advise"], root)).exitCode).toBe(0);
    const file = JSON.parse(
      readFileSync(join(root, ".crewhaus", "advice", "suggestions.json"), "utf-8"),
    ) as SuggestionsFile;
    const entry = file.suggestions.find((s) => s.findingId === "provability-pressure");
    expect(entry?.patch.rationale).toContain("reasons unread");
  }, 30_000);

  test("below 20% of gated turns failing: no finding", async () => {
    const root = newTempRoot();
    seedGatedHarness(root, 0, SPEC);
    expect((await runCli(["advise"], root)).exitCode).toBe(0);
    const file = JSON.parse(
      readFileSync(join(root, ".crewhaus", "advice", "suggestions.json"), "utf-8"),
    ) as SuggestionsFile;
    expect(file.suggestions.some((s) => s.findingId === "provability-pressure")).toBe(false);
  }, 30_000);
});
