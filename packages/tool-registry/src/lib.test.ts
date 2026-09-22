/**
 * The functions underneath the tools: name validation, the four range
 * dialects, the TOML and JSON locators, the manifest reader and the request
 * path. Every network test drives the injected fetch — nothing here resolves
 * a name or opens a socket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { locateJsonMember } from "./lib/jsonspan";
import {
  checkSpecText,
  collectSites,
  dialectForSection,
  manifestKind,
  namesMatch,
  parseRequirement,
  reapplyStyle,
  verifySplice,
} from "./lib/manifest";
import { checkName, nameForUrl, normalizePypiName } from "./lib/names";
import {
  RegistryError,
  _setRegistryFetch,
  getJson,
  mapPool,
  readCapped,
  startDeadline,
} from "./lib/net";
import {
  highestSatisfying,
  highestVersion,
  isSemverShaped,
  sortVersionsDescending,
  toNpmRange,
  toNpmRangeIn,
  versionDelta,
  versionSatisfies,
} from "./lib/ranges";
import { readCrates, readNpm, readPypi, searchRegistry } from "./lib/registries";
import {
  inlineTableEntries,
  lookupPath,
  scanToml,
  stringArrayElements,
  stringInner,
} from "./lib/toml";

afterEach(() => {
  _setRegistryFetch(undefined);
});

/** A fetch that answers from a table of URLs and records what it was asked. */
function stubFetch(
  routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>,
): { calls: string[] } {
  const calls: string[] = [];
  _setRegistryFetch(async (req) => {
    calls.push(req.url);
    const route = routes[req.url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: route.headers ?? {},
    });
  });
  return { calls };
}

// ---------------------------------------------------------------------------

describe("package names", () => {
  test("a scoped npm name survives and is encoded as one path segment", () => {
    expect(checkName("npm", "@crewhaus/tool-registry")).toMatchObject({ ok: true });
    // The separator is escaped so nothing reads it as two segments; the `@`
    // stays literal, which is the form npm's own client sends.
    expect(nameForUrl("npm", "@crewhaus/tool-registry")).toBe("@crewhaus%2Ftool-registry");
    expect(nameForUrl("npm", "left-pad")).toBe("left-pad");
  });

  test("a name that is really a path is refused, not encoded", () => {
    for (const evil of ["../-/user/me", "a/../b", "foo%2f..", "foo?x=1", "foo#frag", "a\\b"]) {
      const result = checkName("npm", evil);
      expect({ evil, ok: result.ok }).toEqual({ evil, ok: false });
    }
  });

  test("whitespace and control characters are refused", () => {
    expect(checkName("npm", " left-pad").ok).toBe(false);
    expect(checkName("crates", "ser\u0000de").ok).toBe(false);
    expect(checkName("pypi", "req uests").ok).toBe(false);
  });

  test("a legacy uppercase npm name is still readable", () => {
    // The registry serves the names it accepted years ago; refusing them here
    // would make the tool unable to answer about JSONStream.
    expect(checkName("npm", "JSONStream").ok).toBe(true);
  });

  test("PEP 503 folds the spellings of one project into one", () => {
    expect(normalizePypiName("Django_REST.framework")).toBe("django-rest-framework");
    expect(nameForUrl("pypi", "Zope.Interface")).toBe("zope-interface");
    expect(namesMatch("pypi", "ruamel.yaml", "ruamel-yaml")).toBe(true);
    expect(namesMatch("npm", "Left-Pad", "left-pad")).toBe(false);
  });

  test("a scope with no package is refused", () => {
    expect(checkName("npm", "@scope").ok).toBe(false);
  });

  test("a dot-dot run is refused even where the ecosystem's own grammar allows it", () => {
    // PEP 508's name grammar accepts `a..b` — letters, dots, letters — so the
    // regex alone would let a path segment through and leave the `..` guard
    // doing nothing. It is the guard that refuses this, and nothing else.
    expect(/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test("a..b")).toBe(true);
    expect(checkName("pypi", "a..b").ok).toBe(false);
    expect(checkName("pypi", "requests..").ok).toBe(false);
  });
});

describe("range dialects", () => {
  test("a bare Cargo requirement is a caret, and reading it as npm gets it wrong", () => {
    const cargo = toNpmRange("crates", "1");
    expect(cargo).toEqual({ ok: true, range: "^1" });
    // The whole reason this translation exists: `serde = "1"` allows 1.9.0.
    expect(versionSatisfies("1.9.0", "^1")).toBe(true);
    expect(versionSatisfies("1.9.0", "1")).toBe(false);
  });

  test("Cargo commas become whitespace, wildcards are left alone", () => {
    expect(toNpmRange("crates", ">=1.2, <2")).toEqual({ ok: true, range: ">=1.2 <2" });
    expect(toNpmRange("crates", "1.*")).toEqual({ ok: true, range: "1.*" });
    expect(toNpmRange("crates", "*")).toEqual({ ok: true, range: "*" });
  });

  test("PEP 440 compatible releases expand to the bound they mean", () => {
    expect(toNpmRange("pypi", "~=1.4.2")).toEqual({ ok: true, range: ">=1.4.2 <1.5.0" });
    expect(toNpmRange("pypi", "~=1.4")).toEqual({ ok: true, range: ">=1.4 <2.0.0" });
    expect(versionSatisfies("1.4.9", ">=1.4.2 <1.5.0")).toBe(true);
    expect(versionSatisfies("1.5.0", ">=1.4.2 <1.5.0")).toBe(false);
  });

  test("PEP 440 operators without an equivalent are refused with the reason", () => {
    const notEqual = toNpmRange("pypi", "!=1.0");
    expect(notEqual.ok).toBe(false);
    expect(notEqual.ok === false && notEqual.reason).toContain("!=");
    const arbitrary = toNpmRange("pypi", "===1.0+local");
    expect(arbitrary.ok).toBe(false);
    const epoch = toNpmRange("pypi", ">=1!2.0");
    expect(epoch.ok === false && epoch.reason).toContain("epoch");
  });

  test("PEP 440 wildcards and comma lists translate", () => {
    expect(toNpmRange("pypi", "==1.4.*")).toEqual({ ok: true, range: "1.4.x" });
    expect(toNpmRange("pypi", ">=2.0,<3")).toEqual({ ok: true, range: ">=2.0 <3" });
  });

  test("a location is not a range, in any dialect", () => {
    for (const spec of ["workspace:*", "file:../x", "git+https://x/y", "npm:other@^1"]) {
      const result = toNpmRange("npm", spec);
      expect({ spec, ok: result.ok }).toEqual({ spec, ok: false });
    }
    expect(toNpmRange("npm", "latest").ok).toBe(false);
  });

  test("a hyphen range is refused rather than split into nonsense", () => {
    expect(toNpmRange("npm", "1.2.3 - 2.0.0").ok).toBe(false);
  });

  test("a PyPI prerelease is not mistaken for its own release", () => {
    // parseSemver is unanchored, so `1.0rc1` would read as 1.0.0 and compare
    // equal to 1.0 — the exact trap this guard exists for.
    expect(isSemverShaped("1.0rc1")).toBe(false);
    expect(isSemverShaped("1.0.post1")).toBe(false);
    expect(isSemverShaped("2023.7.22")).toBe(true);
    expect(isSemverShaped("1.2.3-rc.1")).toBe(true);
    expect(isSemverShaped("1.2.3+build.5")).toBe(true);
    expect(versionSatisfies("1.0rc1", "*")).toBeUndefined();
    expect(highestVersion(["1.0", "1.0rc1", "1.0.post1"])).toBe("1.0");
  });

  test("the highest satisfying version skips prereleases unless invited", () => {
    const versions = ["1.0.0", "1.2.0", "1.3.0-rc.1", "2.0.0"];
    expect(highestSatisfying(versions, "^1")).toBe("1.2.0");
    expect(highestSatisfying(versions, "^1", true)).toBe("1.3.0-rc.1");
    expect(highestSatisfying(versions, "^3")).toBeUndefined();
  });

  test("newest-first is version order, not string order", () => {
    // `.sort()` would put 1.10.0 before 1.9.0 ascending, so a "newest first"
    // list built on it shows the OLDER release at the top of every package
    // that has reached a two-digit minor.
    expect(sortVersionsDescending(["1.9.0", "1.10.0", "1.2.0"])).toEqual([
      "1.10.0",
      "1.9.0",
      "1.2.0",
    ]);
    // Versions that do not order keep a deterministic place at the end.
    expect(sortVersionsDescending(["1.0", "2024.1rc1", "2.0"])).toEqual([
      "2.0",
      "1.0",
      "2024.1rc1",
    ]);
  });

  test("a Poetry constraint is not a PEP 440 specifier, and reading it as one loses the row", () => {
    // `^2.31` is the single most common thing in a [tool.poetry.dependencies]
    // table and PEP 440 does not define `^` at all. Read as PEP 440 it is
    // unevaluable, which puts the whole project in "unchecked" and leaves the
    // outdated count at zero — indistinguishable from "nothing to upgrade".
    const asPep440 = toNpmRange("pypi", "^2.31");
    expect(asPep440.ok).toBe(false);
    expect(asPep440.ok === false && asPep440.reason).toContain("Poetry");
    const asPoetry = toNpmRangeIn("poetry", "^2.31");
    expect(asPoetry).toEqual({ ok: true, range: ">=2.31 <3.0.0" });
    expect(versionSatisfies("2.32.3", ">=2.31 <3.0.0")).toBe(true);
    expect(versionSatisfies("3.0.0", ">=2.31 <3.0.0")).toBe(false);
  });

  test("Poetry's caret widens to the first non-zero segment the author wrote", () => {
    // Poetry's documented rule, and the reason the bound is computed from the
    // segments rather than handed to the shared `^`: that comparator reads
    // every version as three segments, so `^0` would arrive as `^0.0.0` and
    // pin the patch.
    const cases: Array<[string, string]> = [
      ["^1.2.3", ">=1.2.3 <2.0.0"],
      ["^1.2", ">=1.2 <2.0.0"],
      ["^1", ">=1 <2.0.0"],
      ["^0.2.3", ">=0.2.3 <0.3.0"],
      ["^0.0.3", ">=0.0.3 <0.0.4"],
      ["^0.0", ">=0.0 <0.1.0"],
      ["^0", ">=0 <1.0.0"],
    ];
    for (const [spec, range] of cases) {
      expect({ spec, got: toNpmRangeIn("poetry", spec) }).toEqual({
        spec,
        got: { ok: true, range },
      });
    }
    // Checked against the bound rather than against the translation: 0.3.0 is
    // the release `^0.2.3` must not reach.
    expect(versionSatisfies("0.2.9", ">=0.2.3 <0.3.0")).toBe(true);
    expect(versionSatisfies("0.3.0", ">=0.2.3 <0.3.0")).toBe(false);
    expect(versionSatisfies("0.9.0", ">=0 <1.0.0")).toBe(true);
  });

  test("Poetry's tilde depends on how many segments were written", () => {
    expect(toNpmRangeIn("poetry", "~1.2.3")).toEqual({ ok: true, range: ">=1.2.3 <1.3.0" });
    expect(toNpmRangeIn("poetry", "~1.2")).toEqual({ ok: true, range: ">=1.2 <1.3.0" });
    expect(toNpmRangeIn("poetry", "~1")).toEqual({ ok: true, range: ">=1 <2.0.0" });
    // `~1` allows minor-level change and `~1.2` does not — the distinction the
    // shared `~` comparator cannot make, because it sees 1.0.0 either way.
    expect(versionSatisfies("1.5.0", ">=1 <2.0.0")).toBe(true);
    expect(versionSatisfies("1.5.0", ">=1.2 <1.3.0")).toBe(false);
    expect(versionSatisfies("1.5.0", "~1")).toBe(false);
  });

  test("a bare Poetry version is an exact pin, not a floor", () => {
    expect(toNpmRangeIn("poetry", "2.31")).toEqual({ ok: true, range: "=2.31" });
    expect(versionSatisfies("2.32.3", "=2.31")).toBe(false);
    expect(toNpmRangeIn("poetry", "*")).toEqual({ ok: true, range: "*" });
    expect(toNpmRangeIn("poetry", "1.2.*")).toEqual({ ok: true, range: "1.2.x" });
    expect(toNpmRangeIn("poetry", ">=1.0,<2.0")).toEqual({ ok: true, range: ">=1.0 <2.0" });
    expect(toNpmRangeIn("poetry", "^1.0 || ^2.0")).toEqual({
      ok: true,
      range: ">=1.0 <2.0.0||>=2.0 <3.0.0",
    });
  });

  test("a Poetry constraint this package cannot order is refused, not guessed", () => {
    for (const spec of ["!=1.0", "^1.2.3.4", "^1.0rc1", "^nightly"]) {
      const result = toNpmRangeIn("poetry", spec);
      expect({ spec, ok: result.ok }).toEqual({ spec, ok: false });
    }
    // A four-segment PEP 440 release is the sharp one: `parseSemver` reads
    // 1.2.3.4 as 1.2.3, so a bound computed from it would be a whole release
    // series out.
    expect(toNpmRangeIn("poetry", "^1.2.3.4").ok).toBe(false);
    // And a segment past 2^53, which the digit pattern happily matches and
    // `Number` then rounds, so `bound = segment + 1` would be the same number.
    expect(Number("99999999999999999999") + 1).toBe(Number("99999999999999999999"));
    expect(toNpmRangeIn("poetry", "^99999999999999999999.0").ok).toBe(false);
  });

  test("the gap between two versions is named, or reported as unknown", () => {
    expect(versionDelta("1.2.3", "2.0.0")).toBe("major");
    expect(versionDelta("1.2.3", "1.3.0")).toBe("minor");
    expect(versionDelta("1.2.3", "1.2.4")).toBe("patch");
    expect(versionDelta("1.2.3", "1.2.3")).toBe("same");
    expect(versionDelta("2.0.0", "1.0.0")).toBe("downgrade");
    expect(versionDelta("1.0.post1", "1.1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("the TOML locator", () => {
  const cargo = `# a comment nobody should lose
[package]
name = "demo"

[dependencies]
serde = { version = "1.0", features = ["derive"] } # keep me
anyhow = "1"                                       # and me
tokio.version = "1.35"
'quoted' = '2.0'

[dependencies.regex]
version = "1.10"

[[bin]]
name = "demo"
`;

  test("every spelling is found, with its own span", () => {
    const scan = scanToml(cargo);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(lookupPath(scan, ["dependencies", "anyhow"])).toHaveLength(1);
    expect(lookupPath(scan, ["dependencies", "tokio", "version"])).toHaveLength(1);
    expect(lookupPath(scan, ["dependencies", "regex", "version"])).toHaveLength(1);
    expect(scan.tables.some((t) => t.arrayOfTables && t.path[0] === "bin")).toBe(true);
  });

  test("a hash inside a string is not a comment, and a bracket inside one is not a header", () => {
    const scan = scanToml(`[x]\na = "value # not a comment"\nb = "[not a header]"\nc = 1\n`);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.tables).toHaveLength(1);
    expect(scan.tables[0]?.entries.map((e) => e.keyParts[0])).toEqual(["a", "b", "c"]);
  });

  test("an unterminated string stops the scan with a reason instead of guessing", () => {
    const scan = scanToml(`[deps]\nbroken = "1.0\nnext = "2.0"\n`);
    expect(scan.ok).toBe(false);
    expect(scan.ok === false && scan.reason).toContain("line");
  });

  test("an array spanning lines, with comments inside it, is one value", () => {
    const scan = scanToml(
      `[project]\ndependencies = [\n  # why\n  "a>=1",\n  "b",\n]\nname = "x"\n`,
    );
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const entries = scan.tables[0]?.entries ?? [];
    expect(entries.map((e) => e.keyParts[0])).toEqual(["dependencies", "name"]);
    const array = entries[0];
    expect(array?.kind).toBe("array");
  });

  test("an inline table's fields keep their original offsets", () => {
    const scan = scanToml(cargo);
    if (!scan.ok) return;
    const serde = lookupPath(scan, ["dependencies", "serde"])[0];
    expect(serde).toBeDefined();
    if (serde === undefined) return;
    const fields = inlineTableEntries(cargo, serde.entry.valueSpan);
    expect(fields?.map((f) => f.keyParts[0])).toEqual(["version", "features"]);
    const version = fields?.[0];
    if (version === undefined) return;
    expect(cargo.slice(version.valueSpan.start, version.valueSpan.end)).toBe('"1.0"');
  });

  test("a literal string keeps its quote style", () => {
    const scan = scanToml(cargo);
    if (!scan.ok) return;
    const quoted = lookupPath(scan, ["dependencies", "quoted"])[0];
    expect(quoted).toBeDefined();
    if (quoted === undefined) return;
    const inner = stringInner(cargo, quoted.entry.kind, quoted.entry.valueSpan);
    expect(inner?.quote).toBe("'");
    expect(cargo.slice(inner?.inner.start, inner?.inner.end)).toBe("2.0");
  });

  test("an array holding anything but plain strings refuses to enumerate", () => {
    const scan = scanToml(`[dependency-groups]\ndev = ["pytest>=8", {include-group = "x"}]\n`);
    if (!scan.ok) return;
    const entry = scan.tables[0]?.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(
      stringArrayElements(
        `[dependency-groups]\ndev = ["pytest>=8", {include-group = "x"}]\n`,
        entry.valueSpan,
      ),
    ).toBeNull();
  });
});

describe("the JSON locator", () => {
  const pkg = `{\n  "name": "demo",\n  "dependencies": {\n    "left-pad": "^1.3.0",\n    "zod": "3.23.8"\n  }\n}\n`;

  test("a member's value span is exactly its bytes", () => {
    const found = locateJsonMember(pkg, ["dependencies", "left-pad"]);
    expect(found.ok).toBe(true);
    if (!found.ok || found.inner === undefined) return;
    expect(pkg.slice(found.inner.start, found.inner.end)).toBe("^1.3.0");
  });

  test("a missing member says which segment was missing", () => {
    const found = locateJsonMember(pkg, ["devDependencies", "x"]);
    expect(found.ok).toBe(false);
    expect(found.ok === false && found.kind).toBe("missing");
    expect(found.ok === false && found.reason).toContain("devDependencies");
  });

  test("a key declared twice is refused rather than resolved", () => {
    const dupe = `{"dependencies":{"a":"1","a":"2"}}`;
    const found = locateJsonMember(dupe, ["dependencies", "a"]);
    expect(found.ok === false && found.kind).toBe("duplicate");
  });

  test("a non-string value is located but marked as one", () => {
    const odd = `{"dependencies":{"a":{"version":"1"}}}`;
    const found = locateJsonMember(odd, ["dependencies", "a"]);
    expect(found.ok && found.isString).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("reading a manifest", () => {
  test("package.json is read section by section, and a non-string entry is skipped", () => {
    const text = `{
  "dependencies": { "a": "^1.0.0" },
  "devDependencies": { "b": "~2.0.0", "c": { "version": "3" } },
  "peerDependencies": { "d": ">=4" }
}`;
    const sites = collectSites("package.json", text);
    expect(sites.ok).toBe(true);
    if (!sites.ok) return;
    expect(sites.sites.map((s) => `${s.section}/${s.name}=${s.spec}`)).toEqual([
      "dependencies/a=^1.0.0",
      "devDependencies/b=~2.0.0",
      "peerDependencies/d=>=4",
    ]);
    expect(sites.skipped[0]).toMatchObject({ name: "c", section: "devDependencies" });
  });

  test("a Cargo dependency with no version is skipped with the reason, not rewritten", () => {
    const text = `[dependencies]\nlocal = { path = "../local" }\ngitdep = { git = "https://x/y" }\nws = { workspace = true }\n`;
    const sites = collectSites("Cargo.toml", text);
    if (!sites.ok) return;
    expect(sites.sites).toHaveLength(0);
    expect(sites.skipped.map((s) => s.name).sort()).toEqual(["gitdep", "local", "ws"]);
    expect(sites.skipped.every((s) => s.reason.includes("no version"))).toBe(true);
  });

  test("PEP 621 requirements, extras and markers are located to the specifier", () => {
    const text = `[project]
dependencies = [
  "requests>=2.31,<3",
  "httpx[http2]==0.27.0 ; python_version >= '3.9'",
  "tomli",
  "mypkg @ https://example.invalid/mypkg.whl",
]
`;
    const sites = collectSites("pyproject.toml", text);
    if (!sites.ok) return;
    const byName = Object.fromEntries(sites.sites.map((s) => [s.name, s]));
    expect(byName["requests"]?.spec).toBe(">=2.31,<3");
    expect(byName["httpx"]?.spec).toBe("==0.27.0");
    // A requirement with no specifier has an EMPTY span, which is where a new
    // one is inserted rather than appended at the end of the line.
    expect(byName["tomli"]?.spec).toBe("");
    expect(byName["tomli"]?.specSpan.start).toBe(byName["tomli"]?.specSpan.end ?? -1);
    expect(sites.skipped.some((s) => s.reason.includes("URL"))).toBe(true);
  });

  test("Poetry's tables are read like Cargo's, interpreter and all", () => {
    const text = `[tool.poetry.dependencies]\npython = "^3.11"\nrequests = { version = "^2.31", extras = ["socks"] }\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n`;
    const sites = collectSites("pyproject.toml", text);
    if (!sites.ok) return;
    expect(sites.sites.map((s) => s.name).sort()).toEqual(["pytest", "python", "requests"]);
    expect(sites.sites.find((s) => s.name === "pytest")?.section).toBe(
      "tool.poetry.group.dev.dependencies",
    );
  });

  test("a file that does not scan is refused whole", () => {
    expect(collectSites("Cargo.toml", `[dependencies]\nbroken = "1.0\n`).ok).toBe(false);
    expect(collectSites("package.json", "{not json").ok).toBe(false);
  });

  test("requirement parsing refuses a URL requirement and keeps the marker out of the span", () => {
    expect(parseRequirement("mypkg @ https://x/y.whl")).toBeNull();
    const parsed = parseRequirement("httpx[http2]>=0.27 ; python_version >= '3.9'");
    expect(parsed?.name).toBe("httpx");
    expect(parsed?.spec).toBe(">=0.27");
  });

  test("one pyproject.toml holds two grammars, and each site says which it is", () => {
    const text = `[project]\ndependencies = ["requests>=2.31"]\n\n[tool.poetry.dependencies]\nhttpx = "^0.27"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n`;
    const sites = collectSites("pyproject.toml", text);
    expect(sites.ok).toBe(true);
    if (!sites.ok) return;
    const byName = Object.fromEntries(sites.sites.map((site) => [site.name, site.dialect]));
    expect(byName).toEqual({ requests: "pep440", httpx: "poetry", pytest: "poetry" });
    // Cargo and package.json have one grammar each, from the file.
    expect(dialectForSection("Cargo.toml", "dependencies")).toBe("cargo");
    expect(dialectForSection("package.json", "devDependencies")).toBe("npm");
    expect(dialectForSection("pyproject.toml", "dependency-groups.dev")).toBe("pep440");
  });

  test("a dependency declared twice in one TOML table is skipped, with both lines", () => {
    // A duplicate key is a file a real TOML parser rejects outright. Taking
    // the first silently edits one of the two and leaves the manifest still
    // saying two different things about the same crate.
    const text = `[dependencies]\nserde = "1.0"\nanyhow = "1"\nserde = "2.0"\n`;
    const sites = collectSites("Cargo.toml", text);
    expect(sites.ok).toBe(true);
    if (!sites.ok) return;
    expect(sites.sites.map((site) => site.name)).toEqual(["anyhow"]);
    const dupe = sites.skipped.find((entry) => entry.name === "serde");
    expect(dupe?.reason).toContain("declared 2 times");
    expect(dupe?.reason).toContain("lines 2, 4");
  });

  test("a spec written with an escape is skipped rather than reported as its raw text", () => {
    // The raw bytes of `^1.0.0\u0020` are not the range the manifest means,
    // and reporting them as the declared spec would compare the wrong string
    // and splice next to an escape boundary.
    const json = `{"dependencies":{"a":"^1.0.0\\u0020"}}`;
    const npm = collectSites("package.json", json);
    expect(npm.ok).toBe(true);
    if (!npm.ok) return;
    expect(npm.sites).toHaveLength(0);
    expect(npm.skipped[0]?.reason).toContain("JSON escape");

    const cargo = collectSites("Cargo.toml", `[dependencies]\nserde = "1.0\\u002E5"\n`);
    expect(cargo.ok).toBe(true);
    if (!cargo.ok) return;
    expect(cargo.sites).toHaveLength(0);
    expect(cargo.skipped[0]?.reason).toContain("TOML escape");
  });

  test("the manifest kind comes from the filename, and nothing else is accepted", () => {
    expect(manifestKind("package.json")).toBe("package.json");
    expect(manifestKind("Cargo.toml")).toBe("Cargo.toml");
    expect(manifestKind("go.mod")).toBeUndefined();
    expect(manifestKind("requirements.txt")).toBeUndefined();
  });
});

describe("range style", () => {
  test("a single prefix is carried onto a bare version", () => {
    expect(reapplyStyle("^1.2.0", "1.3.0")).toEqual({ spec: "^1.3.0", preserved: true });
    expect(reapplyStyle("~1.2.0", "1.3.0")).toEqual({ spec: "~1.3.0", preserved: true });
    expect(reapplyStyle(">=1.2.0", "1.3.0")).toEqual({ spec: ">=1.3.0", preserved: true });
    expect(reapplyStyle("1.2.0", "1.3.0")).toEqual({ spec: "1.3.0", preserved: true });
  });

  test("anything that is not a single prefix is written verbatim and said so", () => {
    for (const previous of [">=1 <3", "1.x", "workspace:*", "npm:alias@^2", ">=2,<3"]) {
      const styled = reapplyStyle(previous, "1.3.0");
      expect({ previous, spec: styled.spec, preserved: styled.preserved }).toEqual({
        previous,
        spec: "1.3.0",
        preserved: false,
      });
      expect(styled.note).toBeDefined();
    }
  });

  test("an exclusive bound is not carried onto the new version", () => {
    // Carrying `<` writes a range that EXCLUDES the version the caller asked
    // to set — the tool would report stylePreserved:true over a manifest that
    // still cannot install 2.5.0.
    expect(versionSatisfies("2.5.0", "<2.5.0")).toBe(false);
    expect(versionSatisfies("2.5.0", ">2.5.0")).toBe(false);
    for (const previous of ["<2.0.0", ">1.0.0"]) {
      const styled = reapplyStyle(previous, "2.5.0");
      expect({ previous, spec: styled.spec, preserved: styled.preserved }).toEqual({
        previous,
        spec: "2.5.0",
        preserved: false,
      });
      expect(styled.note).toContain("excludes 2.5.0");
    }
    // `<=` still admits the version it is moved to, so it is carried.
    expect(reapplyStyle("<=2.0.0", "2.5.0")).toEqual({ spec: "<=2.5.0", preserved: true });
    expect(versionSatisfies("2.5.0", "<=2.5.0")).toBe(true);
  });

  test("a new spec with its own operator wins over the old style", () => {
    const styled = reapplyStyle("^1.0.0", ">=2.0.0");
    expect(styled).toMatchObject({ spec: ">=2.0.0", preserved: false });
  });
});

describe("the last gate before bytes are written", () => {
  test("a spec that would break out of its quotes is refused", () => {
    expect(checkSpecText('1.0", "evil": "9', '"')).toContain("double quote");
    expect(checkSpecText("1.0' }", "'")).toContain("single quote");
    expect(checkSpecText("1.0 # nope", '"')).toContain("comment");
    expect(checkSpecText("1.0\\n", '"')).toContain("backslash");
    expect(checkSpecText("1.0\n2.0", '"')).toContain("control character");
    expect(checkSpecText(" 1.0 ", '"')).toContain("whitespace");
    expect(checkSpecText("", '"')).toContain("empty");
  });

  test("an ordinary range passes", () => {
    expect(checkSpecText("^1.2.3", '"')).toBeUndefined();
    expect(checkSpecText(">=2.0,<3", '"')).toBeUndefined();
  });
});

/** The splice `ManifestDependencySet` performs, so a test can perform it wrong on purpose. */
function splice(text: string, start: number, end: number, replacement: string): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

describe("verifying a splice before it is written", () => {
  const before = `{\n  "dependencies": { "a": "^1.0.0", "b": "^2.0.0" }\n}\n`;

  test("a correct splice verifies", () => {
    const sites = collectSites("package.json", before);
    if (!sites.ok) return;
    const site = sites.sites[0];
    if (site === undefined) return;
    const after = splice(before, site.specSpan.start, site.specSpan.end, "^1.1.0");
    expect(
      verifySplice("package.json", after, {
        sites: sites.sites,
        skipped: sites.skipped,
        edits: [{ site, spec: "^1.1.0" }],
      }),
    ).toEqual({ ok: true });
  });

  test("a splice that lands on the wrong bytes is caught before anything is written", () => {
    const sites = collectSites("package.json", before);
    if (!sites.ok) return;
    const site = sites.sites[0];
    if (site === undefined) return;
    // Off by one: the splice eats the closing quote, which is exactly the
    // arithmetic mistake this check exists for.
    const after = splice(before, site.specSpan.start, site.specSpan.end + 1, "^1.1.0");
    const verdict = verifySplice("package.json", after, {
      sites: sites.sites,
      skipped: sites.skipped,
      edits: [{ site, spec: "^1.1.0" }],
    });
    expect(verdict.ok).toBe(false);
  });

  test("two requirements for one package are kept apart, not folded into one row", () => {
    // A marker-conditional pair is one of the few places a manifest declares
    // the same name twice in one list. A verification keyed by name would see
    // one row and stop noticing which of the two moved.
    const text = `[project]\ndependencies = ["tomli>=1 ; python_version < '3.11'", "tomli>=2 ; python_version >= '3.11'"]\n`;
    const sites = collectSites("pyproject.toml", text);
    if (!sites.ok) return;
    expect(sites.sites).toHaveLength(2);
    const [first, second] = sites.sites;
    if (first === undefined || second === undefined) return;
    // Edit the FIRST, but splice the second: the check must catch it.
    const after = splice(text, second.specSpan.start, second.specSpan.end, ">=3");
    const verdict = verifySplice("pyproject.toml", after, {
      sites: sites.sites,
      skipped: sites.skipped,
      edits: [{ site: first, spec: ">=1.1" }],
    });
    expect(verdict.ok).toBe(false);
  });

  test("a splice that changes a dependency it was not asked about is caught", () => {
    const sites = collectSites("package.json", before);
    if (!sites.ok) return;
    const [first, second] = sites.sites;
    if (first === undefined || second === undefined) return;
    const after = splice(before, second.specSpan.start, second.specSpan.end, "^9.9.9");
    const verdict = verifySplice("package.json", after, {
      sites: sites.sites,
      skipped: sites.skipped,
      edits: [{ site: first, spec: "^1.1.0" }],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('not "^1.1.0"');
  });
});

// ---------------------------------------------------------------------------

describe("the request path", () => {
  test("a 404 is an answer about the package, not a transport failure", async () => {
    stubFetch({ "https://registry.npmjs.org/nope": { status: 404 } });
    const got = await getJson("https://registry.npmjs.org/nope");
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.kind).toBe("notFound");
  });

  test("a 429 says so, and passes on how long the registry asked for", async () => {
    stubFetch({
      "https://crates.io/api/v1/crates/serde": {
        status: 429,
        headers: { "retry-after": "60" },
      },
    });
    const got = await getJson("https://crates.io/api/v1/crates/serde");
    expect(got.ok === false && got.kind).toBe("rateLimited");
    expect(got.ok === false && got.retryAfter).toBe("60");
    expect(got.ok === false && got.message).toContain("does not retry");
  });

  test("a redirect inside the registry is followed", async () => {
    stubFetch({
      "https://pypi.org/pypi/Flask/json": {
        status: 301,
        headers: { location: "https://pypi.org/pypi/flask/json" },
      },
      "https://pypi.org/pypi/flask/json": { body: `{"info":{"version":"3.0.0"}}` },
    });
    const got = await getJson("https://pypi.org/pypi/Flask/json");
    expect(got.ok).toBe(true);
  });

  test("a redirect OUT of the registry origins is refused, and says why", async () => {
    const stub = stubFetch({
      "https://registry.npmjs.org/left-pad": {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      },
    });
    const got = await getJson("https://registry.npmjs.org/left-pad");
    expect(got.ok).toBe(false);
    // A timeout would also produce ok:false, so the reason is what is asserted.
    expect(got.ok === false && got.kind).toBe("refused");
    expect(got.ok === false && got.message).toContain("refusing a redirect");
    expect(stub.calls).toEqual(["https://registry.npmjs.org/left-pad"]);
  });

  test("a redirect loop stops at the cap", async () => {
    _setRegistryFetch(async (req) => {
      const next = new URL(req.url);
      next.searchParams.set("hop", String(Number(next.searchParams.get("hop") ?? "0") + 1));
      return new Response("", { status: 302, headers: { location: next.toString() } });
    });
    const got = await getJson("https://registry.npmjs.org/loop");
    expect(got.ok === false && got.message).toContain("too many redirects");
  });

  test("a body over the cap is refused rather than parsed from its prefix", async () => {
    const huge = `{"versions":{${Array.from({ length: 200 }, (_, i) => `"1.0.${i}":{}`).join(",")}}}`;
    stubFetch({ "https://registry.npmjs.org/big": { body: huge } });
    const got = await getJson("https://registry.npmjs.org/big", { maxBytes: 64 });
    expect(got.ok === false && got.kind).toBe("tooLarge");
    expect(got.ok === false && got.message).toContain("prefix");
  });

  test("a non-JSON answer is reported as malformed with its size", async () => {
    stubFetch({ "https://crates.io/api/v1/crates/x": { body: "<html>maintenance</html>" } });
    const got = await getJson("https://crates.io/api/v1/crates/x");
    expect(got.ok === false && got.kind).toBe("malformed");
  });

  test("a URL outside the three registries never reaches the network", async () => {
    const stub = stubFetch({});
    await expect(getJson("https://evil.invalid/x")).rejects.toBeInstanceOf(RegistryError);
    expect(stub.calls).toEqual([]);
  });

  test("a dialler that refuses on SSRF grounds is a refusal, not a transport failure", async () => {
    // The production dialler resolves the name and throws FetchPermissionError
    // when the answer is somewhere it will not go. Reported as "transport" a
    // caller reads it as "the registry was unreachable" and retries, which is
    // the one thing that cannot help.
    _setRegistryFetch(async () => {
      const error = new Error('SSRF: host "registry.npmjs.org" resolves to private IP 127.0.0.1');
      error.name = "FetchPermissionError";
      throw error;
    });
    const got = await getJson("https://registry.npmjs.org/left-pad");
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.kind).toBe("refused");
    expect(got.ok === false && got.message).toContain("SSRF");
  });

  test("an aborted call reports the deadline, not a bare failure", async () => {
    _setRegistryFetch(async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (req.signal.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return new Response("{}");
    });
    const deadline = startDeadline(5);
    const got = await getJson("https://registry.npmjs.org/slow", { signal: deadline.signal });
    deadline.cancel();
    expect(got.ok === false && got.kind).toBe("transport");
    expect(got.ok === false && got.message).toContain("deadline");
  });

  test("every request identifies itself, because crates.io refuses anonymous agents", async () => {
    const seen: Array<string | null> = [];
    _setRegistryFetch(async (req) => {
      seen.push(req.headers.get("user-agent"));
      return new Response("{}");
    });
    await getJson("https://crates.io/api/v1/crates/serde");
    expect(seen[0]).toContain("crewhaus-tool-registry");
  });

  test("a capped read keeps the bytes that fit and says when it stopped", async () => {
    const res = new Response("abcdefghij");
    const body = await readCapped(res, 4);
    expect(body.truncated).toBe(true);
    const whole = await readCapped(new Response("abcd"), 4);
    expect(whole).toMatchObject({ text: "abcd", truncated: false });
  });
});

describe("the fan-out pool", () => {
  test("results keep input order however the answers arrive", async () => {
    const out = await mapPool([5, 1, 4, 2, 3], 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
  });

  test("no more than the limit are ever in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return 0;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------

describe("normalizing what each registry says", () => {
  test("npm: deprecation is per version, and the one that matters is the latest", () => {
    const facts = readNpm("old-pkg", {
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "1.0.0": { version: "1.0.0" },
        "2.0.0": {
          version: "2.0.0",
          deprecated: "use new-pkg",
          license: "MIT",
          repository: { url: "git+https://github.com/x/y.git" },
        },
      },
      time: { "2.0.0": "2026-01-01T00:00:00.000Z" },
    });
    expect(facts).toMatchObject({
      ok: true,
      latest: "2.0.0",
      deprecated: "use new-pkg",
      license: "MIT",
      repository: "git+https://github.com/x/y.git",
      latestPublishedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("pypi: a release with no files is not installable and is not offered", () => {
    const facts = readPypi("demo", {
      info: {
        version: "2.0",
        summary: "s",
        classifiers: ["License :: OSI Approved :: MIT License"],
      },
      releases: {
        "1.0": [{ yanked: false, upload_time_iso_8601: "2020-01-01T00:00:00Z" }],
        "1.5": [],
        "1.9": [{ yanked: true }],
        "2.0": [{ yanked: false, upload_time_iso_8601: "2026-01-01T00:00:00Z" }],
      },
    });
    expect(facts.ok && facts.versions).toEqual(["1.0", "2.0"]);
    expect(facts.ok && facts.yankedVersions).toEqual(["1.9"]);
    expect(facts.ok && facts.license).toBe("MIT License");
  });

  test("pypi: a document with no releases map says the version list is unavailable", () => {
    const facts = readPypi("demo", { info: { version: "2.0" } });
    expect(facts).toMatchObject({ ok: true, latest: "2.0", versionListUnavailable: true });
  });

  test("crates: the stable version is preferred over the newest prerelease", () => {
    const facts = readCrates("demo", {
      crate: { max_version: "2.0.0-beta.1", max_stable_version: "1.9.0", repository: "https://x" },
      versions: [
        { num: "2.0.0-beta.1", yanked: false },
        { num: "1.9.0", yanked: false, license: "Apache-2.0", created_at: "2026-02-02T00:00:00Z" },
        { num: "1.8.0", yanked: true },
      ],
    });
    expect(facts).toMatchObject({ ok: true, latest: "1.9.0", license: "Apache-2.0" });
    expect(facts.ok && facts.yankedVersions).toEqual(["1.8.0"]);
  });

  test("a response that is not the shape the registry documents is malformed, not empty", () => {
    expect(readNpm("x", "a string")).toMatchObject({ ok: false, kind: "malformed" });
    expect(readPypi("x", {})).toMatchObject({ ok: false, kind: "malformed" });
    expect(readCrates("x", { versions: [] })).toMatchObject({ ok: false, kind: "malformed" });
  });
});

describe("search, and what it will not pretend", () => {
  test("PyPI is refused with the reason, not scraped", async () => {
    const stub = stubFetch({});
    const result = await searchRegistry("pypi", "http client", 10, "relevance");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe("unsupported");
    expect(result.ok === false && result.message).toContain("no search API");
    expect(stub.calls).toEqual([]);
  });

  test("npm declines a downloads sort instead of re-sorting one page", async () => {
    stubFetch({
      "https://registry.npmjs.org/-/v1/search?text=left%20pad&size=2": {
        body: JSON.stringify({
          total: 900,
          objects: [
            { package: { name: "left-pad", version: "1.3.0", links: { repository: "https://x" } } },
            { package: { name: "pad-left", version: "2.1.0", links: {} } },
          ],
        }),
      },
    });
    const result = await searchRegistry("npm", "left pad", 2, "downloads");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sortApplied).toBe(false);
    expect(result.sortNote).toContain("download");
    // No download field is invented for a registry that publishes none.
    expect(result.hits.every((hit) => hit.downloads === undefined)).toBe(true);
    expect(result.hits[0]).toMatchObject({ name: "left-pad", repository: "https://x" });
  });

  test("crates.io sorts server-side, and its counts come through", async () => {
    stubFetch({
      "https://crates.io/api/v1/crates?q=serde&per_page=1&sort=downloads": {
        body: JSON.stringify({
          meta: { total: 12 },
          crates: [{ name: "serde", max_stable_version: "1.0.203", downloads: 100 }],
        }),
      },
    });
    const result = await searchRegistry("crates", "serde", 1, "downloads");
    expect(result.ok && result.sortApplied).toBe(true);
    expect(result.ok && result.hits[0]).toMatchObject({ name: "serde", downloads: 100 });
  });
});
