#!/usr/bin/env bun
/**
 * Section 11 end-to-end smoke test against the live model.
 *
 * Three scenarios over a temp project:
 *   1. Hooks: pre-tool deny on Bash blocks `whoami` execution
 *   2. Skills: a `say-pirate` SKILL.md surfaces and is callable via Skill tool
 *   3. Slash commands: `/explain quicksort` expands before submission
 *
 * Run with `bun run smoke:section-11` (or directly: `bun scripts/section-11-smoke.ts`).
 * Requires a Claude credential in `.env` — `ANTHROPIC_AUTH_TOKEN` (Claude
 * Pro/Max OAuth) or `ANTHROPIC_API_KEY` (pay-per-token).
 *
 * Exits 0 on full success; 1 on any failed scenario.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");

type ScenarioResult = {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
};

function setupProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "section-11-smoke-"));
  // Minimal CLI spec.
  writeFileSync(
    join(cwd, "crewhaus.yaml"),
    `name: section-11-smoke
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are a helpful assistant. Be concise.
tools:
  - bash
`,
  );
  return cwd;
}

function writeHookSettings(cwd: string): void {
  mkdirSync(join(cwd, ".crewhaus"), { recursive: true });
  writeFileSync(
    join(cwd, ".crewhaus", "settings.json"),
    JSON.stringify(
      {
        hooks: [
          {
            event: "pre-tool",
            matcher: "Bash",
            command: 'cat >/dev/null; printf \'{"decision":"deny","reason":"smoke test deny"}\\n\'',
          },
        ],
      },
      null,
      2,
    ),
  );
}

function writePirateSkill(cwd: string): void {
  const dir = join(cwd, ".crewhaus", "skills", "say-pirate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: say-pirate
description: respond like a 1700s pirate (use ye, arr, matey, ahoy, savvy)
---
You are now speaking entirely in 1700s pirate vernacular. Use words like "ye", "arr", "matey", "ahoy", and "savvy". Keep your response short and unmistakably pirate-flavoured.`,
  );
}

function writeExplainCommand(cwd: string): void {
  const dir = join(cwd, ".crewhaus", "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "explain.md"),
    "Explain $ARGUMENTS in two short sentences. Be technical and direct.",
  );
}

function runAgent(cwd: string, prompt: string, timeoutMs: number): ScenarioResult {
  const stdin = `${prompt}\nexit\n`;
  const result = spawnSync("bun", [CLI_ENTRY, "run", join(cwd, "crewhaus.yaml")], {
    cwd,
    input: stdin,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      // Avoid the sigint-handler default-on path (which re-uses process.stdin).
      // Our piped stdin is already the test driver.
    },
  });
  return {
    name: "(agent run)",
    passed: result.status === 0,
    message: result.error ? String(result.error) : "",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function check(
  scenarioName: string,
  raw: ScenarioResult,
  predicate: (out: { stdout: string; stderr: string }) => string | null,
): ScenarioResult {
  const failure = predicate({ stdout: raw.stdout, stderr: raw.stderr });
  return {
    name: scenarioName,
    passed: failure === null,
    message: failure ?? "OK",
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
}

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];

  // === Scenario 1: hook deny ===
  const cwd1 = setupProject();
  writeHookSettings(cwd1);
  console.log(`[scenario 1] hook deny — temp: ${cwd1}`);
  const raw1 = runAgent(cwd1, "Run `whoami` for me.", 60_000);
  results.push(
    check("hook-deny", raw1, ({ stdout }) => {
      if (!stdout.includes("[hooks] 1 loaded")) return "expected '[hooks] 1 loaded' boot line";
      if (!stdout.includes("[tool: Bash]")) return "expected '[tool: Bash]' (model attempted bash)";
      // The deny reason "smoke test deny" goes back to the model (in the
      // tool_result content), not to stdout directly. The strongest signal
      // is the model's reply acknowledging the block.
      const lower = stdout.toLowerCase();
      const blockMarkers = ["block", "denied", "policy", "cannot", "unable", "restricted"];
      const matched = blockMarkers.some((m) => lower.includes(m));
      if (!matched) {
        return `expected the assistant reply to acknowledge the block (one of: ${blockMarkers.join(", ")})`;
      }
      // Verify whoami was NOT executed: a real `whoami` would output the
      // current username on its own line. Inspect lines that aren't the
      // runtime tool header or hook boot lines.
      const me = process.env["USER"];
      if (typeof me === "string" && me.length > 2) {
        const lines = stdout.split("\n").filter((l) => {
          const trimmed = l.trim();
          if (trimmed.length === 0) return false;
          if (trimmed.startsWith("[tool:")) return false;
          if (trimmed.startsWith("[hooks]")) return false;
          if (trimmed.startsWith("[skills]")) return false;
          if (trimmed.startsWith("[slash]")) return false;
          if (trimmed.startsWith("agent ready")) return false;
          if (trimmed.startsWith("you>") || trimmed.startsWith("agent>")) return false;
          return true;
        });
        // A bare-username line (alone or as the only token) would be
        // whoami's actual stdout. If it appears, the hook didn't block.
        const wholeUsername = new RegExp(`^\\s*${me}\\s*$`);
        if (lines.some((l) => wholeUsername.test(l))) {
          return `unexpected: whoami output (bare username '${me}') appeared — the hook should have prevented execution`;
        }
      }
      return null;
    }),
  );
  rmSync(cwd1, { recursive: true, force: true });

  // === Scenario 2: skill ===
  const cwd2 = setupProject();
  writePirateSkill(cwd2);
  console.log(`[scenario 2] skill say-pirate — temp: ${cwd2}`);
  const raw2 = runAgent(
    cwd2,
    "Use the say-pirate skill and greet me in one short sentence.",
    90_000,
  );
  results.push(
    check("skill", raw2, ({ stdout }) => {
      if (!stdout.includes("[skills]"))
        return "expected boot line '[skills] ...' listing say-pirate";
      if (!stdout.includes("say-pirate")) return "expected 'say-pirate' in skills list";
      const lower = stdout.toLowerCase();
      // The model should call the Skill tool — runtime emits `[tool: Skill]`
      // when any tool is invoked.
      if (!lower.includes("[tool: skill]")) {
        return "expected '[tool: Skill]' line indicating model invoked the Skill tool";
      }
      // After Skill body lands, response should contain pirate vocabulary.
      const pirateMarkers = ["ye ", "arr", "matey", "ahoy", "savvy"];
      const matched = pirateMarkers.some((m) => lower.includes(m));
      if (!matched) {
        return `expected at least one pirate marker (${pirateMarkers.join("/")}) in the assistant reply`;
      }
      return null;
    }),
  );
  rmSync(cwd2, { recursive: true, force: true });

  // === Scenario 3: slash command ===
  const cwd3 = setupProject();
  writeExplainCommand(cwd3);
  console.log(`[scenario 3] slash /explain — temp: ${cwd3}`);
  const raw3 = runAgent(cwd3, "/explain quicksort", 60_000);
  results.push(
    check("slash", raw3, ({ stdout }) => {
      if (!stdout.includes("[slash]")) return "expected boot line '[slash] ... explain'";
      if (!stdout.includes("explain")) return "expected 'explain' in slash command list";
      const lower = stdout.toLowerCase();
      // Negative grep: model should answer the substituted question, not
      // meta-comment about a slash command.
      const metaMarkers = [
        "i see you typed",
        "command not",
        "unknown command",
        "unrecognised slash",
      ];
      for (const m of metaMarkers) {
        if (lower.includes(m)) return `unexpected meta-comment about slash command: '${m}'`;
      }
      // Positive: the assistant should have explained quicksort substantively.
      const quicksortMarkers = ["partition", "pivot", "recurs", "divide", "sort"];
      const matched = quicksortMarkers.some((m) => lower.includes(m));
      if (!matched) {
        return `expected at least one quicksort vocabulary marker (${quicksortMarkers.join(", ")}) in the assistant reply`;
      }
      return null;
    }),
  );
  rmSync(cwd3, { recursive: true, force: true });

  // === Report ===
  console.log("\n=== SECTION 11 SMOKE RESULTS ===");
  let allPass = true;
  for (const r of results) {
    const tag = r.passed ? "✓" : "✗";
    console.log(`${tag} ${r.name}: ${r.message}`);
    if (!r.passed) {
      allPass = false;
      console.log("  -- stdout (last 1500 chars) --");
      console.log(r.stdout.slice(-1500));
      console.log("  -- stderr (last 800 chars) --");
      console.log(r.stderr.slice(-800));
    }
  }
  process.exit(allPass ? 0 : 1);
}

await main();
