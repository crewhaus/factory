import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The load-bearing invariant for this package: it must be runnable on a
 * Cloudflare Worker, which means (1) no `node:*` builtin anywhere in its
 * import graph, and (2) no direct `Date.now()` / `Math.random()` — both are
 * injected via `WorkerPlatform` (see platform.ts). This test enforces both,
 * at the source AND at the bundled-graph level.
 *
 * The source scan strips comments first: the docblocks deliberately SHOW
 * `now: () => Date.now()` as the caller-side pattern, and that documentation
 * must not trip the guard — only real code does.
 */

const SRC_DIR = import.meta.dir;

/** Remove block + line comments so documentation examples don't false-trip the
 *  code scanners. The line-comment rule preserves `://` so URLs survive. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function nonTestSources(): Array<{ file: string; code: string }> {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((file) => ({ file, code: stripComments(readFileSync(join(SRC_DIR, file), "utf8")) }));
}

describe("worker-runtime is node-free", () => {
  test("no source file imports a node: builtin or a bare fs/path/etc.", () => {
    const bareNodeBuiltins =
      /from\s+["'](?:fs|path|os|crypto|events|child_process|stream|http|https|net|tls|util|url|zlib|buffer|worker_threads)["']/;
    for (const { file, code } of nonTestSources()) {
      expect(code, `${file}: no \`node:\` import`).not.toMatch(/from\s+["']node:/);
      expect(code, `${file}: no \`require("node:…")\``).not.toMatch(/require\(\s*["']node:/);
      expect(code, `${file}: no bare node builtin import`).not.toMatch(bareNodeBuiltins);
    }
  });

  test("no source file calls Date.now() or Math.random() (inject via platform)", () => {
    for (const { file, code } of nonTestSources()) {
      expect(code, `${file}: use platform.now(), not Date.now()`).not.toMatch(/\bDate\.now\s*\(/);
      expect(code, `${file}: use platform.randomId(), not Math.random()`).not.toMatch(
        /\bMath\.random\s*\(/,
      );
    }
  });

  test("the bundled import graph pulls in no node: builtin", async () => {
    const built = await Bun.build({
      entrypoints: [join(SRC_DIR, "index.ts")],
      target: "browser",
    });
    expect(built.success, JSON.stringify(built.logs)).toBe(true);
    const combined = (await Promise.all(built.outputs.map((o) => o.text()))).join("\n");
    // A quoted `node:` specifier surviving into the browser bundle means a
    // transitive dependency reached for a builtin — exactly the drift this
    // guards. (Backtick-quoted `node:*` in docblocks is not a specifier.)
    expect(combined).not.toMatch(/["']node:/);
  });
});
