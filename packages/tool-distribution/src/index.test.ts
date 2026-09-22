/**
 * The two tools, driven through their own `execute`.
 *
 * The centrepiece is "three outcomes, never two": one verify run over a
 * release where one asset is fine, one has the wrong bytes, one is a 404 and
 * one cannot be reached, and the result keeps all four apart. Everything else
 * in this file protects that property at the edges — a download that was not
 * requested is not a pass, a manifest that could not be read is not a pass,
 * and a hash that could not be computed is not a mismatch.
 *
 * Nothing here opens a socket: `_setFetch` is replaced in `beforeEach` with a
 * stub that throws if a test forgets its routes, and DNS is injected too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREWHAUS_PRODUCT,
  renderDebianControl,
  renderHomebrewFormula,
  renderScoopManifest,
  renderWingetManifest,
} from "@crewhaus/single-binary-cli";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { _setDnsLookup } from "@crewhaus/tool-fetch";
import {
  ASSET_BYTES,
  ASSET_SHAS,
  DOWNLOAD_BASE,
  FORMULA_URL_WITHOUT_SHA,
  HOMEPAGE,
  RELEASE,
  SCOOP_TOP_LEVEL,
  SCOOP_UNPAIRED,
  VERSION,
  assetUrl,
  bytesOf,
  forbidNetwork,
  releaseRoutes,
  sha256Of,
  stubFetch,
  withoutTarget,
} from "./fixtures";
import {
  DISTRIBUTION_TOOLS,
  _setFetch,
  packageManifestGenerate,
  packageManifestVerify,
} from "./index";

const WIDGET_PRODUCT = {
  binaryName: "widgetd",
  formulaClass: "Widgetd",
  shortDescription: "A widget daemon",
  license: "MIT",
  debian: {
    section: "net",
    maintainer: "Widget Co <ops@widget.example>",
    depends: "libc6 (>= 2.34)",
    longDescription: ["Serves widgets.", "Nothing more."],
  },
  winget: {
    packageIdentifier: "WidgetCo.Widgetd",
    publisher: "Widget Co",
    author: "Widget Co",
    longDescription: "Serves widgets.",
    tags: ["widgets"],
  },
};

const GENERATE_INPUT = {
  version: VERSION,
  homepage: HOMEPAGE,
  downloadBaseUrl: DOWNLOAD_BASE,
  sha256: { ...ASSET_SHAS },
};

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: RegisteredTool, input: unknown, ctx?: unknown): Promise<any> {
  const out = await tool.execute(input, ctx as never);
  if (typeof out !== "string") throw new Error("expected a string result");
  return out.startsWith("{") ? JSON.parse(out) : out;
}

async function text(tool: RegisteredTool, input: unknown): Promise<string> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  return out;
}

function dns(map: Record<string, string> = {}): void {
  _setDnsLookup(async (host) => ({ address: map[host] ?? "93.184.216.34", family: 4 }));
}

beforeEach(() => {
  _setFetch(forbidNetwork);
  dns();
});

afterEach(() => {
  _setFetch(undefined);
  _setDnsLookup(undefined);
});

describe("package-wide contract", () => {
  test("both tools are exported with unique names", () => {
    expect(DISTRIBUTION_TOOLS.map((t) => t.name)).toEqual([
      "PackageManifestGenerate",
      "PackageManifestVerify",
    ]);
    expect(new Set(DISTRIBUTION_TOOLS.map((t) => t.name)).size).toBe(DISTRIBUTION_TOOLS.length);
  });

  test("the generator declares no I/O; the verifier declares the network it uses", () => {
    expect(packageManifestGenerate.scope).toBe("internal");
    expect(packageManifestGenerate.ioCapability).toBeUndefined();
    expect(packageManifestVerify.scope).toBe("external");
    expect(packageManifestVerify.ioCapability).toBe("network");
  });

  test("neither tool is destructive and both are read-only", () => {
    for (const tool of DISTRIBUTION_TOOLS) {
      expect({ name: tool.name, destructive: tool.destructive, readOnly: tool.readOnly }).toEqual({
        name: tool.name,
        destructive: false,
        readOnly: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("PackageManifestGenerate renders the four, and renders them by CONSUMING the renderers", () => {
  test("every file is byte-for-byte what @crewhaus/single-binary-cli produces", async () => {
    // The point of the assertion is that this package does not have its own
    // opinion about these bytes. The goldens live in single-binary-cli; if
    // this tool ever grew a second renderer, this is where it would show.
    const out = await run(packageManifestGenerate, GENERATE_INPUT);
    const byKind = Object.fromEntries(
      out.manifests.map((m: { kind: string; text: string }) => [m.kind, m.text]),
    );
    expect(byKind["homebrew"]).toBe(renderHomebrewFormula(RELEASE));
    expect(byKind["debian"]).toBe(renderDebianControl(RELEASE));
    expect(byKind["scoop"]).toBe(`${JSON.stringify(renderScoopManifest(RELEASE), null, 2)}\n`);
    expect(byKind["winget"]).toBe(renderWingetManifest(RELEASE));
  });

  test("each file comes back with the name its ecosystem expects and its own digest", async () => {
    const out = await run(packageManifestGenerate, GENERATE_INPUT);
    expect(out.manifests.map((m: { filename: string }) => m.filename)).toEqual([
      "Formula/crewhaus.rb",
      "debian/control",
      "crewhaus.json",
      "CrewHaus.CLI.installer.yaml",
    ]);
    for (const manifest of out.manifests) {
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.bytes).toBeGreaterThan(0);
    }
  });

  test("the assets are read back out of the rendered files, not re-derived", async () => {
    const out = await run(packageManifestGenerate, GENERATE_INPUT);
    const urls = out.assets.map((a: { url: string }) => a.url);
    expect(urls).toContain(assetUrl("macos-arm64"));
    expect(urls).toContain(assetUrl("windows-x64"));
    // homebrew's four, scoop's one, winget's one.
    expect(out.assets).toHaveLength(6);
    const homebrew = out.assets.filter((a: { manifest: string }) => a.manifest === "homebrew");
    expect(homebrew.map((a: { target: string }) => a.target)).toEqual([
      "macos-arm64",
      "macos-x64",
      "linux-arm64",
      "linux-x64",
    ]);
  });

  test("winget's digest is uppercase where it is published, lowercase where it is compared", async () => {
    const out = await run(packageManifestGenerate, GENERATE_INPUT);
    const winget = out.assets.find((a: { manifest: string }) => a.manifest === "winget");
    expect(winget.sha256).toBe(ASSET_SHAS["windows-x64"].toUpperCase());
    const scoop = out.assets.find((a: { manifest: string }) => a.manifest === "scoop");
    expect(scoop.sha256).toBe(ASSET_SHAS["windows-x64"]);
  });

  test("a subset renders, and then only needs the shas that subset uses", async () => {
    const out = await run(packageManifestGenerate, {
      ...GENERATE_INPUT,
      manifests: ["debian"],
      sha256: {},
    });
    expect(out.manifests).toHaveLength(1);
    expect(out.manifests[0].kind).toBe("debian");
    expect(out.assets).toEqual([]);
  });

  test("the subset is deduplicated and always in the same order", async () => {
    const out = await run(packageManifestGenerate, {
      ...GENERATE_INPUT,
      manifests: ["winget", "homebrew", "winget"],
    });
    expect(out.manifests.map((m: { kind: string }) => m.kind)).toEqual(["homebrew", "winget"]);
  });

  test("a product that is not crewhaus comes through everywhere", async () => {
    const out = await run(packageManifestGenerate, {
      ...GENERATE_INPUT,
      downloadBaseUrl: "https://widget.example/dl/1.2.3",
      homepage: "https://widget.example",
      product: WIDGET_PRODUCT,
    });
    expect(out.product).toEqual({
      binaryName: "widgetd",
      formulaClass: "Widgetd",
      packageIdentifier: "WidgetCo.Widgetd",
      isDefault: false,
    });
    const joined = out.manifests.map((m: { text: string }) => m.text).join("\n");
    expect(joined).toContain("class Widgetd < Formula");
    expect(joined).toContain("Package: widgetd");
    expect(joined).not.toContain("crewhaus");
    // The AVX note is crewhaus's, and it is opt-in.
    expect(joined).not.toContain("Rosetta");
  });

  test("the four cannot disagree with each other — that is the point of one call", async () => {
    // The failure this prevents: four files edited by hand, three of them
    // updated. Every version and every checksum here comes from one input.
    const out = await run(packageManifestGenerate, GENERATE_INPUT);
    for (const manifest of out.manifests) {
      expect({ kind: manifest.kind, hasVersion: manifest.text.includes(VERSION) }).toEqual({
        kind: manifest.kind,
        hasVersion: true,
      });
    }
    // scoop calls the target "64bit" and winget calls it "x64"; both point at
    // the same file and must carry the same digest, case aside.
    const windows = out.assets.filter(
      (a: { manifest: string }) => a.manifest === "scoop" || a.manifest === "winget",
    );
    expect(windows.map((a: { url: string }) => a.url)).toEqual([
      assetUrl("windows-x64"),
      assetUrl("windows-x64"),
    ]);
    expect(new Set(windows.map((a: { sha256: string }) => a.sha256.toLowerCase())).size).toBe(1);
  });

  test("the Rosetta/AVX note survives into the formula for the default product", async () => {
    // Knowledge this project paid for once: an x86_64 brew under Rosetta
    // reports an Intel CPU, and Bun's macOS x64 runtime needs AVX2.
    const out = await run(packageManifestGenerate, GENERATE_INPUT);
    const formula = out.manifests.find((m: { kind: string }) => m.kind === "homebrew").text;
    expect(formula).toContain("Rosetta");
    expect(formula).toContain("Hardware::CPU.physical_cpu_arm64?");
  });

  test("the default product is the CLI's own identity", async () => {
    const out = await run(packageManifestGenerate, GENERATE_INPUT);
    expect(out.product.isDefault).toBe(true);
    expect(out.product.binaryName).toBe(CREWHAUS_PRODUCT.binaryName);
  });
});

describe("PackageManifestGenerate refuses", () => {
  test("a sha that is not 64 hex characters", async () => {
    const out = await text(packageManifestGenerate, {
      ...GENERATE_INPUT,
      sha256: { ...ASSET_SHAS, "linux-x64": "deadbeef" },
    });
    expect(out).toMatch(/refused/);
    expect(out).toMatch(/linux-x64 is 8 characters, not 64/);
  });

  test("a sha that is missing for a target the selected manifests need", async () => {
    const sha256 = withoutTarget(ASSET_SHAS, "macos-x64");
    const out = await text(packageManifestGenerate, { ...GENERATE_INPUT, sha256 });
    expect(out).toMatch(/macos-x64 \(needed by homebrew\)/);
  });

  test("...but not when no selected manifest needs it", async () => {
    const sha256 = withoutTarget(ASSET_SHAS, "macos-x64");
    const out = await run(packageManifestGenerate, {
      ...GENERATE_INPUT,
      sha256,
      manifests: ["scoop", "winget"],
    });
    expect(out.manifests).toHaveLength(2);
  });

  test("a version the Homebrew formula will reject", async () => {
    const out = await text(packageManifestGenerate, { ...GENERATE_INPUT, version: "v1.2" });
    expect(out).toMatch(/not semver-shaped/);
  });

  test("a version that would close the Ruby string and keep going", async () => {
    const out = await text(packageManifestGenerate, {
      ...GENERATE_INPUT,
      version: '1.2.3"\n  system "id',
    });
    expect(out).toMatch(/not semver-shaped/);
  });

  test("a download base URL that is not https", async () => {
    const out = await text(packageManifestGenerate, {
      ...GENERATE_INPUT,
      downloadBaseUrl: "http://dl.example.com/v1.2.3",
    });
    expect(out).toMatch(/bearer instruction to download and execute/);
  });

  test("a download base URL that points into private space", async () => {
    const out = await text(packageManifestGenerate, {
      ...GENERATE_INPUT,
      downloadBaseUrl: "https://10.10.0.4/dl",
    });
    expect(out).toMatch(/private or link-local/);
    expect(out).toMatch(/every installer in the world/);
  });

  test("a Debian description line that already carries its leading space", async () => {
    const out = await text(packageManifestGenerate, {
      ...GENERATE_INPUT,
      product: {
        ...WIDGET_PRODUCT,
        debian: { ...WIDGET_PRODUCT.debian, longDescription: [" Serves widgets."] },
      },
    });
    expect(out).toMatch(/doubly indented/);
    expect(out).toMatch(/stops it being a continuation line/);
  });

  test("a description that would stop being a YAML scalar", async () => {
    const out = await text(packageManifestGenerate, {
      ...GENERATE_INPUT,
      downloadBaseUrl: "https://widget.example/dl/1.2.3",
      homepage: "https://widget.example",
      product: { ...WIDGET_PRODUCT, shortDescription: "widgetd: a daemon" },
    });
    expect(out).toMatch(/nested mapping/);
  });

  test("several problems at once come back as a list, not as the first one", async () => {
    const out = await text(packageManifestGenerate, {
      ...GENERATE_INPUT,
      version: "nope",
      downloadBaseUrl: "http://dl.example.com/v1",
      product: { ...WIDGET_PRODUCT, formulaClass: "widgetd" },
    });
    expect(out).toMatch(/3 problems/);
    expect(out.split("\n")).toHaveLength(4);
  });

  test("nothing is rendered when anything is refused", async () => {
    const out = await text(packageManifestGenerate, { ...GENERATE_INPUT, version: "nope" });
    expect(out).not.toContain("class Crewhaus < Formula");
  });
});

describe("PackageManifestGenerate says things out loud rather than silently fixing them", () => {
  test("a trailing slash is trimmed, with a note", async () => {
    const out = await run(packageManifestGenerate, {
      ...GENERATE_INPUT,
      downloadBaseUrl: `${DOWNLOAD_BASE}/`,
    });
    expect(out.downloadBaseUrl).toBe(DOWNLOAD_BASE);
    expect(out.notes.join(" ")).toMatch(/trailing slash/);
    expect(out.manifests[0].text).not.toContain("download/v1.2.3//");
  });

  test("an uppercase sha is lowercased, with a note", async () => {
    const out = await run(packageManifestGenerate, {
      ...GENERATE_INPUT,
      sha256: { ...ASSET_SHAS, "linux-x64": ASSET_SHAS["linux-x64"].toUpperCase() },
    });
    expect(out.notes.join(" ")).toMatch(/lowercased/);
    expect(out.manifests[0].text).toContain(ASSET_SHAS["linux-x64"]);
  });

  test("a formulaClass Homebrew would not derive from the filename gets a note, not a refusal", async () => {
    const out = await run(packageManifestGenerate, {
      ...GENERATE_INPUT,
      downloadBaseUrl: "https://widget.example/dl/1.2.3",
      homepage: "https://widget.example",
      product: { ...WIDGET_PRODUCT, formulaClass: "Widget" },
    });
    expect(out.notes.join(" ")).toMatch(/brew audit will want them to agree/);
    expect(out.manifests.length).toBeGreaterThan(0);
  });

  test("shas the selected manifests never reference are noted, not silently dropped", async () => {
    const out = await run(packageManifestGenerate, { ...GENERATE_INPUT, manifests: ["scoop"] });
    expect(out.notes.join(" ")).toMatch(/macos-arm64/);
  });
});

// ---------------------------------------------------------------------------

describe("PackageManifestVerify keeps three outcomes apart", () => {
  test("one run, four different answers, none of them collapsed", async () => {
    // macos-arm64 is served correctly, macos-x64 serves the WRONG bytes,
    // linux-arm64 is not there at all, and linux-x64 never answers.
    const stub = stubFetch({
      [assetUrl("macos-arm64")]: { body: ASSET_BYTES["macos-arm64"] },
      [assetUrl("macos-x64")]: { body: bytesOf("something else entirely") },
      [assetUrl("linux-x64")]: { hang: true },
    });
    _setFetch(stub.fetch);

    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderHomebrewFormula(RELEASE), label: "crewhaus.rb" }],
      timeoutMs: 25,
    });

    expect(out.summary).toEqual({ verified: 1, mismatched: 1, missing: 1, unchecked: 1 });
    const byTarget = Object.fromEntries(out.assets.map((a: { target: string }) => [a.target, a]));
    expect(byTarget["macos-arm64"].outcome).toBe("verified");
    expect(byTarget["macos-x64"].outcome).toBe("mismatch");
    expect(byTarget["linux-arm64"].outcome).toBe("missing");
    expect(byTarget["linux-x64"].outcome).toBe("unchecked");
    // The one that could not be checked says WHY, and the reason is the thing
    // asserted — "it failed" would also be true of a genuine mismatch.
    expect(byTarget["linux-x64"].reason).toBe("timeout");
    expect(byTarget["linux-x64"].computedSha256).toBeUndefined();
    expect(out.verdict).toBe("failed");
  });

  test("a mismatch says it is a real disagreement, and shows both digests", async () => {
    _setFetch(
      stubFetch({ [assetUrl("windows-x64")]: { body: bytesOf("not the release binary") } }).fetch,
    );
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderWingetManifest(RELEASE), kind: "winget" }],
    });
    const row = out.assets[0];
    expect(row.outcome).toBe("mismatch");
    expect(row.computedSha256).toBe(sha256Of("not the release binary"));
    expect(row.declaredSha256.toLowerCase()).toBe(ASSET_SHAS["windows-x64"]);
    expect(row.message).toMatch(/not a failed download/);
    expect(out.verdict).toBe("failed");
  });

  test("a clean release verifies, and says every asset was actually fetched", async () => {
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const out = await run(packageManifestVerify, {
      manifests: [
        { text: renderHomebrewFormula(RELEASE), label: "crewhaus.rb" },
        { text: renderWingetManifest(RELEASE), label: "winget.yaml" },
        { text: `${JSON.stringify(renderScoopManifest(RELEASE), null, 2)}\n`, label: "scoop.json" },
        { text: renderDebianControl(RELEASE), label: "control" },
      ],
    });
    expect(out.verdict).toBe("verified");
    expect(out.summary).toEqual({ verified: 6, mismatched: 0, missing: 0, unchecked: 0 });
    expect(out.version).toBe(VERSION);
    expect(out.bytesDownloaded).toBeGreaterThan(0);
    expect(out.headline).toMatch(/every hash agreed/);
  });

  test("one URL is fetched once, however many manifests point at it", async () => {
    // scoop and winget both install the Windows binary. That file is tens of
    // megabytes in real life, and downloading it twice to check the same bytes
    // twice is a cost with nothing on the other side of it.
    const stub = stubFetch(releaseRoutes());
    _setFetch(stub.fetch);
    const out = await run(packageManifestVerify, {
      manifests: [
        { text: renderHomebrewFormula(RELEASE), label: "crewhaus.rb" },
        { text: renderWingetManifest(RELEASE), label: "winget.yaml" },
        { text: `${JSON.stringify(renderScoopManifest(RELEASE), null, 2)}\n`, label: "scoop.json" },
      ],
    });
    expect(out.summary.verified).toBe(6);
    expect(stub.calls).toHaveLength(5);
    // …and the bytes are counted once, not once per manifest that names them.
    const served = Object.values(ASSET_BYTES).reduce((sum, b) => sum + b.byteLength, 0);
    expect(out.bytesDownloaded).toBe(served);
  });

  test("two manifests that claim different checksums for the same file", async () => {
    // True without downloading anything: whatever the bytes are, one of these
    // two files is wrong about them.
    const tampered = `${JSON.stringify(
      {
        ...(renderScoopManifest(RELEASE) as Record<string, unknown>),
        architecture: { "64bit": { url: assetUrl("windows-x64"), hash: "b".repeat(64) } },
      },
      null,
      2,
    )}\n`;
    const out = await run(packageManifestVerify, {
      manifests: [
        { text: renderWingetManifest(RELEASE), label: "winget.yaml" },
        { text: tampered, kind: "scoop", label: "scoop.json" },
      ],
      download: false,
    });
    const finding = out.findings.find((f: { code: string }) => f.code === "shasDisagree");
    expect(finding.message).toMatch(/at most one of those manifests can be right/);
    expect(out.verdict).toBe("failed");
  });

  test("a control paragraph declares no downloads, and the headline says so", async () => {
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderDebianControl(RELEASE), label: "control" }],
    });
    expect(out.verdict).toBe("verified");
    expect(out.headline).toMatch(/declare no downloads/);
    expect(out.bytesDownloaded).toBe(0);
  });

  test("downloads turned off is INCOMPLETE, never verified", async () => {
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderHomebrewFormula(RELEASE) }],
      download: false,
    });
    expect(out.verdict).toBe("incomplete");
    expect(out.summary.unchecked).toBe(4);
    expect(out.assets[0].reason).toBe("notRequested");
    expect(out.assets[0].message).toMatch(/unconfirmed, not confirmed/);
    expect(out.headline).toMatch(/is not an asset that verified/);
  });

  test("a failure outranks an unknown, and the unknowns are still reported", async () => {
    _setFetch(
      stubFetch({
        [assetUrl("macos-arm64")]: { body: bytesOf("wrong") },
        [assetUrl("macos-x64")]: { throws: "ECONNRESET" },
      }).fetch,
    );
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderHomebrewFormula(RELEASE) }],
    });
    expect(out.verdict).toBe("failed");
    expect(out.summary.mismatched).toBe(1);
    expect(out.summary.unchecked).toBe(1);
    expect(out.headline).toMatch(/1 not checked/);
  });

  test("every unknown reason survives into the result under its own name", async () => {
    _setFetch(
      stubFetch({
        [assetUrl("macos-arm64")]: { status: 500, body: "" },
        [assetUrl("macos-x64")]: { throws: "ECONNRESET" },
        [assetUrl("linux-arm64")]: { body: "x".repeat(5000), chunk: 500 },
        [assetUrl("linux-x64")]: { body: bytesOf("short"), headers: { "content-length": "900" } },
      }).fetch,
    );
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderHomebrewFormula(RELEASE) }],
      maxBytes: 1024,
    });
    expect(out.assets.map((a: { reason: string }) => a.reason)).toEqual([
      "status",
      "transport",
      "cap",
      "shortRead",
    ]);
    expect(out.summary).toEqual({ verified: 0, mismatched: 0, missing: 0, unchecked: 4 });
    expect(out.verdict).toBe("incomplete");
  });
});

describe("PackageManifestVerify checks what the manifest says about itself", () => {
  test("the version in the file against the version in its URLs", async () => {
    const stale = renderHomebrewFormula(RELEASE).replace(/version "1\.2\.3"/, 'version "1.2.4"');
    const out = await run(packageManifestVerify, {
      manifests: [{ text: stale }],
      download: false,
    });
    expect(out.assets.every((a: { versionInUrl: string }) => a.versionInUrl === "differs")).toBe(
      true,
    );
  });

  test("a half-finished version bump FAILS even though every hash agrees", async () => {
    // The regression this file exists for. The `version` line was bumped to
    // 1.2.4 and the URLs still point at the 1.2.3 binaries, so every download
    // hashes exactly as its manifest says — each URL really does serve the
    // build it names — and the old code answered "verified: every asset these
    // manifests point at was fetched and hashed, and every hash agreed". brew
    // would then install 1.2.3 and call it 1.2.4. The disagreement is inside
    // the file, and no amount of downloading can find it.
    const stale = renderHomebrewFormula(RELEASE).replace(/version "1\.2\.3"/, 'version "1.2.4"');
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const out = await run(packageManifestVerify, { manifests: [{ text: stale }] });
    expect(out.summary).toEqual({ verified: 4, mismatched: 0, missing: 0, unchecked: 0 });
    expect(out.verdict).toBe("failed");
    const finding = out.findings.find((f: { code: string }) => f.code === "versionUrlMismatch");
    expect(finding.severity).toBe("error");
    // The message names what the URL says, not just that something is wrong.
    expect(finding.message).toContain("states version 1.2.4");
    expect(finding.message).toContain('"1.2.3"');
    expect(
      out.findings.filter((f: { code: string }) => f.code === "versionUrlMismatch"),
    ).toHaveLength(4);
  });

  test("a URL that agrees with the version raises nothing at all", async () => {
    // The inverse, so the check above cannot be satisfied by failing always.
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderHomebrewFormula(RELEASE) }],
      expectVersion: VERSION,
    });
    expect(out.verdict).toBe("verified");
    expect(out.findings).toBeUndefined();
  });

  test("a URL with no version in it is 'notFound', which is not a mismatch", async () => {
    // A release that publishes stable paths: no version in the tag and none in
    // the filename either, so there is nothing in the URL to compare against.
    const latest = renderHomebrewFormula({
      ...RELEASE,
      downloadBaseUrl: "https://dl.example.com/latest",
    }).replaceAll("-1.2.3", "");
    const out = await run(packageManifestVerify, {
      manifests: [{ text: latest }],
      download: false,
    });
    expect(out.assets[0].versionInUrl).toBe("notFound");
    // It is not an error finding either: publishing a stable path is unusual,
    // not wrong.
    expect((out.findings ?? []).some((f: { severity: string }) => f.severity === "error")).toBe(
      false,
    );
  });

  test("two manifests that disagree about the version", async () => {
    const out = await run(packageManifestVerify, {
      manifests: [
        { text: renderHomebrewFormula(RELEASE), label: "crewhaus.rb" },
        { text: renderDebianControl({ ...RELEASE, version: "1.2.4" }), label: "control" },
      ],
      download: false,
    });
    const finding = out.findings.find((f: { code: string }) => f.code === "versionsDisagree");
    expect(finding.severity).toBe("error");
    expect(out.verdict).toBe("failed");
  });

  test("expectVersion catches the right file for the wrong release", async () => {
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderDebianControl(RELEASE), label: "control" }],
      expectVersion: "1.3.0",
      download: false,
    });
    const finding = out.findings.find((f: { code: string }) => f.code === "versionUnexpected");
    expect(finding.message).toMatch(/states version 1.2.3, but 1.3.0 was expected/);
    expect(out.verdict).toBe("failed");
  });

  test("a version it could not read is not a version that matched expectVersion", async () => {
    // The defect this guards: `undefined === undefined` reading as agreement,
    // and a file with no version line passing a check it never underwent.
    const noVersion = renderHomebrewFormula(RELEASE).replace(/^\s*version "1\.2\.3"\n/m, "");
    const out = await run(packageManifestVerify, {
      manifests: [{ text: noVersion, label: "crewhaus.rb" }],
      expectVersion: "1.2.3",
      download: false,
    });
    expect(out.manifests[0].version).toBeUndefined();
    expect(out.findings.some((f: { code: string }) => f.code === "versionUnexpected")).toBe(false);
    const unreadable = out.findings.find((f: { code: string }) => f.code === "versionUnreadable");
    expect(unreadable.severity).toBe("unknown");
    expect(out.verdict).toBe("incomplete");
    // …and no row claims its URL carried the right version either.
    expect(out.assets.every((a: { versionInUrl?: string }) => a.versionInUrl === undefined)).toBe(
      true,
    );
  });

  test("a lowercase winget InstallerSha256 fails the file without touching the hash check", async () => {
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const lowered = renderWingetManifest(RELEASE).replace(
      ASSET_SHAS["windows-x64"].toUpperCase(),
      ASSET_SHAS["windows-x64"],
    );
    const out = await run(packageManifestVerify, { manifests: [{ text: lowered }] });
    expect(out.assets[0].outcome).toBe("verified");
    expect(out.findings.find((f: { code: string }) => f.code === "shaNotUppercase").severity).toBe(
      "error",
    );
    expect(out.verdict).toBe("failed");
  });

  test("a published manifest that points at plain http is a defect, not just unfetchable", async () => {
    const insecure = renderHomebrewFormula(RELEASE).replaceAll(
      "https://github.com",
      "http://github.com",
    );
    const stub = stubFetch(releaseRoutes());
    _setFetch(stub.fetch);
    const out = await run(packageManifestVerify, { manifests: [{ text: insecure }] });
    expect(out.assets.every((a: { reason: string }) => a.reason === "insecureScheme")).toBe(true);
    // Nothing is dialled: fetching it could not make the manifest correct.
    expect(stub.calls).toHaveLength(0);
    expect(out.findings.every((f: { code: string }) => f.code === "insecureScheme")).toBe(true);
    expect(out.verdict).toBe("failed");
  });

  test("a manifest that points at an internal host is a defect too", async () => {
    // What copying a manifest out of a staging environment looks like. The
    // bytes behind that URL might be perfect; nobody else can reach them.
    const internal = renderHomebrewFormula({
      ...RELEASE,
      downloadBaseUrl: "https://10.0.0.5/releases/1.2.3",
    });
    const stub = stubFetch({});
    _setFetch(stub.fetch);
    const out = await run(packageManifestVerify, { manifests: [{ text: internal }] });
    expect(out.assets[0].reason).toBe("privateHost");
    expect(out.assets[0].outcome).toBe("unchecked");
    expect(stub.calls).toHaveLength(0);
    expect(out.verdict).toBe("failed");
    expect(out.findings[0].message).toMatch(/private or link-local/);
  });

  test("a published URL with credentials before the @ is a defect, and is never dialled", async () => {
    // `https://github.com:token@dl.attacker.example/…` reads as github.com to
    // every human reviewing the diff and fetches from dl.attacker.example.
    // PackageManifestGenerate already refuses to WRITE one of these; a
    // published one has to be caught on the way in too, and dialling it would
    // hand the credential to that host.
    const disguised = renderHomebrewFormula(RELEASE).replace(
      assetUrl("macos-arm64"),
      "https://github.com:token@dl.attacker.example/crewhaus-macos-arm64-1.2.3",
    );
    const stub = stubFetch(releaseRoutes());
    _setFetch(stub.fetch);
    const out = await run(packageManifestVerify, { manifests: [{ text: disguised }] });
    const row = out.assets[0];
    expect(row.outcome).toBe("unchecked");
    expect(row.reason).toBe("credentialsInUrl");
    // The message names the host that would actually have been fetched.
    expect(row.message).toContain("dl.attacker.example");
    expect(stub.calls.map((c) => c.url).join(" ")).not.toContain("attacker");
    expect(out.findings.some((f: { code: string }) => f.code === "credentialsInUrl")).toBe(true);
    expect(out.verdict).toBe("failed");
  });

  test("a URL carrying a tab is not the URL that would be fetched, so it is not fetched", async () => {
    // The URL parser DELETES tab, CR and LF from anywhere in a URL. Reporting
    // `…/crew<TAB>haus-macos-arm64-1.2.3` as verified would be naming a URL
    // nobody fetched — the bytes came from the de-tabbed one — while brew's
    // own URI handling is not the WHATWG parser's and may resolve it a third
    // way. Comparing the parsed form and publishing the string is the trap.
    const tabbed = renderHomebrewFormula(RELEASE).replace(
      "/crewhaus-macos-arm64-1.2.3",
      "/crew\thaus-macos-arm64-1.2.3",
    );
    const stub = stubFetch(releaseRoutes());
    _setFetch(stub.fetch);
    const out = await run(packageManifestVerify, { manifests: [{ text: tabbed }] });
    expect(out.assets[0].outcome).toBe("unchecked");
    expect(out.assets[0].reason).toBe("urlWhitespace");
    expect(out.assets[0].message).toContain("U+0009");
    expect(stub.calls.map((c) => c.url)).not.toContain(assetUrl("macos-arm64"));
    expect(out.verdict).toBe("failed");
  });

  test("a redirect is recorded on the row, with the signed-URL token stripped", async () => {
    // "the bytes at this URL hash to X" is misleading when the bytes came from
    // three hops away, so the row says where they came from — through
    // safeLabel, because a redirect target routinely carries a token in its
    // query and a release log is not the place to publish one.
    _setFetch(
      stubFetch(
        releaseRoutes({
          [assetUrl("macos-arm64")]: {
            status: 302,
            headers: { location: "https://cdn.other.example/blob?token=SECRET" },
          },
          "https://cdn.other.example/blob?token=SECRET": { body: ASSET_BYTES["macos-arm64"] },
        }),
      ).fetch,
    );
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderHomebrewFormula(RELEASE) }],
    });
    expect(out.assets[0].outcome).toBe("verified");
    expect(out.assets[0].fetchedFrom).toBe("https://cdn.other.example/blob");
    expect(JSON.stringify(out)).not.toContain("SECRET");
    // A download that was NOT redirected does not carry the field at all.
    expect(out.assets[1].fetchedFrom).toBeUndefined();
  });

  test("a malformed sha means there is nothing to compare against, so nothing is downloaded", async () => {
    const broken = renderHomebrewFormula(RELEASE).replace(ASSET_SHAS["macos-arm64"], "abc123");
    const stub = stubFetch(releaseRoutes());
    _setFetch(stub.fetch);
    const out = await run(packageManifestVerify, { manifests: [{ text: broken }] });
    const row = out.assets.find((a: { target: string }) => a.target === "macos-arm64");
    expect(row.outcome).toBe("unchecked");
    expect(row.reason).toBe("malformedSha");
    expect(stub.calls.map((c) => c.url)).not.toContain(assetUrl("macos-arm64"));
    expect(out.verdict).toBe("failed");
  });
});

describe("PackageManifestVerify on manifests nobody generated", () => {
  test("a url with no sha256 fails the file, and the intact pair is still checked", async () => {
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const out = await run(packageManifestVerify, {
      manifests: [{ text: FORMULA_URL_WITHOUT_SHA, label: "hand-edited.rb" }],
    });
    expect(out.verdict).toBe("failed");
    expect(out.findings.some((f: { code: string }) => f.code === "urlWithoutSha")).toBe(true);
    // The pair that IS intact still gets fetched and hashed: half a formula
    // checked is better than a file rejected wholesale.
    expect(out.summary.verified).toBe(1);
  });

  test("two scoop urls and one hash is one unverified download", async () => {
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const out = await run(packageManifestVerify, {
      manifests: [{ text: SCOOP_UNPAIRED, kind: "scoop", label: "crewhaus.json" }],
    });
    expect(out.findings.some((f: { code: string }) => f.code === "urlWithoutSha")).toBe(true);
    expect(out.verdict).toBe("failed");
  });

  test("bytesDownloaded counts what was actually read, and only that", async () => {
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const out = await run(packageManifestVerify, {
      manifests: [{ text: renderWingetManifest(RELEASE) }],
    });
    expect(out.bytesDownloaded).toBe(ASSET_BYTES["windows-x64"].byteLength);

    const off = await run(packageManifestVerify, {
      manifests: [{ text: renderWingetManifest(RELEASE) }],
      download: false,
    });
    expect(off.bytesDownloaded).toBe(0);
  });
});

describe("PackageManifestVerify: a manifest it could not read is not a manifest that passed", () => {
  test("a format it cannot identify is reported as not checked", async () => {
    const out = await run(packageManifestVerify, {
      manifests: [{ text: "this is not a package manifest\n", label: "mystery.txt" }],
      download: false,
    });
    expect(out.verdict).toBe("incomplete");
    expect(out.notChecked[0].message).toMatch(/could not tell which of/);
    expect(out.assets).toEqual([]);
  });

  test("a scoop manifest that is not JSON is reported, not parsed as far as it goes", async () => {
    const out = await run(packageManifestVerify, {
      manifests: [{ text: '{"version": "1.2.3", "url"', kind: "scoop", label: "scoop.json" }],
      download: false,
    });
    expect(out.notChecked[0].message).toMatch(/not valid JSON/);
    expect(out.verdict).toBe("incomplete");
  });

  test("an explicit kind skips detection for a file that does not announce itself", async () => {
    const out = await run(packageManifestVerify, {
      manifests: [{ text: SCOOP_TOP_LEVEL, kind: "scoop" }],
      download: false,
    });
    expect(out.manifests[0].kind).toBe("scoop");
    expect(out.assets).toHaveLength(1);
  });

  test("with nothing to check at all it says so rather than reporting success", async () => {
    const out = await text(packageManifestVerify, {});
    expect(out).toMatch(/needs at least one manifest/);
  });
});

describe("PackageManifestVerify reads manifests from the workspace", () => {
  const originalCwd = process.cwd();
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "crewhaus-distribution-"));
    process.chdir(workspace);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  test("a path is read, parsed and reported under its relative name", async () => {
    writeFileSync(join(workspace, "crewhaus.rb"), renderHomebrewFormula(RELEASE));
    const out = await run(packageManifestVerify, { paths: ["crewhaus.rb"], download: false });
    expect(out.manifests[0].source).toBe("crewhaus.rb");
    expect(out.manifests[0].kind).toBe("homebrew");
    expect(out.assets).toHaveLength(4);
  });

  test("a path that leaves the workspace is refused outright", async () => {
    const out = await text(packageManifestVerify, { paths: ["../escape.rb"] });
    expect(out).toMatch(/escapes the workspace root/);
  });

  test("a file that is not there is 'not checked', not 'nothing wrong'", async () => {
    const out = await run(packageManifestVerify, { paths: ["absent.rb"], download: false });
    expect(out.verdict).toBe("incomplete");
    expect(out.notChecked[0].source).toBe("absent.rb");
    expect(out.assets).toEqual([]);
  });

  test("text and paths can be mixed in one call", async () => {
    writeFileSync(join(workspace, "control"), renderDebianControl(RELEASE));
    const out = await run(packageManifestVerify, {
      paths: ["control"],
      manifests: [{ text: renderHomebrewFormula(RELEASE), label: "crewhaus.rb" }],
      download: false,
    });
    expect(out.manifests.map((m: { kind: string }) => m.kind).sort()).toEqual([
      "debian",
      "homebrew",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("the two tools together", () => {
  test("generate, then verify what was generated against the bytes it hashes", async () => {
    const generated = await run(packageManifestGenerate, GENERATE_INPUT);
    _setFetch(stubFetch(releaseRoutes()).fetch);
    const verified = await run(packageManifestVerify, {
      manifests: generated.manifests.map((m: { kind: string; text: string; filename: string }) => ({
        text: m.text,
        kind: m.kind,
        label: m.filename,
      })),
      expectVersion: VERSION,
    });
    expect(verified.verdict).toBe("verified");
    expect(verified.findings).toBeUndefined();
    expect(verified.summary.verified).toBe(6);
  });

  test("a release whose assets were rebuilt is caught by the pair", async () => {
    // The manifests were generated from one build; the host now serves a
    // different one. Nothing is missing and nothing is unreachable — the
    // digests simply disagree, and that is the loud one.
    const generated = await run(packageManifestGenerate, GENERATE_INPUT);
    const rebuilt = Object.fromEntries(
      Object.keys(releaseRoutes()).map((url) => [url, { body: bytesOf(`rebuilt ${url}`) }]),
    );
    _setFetch(stubFetch(rebuilt).fetch);
    const verified = await run(packageManifestVerify, {
      manifests: generated.manifests.map((m: { kind: string; text: string }) => ({
        text: m.text,
        kind: m.kind,
      })),
    });
    expect(verified.verdict).toBe("failed");
    expect(verified.summary.mismatched).toBe(6);
    expect(verified.summary.unchecked).toBe(0);
  });
});
