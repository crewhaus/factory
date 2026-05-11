#!/usr/bin/env bun
/**
 * Dynamic recipe smoke test.
 *
 * Where scripts/test-recipes.ts does static validation (links, spec
 * parsing, package.json script presence), this script actually runs
 * the bun scripts each recipe declares in its frontmatter.
 *
 * Two modes:
 *
 *   - Default (RECIPE_SMOKE_LIVE unset): runs only `compile:*` scripts.
 *     No model calls, no credentials, no cost. Catches bugs where a
 *     spec parses but the codegen + bundler steps fail.
 *
 *   - Live (RECIPE_SMOKE_LIVE=1): also runs `run:*`, `smoke:*`, and
 *     any other `bun_scripts` entries the recipe declares. Requires
 *     an Anthropic credential in env.
 *
 * Recipes opt in by declaring their bun scripts in frontmatter:
 *
 *   ---
 *   test:
 *     bun_scripts:
 *       - compile:hello
 *       - run:hello              # only runs under RECIPE_SMOKE_LIVE=1
 *   ---
 *
 * Exit codes: 0 if every selected script succeeded; 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RECIPES_DIR = join(REPO_ROOT, "docs", "recipes");
const LIVE = process.env["RECIPE_SMOKE_LIVE"] === "1";

const SAFE_PREFIXES = ["compile:"];
const LIVE_PREFIXES = ["run:", "smoke:"];

// Scripts that require non-Anthropic credentials beyond `RECIPE_SMOKE_LIVE`.
// The smoke runner skips them (instead of failing loudly) when the listed
// env vars are absent — e.g. `run:hello-channel` boots a Slack daemon and
// fails immediately without `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`. Adding
// an entry here is purely cosmetic: the underlying script still fails-loud
// when invoked directly, which is the right behavior outside CI.
const REQUIRES_ENV: Record<string, readonly string[]> = {
  "run:hello-channel": ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
};

type Frontmatter = { bunScripts?: string[] };

type Result = {
  recipe: string;
  script: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
};

const results: Result[] = [];

function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const lines = content.slice(4, end).split("\n");
  const out: Frontmatter = {};
  let inTest = false;
  let inList: "bunScripts" | undefined;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\r$/, "");
    if (/^test:\s*$/.test(line)) {
      inTest = true;
      continue;
    }
    if (!inTest) continue;
    if (/^\s{2}bun_scripts:\s*$/.test(line)) {
      inList = "bunScripts";
      out.bunScripts = [];
      continue;
    }
    const itemM = /^\s{4}-\s*(.+?)\s*$/.exec(line);
    if (itemM?.[1] !== undefined && inList === "bunScripts") {
      const list = out.bunScripts;
      if (list !== undefined) list.push(stripQuotes(itemM[1]));
      continue;
    }
    if (/^\s{2}\w/.test(line)) {
      inList = undefined;
    } else if (/^\S/.test(line)) {
      inTest = false;
      inList = undefined;
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function classify(script: string): "safe" | "live" | "unknown" {
  if (SAFE_PREFIXES.some((p) => script.startsWith(p))) return "safe";
  if (LIVE_PREFIXES.some((p) => script.startsWith(p))) return "live";
  return "unknown";
}

function runScript(recipe: string, script: string): Result {
  const start = Date.now();
  const result = spawnSync("bun", ["run", script], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", CREWHAUS_LOG_LEVEL: "error" },
    // Generous: codegen + bundling per shape takes a few seconds on
    // first run, sub-second after.
    timeout: 60_000,
  });
  const ms = Date.now() - start;
  if (result.status === 0) {
    process.stdout.write(`  ✓ ${script}  (${ms}ms)\n`);
    return { recipe, script, status: "passed" };
  }
  const tail =
    (result.stderr || "")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-3)
      .join("\n  ") || "(no stderr)";
  process.stderr.write(`  ✗ ${script}  (${ms}ms)\n  ${tail}\n`);
  return { recipe, script, status: "failed", reason: tail };
}

function main(): void {
  const recipes = readdirSync(RECIPES_DIR)
    .filter((n) => n.endsWith(".md"))
    .sort();

  process.stdout.write(
    `Smoke runner — mode: ${LIVE ? "LIVE (run+smoke scripts enabled)" : "STATIC (compile-only)"}\n`,
  );

  for (const name of recipes) {
    const path = join(RECIPES_DIR, name);
    const content = readFileSync(path, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.bunScripts || fm.bunScripts.length === 0) continue;

    const rel = relative(REPO_ROOT, path);
    process.stdout.write(`\n${rel}\n`);
    for (const script of fm.bunScripts) {
      const c = classify(script);
      if (c === "unknown") {
        process.stdout.write(`  ⚠ ${script}  (unknown prefix; skipping)\n`);
        results.push({ recipe: rel, script, status: "skipped", reason: "unknown prefix" });
        continue;
      }
      if (c === "live" && !LIVE) {
        process.stdout.write(`  · ${script}  (gated on RECIPE_SMOKE_LIVE=1; skipping)\n`);
        results.push({ recipe: rel, script, status: "skipped", reason: "live mode disabled" });
        continue;
      }
      const required = REQUIRES_ENV[script];
      if (required !== undefined) {
        const missing = required.filter((v) => !process.env[v]);
        if (missing.length > 0) {
          process.stdout.write(`  · ${script}  (requires ${missing.join(", ")}; skipping)\n`);
          results.push({
            recipe: rel,
            script,
            status: "skipped",
            reason: `missing env: ${missing.join(", ")}`,
          });
          continue;
        }
      }
      results.push(runScript(rel, script));
    }
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  process.stdout.write(`\nTotal: ${passed} passed, ${failed} failed, ${skipped} skipped.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
