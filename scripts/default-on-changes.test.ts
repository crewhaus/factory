/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 3, §15) — the
 * release notes promise that a spec without `provability:` runs as before,
 * apart from the changes listed under "Changes that can affect a harness
 * without `provability:`". The first review of the release changed three
 * things every harness sees: the runtime-state floor and the tools that
 * refuse on their own (§10), the WebFetch header, and the warnings
 * `compile --emit-as cf-worker` gives. None of them reached that list, so the
 * promise was false where it matters most: a deny no rule can lift.
 *
 * So each change is FOUND in the code that makes it, and the list must name
 * what was found: the roots the runtime protects in a run without the block,
 * every tool that checks its own writes against them, every WebFetch header
 * line 0.7.x did not print, and every block the edge says it does not run
 * besides `provability:` itself. A change reverted or scoped to the block
 * stops being found, and a new root, tool, header line or edge warning fails
 * until the notes name it. Each scan also asserts it found something, so a
 * scan that silently matches nothing fails too.
 *
 * A default-on change of another kind adds a check here and a bullet there.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { cfWorkerUnwiredBlockWarnings } from "../packages/compiler/src/index";
import { runtimeStateRoots } from "../packages/runtime-core/src/state-roots";

const ROOT = dirname(import.meta.dir);
const HEADING = "**Changes that can affect a harness without `provability:`.**";

/**
 * The bullets under every copy of the heading (each release that makes such
 * changes lists its own), each folded onto one line. A bullet runs to the
 * next one; the list ends at the next bold paragraph (`**What's new.**`).
 */
function withoutBlockBullets(): string[] {
  const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");
  const bullets: string[] = [];
  for (let at = text.indexOf(HEADING); at >= 0; at = text.indexOf(HEADING, at + 1)) {
    let open = false;
    for (const line of text.slice(at + HEADING.length).split("\n")) {
      if (line.startsWith("**")) break;
      if (line.startsWith("- ")) {
        bullets.push(line.slice(2).trim());
        open = true;
      } else if (line.trim() === "") {
        open = false;
      } else if (open) {
        bullets[bullets.length - 1] += ` ${line.trim()}`;
      }
    }
  }
  return bullets;
}

/** Workspace source files (tracked or new, never dist or a test) that contain `needle`. */
function sourcesContaining(needle: string): string[] {
  const out = Bun.spawnSync(
    ["git", "grep", "-l", "-z", "--untracked", "-F", "-e", needle, "--", "packages", "apps"],
    { cwd: ROOT },
  );
  return out.stdout
    .toString()
    .split("\0")
    .filter((f) => /\/src\/.+\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("/dist/"));
}

describe("the release notes name every change a harness without provability: sees", () => {
  const bullets = withoutBlockBullets();
  const notes = bullets.join("\n");

  test("the list is there to check", () => {
    expect(bullets.length).toBeGreaterThan(0);
  });

  test("the runtime-state floor: every root a run without the block protects, and what bypass lifts", () => {
    // The roots of a run with no tenant and no session-dir override, the
    // call runChatLoop makes for every harness; a path that does not exist
    // only spells them, nothing is created.
    const cwd = join(tmpdir(), "crewhaus-default-on-changes");
    const roots = runtimeStateRoots(undefined, undefined, cwd)
      .filter((root) => !isAbsolute(root))
      .map((root) => root.split(sep).join("/"));
    expect(roots.length).toBeGreaterThan(0);
    const unnamed = roots.filter((root) => !notes.includes(`\`${root}\``));
    expect(unnamed).toEqual([]);
    // The bullet that names them says how far bypass reaches and what the
    // floor cannot see (permission-engine `EvaluateOptions.protectedRoots`).
    const floor = bullets.find((b) => roots.every((root) => b.includes(`\`${root}\``))) ?? "";
    expect(floor).toContain("bypass");
    expect(floor).toContain("`Bash`");
    expect(floor).toContain("`RunCommand`");
  });

  test("every tool that refuses a write into those roots on its own is named", () => {
    // Each `protectedRootsOf(ctx)` call is a tool checking its own targets
    // against the roots on its bridge — in every permission mode, bypass
    // included — and the tool is the one whose `name:` precedes the call.
    const tools = new Set<string>();
    const unattributed: string[] = [];
    for (const file of sourcesContaining("protectedRootsOf(")) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const names = [...text.matchAll(/\bname: "([A-Z][A-Za-z0-9]*)"/g)];
      for (const call of text.matchAll(/(?<!function )\bprotectedRootsOf\(/g)) {
        const owner = names.filter((m) => (m.index ?? 0) < (call.index ?? 0)).at(-1);
        if (owner?.[1] === undefined) unattributed.push(`${file}@${call.index}`);
        else tools.add(owner[1]);
      }
    }
    expect(unattributed).toEqual([]);
    // CopyPath, MovePath, RemovePath, ArchiveExtract (tool-fsx),
    // GitApplyPatch (tool-git), StateImport (tool-state) and StoreMigrate
    // (tool-lifecycle) today.
    expect(tools.size).toBe(7);
    const unnamed = [...tools].filter((tool) => !notes.includes(`\`${tool}\``)).sort();
    expect(unnamed).toEqual([]);
  });

  test("WebFetch: a header line 0.7.x did not print is named", () => {
    const source = readFileSync(join(ROOT, "packages", "tool-web", "src", "index.ts"), "utf8");
    const line = source.split(/\r?\n/).find((l) => /\bconst header = `URL: /.test(l)) ?? "";
    const fields = [...line.matchAll(/([A-Z][A-Za-z-]*): \$\{/g)].map((m) => m[1] ?? "");
    expect(fields).toContain("URL");
    const added = fields.filter((f) => !["URL", "Status", "Content-Type"].includes(f));
    const webFetch = bullets.filter((b) => b.includes("`WebFetch`")).join("\n");
    expect(added.filter((f) => !webFetch.includes(`\`${f}:\``))).toEqual([]);
  });

  test("the cf-worker edge: a block it says it does not run, besides provability:, is named with what --strict does", () => {
    // Every block the rule knows, found by handing it an IR that carries
    // them all. `provability:` is the release's own block; any other is one
    // a spec without it may carry, which 0.7.x compiled without a word.
    const everyBlock = new Proxy({}, { get: () => ({}) }) as Parameters<
      typeof cfWorkerUnwiredBlockWarnings
    >[0];
    const paths = cfWorkerUnwiredBlockWarnings(everyBlock).map((w) => w.path);
    expect(paths).toContain("provability");
    const edge = bullets.filter((b) => b.includes("--emit-as cf-worker") && b.includes("--strict"));
    const unnamed = paths
      .filter((p) => p !== "provability")
      .filter((p) => !edge.some((b) => b.includes(`\`${p}:\``)));
    expect(unnamed).toEqual([]);
  });
});
