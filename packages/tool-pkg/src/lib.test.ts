import { afterAll, beforeAll, describe, expect, test } from "bun:test";
/**
 * The behaviour of the pure functions under `./lib`.
 *
 * The tar reader is checked against archives produced by real tools, not
 * only by a writer in this file — a reader tested only against its own
 * fixtures agrees with itself and with nothing else.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { declaredLicense, isDisjunctive, splitExpression, summarize } from "./lib/license";
import { classifyBump, diffLocks } from "./lib/lockdiff";
import { entryPoints, preflight, wouldInclude } from "./lib/preflight";
import { resolveRange } from "./lib/resolve";
import { listTar } from "./lib/tar";

describe("resolveRange", () => {
  const versions = ["1.0.0", "1.2.0", "1.9.3", "2.0.0", "2.1.0-rc.1", "0.9.0"];

  test("a caret range stays inside its major", () => {
    const result = resolveRange("^1.2.0", versions);
    expect(result.satisfying).toEqual(["1.2.0", "1.9.3"]);
    expect(result.best).toBe("1.9.3");
  });

  test("lowest picks the floor a resolver would honour", () => {
    expect(resolveRange("^1.2.0", versions, { strategy: "lowest" }).best).toBe("1.2.0");
  });

  test("a prerelease is not picked by a stable range", () => {
    const result = resolveRange(">=2.0.0", versions);
    expect(result.satisfying).toEqual(["2.0.0"]);
    expect(result.rejected).toContainEqual({ version: "2.1.0-rc.1", why: "prerelease" });
  });

  test("...unless it is asked for", () => {
    expect(resolveRange(">=2.0.0", versions, { includePrerelease: true }).best).toBe("2.1.0-rc.1");
  });

  test("a range naming a prerelease opts in by itself", () => {
    expect(resolveRange(">=2.1.0-rc.0", versions).satisfying).toContain("2.1.0-rc.1");
  });

  test("nothing satisfying is not the same as a range nobody understood", () => {
    const empty = resolveRange("^99.0.0", versions);
    expect(empty).toMatchObject({ best: null, rangeUnderstood: true });

    const nonsense = resolveRange("workspace:*", versions);
    expect(nonsense.rangeUnderstood).toBe(false);
  });

  test("unparseable versions are reported, not silently dropped", () => {
    const result = resolveRange("*", ["1.0.0", "not-a-version"]);
    expect(result.rejected).toContainEqual({ version: "not-a-version", why: "unparseable" });
  });

  test("the answer does not depend on the order the versions arrived in", () => {
    const shuffled = [...versions].reverse();
    expect(resolveRange("^1.0.0", shuffled).satisfying).toEqual(
      resolveRange("^1.0.0", versions).satisfying,
    );
  });
});

describe("classifyBump", () => {
  test("classifies each kind of move", () => {
    expect(classifyBump("1.0.0", "2.0.0")).toBe("major");
    expect(classifyBump("1.0.0", "1.1.0")).toBe("minor");
    expect(classifyBump("1.0.0", "1.0.1")).toBe("patch");
    expect(classifyBump("1.0.0-a", "1.0.0-b")).toBe("prerelease");
    expect(classifyBump("1.0.0", "1.0.0")).toBe("same");
  });

  test("a downgrade is called out rather than folded into its magnitude", () => {
    // "major" and "went backwards by a major" need different attention, and
    // a reviewer scanning counts would miss the second.
    expect(classifyBump("2.0.0", "1.0.0")).toBe("downgrade");
    expect(classifyBump("1.2.0", "1.1.0")).toBe("downgrade");
  });

  test("an unparseable side is unknown, not a guess", () => {
    expect(classifyBump("1.0.0", "next")).toBe("unknown");
  });
});

describe("diffLocks", () => {
  const before = [
    { name: "a", version: "1.0.0" },
    { name: "b", version: "2.0.0" },
    { name: "gone", version: "1.0.0" },
  ];
  const after = [
    { name: "a", version: "1.0.1" },
    { name: "b", version: "2.0.0" },
    { name: "new", version: "0.1.0" },
  ];

  test("reports what was added, removed and moved", () => {
    const diff = diffLocks(before, after);
    expect(diff.added).toEqual([{ name: "new", version: "0.1.0" }]);
    expect(diff.removed).toEqual([{ name: "gone", version: "1.0.0" }]);
    expect(diff.changed).toEqual([{ name: "a", from: "1.0.0", to: "1.0.1", bump: "patch" }]);
    expect(diff.unchanged).toBe(1);
  });

  test("the counts are what a reviewer actually reads", () => {
    const diff = diffLocks(before, after);
    expect(diff.counts).toMatchObject({ added: 1, removed: 1, patch: 1, major: 0, downgrade: 0 });
  });

  test("a package held at several versions is not collapsed to one", () => {
    // A lockfile holding two copies of a package is the normal case, and
    // keeping only one would silently drop the other.
    const diff = diffLocks(
      [{ name: "dup", version: "1.0.0" }],
      [
        { name: "dup", version: "1.0.0" },
        { name: "dup", version: "2.0.0" },
      ],
    );
    expect(diff.added).toEqual([{ name: "dup", version: "2.0.0" }]);
  });

  test("two identical lockfiles produce no changes at all", () => {
    const diff = diffLocks(before, before);
    expect(diff).toMatchObject({ added: [], removed: [], changed: [], unchanged: 3 });
  });

  test("the result does not depend on entry order", () => {
    const a = diffLocks(before, after);
    const b = diffLocks([...before].reverse(), [...after].reverse());
    expect(b.changed).toEqual(a.changed);
    expect(b.added).toEqual(a.added);
  });
});

describe("license expressions", () => {
  test("an expression splits into the identifiers a policy has to see", () => {
    expect(splitExpression("(MIT OR Apache-2.0)")).toEqual(["MIT", "Apache-2.0"]);
    expect(splitExpression("MIT AND CC-BY-4.0")).toEqual(["MIT", "CC-BY-4.0"]);
    expect(splitExpression("Apache-2.0 WITH LLVM-exception")).toEqual([
      "Apache-2.0",
      "LLVM-exception",
    ]);
  });

  test("OR is alternatives, AND is cumulative", () => {
    expect(isDisjunctive("MIT OR GPL-3.0")).toBe(true);
    expect(isDisjunctive("MIT AND GPL-3.0")).toBe(false);
  });

  test("a deny rule does not bite an expression that offers a way out", () => {
    // "MIT OR GPL-3.0" lets the consumer take MIT, so denying GPL must not
    // flag it — while "MIT AND GPL-3.0" imposes both, so it must.
    const findings = [
      {
        name: "choice",
        version: "1.0.0",
        license: "MIT OR GPL-3.0",
        identifiers: ["MIT", "GPL-3.0"],
      },
      {
        name: "both",
        version: "1.0.0",
        license: "MIT AND GPL-3.0",
        identifiers: ["MIT", "GPL-3.0"],
      },
    ];
    const report = summarize(findings, { deny: ["GPL"] });
    expect(report.violations.map((v) => v.name)).toEqual(["both"]);
  });

  test("an allow-list is satisfied by any arm of an OR and by every arm of an AND", () => {
    const findings = [
      { name: "ok", version: "1.0.0", license: "MIT OR GPL-3.0", identifiers: ["MIT", "GPL-3.0"] },
      {
        name: "bad",
        version: "1.0.0",
        license: "MIT AND GPL-3.0",
        identifiers: ["MIT", "GPL-3.0"],
      },
    ];
    const report = summarize(findings, { allow: ["MIT", "Apache-2.0"] });
    expect(report.violations.map((v) => v.name)).toEqual(["bad"]);
  });

  test("a deny prefix matches a family without matching a lookalike", () => {
    const findings = [
      { name: "gpl", version: "1", license: "GPL-3.0", identifiers: ["GPL-3.0"] },
      { name: "lgpl", version: "1", license: "LGPL-3.0", identifiers: ["LGPL-3.0"] },
    ];
    // "GPL" must not match "LGPL-3.0": they are different obligations.
    expect(summarize(findings, { deny: ["GPL"] }).violations.map((v) => v.name)).toEqual(["gpl"]);
  });

  test("copyleft and undeclared are separated, because they need different actions", () => {
    const report = summarize([
      { name: "a", version: "1", license: "GPL-3.0", identifiers: ["GPL-3.0"] },
      { name: "b", version: "1", license: "", identifiers: [] },
      { name: "c", version: "1", license: "MIT", identifiers: ["MIT"] },
    ]);
    expect(report.copyleft.map((f) => f.name)).toEqual(["a"]);
    expect(report.undeclared.map((f) => f.name)).toEqual(["b"]);
    expect(report.counts[0]).toMatchObject({ count: 1 });
  });

  test("the deprecated licenses array is still read", () => {
    // Treating these as undeclared would send a human to look at a package
    // that did say what it was.
    expect(declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "MIT OR Apache-2.0",
    );
    expect(declaredLicense({ license: { type: "ISC" } })).toBe("ISC");
    expect(declaredLicense({})).toBe("");
  });
});

describe("preflight", () => {
  const nothing = { exists: () => false, isDirectory: () => false };
  const everything = { exists: () => true, isDirectory: () => false };

  test("a workspace range is blocking, because no registry client can resolve it", () => {
    const report = preflight(
      { name: "p", version: "1.0.0", dependencies: { dep: "workspace:*" } },
      everything,
    );
    expect(report.ok).toBe(false);
    expect(report.blocking.map((p) => p.id)).toContain("unpublishable-range");
  });

  test("file:, link: and portal: ranges are caught too", () => {
    for (const range of ["file:../x", "link:../x", "portal:../x"]) {
      const report = preflight(
        { name: "p", version: "1.0.0", dependencies: { d: range } },
        everything,
      );
      expect({ range, ok: report.ok }).toEqual({ range, ok: false });
    }
  });

  test("an entry point that no files entry covers is blocking", () => {
    // This is the bug that ships an empty package: the file is there, the
    // tests pass, and the tarball does not contain it.
    const report = preflight(
      { name: "p", version: "1.0.0", main: "dist/index.js", files: ["src"] },
      everything,
    );
    expect(report.blocking.map((p) => p.id)).toContain("entry-excluded");
  });

  test("...and is not reported when files does cover it", () => {
    const report = preflight(
      { name: "p", version: "1.0.0", main: "dist/index.js", files: ["dist"] },
      everything,
    );
    expect(report.blocking.map((p) => p.id)).not.toContain("entry-excluded");
  });

  test("a missing entry point is blocking", () => {
    const report = preflight({ name: "p", version: "1.0.0", main: "dist/index.js" }, nothing);
    expect(report.blocking.map((p) => p.id)).toContain("entry-missing");
  });

  test("private: true is blocking, since npm will refuse the publish", () => {
    const report = preflight({ name: "p", version: "1.0.0", private: true }, everything);
    expect(report.blocking.map((p) => p.id)).toContain("private-true");
  });

  test("a bad version is caught", () => {
    expect(
      preflight({ name: "p", version: "1.0" }, everything).blocking.map((p) => p.id),
    ).toContain("version-invalid");
    expect(preflight({ name: "p" }, everything).blocking.map((p) => p.id)).toContain(
      "version-missing",
    );
  });

  test("a secret file that would ship is blocking; one that would not is a warning", () => {
    const withEnv = { exists: (rel: string) => rel === ".env", isDirectory: () => false };
    const shipped = preflight({ name: "p", version: "1.0.0" }, withEnv);
    expect(shipped.blocking.map((p) => p.id)).toContain("secret-file");

    const excluded = preflight({ name: "p", version: "1.0.0", files: ["dist"] }, withEnv);
    expect(excluded.warnings.map((p) => p.id)).toContain("secret-file");
    expect(excluded.blocking.map((p) => p.id)).not.toContain("secret-file");
  });

  test("a clean package passes", () => {
    const report = preflight(
      {
        name: "p",
        version: "1.0.0",
        license: "MIT",
        main: "dist/index.js",
        files: ["dist"],
        repository: { type: "git", url: "https://example.invalid/p" },
      },
      { exists: (rel) => rel !== ".env" && !rel.startsWith("."), isDirectory: () => false },
    );
    expect(report.blocking).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("entryPoints finds every declared target, including nested exports", () => {
    const found = entryPoints({
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      bin: { tool: "./bin/cli.js" },
      exports: { ".": { import: "./dist/esm.js", require: "./dist/cjs.js" } },
    });
    expect(found).toEqual([
      "dist/index.js",
      "dist/index.d.ts",
      "bin/cli.js",
      "dist/esm.js",
      "dist/cjs.js",
    ]);
  });

  test("a pathological files entry finishes instead of hanging", () => {
    // As a regex — each `*` becoming `[^/]*` — this never returns. A
    // preflight check that hangs on a typo is not a preflight check.
    const started = performance.now();
    expect(wouldInclude([`${"*".repeat(30)}z`], "a".repeat(40))).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("wouldInclude follows a directory entry and a simple glob", () => {
    expect(wouldInclude(["dist"], "dist/index.js")).toBe(true);
    expect(wouldInclude(["dist"], "src/index.js")).toBe(false);
    expect(wouldInclude(["*.js"], "index.js")).toBe(true);
    expect(wouldInclude(["*.js"], "nested/index.js")).toBe(false);
    // Always published whatever `files` says.
    expect(wouldInclude(["dist"], "package.json")).toBe(true);
  });
});

describe("listTar, against archives real tools produced", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tool-pkg-tar-"));
    const pkg = join(dir, "package");
    mkdirSync(join(pkg, "deep", "nested"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"x","version":"1.0.0"}');
    writeFileSync(join(pkg, "README.md"), "hello\n");
    writeFileSync(join(pkg, "deep", "nested", "big.txt"), "x".repeat(5000));
    symlinkSync("README.md", join(pkg, "link.md"));
    // A name too long for the 100-byte header field, forcing the prefix or a
    // pax/GNU extension depending on which tar wrote it.
    const longDir = join(pkg, "a".repeat(120));
    mkdirSync(longDir, { recursive: true });
    writeFileSync(join(longDir, `${"b".repeat(120)}.txt`), "long name test");
    // COPYFILE_DISABLE stops BSD tar on macOS from adding an AppleDouble
    // `._name` member beside every file. Without it the fixture differs
    // between a developer's machine and CI, and predicates below would match
    // the resource fork rather than the file.
    execFileSync("tar", ["czf", join(dir, "real.tgz"), "-C", dir, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads a gzipped archive without being told it is gzipped", () => {
    const listing = listTar(new Uint8Array(readFileSync(join(dir, "real.tgz"))));
    expect(listing.truncated).toBe(false);
    expect(listing.entries.length).toBeGreaterThan(4);
  });

  test("sizes are exact", () => {
    const listing = listTar(new Uint8Array(readFileSync(join(dir, "real.tgz"))));
    const big = listing.entries.find((e) => e.name.endsWith("big.txt"));
    expect(big?.size).toBe(5000);
  });

  test("a name past the 100-byte header field is reconstructed whole", () => {
    const listing = listTar(new Uint8Array(readFileSync(join(dir, "real.tgz"))));
    const long = listing.entries.find((e) => e.name.includes("bbbbb") && e.type === "file");
    expect(long?.name).toContain("a".repeat(120));
    expect(long?.size).toBe(14);
  });

  test("a symlink member is identified with its target, not followed", () => {
    const listing = listTar(new Uint8Array(readFileSync(join(dir, "real.tgz"))));
    const link = listing.entries.find((e) => e.type === "symlink");
    expect(link?.name).toContain("link.md");
    expect(link?.linkname).toBe("README.md");
  });

  test("truncation is reported rather than returned as a short listing", () => {
    const bytes = readFileSync(join(dir, "real.tgz"));
    // Cut the compressed stream: gunzip itself will refuse it.
    expect(() => listTar(new Uint8Array(bytes.subarray(0, bytes.length - 40)))).toThrow();
  });

  test("a truncated uncompressed archive is reported, not mistaken for the end", () => {
    execFileSync("tar", ["cf", join(dir, "plain.tar"), "-C", dir, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const bytes = readFileSync(join(dir, "plain.tar"));
    const listing = listTar(new Uint8Array(bytes.subarray(0, 512 * 3)));
    expect(listing.truncated).toBe(true);
  });

  test("random bytes are not read as entries", () => {
    // Without a checksum check, any 512 bytes can be mistaken for a header,
    // and the walk then reports garbage instead of failing.
    const junk = new Uint8Array(4096);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) % 256;
    const listing = listTar(junk);
    expect(listing.entries).toEqual([]);
    expect(listing.truncated).toBe(true);
  });

  test("a complete archive is not reported truncated", () => {
    // The counterpart to the test above: the terminator check must not turn
    // every well-formed archive into a truncated one.
    const listing = listTar(new Uint8Array(readFileSync(join(dir, "real.tgz"))));
    expect(listing.truncated).toBe(false);
  });

  test("a decompression bomb is refused instead of expanded", () => {
    // A size limit on the FILE bounds nothing: gzip of a repetitive stream
    // runs a thousand to one, so this 200 KB input expands to 200 MB, and a
    // few hundred megabytes of input expands until the process dies.
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(200 * 1024 * 1024)));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => listTar(bomb, { maxBytes: 8 * 1024 * 1024 })).toThrow(/expands past/);
    // Expands a real archive up to the refusal point.
  }, 20_000);

  test("an archive within the limit still reads", () => {
    const listing = listTar(new Uint8Array(readFileSync(join(dir, "real.tgz"))), {
      maxBytes: 64 * 1024 * 1024,
    });
    expect(listing.entries.length).toBeGreaterThan(0);
  });

  test("the entry cap stops the walk and says so", () => {
    const listing = listTar(new Uint8Array(readFileSync(join(dir, "real.tgz"))), { maxEntries: 2 });
    expect(listing.capped).toBe(true);
    expect(listing.entries).toHaveLength(2);
  });
});
