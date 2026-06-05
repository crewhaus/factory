import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARCHES,
  BUILD_MATRIX,
  type BuildBinaryRunner,
  type BuildTarget,
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
  test.each(BUILD_MATRIX.map((t): [BuildTarget, string] => [t, `bun-${t.platform}-${t.arch}`]))(
    "%j → %s",
    (t, expected) => {
      expect(bunCompileTarget(t)).toBe(expected);
    },
  );
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
    expect(captured).toContain("bun-linux-x64");
    expect(captured).toContain("--outfile");
    expect(captured).toContain("/tmp/dist/crewhaus-linux-x64-1.2.3");
    expect(result.outPath).toBe("/tmp/dist/crewhaus-linux-x64-1.2.3");
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
      architecture: { "64bit": { url: string; hash: string } };
    };
    expect(scoop.version).toBe("1.0.0");
    expect(scoop.architecture["64bit"].hash).toBe(sha256["windows-x64"]);
    expect(scoop.architecture["64bit"].url).toContain("crewhaus-windows-x64-1.0.0.exe");
  });

  test("Winget manifest is valid YAML-shaped text with InstallerSha256 uppercase", () => {
    const winget = renderWingetManifest(inputs);
    expect(winget).toContain("PackageIdentifier: CrewHaus.CLI");
    expect(winget).toContain("PackageVersion: 1.0.0");
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
