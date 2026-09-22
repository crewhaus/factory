/**
 * The three libraries under the two tools: what the generator refuses, what
 * the reader can make of a published manifest, and what the download path
 * concludes when a fetch does not go as planned.
 *
 * The download tests exist for one reason: to pin the difference between "this
 * asset is missing", "this hash disagrees" and "nothing was learned". Each of
 * the last group asserts its REASON, never just that something failed — a test
 * that only checks for failure is satisfied by a timeout, which is the exact
 * confusion this package is meant to prevent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CREWHAUS_PRODUCT,
  type ManifestInputs,
  renderDebianControl,
  renderHomebrewFormula,
  renderScoopManifest,
  renderWingetManifest,
} from "@crewhaus/single-binary-cli";
import { toHex } from "@crewhaus/tool-encode";
import { hash as encodeHash } from "@crewhaus/tool-encode";
import { _setDnsLookup } from "@crewhaus/tool-fetch";
import {
  ASSET_BYTES,
  ASSET_SHAS,
  CONTROL_DOUBLE_INDENTED,
  CONTROL_LOST_SPACE,
  FORMULA_URL_WITHOUT_SHA,
  RELEASE,
  SCOOP_TOP_LEVEL,
  SCOOP_UNPAIRED,
  VERSION,
  assetUrl,
  bytesOf,
  forbidNetwork,
  sha256Of,
  stubFetch,
  withoutTarget,
} from "./fixtures";
import {
  MANIFEST_KINDS,
  type ManifestKind,
  REQUIRED_TARGETS,
  TARGET_KEYS,
  checkDownloadBaseUrl,
  checkHomepage,
  checkProduct,
  checkRubyString,
  checkShas,
  checkVersion,
  checkYamlScalar,
  homebrewClassFor,
  manifestFilename,
} from "./lib/inputs";
import { DEFAULT_MAX_BYTES, _setFetch, probeAsset, sha256Hex } from "./lib/net";
import { detectKind, parseManifest, targetOf, versionInUrl, versionTokensInUrl } from "./lib/parse";

const PRODUCT = {
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

/** Resolve every host to a public address unless a test says otherwise. */
function dns(map: Record<string, string> = {}): void {
  _setDnsLookup(async (host) => ({ address: map[host] ?? "93.184.216.34", family: 4 }));
}

beforeEach(() => {
  // Fail loudly rather than dialling: see `forbidNetwork`.
  _setFetch(forbidNetwork);
  dns();
});

afterEach(() => {
  _setFetch(undefined);
  _setDnsLookup(undefined);
});

// ---------------------------------------------------------------------------

describe("REQUIRED_TARGETS is proven against the renderers, not just stated", () => {
  /**
   * The table in `inputs.ts` restates the `requireSha` calls inside four
   * functions this package does not own. A restatement that drifts is worse
   * than none: the tool would accept a sha map the renderer then throws on, or
   * demand one it does not need. So the table is checked from both sides —
   * every listed target is genuinely required, and the listed set is genuinely
   * sufficient.
   */
  const render: Record<ManifestKind, (inputs: ManifestInputs) => unknown> = {
    homebrew: renderHomebrewFormula,
    debian: renderDebianControl,
    scoop: renderScoopManifest,
    winget: renderWingetManifest,
  };

  for (const kind of MANIFEST_KINDS) {
    for (const target of REQUIRED_TARGETS[kind]) {
      test(`${kind} refuses to render without ${target}`, () => {
        const sha256 = withoutTarget(ASSET_SHAS, target);
        expect(() => render[kind]({ ...RELEASE, sha256 })).toThrow(
          new RegExp(`missing sha256 for ${target}`),
        );
      });
    }

    test(`${kind} renders with exactly the targets the table lists (${REQUIRED_TARGETS[kind].length})`, () => {
      const sha256 = Object.fromEntries(
        REQUIRED_TARGETS[kind].map((target) => [target, ASSET_SHAS[target as never]]),
      );
      expect(() => render[kind]({ ...RELEASE, sha256 })).not.toThrow();
    });
  }

  test("debian needs no sha at all — the archive carries the checksums", () => {
    expect(REQUIRED_TARGETS.debian).toEqual([]);
    expect(() => renderDebianControl({ ...RELEASE, sha256: {} })).not.toThrow();
  });

  test("TARGET_KEYS comes from the build matrix, windows-arm64 included nowhere", () => {
    expect(TARGET_KEYS).toContain("windows-x64");
    expect(TARGET_KEYS).not.toContain("windows-arm64");
  });
});

// ---------------------------------------------------------------------------

describe("checkVersion", () => {
  test("accepts semver, with prerelease and build metadata", () => {
    for (const version of ["1.2.3", "0.0.1", "1.2.3-rc.1", "1.2.3+build.5", "10.20.30-alpha-2"]) {
      expect(checkVersion(version)).toBeUndefined();
    }
  });

  test("refuses what the Homebrew formula refuses", () => {
    expect(checkVersion("v1")).toMatch(/not semver-shaped/);
    expect(checkVersion("1.2")).toMatch(/not semver-shaped/);
  });

  test("refuses `1.2.3\"` — the renderer's own check would let it into the Ruby string", () => {
    // renderHomebrewFormula tests /^\d+\.\d+\.\d+/, which is unanchored at the
    // end. This is the case that check waves through and this one stops.
    const attack = '1.2.3"\n  system "touch /tmp/pwned';
    expect(() => renderHomebrewFormula({ ...RELEASE, version: attack })).not.toThrow();
    expect(checkVersion(attack)).toMatch(/not semver-shaped/);
  });
});

describe("checkDownloadBaseUrl", () => {
  test("accepts an https release URL unchanged", () => {
    const out = checkDownloadBaseUrl(
      "https://github.com/crewhaus/factory/releases/download/v1.2.3",
    );
    expect(out.ok && out.url).toBe("https://github.com/crewhaus/factory/releases/download/v1.2.3");
    expect(out.ok && out.notes).toEqual([]);
  });

  test("refuses plain http, and says why it is not a style preference", () => {
    const out = checkDownloadBaseUrl("http://dl.example.com/v1.2.3");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toMatch(/download and execute/);
  });

  test("refuses https to a private, loopback or link-local address", () => {
    for (const base of [
      "https://10.0.0.5/dl",
      "https://192.168.1.10/dl",
      "https://169.254.169.254/dl",
      "https://127.0.0.1/dl",
      "https://localhost/dl",
      "https://build.local/dl",
    ]) {
      const out = checkDownloadBaseUrl(base);
      expect({ base, ok: out.ok }).toEqual({ base, ok: false });
    }
  });

  test("sees through the inet_aton spellings of 127.0.0.1", () => {
    // A text comparison passes every one of these. The classifier comes from
    // tool-fetch, which parses instead of matching.
    for (const host of ["0177.0.0.1", "2130706433", "127.1", "0x7f.0.0.1"]) {
      const out = checkDownloadBaseUrl(`https://${host}/dl`);
      expect({ host, ok: out.ok }).toEqual({ host, ok: false });
    }
  });

  test("refuses credentials in the URL — these files are published", () => {
    const out = checkDownloadBaseUrl("https://user:token@dl.example.com/v1.2.3");
    expect(!out.ok && out.message).toMatch(/credentials/);
  });

  test("refuses a tab, because the parser deletes it and the renderer does not", () => {
    // THE trap this check exists for: `new URL` DELETES tab, CR and LF from
    // anywhere in a URL, so the string below validates as
    // https://dl.example.com/v1.2 — https, public host, no credentials — and
    // is then spliced into the formula verbatim, tab and all, in every
    // download line of all four files. Checking the parsed form and
    // publishing the string is how a validated URL becomes a different URL.
    const withTab = checkDownloadBaseUrl("https://dl.example.com/v1\t.2");
    expect(withTab.ok).toBe(false);
    expect(withTab.ok === false && withTab.message).toContain("U+0009");
    // The parse really does hide it, which is what makes the check necessary.
    expect(new URL("https://dl.example.com/v1\t.2").href).toBe("https://dl.example.com/v1.2");
    // A space and a DEL are the same mistake.
    expect(checkDownloadBaseUrl("https://dl.example.com/a b").ok).toBe(false);
    expect(checkHomepage("https://crewhaus.ai/\u007f").ok).toBe(false);
    // Percent-encoded, it is just a URL.
    expect(checkDownloadBaseUrl("https://dl.example.com/a%20b").ok).toBe(true);
  });

  test("refuses a query or fragment, which the appended filename would land behind", () => {
    expect(checkDownloadBaseUrl("https://dl.example.com/get?v=1").ok).toBe(false);
    expect(checkDownloadBaseUrl("https://dl.example.com/get#top").ok).toBe(false);
  });

  test("trims a trailing slash and says so rather than silently", () => {
    const out = checkDownloadBaseUrl("https://dl.example.com/v1.2.3//");
    expect(out.ok && out.url).toBe("https://dl.example.com/v1.2.3");
    expect(out.ok && out.notes[0]).toMatch(/trailing slash/);
  });

  test("refuses a quote, a backslash or Ruby interpolation before the URL is parsed", () => {
    expect(checkDownloadBaseUrl('https://dl.example.com/a"b').ok).toBe(false);
    expect(checkDownloadBaseUrl("https://dl.example.com/#{`id`}").ok).toBe(false);
  });
});

describe("checkHomepage", () => {
  test("https passes with no note; http passes with one", () => {
    expect(checkHomepage("https://crewhaus.ai")).toEqual({
      ok: true,
      url: "https://crewhaus.ai",
      notes: [],
    });
    const http = checkHomepage("http://crewhaus.ai");
    expect(http.ok && http.notes[0]).toMatch(/brew audit/);
  });

  test("refuses a scheme a browser would not open", () => {
    expect(checkHomepage("javascript:alert(1)").ok).toBe(false);
    expect(checkHomepage("file:///etc/passwd").ok).toBe(false);
  });
});

describe("the two format guards", () => {
  test("checkRubyString stops what would end or escape the string, or run", () => {
    expect(checkRubyString("desc", 'a "quote"')).toMatch(/double quote/);
    expect(checkRubyString("desc", "back\\slash")).toMatch(/backslash/);
    expect(checkRubyString("desc", "hi #{`id`}")).toMatch(/interpolation/);
    expect(checkRubyString("desc", "a plain sentence — with an em dash")).toBeUndefined();
  });

  test("checkYamlScalar stops what would not read back as text", () => {
    expect(checkYamlScalar("f", "key: value")).toMatch(/nested mapping/);
    expect(checkYamlScalar("f", "- item")).toMatch(/indicator character/);
    expect(checkYamlScalar("f", "trailing:")).toMatch(/mapping key/);
    expect(checkYamlScalar("f", "text # comment")).toMatch(/comment/);
    expect(checkYamlScalar("f", " padded ")).toMatch(/whitespace/);
    // The real crewhaus strings have to pass, colons in URLs included.
    expect(checkYamlScalar("f", "https://crewhaus.ai")).toBeUndefined();
    expect(
      checkYamlScalar("f", "Modular meta-harness — compile a single spec into multiple runtimes"),
    ).toBeUndefined();
  });
});

describe("checkProduct", () => {
  test("the crewhaus and widget identities pass unchanged", () => {
    // CREWHAUS_PRODUCT is what ships on every real release, so a rule tightened
    // here has to keep accepting it — including the em dash in its description,
    // the angle brackets in its maintainer and its six-line macOS note.
    expect(checkProduct(CREWHAUS_PRODUCT)).toEqual([]);
    expect(checkProduct(PRODUCT)).toEqual([]);
  });

  test("THE trap: a Debian line that already carries its leading space", () => {
    const problems = checkProduct({
      ...PRODUCT,
      debian: { ...PRODUCT.debian, longDescription: [" Serves widgets."] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/doubly indented/);
  });

  test("a tab is the same mistake and reads the same way", () => {
    const problems = checkProduct({
      ...PRODUCT,
      debian: { ...PRODUCT.debian, longDescription: ["\tServes widgets."] },
    });
    expect(problems[0]).toMatch(/already starts with a tab/);
  });

  test("a blank continuation line ends the paragraph; '.' is the break", () => {
    const problems = checkProduct({
      ...PRODUCT,
      debian: { ...PRODUCT.debian, longDescription: ["Serves widgets.", "", "Nothing more."] },
    });
    expect(problems[0]).toMatch(/use "\." for a paragraph break/);
    expect(
      checkProduct({
        ...PRODUCT,
        debian: { ...PRODUCT.debian, longDescription: ["Serves widgets.", ".", "Nothing more."] },
      }),
    ).toEqual([]);
  });

  test("a line break inside one entry is refused with the fix in the message", () => {
    const problems = checkProduct({
      ...PRODUCT,
      debian: { ...PRODUCT.debian, longDescription: ["one\ntwo"] },
    });
    expect(problems[0]).toMatch(/one array entry per line/);
  });

  test("binaryName has to be a Debian package name and a safe filename", () => {
    for (const binaryName of ["Widgetd", "widget d", "../widgetd", "w", "widget/d"]) {
      const problems = checkProduct({ ...PRODUCT, binaryName });
      expect({ binaryName, problems: problems.length > 0 }).toEqual({ binaryName, problems: true });
    }
  });

  test("formulaClass has to be a Ruby class name", () => {
    expect(checkProduct({ ...PRODUCT, formulaClass: "widgetd" })[0]).toMatch(/Ruby class name/);
  });

  test("winget.packageIdentifier has to be Publisher.Package", () => {
    expect(
      checkProduct({ ...PRODUCT, winget: { ...PRODUCT.winget, packageIdentifier: "widgetd" } })[0],
    ).toMatch(/winget identifier/);
  });

  test("a quote in the description is Ruby, not decoration", () => {
    const problems = checkProduct({ ...PRODUCT, shortDescription: 'the "daemon"' });
    expect(problems[0]).toMatch(/double quote/);
  });

  test("every problem is reported, not just the first", () => {
    const problems = checkProduct({
      ...PRODUCT,
      binaryName: "Widget D",
      formulaClass: "widgetd",
      shortDescription: 'a "quote"',
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  test("a '#{' inside the macOS note is inert — it is a Ruby comment", () => {
    expect(
      checkProduct({ ...PRODUCT, homebrewMacosNote: ["mentions #{something} in prose"] }),
    ).toEqual([]);
    expect(checkProduct({ ...PRODUCT, homebrewMacosNote: ["two\nlines"] })[0]).toMatch(
      /one array entry per line/,
    );
  });
});

describe("checkShas", () => {
  const all = { ...ASSET_SHAS };

  test("accepts the five targets for all four manifests", () => {
    const out = checkShas(all, [...MANIFEST_KINDS]);
    expect(out.ok).toBe(true);
  });

  test("refuses a sha that is not 64 hex characters, and says which", () => {
    const short = checkShas({ ...all, "linux-x64": "abc" }, ["homebrew"]);
    expect(!short.ok && short.message).toMatch(/linux-x64 is 3 characters, not 64/);
    const notHex = checkShas({ ...all, "linux-x64": "z".repeat(64) }, ["homebrew"]);
    expect(!notHex.ok && notHex.message).toMatch(/linux-x64 is not hex/);
  });

  test("a missing sha names the manifests that need that target", () => {
    const out = checkShas(withoutTarget(all, "windows-x64"), ["scoop", "winget"]);
    expect(!out.ok && out.message).toMatch(/windows-x64 \(needed by scoop, winget\)/);
  });

  test("the same missing sha is NOT a problem for a manifest that never uses it", () => {
    expect(checkShas(withoutTarget(all, "windows-x64"), ["homebrew"]).ok).toBe(true);
    expect(checkShas({}, ["debian"]).ok).toBe(true);
  });

  test("an unknown target key is refused rather than ignored", () => {
    // Ignoring it would report "missing sha256 for macos-arm64" and send the
    // caller looking at the wrong line.
    const out = checkShas({ ...all, macos_arm64: "a".repeat(64) }, ["homebrew"]);
    expect(!out.ok && out.message).toMatch(/"macos_arm64", which is not a build target/);
  });

  test("an uppercase sha is lowercased, with a note", () => {
    const out = checkShas({ ...all, "linux-x64": ASSET_SHAS["linux-x64"].toUpperCase() }, [
      "homebrew",
    ]);
    expect(out.ok && out.sha256["linux-x64"]).toBe(ASSET_SHAS["linux-x64"]);
    expect(out.ok && out.notes.some((n) => n.includes("lowercased"))).toBe(true);
  });

  test("shas the selected manifests do not use are kept out, with a note", () => {
    const out = checkShas(all, ["scoop"]);
    expect(out.ok && out.notes.some((n) => n.includes("macos-arm64"))).toBe(true);
  });
});

describe("homebrewClassFor and manifestFilename", () => {
  test("Homebrew's filename-to-class rule, for the note the tool emits", () => {
    expect(homebrewClassFor("crewhaus")).toBe("Crewhaus");
    expect(homebrewClassFor("demo-driver")).toBe("DemoDriver");
    expect(homebrewClassFor("node@20")).toBe("Node20");
  });

  test("each manifest is published under the name its ecosystem expects", () => {
    expect(manifestFilename("homebrew", PRODUCT)).toBe("Formula/widgetd.rb");
    expect(manifestFilename("debian", PRODUCT)).toBe("debian/control");
    expect(manifestFilename("scoop", PRODUCT)).toBe("widgetd.json");
    expect(manifestFilename("winget", PRODUCT)).toBe("WidgetCo.Widgetd.installer.yaml");
  });
});

// ---------------------------------------------------------------------------

describe("detectKind", () => {
  test("recognises all four of the renderer's own outputs", () => {
    expect(detectKind(renderHomebrewFormula(RELEASE))).toBe("homebrew");
    expect(detectKind(renderDebianControl(RELEASE))).toBe("debian");
    expect(detectKind(JSON.stringify(renderScoopManifest(RELEASE), null, 2))).toBe("scoop");
    expect(detectKind(renderWingetManifest(RELEASE))).toBe("winget");
  });

  test("winget is not mistaken for debian by its PackageIdentifier line", () => {
    expect(detectKind("PackageIdentifier: CrewHaus.CLI\nPackageVersion: 1.2.3\n")).toBe("winget");
  });

  test("undecided stays undecided rather than guessing", () => {
    expect(detectKind("just some text\n")).toBeUndefined();
    expect(detectKind("{not json")).toBeUndefined();
  });
});

describe("reading a Homebrew formula back", () => {
  const parsed = parseManifest(renderHomebrewFormula(RELEASE), "crewhaus.rb", "homebrew");

  test("every url is paired with the sha256 that follows it", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.version).toBe(VERSION);
    expect(parsed.manifest.assets.map((a) => a.label)).toEqual([
      "macos-arm64",
      "macos-x64",
      "linux-arm64",
      "linux-x64",
    ]);
    expect(parsed.manifest.assets.map((a) => a.declaredSha256)).toEqual([
      ASSET_SHAS["macos-arm64"],
      ASSET_SHAS["macos-x64"],
      ASSET_SHAS["linux-arm64"],
      ASSET_SHAS["linux-x64"],
    ]);
    expect(parsed.manifest.findings).toEqual([]);
  });

  test("a url with no sha256 after it is the loudest thing in the file", () => {
    const out = parseManifest(FORMULA_URL_WITHOUT_SHA, "hand-edited.rb", "homebrew");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const finding = out.manifest.findings.find((f) => f.code === "urlWithoutSha");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toMatch(/without checking it/);
    // The pair that IS intact is still read, so the rest of the file is checked.
    expect(out.manifest.assets).toHaveLength(1);
  });

  test("a formula with no version line reports that it could not read one", () => {
    const out = parseManifest(
      `class X < Formula\n  url "https://e.example/a"\n  sha256 "${"a".repeat(64)}"\nend\n`,
      "x.rb",
      "homebrew",
    );
    expect(out.ok && out.manifest.version).toBeUndefined();
    expect(out.ok && out.manifest.findings[0]?.severity).toBe("unknown");
  });
});

describe("reading a Debian control paragraph back", () => {
  test("the renderer's output is clean", () => {
    const out = parseManifest(renderDebianControl(RELEASE), "control", "debian");
    expect(out.ok && out.manifest.findings).toEqual([]);
    expect(out.ok && out.manifest.version).toBe(VERSION);
    expect(out.ok && out.manifest.assets).toEqual([]);
  });

  test("a continuation line that lost its space is an error", () => {
    const out = parseManifest(CONTROL_LOST_SPACE, "control", "debian");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const finding = out.manifest.findings.find((f) => f.code === "continuationLostSpace");
    expect(finding?.severity).toBe("error");
  });

  test("a doubly indented line is legal but almost never intended, so it is a note", () => {
    const out = parseManifest(CONTROL_DOUBLE_INDENTED, "control", "debian");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const finding = out.manifest.findings.find((f) => f.code === "continuationDoubleIndented");
    expect(finding?.severity).toBe("note");
    expect(finding?.message).toMatch(/verbatim/);
  });

  test("a missing required field is named", () => {
    const out = parseManifest("Package: x\nVersion: 1.0.0\n", "control", "debian");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const missing = out.manifest.findings.filter((f) => f.code === "fieldMissing");
    expect(missing.map((f) => f.message).join(" ")).toMatch(/Description/);
  });
});

describe("reading a winget manifest back", () => {
  test("the renderer's output is clean and its digest is uppercase", () => {
    const out = parseManifest(renderWingetManifest(RELEASE), "winget.yaml", "winget");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest.findings).toEqual([]);
    expect(out.manifest.assets[0]?.label).toBe("x64");
    expect(out.manifest.assets[0]?.declaredSha256).toBe(ASSET_SHAS["windows-x64"].toUpperCase());
  });

  test("an InstallerUrl with no InstallerSha256 is the loudest thing in the file", () => {
    // The winget twin of the formula case: `winget install` would download and
    // run that installer without checking it against anything. Both spellings
    // are covered — the entry followed by another installer, and the one at
    // the end of the list with nothing after it.
    const manifest = `PackageIdentifier: CrewHaus.CLI
PackageVersion: 1.2.3
Installers:
  - Architecture: x64
    InstallerUrl: ${assetUrl("windows-x64")}
  - Architecture: arm64
    InstallerUrl: https://dl.example.com/crewhaus-windows-arm64-1.2.3.exe
ManifestType: installer
`;
    const parsed = parseManifest(manifest, "winget.yaml", "winget");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const unverified = parsed.manifest.findings.filter((f) => f.code === "urlWithoutSha");
    expect(unverified).toHaveLength(2);
    expect(unverified.every((f) => f.severity === "error")).toBe(true);
    expect(unverified[0]?.message).toContain("windows-x64");
    expect(unverified[1]?.message).toContain("windows-arm64");
    // Neither became an asset row: there is no sha to compare a download to,
    // so "not checked" is the only honest thing to say about the bytes.
    expect(parsed.manifest.assets).toHaveLength(0);
    expect(parsed.manifest.findings.some((f) => f.code === "noDownloads")).toBe(true);
  });

  test("a lowercase InstallerSha256 is a manifest defect, and says it is not a hash mismatch", () => {
    const lowered = renderWingetManifest(RELEASE).replace(
      ASSET_SHAS["windows-x64"].toUpperCase(),
      ASSET_SHAS["windows-x64"],
    );
    const out = parseManifest(lowered, "winget.yaml", "winget");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const finding = out.manifest.findings.find((f) => f.code === "shaNotUppercase");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toMatch(/not a hash mismatch/);
  });
});

describe("reading a scoop manifest back", () => {
  test("the architecture map shape, as the renderer writes it", () => {
    const out = parseManifest(
      JSON.stringify(renderScoopManifest(RELEASE), null, 2),
      "crewhaus.json",
      "scoop",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest.assets).toHaveLength(1);
    expect(out.manifest.assets[0]?.label).toBe("64bit");
    expect(out.manifest.findings).toEqual([]);
  });

  test("the top-level url/hash shape a bucket may publish instead", () => {
    const out = parseManifest(SCOOP_TOP_LEVEL, "crewhaus.json", "scoop");
    expect(out.ok && out.manifest.assets[0]?.url).toBe(assetUrl("windows-x64"));
  });

  test("two urls and one hash means one unverified download", () => {
    const out = parseManifest(SCOOP_UNPAIRED, "crewhaus.json", "scoop");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest.findings.find((f) => f.code === "urlWithoutSha")?.severity).toBe("error");
  });

  test("a hash this tool cannot compute is reported as unchecked, not as wrong", () => {
    const out = parseManifest(
      JSON.stringify({ version: "1.2.3", url: "https://e.example/a", hash: "sha512:abc" }),
      "s.json",
      "scoop",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const finding = out.manifest.findings.find((f) => f.code === "hashAlgorithmUnsupported");
    expect(finding?.severity).toBe("unknown");
  });

  test("invalid JSON is a manifest that was not read, not one that passed", () => {
    const out = parseManifest("{oops", "s.json", "scoop");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toMatch(/not valid JSON/);
  });
});

describe("versionInUrl has three answers", () => {
  test("matches", () => {
    expect(versionInUrl(assetUrl("linux-x64"), "1.2.3")).toBe("matches");
  });

  test("differs — and 1.2.30 is not 1.2.3", () => {
    // A substring test says these match. That is how a manifest pointing at
    // last week's build passes a version check.
    expect(versionInUrl("https://e.example/tool-linux-x64-1.2.30", "1.2.3")).toBe("differs");
    expect(versionInUrl("https://e.example/tool-1.2.4", "1.2.3")).toBe("differs");
  });

  test("notFound is not a failure — some releases publish a 'latest' path", () => {
    expect(versionInUrl("https://e.example/latest/download/tool.exe", "1.2.3")).toBe("notFound");
  });

  test("the HOST is not scanned — an IP-literal host is not a version", () => {
    // `93.184.216.34` contains the token `93.184.216`, so scanning the whole
    // URL made a manifest served from an IP literal read as "this URL names a
    // different version" — an error finding on a file whose only sin is an
    // unusual host. The version lives in the tag and the filename.
    expect(versionInUrl("https://93.184.216.34/latest/crewhaus.exe", "1.2.3")).toBe("notFound");
    expect(versionTokensInUrl("https://93.184.216.34/latest/crewhaus.exe")).toEqual([]);
    expect(versionTokensInUrl("https://93.184.216.34/v1.2.3/crewhaus")).toEqual(["1.2.3"]);
  });

  test("a version carried only in the tag still counts", () => {
    expect(versionInUrl("https://e.example/releases/v1.2.3/tool", "1.2.3")).toBe("matches");
  });
});

describe("targetOf", () => {
  test("names the build target when the filename does", () => {
    expect(targetOf(assetUrl("macos-arm64"))).toBe("macos-arm64");
    expect(targetOf(assetUrl("windows-x64"))).toBe("windows-x64");
  });

  test("falls back to the filename rather than inventing a target", () => {
    expect(targetOf("https://e.example/downloads/tool.zip")).toBe("tool.zip");
  });
});

// ---------------------------------------------------------------------------

describe("probeAsset: the asset is there", () => {
  test("hashes the bytes and reports how many arrived", async () => {
    dns();
    const url = assetUrl("linux-x64");
    _setFetch(stubFetch({ [url]: { body: ASSET_BYTES["linux-x64"] } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind).toBe("ok");
    if (probe.kind !== "ok") return;
    expect(probe.sha256).toBe(ASSET_SHAS["linux-x64"]);
    expect(probe.bytes).toBe(ASSET_BYTES["linux-x64"].byteLength);
  });

  test("a body that arrives in many chunks hashes to the same digest", async () => {
    dns();
    const url = assetUrl("macos-arm64");
    _setFetch(stubFetch({ [url]: { body: ASSET_BYTES["macos-arm64"], chunk: 3 } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "ok" && probe.sha256).toBe(ASSET_SHAS["macos-arm64"]);
  });

  test("the streaming digest agrees with @crewhaus/tool-encode, which owns the primitive", async () => {
    // This package hashes incrementally so an 80 MB installer is never held in
    // memory, which tool-encode's one-shot `Hash` cannot do. The two must
    // still agree, so the oracle is tool-encode itself rather than a literal.
    dns();
    const body = bytesOf("a body worth hashing twice, in two different ways");
    const url = "https://dl.example.com/tool-1.2.3";
    _setFetch(stubFetch({ [url]: { body, chunk: 7 } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    const oracle = await encodeHash.execute({
      text: toHex(body),
      inputEncoding: "hex",
      algorithm: "sha256",
    });
    const expected = JSON.parse(oracle as string).digest as string;
    expect(probe.kind === "ok" && probe.sha256).toBe(expected);
    expect(sha256Hex(body)).toBe(expected);
  });

  test("a body that is not text hashes byte-for-byte — no decode, no re-encode", async () => {
    dns();
    // An installer is a binary, and these bytes are deliberately not valid
    // UTF-8: a lone 0x80 continuation, a truncated two-byte lead (0xC3 0x28)
    // and a surrogate half (0xED 0xA0 0x80). Anything that turned the chunk
    // into a string and back would replace each of them with U+FFFD, change
    // both the digest and the byte count, and make every verdict this package
    // reaches a statement about bytes it never saw. Chunked, because the
    // round-trip would also corrupt a multi-byte sequence split across a
    // chunk boundary even for text that IS valid UTF-8.
    const binary = new Uint8Array([
      0x4d, 0x5a, 0x90, 0x00, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf4, 0x90,
      0x80, 0x80, 0x00, 0x1b, 0x7f,
    ]);
    const url = "https://dl.example.com/binary-1.2.3";
    _setFetch(stubFetch({ [url]: { body: binary, chunk: 3 } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "ok" && probe.sha256).toBe(sha256Of(binary));
    expect(probe.kind === "ok" && probe.bytes).toBe(binary.byteLength);
    // Belt and braces: the digest of what a UTF-8 round trip would produce is
    // a different number, so asserting the right one is a real assertion.
    expect(sha256Of(new TextEncoder().encode(new TextDecoder().decode(binary)))).not.toBe(
      sha256Of(binary),
    );
  });

  test("a body far larger than one chunk still streams — 4 MiB in 64 KiB pieces", async () => {
    dns();
    // Bytes moved, not wall clock: 4 MiB through 64 reads. The budget is
    // generous because CI is a loaded two-core box, and this test must never
    // be the one that flakes there.
    const big = new Uint8Array(4 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const url = "https://dl.example.com/big-1.2.3";
    _setFetch(stubFetch({ [url]: { body: big, chunk: 64 * 1024 } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 30_000 });
    expect(probe.kind === "ok" && probe.sha256).toBe(sha256Of(big));
    expect(probe.kind === "ok" && probe.bytes).toBe(big.byteLength);
  }, 30_000);
});

describe("probeAsset: the asset is missing", () => {
  test("404 is a definite answer about the asset", async () => {
    dns();
    // An unlisted URL answers 404, which is what a release host does for an
    // asset that was never uploaded.
    _setFetch(stubFetch({}).fetch);
    const probe = await probeAsset("https://dl.example.com/gone-1.2.3", {
      maxBytes: DEFAULT_MAX_BYTES,
      timeoutMs: 5_000,
    });
    expect(probe.kind).toBe("missing");
    expect(probe.kind === "missing" && probe.status).toBe(404);
  });

  test("410 Gone is the same answer", async () => {
    dns();
    const url = "https://dl.example.com/retired-1.2.3";
    _setFetch(stubFetch({ [url]: { status: 410, body: "" } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind).toBe("missing");
  });
});

describe("probeAsset: nothing was learned, and the reason says which", () => {
  test("a name that does not resolve is dns, not missing", async () => {
    _setDnsLookup(async () => {
      throw new Error("getaddrinfo ENOTFOUND dl.example.com");
    });
    const probe = await probeAsset("https://dl.example.com/tool-1.2.3", {
      maxBytes: DEFAULT_MAX_BYTES,
      timeoutMs: 5_000,
    });
    expect(probe.kind).toBe("unknown");
    expect(probe.kind === "unknown" && probe.reason).toBe("dns");
  });

  test("a host that resolves into private space is refused, not fetched", async () => {
    dns({ "dl.example.com": "169.254.169.254" });
    const probe = await probeAsset("https://dl.example.com/tool-1.2.3", {
      maxBytes: DEFAULT_MAX_BYTES,
      timeoutMs: 5_000,
    });
    expect(probe.kind === "unknown" && probe.reason).toBe("refused");
    expect(probe.kind === "unknown" && probe.message).toMatch(/private IP/);
  });

  test("a deadline that elapses is timeout — asserted by REASON, not by failing", async () => {
    dns();
    const url = "https://dl.example.com/slow-1.2.3";
    _setFetch(stubFetch({ [url]: { hang: true } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 25 });
    expect(probe.kind === "unknown" && probe.reason).toBe("timeout");
  });

  test("a caller who cancels is `cancelled`, not `timeout` — the host was not slow", async () => {
    // Both arrive as an AbortError. Reporting a cancelled run as a timeout
    // sends somebody to look at a release host that was never asked anything.
    dns();
    const url = "https://dl.example.com/tool-1.2.3";
    _setFetch(stubFetch({ [url]: { body: ASSET_BYTES["linux-x64"] } }).fetch);
    const controller = new AbortController();
    controller.abort();
    const probe = await probeAsset(url, {
      maxBytes: DEFAULT_MAX_BYTES,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(probe.kind === "unknown" && probe.reason).toBe("cancelled");
  });

  test("a socket that dies is transport", async () => {
    dns();
    const url = "https://dl.example.com/tool-1.2.3";
    _setFetch(stubFetch({ [url]: { throws: "ECONNRESET" } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("transport");
    expect(probe.kind === "unknown" && probe.message).toMatch(/ECONNRESET/);
  });

  test("a body past the cap is `cap`, and the message refuses to call it a mismatch", async () => {
    dns();
    const url = "https://dl.example.com/huge-1.2.3";
    _setFetch(stubFetch({ [url]: { body: "x".repeat(4096), chunk: 512 } }).fetch);
    const probe = await probeAsset(url, { maxBytes: 1024, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("cap");
    expect(probe.kind === "unknown" && probe.message).toMatch(/not a mismatch/);
  });

  test("a body shorter than its own Content-Length is shortRead, never a mismatch", async () => {
    dns();
    const url = "https://dl.example.com/truncated-1.2.3";
    _setFetch(
      stubFetch({
        [url]: { body: bytesOf("half of"), headers: { "content-length": "999" } },
      }).fetch,
    );
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("shortRead");
    expect(probe.kind === "unknown" && probe.message).toMatch(/999 bytes and delivered 7/);
  });

  test("a gzipped body is not a short read — Content-Length counts wire bytes", async () => {
    // The CDN default that would otherwise make every asset fail: the length
    // header describes the compressed bytes, the runtime hands over the
    // decoded ones, and comparing the two invents a truncation.
    dns();
    const url = "https://dl.example.com/tool-1.2.3";
    _setFetch(
      stubFetch({
        [url]: {
          body: ASSET_BYTES["linux-x64"],
          headers: { "content-length": "11", "content-encoding": "gzip" },
        },
      }).fetch,
    );
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "ok" && probe.sha256).toBe(ASSET_SHAS["linux-x64"]);
  });

  test("a 500 is not a 404 — a bad minute at the CDN is not a deleted asset", async () => {
    dns();
    const url = "https://dl.example.com/tool-1.2.3";
    _setFetch(stubFetch({ [url]: { status: 500, body: "boom" } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("status");
    expect(probe.kind === "unknown" && probe.status).toBe(500);
  });

  test("a 403 is not a 404 either", async () => {
    dns();
    const url = "https://dl.example.com/private-1.2.3";
    _setFetch(stubFetch({ [url]: { status: 403, body: "" } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("status");
  });

  test("a 200 with no body at all is unreadable, not an empty asset", async () => {
    dns();
    const url = "https://dl.example.com/empty-1.2.3";
    _setFetch(stubFetch({ [url]: { body: null } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("unreadable");
    // e3b0c442… is the sha256 of nothing, and answering with it here would be
    // total confidence about bytes that were never read.
    expect(JSON.stringify(probe)).not.toContain("e3b0c442");
  });

  test("a 200 that delivered zero bytes is unreadable too, not a mismatch", async () => {
    dns();
    // The sibling of the arm above, and the one that used to get through: the
    // body existed, it just carried nothing, so the stream read cleanly and
    // e3b0c442… went out as a computed digest. Compared against the real
    // sha256 it becomes a DEFINITE mismatch whose message says "0 bytes were
    // read in full, so this is a real disagreement and not a failed download".
    // A release asset is never empty; a zero-byte 200 is a dropped connection
    // or a bad cache entry, and neither is evidence about the release.
    const url = "https://dl.example.com/truncated-1.2.3";
    _setFetch(stubFetch({ [url]: { body: new Uint8Array(0) } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("unreadable");
    expect(JSON.stringify(probe)).not.toContain("e3b0c442");
  });

  test("a URL that is not a URL is refused before anything is dialled", async () => {
    dns();
    const probe = await probeAsset("not a url", { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("refused");
  });
});

describe("probeAsset: redirects", () => {
  test("follows a redirect and hashes what it lands on", async () => {
    dns();
    const first = "https://dl.example.com/tool-1.2.3";
    const second = "https://cdn.example.net/blobs/tool-1.2.3";
    const stub = stubFetch({
      [first]: { status: 302, headers: { location: second }, body: "" },
      [second]: { body: ASSET_BYTES["linux-x64"] },
    });
    _setFetch(stub.fetch);
    const probe = await probeAsset(first, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "ok" && probe.sha256).toBe(ASSET_SHAS["linux-x64"]);
    expect(probe.kind === "ok" && probe.finalUrl).toBe(second);
    expect(stub.calls).toHaveLength(2);
  });

  test("a redirect to plain http is refused at the hop", async () => {
    dns();
    const first = "https://dl.example.com/tool-1.2.3";
    _setFetch(
      stubFetch({
        [first]: { status: 302, headers: { location: "http://cdn.example.net/tool" }, body: "" },
      }).fetch,
    );
    const probe = await probeAsset(first, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("refused");
    expect(probe.kind === "unknown" && probe.message).toMatch(/only verifiable over https/);
  });

  test("a redirect into private space is refused at the hop, not followed", async () => {
    // The classic: a release host that bounces the download at the cloud
    // metadata service. The guard runs at EVERY hop, not just the first.
    dns({ "dl.example.com": "93.184.216.34", "metadata.example": "169.254.169.254" });
    const first = "https://dl.example.com/tool-1.2.3";
    const stub = stubFetch({
      [first]: {
        status: 302,
        headers: { location: "https://metadata.example/latest/meta-data/" },
        body: "",
      },
    });
    _setFetch(stub.fetch);
    const probe = await probeAsset(first, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("refused");
    expect(stub.calls).toHaveLength(1);
  });

  test("a redirect loop stops at the cap and says so", async () => {
    dns();
    const url = "https://dl.example.com/loop-1.2.3";
    _setFetch(stubFetch({ [url]: { status: 302, headers: { location: url }, body: "" } }).fetch);
    const probe = await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(probe.kind === "unknown" && probe.reason).toBe("refused");
    expect(probe.kind === "unknown" && probe.message).toMatch(/redirected more than/);
  });

  test("the connection is pinned to the address the guard vetted", async () => {
    dns({ "dl.example.com": "203.0.113.7" });
    const url = "https://dl.example.com/tool-1.2.3";
    const stub = stubFetch({ [url]: { body: ASSET_BYTES["linux-x64"] } });
    _setFetch(stub.fetch);
    await probeAsset(url, { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: 5_000 });
    expect(stub.calls[0]?.pinnedIp).toBe("203.0.113.7");
  });
});
