import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProvabilityLevel, levelRank, maxRung, meetsFloor, rungOfRank } from "./levels";
import {
  doiUrl,
  hostMatches,
  hostOf,
  isPrivateHost,
  normalizePath,
  normalizeUrl,
  originKey,
  registrableDomain,
} from "./origin";

describe("levels", () => {
  test("rank orders the ladder, none below it", () => {
    expect(
      ["none", "cited", "grounded", "checked", "proven"].map((r) => levelRank(r as never)),
    ).toEqual([0, 1, 2, 3, 4]);
    expect([0, 1, 2, 3, 4, 9, -1, Number.NaN].map(rungOfRank)).toEqual([
      "none",
      "cited",
      "grounded",
      "checked",
      "proven",
      "proven",
      "none",
      "none",
    ]);
  });

  test("higher-rung evidence satisfies a lower floor, never the reverse", () => {
    expect(meetsFloor("checked", "cited")).toBe(true);
    expect(meetsFloor("grounded", "grounded")).toBe(true);
    expect(meetsFloor("grounded", "checked")).toBe(false);
    expect(meetsFloor("none", "cited")).toBe(false);
  });

  test("maxRung picks the highest, none for nothing", () => {
    expect(maxRung()).toBe("none");
    expect(maxRung("cited", "proven", "grounded")).toBe("proven");
    expect(isProvabilityLevel("grounded")).toBe(true);
    expect(isProvabilityLevel("off")).toBe(false);
    expect(isProvabilityLevel("none")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  test("lowercases scheme and host, drops the default port, fragment and credentials", () => {
    expect(normalizeUrl("HTTPS://User:pw@Acme.Example:443/Policy#refunds")).toBe(
      "https://acme.example/Policy",
    );
    expect(normalizeUrl("http://acme.example:80/a")).toBe("http://acme.example/a");
    expect(normalizeUrl("http://acme.example:8080/a")).toBe("http://acme.example:8080/a");
  });

  test("folds a trailing slash but keeps the root and the query", () => {
    expect(normalizeUrl("https://acme.example/policy/")).toBe("https://acme.example/policy");
    expect(normalizeUrl("https://acme.example")).toBe("https://acme.example/");
    expect(normalizeUrl("https://acme.example/")).toBe("https://acme.example/");
    expect(normalizeUrl("https://acme.example/p/?id=2#x")).toBe("https://acme.example/p?id=2");
    expect(normalizeUrl("https://acme.example./x")).toBe("https://acme.example/x");
    expect(normalizeUrl("https://acme.example/a///")).toBe("https://acme.example/a");
    expect(normalizeUrl("https://acme.example///")).toBe("https://acme.example/");
    expect(normalizeUrl("https://acme.example//a//b//")).toBe("https://acme.example//a//b");
  });

  test("a long run of slashes inside the path is folded in linear time", () => {
    // `/\/+$/` restarted at every slash of a run that does not end the path,
    // in a URL the model (or an MCP result) wrote: 1.5 s for 50 000 of them,
    // where the walk in from the end takes a quarter of a millisecond. The
    // regression is inside the regex engine, with nothing of ours to count,
    // so the bound is absolute: a runner twenty times slower than a laptop
    // still folds in a tenth of it, and the pattern overshoots it twentyfold
    // on the laptop. The least of three runs.
    const fastest = (run: () => unknown): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        run();
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    const url = `https://a.example/${"/".repeat(50_000)}x`;
    expect(fastest(() => normalizeUrl(url))).toBeLessThan(50);
  }, 20_000);

  test("http and https stay distinct; non-http schemes and junk are not URLs", () => {
    expect(normalizeUrl("http://acme.example/x")).not.toBe(normalizeUrl("https://acme.example/x"));
    expect(normalizeUrl("ftp://acme.example/x")).toBeUndefined();
    expect(normalizeUrl("acme.example/x")).toBeUndefined();
    expect(normalizeUrl("https://")).toBeUndefined();
    expect(normalizeUrl("https://[bad")).toBeUndefined();
  });

  test("every DOI resolver host and case folds to one origin", () => {
    const want = "https://doi.org/10.1000/abc.def";
    expect(normalizeUrl("http://dx.doi.org/10.1000/ABC.def")).toBe(want);
    expect(normalizeUrl("https://www.doi.org/10.1000/abc.DEF/")).toBe(want);
    expect(doiUrl("10.1000/ABC.def")).toBe(want);
    expect(doiUrl("doi: 10.1000/abc.def")).toBe(want);
  });

  test("hostOf strips IPv6 brackets", () => {
    expect(hostOf("http://[::1]:8080/x")).toBe("::1");
    expect(hostOf("https://Docs.Acme.example/x")).toBe("docs.acme.example");
    expect(hostOf("not a url")).toBeUndefined();
  });
});

describe("normalizePath", () => {
  const root = mkdtempSync(join(tmpdir(), "prov-origin-"));
  test("relative, ./ and ../ inside the workspace become workspace-relative POSIX", () => {
    expect(normalizePath("docs/pricing.md", { workspaceRoot: root })).toBe("docs/pricing.md");
    expect(normalizePath("./docs/../docs/pricing.md", { workspaceRoot: root })).toBe(
      "docs/pricing.md",
    );
    expect(normalizePath(join(root, "a", "b.md"), { workspaceRoot: root })).toBe("a/b.md");
    expect(normalizePath(".", { workspaceRoot: root })).toBe(".");
  });

  test("baseDir resolves relative paths; absolute escapes and .. escapes have no origin", () => {
    expect(normalizePath("x.md", { workspaceRoot: root, baseDir: "reports" })).toBe("reports/x.md");
    expect(normalizePath("../x.md", { workspaceRoot: root, baseDir: "reports" })).toBe("x.md");
    expect(normalizePath("../../etc/passwd", { workspaceRoot: root })).toBeUndefined();
    expect(normalizePath("/etc/passwd", { workspaceRoot: root })).toBeUndefined();
    expect(normalizePath(`${root}-sibling/x`, { workspaceRoot: root })).toBeUndefined();
  });

  test("file:// is the path it names; other schemes, NUL and empty are not paths", () => {
    expect(normalizePath(`file://${join(root, "a.md")}`, { workspaceRoot: root })).toBe("a.md");
    expect(normalizePath("https://acme.example/x", { workspaceRoot: root })).toBeUndefined();
    expect(normalizePath("mailto:x@y", { workspaceRoot: root })).toBeUndefined();
    expect(normalizePath("a\0b", { workspaceRoot: root })).toBeUndefined();
    expect(normalizePath("  ", { workspaceRoot: root })).toBeUndefined();
    expect(normalizePath("x".repeat(9_000), { workspaceRoot: root })).toBeUndefined();
  });

  test("a root spelled through a link (macOS /var vs /private/var) still contains its files", () => {
    const real = realpathSync(root);
    if (real === root) return; // the platform has no such alias here
    expect(normalizePath(join(real, "a.md"), { workspaceRoot: root })).toBe("a.md");
  });

  test("originKey reads url, doi and path refs; everything else has none", () => {
    expect(originKey({ kind: "url", url: "https://Acme.example/p/" })).toBe(
      "https://acme.example/p",
    );
    expect(originKey({ kind: "doi", doi: "10.1000/X" })).toBe("https://doi.org/10.1000/x");
    expect(originKey({ kind: "path", path: "./d.md" }, { workspaceRoot: root })).toBe("d.md");
    expect(originKey({ kind: "tool", toolUseId: "t" })).toBeUndefined();
    expect(originKey({ kind: "text", text: "Smith 2024" })).toBeUndefined();
  });

  test("cleanup", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("hosts", () => {
  test("registrableDomain keeps two labels, three under a known two-level suffix", () => {
    expect(registrableDomain("docs.acme.example")).toBe("acme.example");
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("news.abc.net.au")).toBe("abc.net.au");
    expect(registrableDomain("acme.example.")).toBe("acme.example");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("10.0.0.1")).toBe("10.0.0.1");
    expect(registrableDomain("[2606:4700::1]")).toBe("2606:4700::1");
    // Private suffixes are deliberately one origin (corroboration errs strict).
    expect(registrableDomain("alice.github.io")).toBe(registrableDomain("bob.github.io"));
  });

  test("hostMatches: *, *.suffix (subdomains only), exact; case-insensitive", () => {
    expect(hostMatches("anything.example", ["*"])).toBe(true);
    expect(hostMatches("nasa.gov", ["*.gov"])).toBe(true);
    expect(hostMatches("www.nasa.gov", ["*.gov"])).toBe(true);
    expect(hostMatches("gov", ["*.gov"])).toBe(false);
    expect(hostMatches("evilgov", ["*.gov"])).toBe(false);
    expect(hostMatches("ArXiv.org.", ["arxiv.org"])).toBe(true);
    expect(hostMatches("export.arxiv.org", ["arxiv.org"])).toBe(false);
    expect(hostMatches("x.example", [])).toBe(false);
  });

  test("isPrivateHost: the shared classifier's spellings and the names tool-fetch refuses", () => {
    for (const host of [
      "169.254.169.254",
      "2852039166",
      "0xA9FEA9FE",
      "127.1",
      "[::ffff:a9fe:a9fe]",
      "::1",
      "10.0.0.1",
      "192.168.1.1",
      "localhost",
      "api.localhost",
      "printer.local",
      "LOCALHOST.",
    ]) {
      expect(isPrivateHost(host)).toBe(true);
    }
    for (const host of ["acme.example", "8.8.8.8", "2606:4700:4700::1111", "localhost.example"]) {
      expect(isPrivateHost(host)).toBe(false);
    }
  });
});
