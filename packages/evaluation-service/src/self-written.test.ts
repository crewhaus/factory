/**
 * Design §10's accepted `grounded` residual — "a model that fetches a page
 * it wrote itself" — through the LIVE loop: the model writes a file, reads
 * it back and cites it. The gate still grounds the claim (the file does say
 * it now), and every surface says the run is its own source: the binding
 * names the Write (`writtenBy`), the bundle and the `provability_graded`
 * line count the origin (`selfWritten`), and the footer shows it beside the
 * sources. `provability audit` lists such bindings as a gaming signal
 * (apps/cli provability-cli.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ProofBundle, proofsRoot } from "@crewhaus/provability";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { config, tempDirs } from "./__fixtures__/helpers";
import { runTurn, scriptedModel } from "./__fixtures__/loop";
import { wireEvaluation } from "./wire";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** tool-fs's `Write` and `Read`, by name, input and flags, rooted at `root`. */
function fsTools(root: string): { write: RegisteredTool; read: RegisteredTool } {
  const write = buildTool({
    name: "Write",
    description: "write a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
    destructive: true,
    execute: async (input) => {
      const at = join(root, input.path);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, input.content);
      return `wrote ${input.content.length} bytes to ${input.path}`;
    },
  });
  const read = buildTool({
    name: "Read",
    description: "read a file",
    inputSchema: z.object({ path: z.string() }).strict(),
    readOnly: true,
    concurrencySafe: true,
    execute: async (input) => readFileSync(join(root, input.path), "utf8"),
  });
  return { write, read };
}

const POLICY = "The refund window is 30 days from the date of purchase.";
const ANSWER = `${POLICY.replace(/\.$/, "")} [1].\n\n[1]: ./notes/policy.md`;

describe("the live loop — a source the run wrote itself (design §10)", () => {
  test("Write, Read, cite: grounded, and the bundle, the trace line and the footer say the run wrote it", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, ".crewhaus", "sessions");
    const { write, read } = fsTools(cwd);
    const gates = await wireEvaluation(
      { specName: "support-bot", primaryModel: "test-model", provability: config("grounded") },
      { cwd, sessionRootDir, footerTarget: "reply", catalog: [write, read] },
    );
    const model = scriptedModel([
      [
        {
          type: "tool_use",
          id: "toolu_write1",
          name: "Write",
          input: { path: "notes/policy.md", content: POLICY },
        },
      ],
      [{ type: "tool_use", id: "toolu_read1", name: "Read", input: { path: "notes/policy.md" } }],
      [{ type: "text", text: ANSWER }],
    ]);
    const run = await runTurn({ model, tools: [write, read], gates, sessionRootDir });
    expect(model.calls()).toBe(3);
    expect(run.graded.map((e) => e.verdict)).toEqual(["pass"]);
    expect((run.graded[0] as { selfWritten?: number }).selfWritten).toBe(1);
    expect(run.result).toContain(
      "── provability · grounded ✓ · 1/1 claim · 1 source (1 written by this run) · 0 assumptions",
    );
    const bundleDir = join(proofsRoot(cwd, "support-bot"), run.sessionId);
    const bundle = JSON.parse(readFileSync(join(bundleDir, "turn-1.json"), "utf8")) as ProofBundle;
    expect(bundle.selfWritten).toBe(1);
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({
      ok: true,
      rung: "grounded",
      origin: "notes/policy.md",
      writtenBy: { toolUseId: "toolu_write1", toolName: "Write" },
    });
  });

  test("a file the run only read is an outside source: no mark", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, ".crewhaus", "sessions");
    mkdirSync(join(cwd, "notes"), { recursive: true });
    writeFileSync(join(cwd, "notes", "policy.md"), POLICY);
    const { write, read } = fsTools(cwd);
    const gates = await wireEvaluation(
      { specName: "support-bot", primaryModel: "test-model", provability: config("grounded") },
      { cwd, sessionRootDir, footerTarget: "reply", catalog: [write, read] },
    );
    const model = scriptedModel([
      [{ type: "tool_use", id: "toolu_read1", name: "Read", input: { path: "notes/policy.md" } }],
      // A report saved AFTER the read repeats the claim: the page is still the page.
      [
        {
          type: "tool_use",
          id: "toolu_write1",
          name: "Write",
          input: { path: "report.md", content: ANSWER },
        },
      ],
      [{ type: "text", text: ANSWER }],
    ]);
    const run = await runTurn({ model, tools: [write, read], gates, sessionRootDir });
    expect(run.graded.map((e) => e.verdict)).toEqual(["pass"]);
    expect((run.graded[0] as { selfWritten?: number }).selfWritten).toBeUndefined();
    expect(run.result).toContain(
      "── provability · grounded ✓ · 1/1 claim · 1 source · 0 assumptions",
    );
  });
});
