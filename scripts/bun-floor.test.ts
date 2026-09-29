/**
 * The oldest supported Bun is stated in five kinds of place: the root
 * package.json's `engines.bun` (release-prep stamps it into every published
 * package), `crewhaus doctor`, the container images, CI's Bun pins and the
 * install docs. 0.7.0 said 1.2 in all of them while CI ran 1.3 only, and on
 * 1.2 the 0.7.1 hardening does not hold (a timed-out regex worker keeps a core
 * busy for tens of seconds) and the suite cannot run. So the floor is one
 * constant, and this test fails when any statement of it drifts from it.
 *
 * Every place is FOUND, not listed: each Dockerfile under docker-images, every
 * `bun-version:` in the workflows, and every "Bun ≥ x" / "Bun >= x" in a
 * tracked Markdown file other than a changelog (whose old entries are history).
 * Each scan also asserts how many it found, so a scan that silently matches
 * nothing fails too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUN_FLOOR, bunVersionParts, checkBunVersion } from "../apps/cli/src/bun-floor";

const ROOT = dirname(import.meta.dir);
const FLOOR = bunVersionParts(BUN_FLOOR) as [number, number, number];

/** Is `version` at or above the floor? A version without a patch is a tag that
 *  floats within its minor (`1.3` is the newest 1.3.x), judged by its minor. */
function meetsFloor(version: string): boolean {
  const m = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (m === null) return false;
  const have = [Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3])];
  if (have[0] !== FLOOR[0]) return (have[0] as number) > FLOOR[0];
  if (have[1] !== FLOOR[1]) return (have[1] as number) > FLOOR[1];
  return have[2] === undefined || have[2] >= FLOOR[2];
}

function trackedFiles(pattern: string): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z", pattern], { cwd: ROOT });
  return out.stdout
    .toString()
    .split("\0")
    .filter((f) => f !== "");
}

describe("the Bun floor is stated once and held everywhere", () => {
  test("the judge: tags and pins are read the way they resolve", () => {
    const [major, minor, patch] = FLOOR;
    expect(meetsFloor(BUN_FLOOR)).toBe(true);
    expect(meetsFloor(`${major}.${minor}`)).toBe(true);
    expect(meetsFloor(`${major}.${minor}.${patch + 1}`)).toBe(true);
    expect(meetsFloor(`${major}.${minor + 1}.0`)).toBe(true);
    expect(meetsFloor(`${major}.${minor - 1}`)).toBe(false);
    expect(meetsFloor(`${major}.${minor}.${patch - 1}`)).toBe(false);
    expect(meetsFloor("latest")).toBe(false);
  });

  test("root engines.bun is exactly the floor (release-prep copies it to every package)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      engines?: { bun?: string };
    };
    expect(pkg.engines?.bun).toBe(`>=${BUN_FLOOR}`);
  });

  test("crewhaus doctor passes the floor and refuses what is below it", () => {
    expect(checkBunVersion(BUN_FLOOR).pass).toBe(true);
    expect(checkBunVersion(`${FLOOR[0]}.${FLOOR[1]}.${FLOOR[2] - 1}`).pass).toBe(false);
    expect(checkBunVersion("1.2.23").pass).toBe(false);
  });

  test("every container image starts from a Bun at or above the floor", () => {
    const dockerRoot = join(ROOT, "packages", "docker-images", "docker");
    const dockerfiles = readdirSync(dockerRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dockerRoot, e.name, "Dockerfile"));
    const bad: string[] = [];
    let froms = 0;
    for (const file of dockerfiles) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/^FROM\s+oven\/bun:(\S+)/gm)) {
        froms += 1;
        const tag = (m[1] ?? "").replace(/-(alpine|slim|debian|distroless)$/, "");
        if (!meetsFloor(tag)) bad.push(`${file}: oven/bun:${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
    // Twelve shapes, each with a deps and a runtime stage from oven/bun.
    expect(dockerfiles.length).toBe(12);
    expect(froms).toBe(24);
  });

  test("every Bun that CI and the release jobs install IS the floor, so CI proves it before a tag", () => {
    // Equal, not merely at or above: the first 0.7.1 floor (1.3.11) was
    // "at or above" a pin nobody had seen green on Linux x64, and CI there
    // refuted it. A pinned job runs exactly the floor; a floating one
    // (pricing-drift) floats from exactly the floor.
    const workflows = trackedFiles(".github/workflows/*.yml");
    const bad: string[] = [];
    let pins = 0;
    let exact = 0;
    for (const file of workflows) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(/bun-version:\s*"?([^"\s]+)"?/g)) {
        pins += 1;
        const spec = m[1] ?? "";
        if (spec === BUN_FLOOR) exact += 1;
        else if (spec !== `>=${BUN_FLOOR}`) bad.push(`${file}: bun-version ${spec}`);
      }
    }
    expect(bad).toEqual([]);
    expect(pins).toBe(9);
    // ci (3 jobs), release (3), smoke-runtime (1) pin it exactly.
    expect(exact).toBe(7);
  });

  test("every install doc that names a minimum Bun names the floor", () => {
    const docs = trackedFiles("*.md").filter((f) => !/(^|\/)CHANGELOG\.md$/.test(f));
    const bad: string[] = [];
    let mentions = 0;
    for (const file of docs) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(/\bBun\b[^\n]{0,40}?(?:>=|≥)\s*(\d+\.\d+(?:\.\d+)?)/gi)) {
        mentions += 1;
        if (m[1] !== BUN_FLOOR) bad.push(`${file}: "${m[0]}"`);
      }
    }
    expect(bad).toEqual([]);
    expect(mentions).toBe(6);
  });
});
