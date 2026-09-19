import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARCHES,
  BUILD_MATRIX,
  type BuildBinaryRunner,
  type ManifestInputs,
  PLATFORMS,
  SingleBinaryError,
  binaryName,
  buildBinary,
  bunCompileTarget,
  formatTarget,
  isBuildTarget,
  packagingDir,
  renderDebianControl,
  renderHomebrewFormula,
  renderScoopManifest,
  renderWingetManifest,
  sha256OfFile,
  writeAllManifests,
} from "./index";

describe("BUILD_MATRIX shape", () => {
  test("has 5 entries (windows-arm64 intentionally absent)", () => {
    expect(BUILD_MATRIX.length).toBe(5);
    expect(
      BUILD_MATRIX.find((m) => m.platform === "windows" && m.arch === "arm64"),
    ).toBeUndefined();
  });

  test("PLATFORMS and ARCHES are tightly typed enums", () => {
    expect(PLATFORMS).toEqual(["linux", "macos", "windows"]);
    expect(ARCHES).toEqual(["x64", "arm64"]);
  });
});

describe("bunCompileTarget", () => {
  test("linux/windows x64 compile against the AVX-free -baseline runtime", () => {
    expect(bunCompileTarget({ platform: "linux", arch: "x64" })).toBe("bun-linux-x64-baseline");
    expect(bunCompileTarget({ platform: "windows", arch: "x64" })).toBe("bun-windows-x64-baseline");
  });

  test("macos x64 stays on the default target (Bun ships no AVX-free macOS build)", () => {
    expect(bunCompileTarget({ platform: "macos", arch: "x64" })).toBe("bun-macos-x64");
  });

  test("arm64 targets have no baseline variant", () => {
    expect(bunCompileTarget({ platform: "linux", arch: "arm64" })).toBe("bun-linux-arm64");
    expect(bunCompileTarget({ platform: "macos", arch: "arm64" })).toBe("bun-macos-arm64");
  });

  test("every BUILD_MATRIX target produces a valid bun-<platform>-<arch>[-baseline] string", () => {
    for (const t of BUILD_MATRIX) {
      expect(bunCompileTarget(t)).toMatch(new RegExp(`^bun-${t.platform}-${t.arch}(-baseline)?$`));
    }
  });
});

describe("binaryName", () => {
  test("appends version + .exe on windows", () => {
    expect(binaryName({ platform: "windows", arch: "x64" }, "1.0.0")).toBe(
      "crewhaus-windows-x64-1.0.0.exe",
    );
  });

  test("no .exe on linux/macos", () => {
    expect(binaryName({ platform: "linux", arch: "x64" }, "1.0.0")).toBe(
      "crewhaus-linux-x64-1.0.0",
    );
    expect(binaryName({ platform: "macos", arch: "arm64" }, "0.0.1")).toBe(
      "crewhaus-macos-arm64-0.0.1",
    );
  });

  test("empty version → no trailing dash", () => {
    expect(binaryName({ platform: "linux", arch: "x64" }, "")).toBe("crewhaus-linux-x64");
  });
});

describe("isBuildTarget guard", () => {
  test("accepts every entry in BUILD_MATRIX", () => {
    for (const t of BUILD_MATRIX) {
      expect(isBuildTarget(t)).toBe(true);
    }
  });

  test("rejects windows-arm64 (not supported by Bun)", () => {
    expect(isBuildTarget({ platform: "windows", arch: "arm64" })).toBe(false);
  });
});

describe("buildBinary() (T2 dry-run)", () => {
  test("happy path — argv is bun build --compile --target=<platform>-<arch> ...", async () => {
    let captured: readonly string[] = [];
    const runner: BuildBinaryRunner = async (argv) => {
      captured = argv;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await buildBinary({
      target: { platform: "linux", arch: "x64" },
      version: "1.2.3",
      outDir: "/tmp/dist",
      runner,
    });
    expect(captured[0]).toBe("bun");
    expect(captured).toContain("build");
    expect(captured).toContain("--compile");
    expect(captured).toContain("--target");
    expect(captured).toContain("bun-linux-x64-baseline");
    expect(captured).toContain("--outfile");
    expect(captured).toContain("/tmp/dist/crewhaus-linux-x64-1.2.3");
    expect(captured).toContain("--define");
    expect(captured).toContain('CREWHAUS_EMBEDDED_VERSION="1.2.3"');
    expect(result.outPath).toBe("/tmp/dist/crewhaus-linux-x64-1.2.3");
  });

  test("no version → no --define (the CLI falls back to its package.json read)", async () => {
    let captured: readonly string[] = [];
    const runner: BuildBinaryRunner = async (argv) => {
      captured = argv;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await buildBinary({
      target: { platform: "linux", arch: "x64" },
      outDir: "/tmp/dist",
      runner,
    });
    expect(captured).not.toContain("--define");
  });

  test("rejects unsupported target windows-arm64", async () => {
    await expect(
      buildBinary({
        target: { platform: "windows", arch: "arm64" },
        runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow(/unsupported build target/);
  });

  test("non-zero exit → SingleBinaryError with stderr", async () => {
    await expect(
      buildBinary({
        target: { platform: "linux", arch: "x64" },
        runner: async () => ({ exitCode: 2, stdout: "", stderr: "bun not found" }),
      }),
    ).rejects.toThrow(/bun not found/);
  });

  test("formatTarget round-trip", () => {
    expect(formatTarget({ platform: "linux", arch: "arm64" })).toBe("linux-arm64");
  });
});

describe("manifest rendering (T1)", () => {
  const sha256 = {
    "macos-arm64": "a".repeat(64),
    "macos-x64": "b".repeat(64),
    "linux-arm64": "c".repeat(64),
    "linux-x64": "d".repeat(64),
    "windows-x64": "e".repeat(64),
  } as const;

  const inputs = {
    version: "1.0.0",
    homepage: "https://github.com/crewhaus/factory",
    downloadBaseUrl: "https://github.com/crewhaus/factory/releases/download/v1.0.0",
    sha256,
  };

  test("Homebrew formula has on_macos / on_linux blocks with correct shas", () => {
    const formula = renderHomebrewFormula(inputs);
    expect(formula).toContain("class Crewhaus < Formula");
    expect(formula).toContain('version "1.0.0"');
    expect(formula).toContain("on_macos");
    expect(formula).toContain("on_linux");
    // Apple Silicon under a Rosetta'd x86_64 brew must still get the arm64 binary
    // (Bun's macOS x64 runtime needs AVX2, which Rosetta lacks).
    expect(formula).toContain("Hardware::CPU.physical_cpu_arm64?");
    expect(formula).toContain('license "Apache-2.0"');
    expect(formula).toContain(sha256["macos-arm64"]);
    expect(formula).toContain(sha256["macos-x64"]);
    expect(formula).toContain(sha256["linux-arm64"]);
    expect(formula).toContain(sha256["linux-x64"]);
  });

  test("Homebrew rejects non-semver versions", () => {
    expect(() => renderHomebrewFormula({ ...inputs, version: "v1" })).toThrow();
  });

  test("Debian control has correct Architecture/Description", () => {
    const ctl = renderDebianControl(inputs);
    expect(ctl).toContain("Package: crewhaus");
    expect(ctl).toContain("Version: 1.0.0");
    expect(ctl).toContain("Architecture: any");
  });

  test("Scoop manifest exposes 64bit url + hash", () => {
    const scoop = renderScoopManifest(inputs) as {
      version: string;
      license: string;
      architecture: { "64bit": { url: string; hash: string } };
    };
    expect(scoop.version).toBe("1.0.0");
    expect(scoop.license).toBe("Apache-2.0");
    expect(scoop.architecture["64bit"].hash).toBe(sha256["windows-x64"]);
    expect(scoop.architecture["64bit"].url).toContain("crewhaus-windows-x64-1.0.0.exe");
  });

  test("Winget manifest is valid YAML-shaped text with InstallerSha256 uppercase", () => {
    const winget = renderWingetManifest(inputs);
    expect(winget).toContain("PackageIdentifier: CrewHaus.CLI");
    expect(winget).toContain("PackageVersion: 1.0.0");
    expect(winget).toContain("License: Apache-2.0");
    expect(winget).toContain(sha256["windows-x64"].toUpperCase());
  });

  test("manifest rendering refuses missing/short shas", () => {
    expect(() =>
      renderHomebrewFormula({ ...inputs, sha256: { "macos-arm64": sha256["macos-arm64"] } }),
    ).toThrow(/missing sha256/);
    expect(() => renderScoopManifest({ ...inputs, sha256: { "windows-x64": "short" } })).toThrow(
      /malformed sha256/,
    );
  });

  test("writeAllManifests writes deterministic files", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-pkg-"));
    const out = writeAllManifests(inputs, dir);
    const formulaText = readFileSync(out.homebrew, "utf8");
    const scoopText = readFileSync(out.scoop, "utf8");
    expect(formulaText).toContain('version "1.0.0"');
    expect(scoopText).toContain(
      '"hash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"',
    );
  });

  test("packagingDir() points at the package's packaging/ directory (default root)", () => {
    // The default on-disk root used by writeAllManifests when no dir is given.
    expect(packagingDir()).toMatch(/single-binary-cli[/\\]packaging$/);
  });
});

describe("sha256OfFile", () => {
  test("rejects missing files", async () => {
    await expect(sha256OfFile("/nonexistent/path/to/file")).rejects.toThrow(SingleBinaryError);
  });

  test("hashes a real file deterministically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-sha-"));
    const path = join(dir, "test.bin");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "deterministic test bytes");
    const a = await sha256OfFile(path);
    const b = await sha256OfFile(path);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the release manifests render byte-for-byte what they rendered before", () => {
  /**
   * These four strings ARE the published artefacts. A Homebrew formula that
   * differs by a line is a formula Homebrew may still install and then fail to
   * audit; a Debian control paragraph that loses its indentation is not a
   * control paragraph at all.
   *
   * The rest of this file checks these renderers with `toContain`, which is
   * fine for "does the sha appear" and useless for "did anything else move".
   * A refactor can reorder, reindent or drop a line — including the on_macos
   * comment that explains why an Apple-Silicon host is served the arm64 binary
   * even when Homebrew reports an Intel CPU, which is load-bearing knowledge
   * this project paid for once — and every existing assertion still passes.
   *
   * So: full output, pinned. Changing a manifest deliberately means updating
   * the expected text here, which is the point — it makes the change visible
   * in a diff instead of in the next release.
   */
  const SHA = (n: string): string => n.repeat(64).slice(0, 64);
  const INPUTS: ManifestInputs = {
    version: "1.2.3",
    homepage: "https://crewhaus.ai",
    downloadBaseUrl: "https://github.com/crewhaus/factory/releases/download/v1.2.3",
    sha256: {
      "macos-arm64": SHA("a"),
      "macos-x64": SHA("b"),
      "linux-arm64": SHA("c"),
      "linux-x64": SHA("d"),
      "windows-x64": SHA("e"),
    },
  };

  test("homebrew: the whole file, not a sample of it", () => {
    expect(renderHomebrewFormula(INPUTS)).toBe(`class Crewhaus < Formula
  desc "Modular meta-harness — compile a single spec into multiple agent runtimes"
  homepage "https://crewhaus.ai"
  version "1.2.3"
  license "Apache-2.0"

  on_macos do
    # An x86_64 Homebrew running under Rosetta 2 on Apple Silicon reports
    # Hardware::CPU.intel?, but the x64 binary then executes under Rosetta — which
    # emulates a pre-AVX (Westmere) CPU. Bun's macOS x64 runtime requires AVX2 and
    # there is no AVX-free macOS Bun build, so it warns ("CPU lacks AVX support")
    # and may crash. Serve the native arm64 binary on every Apple-Silicon host,
    # translated or not. Genuine Intel Macs (AVX2-capable) still get the x64 build.
    if Hardware::CPU.physical_cpu_arm64?
      url "https://github.com/crewhaus/factory/releases/download/v1.2.3/crewhaus-macos-arm64-1.2.3"
      sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    else
      url "https://github.com/crewhaus/factory/releases/download/v1.2.3/crewhaus-macos-x64-1.2.3"
      sha256 "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/crewhaus/factory/releases/download/v1.2.3/crewhaus-linux-arm64-1.2.3"
      sha256 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    end
    on_intel do
      url "https://github.com/crewhaus/factory/releases/download/v1.2.3/crewhaus-linux-x64-1.2.3"
      sha256 "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    end
  end

  def install
    bin.install Dir["*"].first => "crewhaus"
  end

  test do
    system "#{bin}/crewhaus", "--version"
  end
end
`);
  });

  test("debian: the whole file, not a sample of it", () => {
    expect(renderDebianControl(INPUTS)).toBe(`Package: crewhaus
Version: 1.2.3
Section: utils
Priority: optional
Architecture: any
Maintainer: CrewHaus Maintainers <maintainers@crewhaus.ai>
Depends: libc6 (>= 2.31)
Description: Modular meta-harness — compile a single spec into multiple agent runtimes
 CrewHaus compiles a single high-level harness spec into multiple
 runtime targets (graph, workflow, channel bot, eval, batch worker,
 voice service, browser-driver, research-runner). The binary is a
 self-contained Bun bundle requiring no Node/Bun on the target host.
`);
  });

  test("winget: the whole file, not a sample of it", () => {
    expect(
      renderWingetManifest(INPUTS),
    ).toBe(`# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.4.0.schema.json
PackageIdentifier: CrewHaus.CLI
PackageVersion: 1.2.3
Publisher: CrewHaus
Author: CrewHaus
PackageName: crewhaus
PackageUrl: https://crewhaus.ai
License: Apache-2.0
ShortDescription: Modular meta-harness — compile a single spec into multiple agent runtimes
Description: |
  CrewHaus compiles a single high-level harness spec into multiple runtime targets.
Tags:
  - cli
  - llm
  - agent-framework
Installers:
  - Architecture: x64
    InstallerType: portable
    InstallerUrl: https://github.com/crewhaus/factory/releases/download/v1.2.3/crewhaus-windows-x64-1.2.3.exe
    InstallerSha256: EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE
ManifestType: installer
ManifestVersion: 1.4.0
`);
  });

  test("scoop: the whole object, key order included", () => {
    // Scoop's manifest is JSON, so the assertion is on the serialised form —
    // key ORDER is part of what gets published and a plain object comparison
    // would not notice it moving.
    expect(JSON.stringify(renderScoopManifest(INPUTS), null, 2)).toBe(
      JSON.stringify(
        {
          version: "1.2.3",
          description:
            "Modular meta-harness \u2014 compile a single spec into multiple agent runtimes",
          homepage: "https://crewhaus.ai",
          license: "Apache-2.0",
          architecture: {
            "64bit": {
              url: "https://github.com/crewhaus/factory/releases/download/v1.2.3/crewhaus-windows-x64-1.2.3.exe",
              hash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            },
          },
          bin: "crewhaus.exe",
        },
        null,
        2,
      ),
    );
  });
});

describe("the renderers serve a product that is not crewhaus", () => {
  /**
   * The goldens above prove the refactor moved no bytes for crewhaus. This
   * proves the parameter is real rather than decorative — a `ProductIdentity`
   * nothing exercises is a type that compiles and does nothing.
   */
  const OTHER: ProductIdentity = {
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
    // No macOS note: the Rosetta/AVX caveat is a fact about Bun-compiled
    // binaries, and this one is not.
  };
  const INPUTS_OTHER: ManifestInputs = {
    version: "0.9.0",
    homepage: "https://widget.example",
    downloadBaseUrl: "https://widget.example/dl/0.9.0",
    sha256: {
      "macos-arm64": "1".repeat(64),
      "macos-x64": "2".repeat(64),
      "linux-arm64": "3".repeat(64),
      "linux-x64": "4".repeat(64),
      "windows-x64": "5".repeat(64),
    },
    product: OTHER,
  };

  test("homebrew takes the class, the binary name and drops an absent note", () => {
    const out = renderHomebrewFormula(INPUTS_OTHER);
    expect(out).toContain("class Widgetd < Formula");
    expect(out).toContain('license "MIT"');
    expect(out).toContain("/widgetd-macos-arm64-0.9.0");
    expect(out).toContain('bin.install Dir["*"].first => "widgetd"');
    // Nothing of crewhaus survives — including the AVX note, which is opt-in.
    expect(out).not.toContain("crewhaus");
    expect(out).not.toContain("Crewhaus");
    expect(out).not.toContain("Rosetta");
    // And the block it lived in is still well-formed with no comment at all.
    expect(out).toContain("  on_macos do\n    if Hardware::CPU.physical_cpu_arm64?");
  });

  test("debian keeps the one leading space on every continuation line", () => {
    const out = renderDebianControl(INPUTS_OTHER);
    expect(out).toContain("Package: widgetd");
    expect(out).toContain("Section: net");
    // The space is the whole format. Asserting the exact two lines is the only
    // way to catch it being dropped or doubled.
    expect(out).toContain("Description: A widget daemon\n Serves widgets.\n Nothing more.\n");
    expect(out).not.toContain("crewhaus");
  });

  test("scoop and winget carry the product through", () => {
    const scoop = renderScoopManifest(INPUTS_OTHER) as Record<string, unknown>;
    expect(scoop["bin"]).toBe("widgetd.exe");
    expect(scoop["license"]).toBe("MIT");
    const winget = renderWingetManifest(INPUTS_OTHER);
    expect(winget).toContain("PackageIdentifier: WidgetCo.Widgetd");
    expect(winget).toContain("Tags:\n  - widgets\nInstallers:");
    expect(winget).not.toContain("crewhaus");
  });
});
