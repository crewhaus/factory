/**
 * No shipped code calls home: every CrewHaus-hosted address in shipped source is
 * one of four, each with its reason, and a new one fails here until it has one.
 *
 * Scanned: everything under `packages/<x>/src` and `apps/<x>/src` except tests
 * (`*.test.ts`) and the `__fixtures__/` and `__test__/` trees, which never ship.
 * `fixtures.ts` files are scanned: tool-distribution's ships. Matched: URL
 * literals with a scheme whose host is `crewhaus.<tld>` or a subdomain of it. A
 * bare host name in help text or a comment, an email address and an attribute or
 * label key such as `crewhaus.ai/cluster` carry no scheme and are out of scope,
 * and so are `github.com/crewhaus` links (documentation and release assets).
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);

/** The hosts shipped code may name, and why each is not a call home. */
const ALLOWED_HOSTS: Readonly<Record<string, string>> = {
  "crewhaus.ai": "documentation and homepage links, never fetched",
  "thredz.crewhaus.ai":
    "the default base of the Thredz service, which the user configures with their own key",
  "registry.crewhaus.ai":
    "the default marketplace registries, called only by the explicit marketplace verbs",
  "studio.crewhaus.ai": "a CORS allowed origin in the Worker targets, never called",
};

const CREWHAUS_URL = /https?:\/\/((?:[a-z0-9-]+\.)*crewhaus\.[a-z]{2,})\b/gi;

type Site = { readonly file: string; readonly line: number; readonly host: string };

/** Shipped source files under `root`'s packages/<x>/src and apps/<x>/src. */
function shippedSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "__fixtures__" ||
          entry.name === "__test__"
        ) {
          continue;
        }
        walk(path);
      } else if (entry.isFile() && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(path);
      }
    }
  };
  for (const group of ["packages", "apps"]) {
    if (!existsSync(join(root, group))) continue;
    for (const pkg of readdirSync(join(root, group)).sort()) {
      const src = join(root, group, pkg, "src");
      if (existsSync(src)) walk(src);
    }
  }
  return out;
}

/** Every CrewHaus-hosted URL literal in those files. */
function crewhausSites(root: string): { sites: Site[]; files: number } {
  const files = shippedSources(root);
  const sites: Site[] = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 8000).includes(0)) continue;
    bytes
      .toString("utf8")
      .split("\n")
      .forEach((text, i) => {
        for (const m of text.matchAll(CREWHAUS_URL)) {
          sites.push({
            file: file.slice(root.length + 1),
            line: i + 1,
            host: (m[1] as string).toLowerCase(),
          });
        }
      });
  }
  return { sites, files: files.length };
}

/** A site whose host has no reason on the list. */
const unexplained = (sites: readonly Site[]): string[] =>
  sites
    .filter((s) => ALLOWED_HOSTS[s.host] === undefined)
    .map((s) => `${s.file}:${s.line}: ${s.host} is not an allowed CrewHaus host`);

describe("the real tree", () => {
  const { sites, files } = crewhausSites(ROOT);

  test("every CrewHaus-hosted address in shipped source is an allowed host", () => {
    expect(files).toBeGreaterThan(1000);
    expect(unexplained(sites)).toEqual([]);
  });

  test("each allowed host is still used, so a stale entry leaves the list", () => {
    for (const host of Object.keys(ALLOWED_HOSTS)) {
      expect({ host, used: sites.some((s) => s.host === host) }).toEqual({ host, used: true });
    }
  });

  test("the sites are counted, so a new one is a decision", () => {
    // Four hosts over eleven lines: the docs link and the distribution fixture's
    // homepage, the Thredz base (two packages), the two marketplace clients and
    // the three Worker targets' CORS origin.
    expect(sites).toHaveLength(11);
  });
});

describe("planted", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  test("an unknown subdomain is reported, and tests and fixtures trees are not read", () => {
    const root = mkdtempSync(join(tmpdir(), "no-phone-home-"));
    temps.push(root);
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put("packages/x/src/index.ts", 'const BEACON = "https://telemetry.crewhaus.ai/v1/ping";\n');
    put(
      "packages/x/src/docs.ts",
      '// see https://crewhaus.ai/docs\nexport const d = "https://CrewHaus.ai";\n',
    );
    put("packages/x/src/fixtures.ts", 'export const home = "https://beacon.crewhaus.io";\n');
    put("packages/x/src/index.test.ts", 'fetch("https://tests.crewhaus.ai");\n');
    put("packages/x/src/__fixtures__/a.json", '{"u":"https://fixture.crewhaus.ai"}\n');
    put("packages/x/src/__test__/h.ts", 'fetch("https://helper.crewhaus.ai");\n');
    put(
      "apps/y/src/main.ts",
      'const mail = "release@crewhaus.ai"; // a label crewhaus.ai/cluster\n',
    );
    const { sites } = crewhausSites(root);
    expect(unexplained(sites)).toEqual([
      "packages/x/src/fixtures.ts:1: beacon.crewhaus.io is not an allowed CrewHaus host",
      "packages/x/src/index.ts:1: telemetry.crewhaus.ai is not an allowed CrewHaus host",
    ]);
    expect(sites.filter((s) => s.host === "crewhaus.ai")).toHaveLength(2);
  });
});
