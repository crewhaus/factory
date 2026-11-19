/**
 * The informational compile-warning list is read by two places — the
 * `--strict` filter and `crewhaus compile --help` — and the help used to be
 * typed by hand: by 0.7.1 it had dropped mcp-server-name and
 * permission-rule-note. These tests pin both readers to the one list, and the
 * list to codes the compiler still emits.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@crewhaus/compiler";
import { INFORMATIONAL_COMPILE_WARNING_CODES, wrapCodes } from "./compile-warnings";

const CLI_PATH = join(import.meta.dir, "index.ts");
const COMPILER_SRC = join(import.meta.dir, "..", "..", "..", "packages", "compiler", "src");

describe("informational compile warnings", () => {
  test("compile --help names every informational code", async () => {
    const proc = Bun.spawn([process.execPath, CLI_PATH, "compile", "--help"], {
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const strict = stdout.slice(stdout.indexOf("--strict   Escalate"));
    const missing = INFORMATIONAL_COMPILE_WARNING_CODES.filter((code) => !strict.includes(code));
    expect(missing).toEqual([]);
    // The help also says what the shadowed-rule codes mean.
    expect(stdout).toContain("permission-rule (a rule that can never fire");
  }, 20_000);

  test("every listed code is one the compiler emits", () => {
    const source = readdirSync(COMPILER_SRC)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => readFileSync(join(COMPILER_SRC, f), "utf8"))
      .join("\n");
    const stale = INFORMATIONAL_COMPILE_WARNING_CODES.filter(
      (code) => !source.includes(`"${code}"`),
    );
    expect(stale).toEqual([]);
    expect(INFORMATIONAL_COMPILE_WARNING_CODES.length).toBe(20);
  });

  test("wrapCodes keeps each code whole and ends the list with a full stop", () => {
    const text = wrapCodes(["alpha-one", "beta-two", "gamma-three"], "  ", 20);
    expect(text).toBe("  alpha-one,\n  beta-two,\n  gamma-three.\n");
  });
});

describe("permissions.ask_mode on a pipeline eval-harness build", () => {
  test("is rendered, and nothing it prints fails --strict", () => {
    const yaml = [
      "name: docs-rag",
      "target: pipeline",
      "agent: {model: claude-opus-4-7, instructions: Answer from docs.}",
      "retrieve: {embedderModel: text-embedding-3-small, defaultK: 3}",
      "indexing:",
      "  documents:",
      "    - {id: handbook, text: hello}",
      "permissions:",
      "  ask_mode: deny",
      "",
    ].join("\n");
    const built = compile(yaml, { readme: false, evalEntry: true });
    expect(built.files.find((f) => f.path === "agent.ts")?.content).toContain('askMode: "deny"');
    const strictFailing = built.warnings.filter(
      (w) => !INFORMATIONAL_COMPILE_WARNING_CODES.includes(w.code),
    );
    expect(strictFailing).toEqual([]);
    expect(built.warnings.map((w) => w.code)).toContain("ask-mode-eval-entry-only");
  });
});
