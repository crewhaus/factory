import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Section 32 — `@crewhaus/single-binary-cli`
 *
 * `bun build --compile` wrapper that produces self-contained
 * `dist/crewhaus-{linux,macos,windows}-{x64,arm64}` binaries for the
 * `crewhaus` CLI. Each binary is ~80 MB; no Bun/Node prereq on the
 * target host.
 *
 * Bun 1.2's `--compile` cross-compile matrix:
 *   - linux-x64        ✅
 *   - linux-arm64      ✅
 *   - macos-x64        ✅
 *   - macos-arm64      ✅
 *   - windows-x64      ✅ (named "bun-windows-x64" target)
 *   - windows-arm64    ❌ (Bun does not produce windows-arm64; documented
 *                          gap — use linux-arm64 in WSL or skip)
 *
 * The auto-generated package manifests (Homebrew formula, Debian
 * control, Scoop manifest, Winget manifest) live under
 * `packaging/` and are templated against the binaries this package
 * builds. `renderHomebrewFormula({version, sha256ByPlatform})` etc.
 * regenerate them deterministically on every release.
 */
import { CrewhausError } from "@crewhaus/errors";

export class SingleBinaryError extends CrewhausError {
  override readonly name = "SingleBinaryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export const PLATFORMS = ["linux", "macos", "windows"] as const;
export const ARCHES = ["x64", "arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Arch = (typeof ARCHES)[number];

/**
 * The (platform, arch) pairs Bun --compile actually produces. The
 * `windows-arm64` slot is intentionally absent because Bun has no
 * `bun-windows-arm64` target as of Bun 1.2.
 */
export type BuildTarget = { readonly platform: Platform; readonly arch: Arch };
export const BUILD_MATRIX: readonly BuildTarget[] = [
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "macos", arch: "x64" },
  { platform: "macos", arch: "arm64" },
  { platform: "windows", arch: "x64" },
];

/** Bun's --target string for a given (platform, arch) pair. */
export function bunCompileTarget(t: BuildTarget): string {
  return `bun-${t.platform}-${t.arch}`;
}

/**
 * Output filename of a built binary. Adds `.exe` on windows.
 */
export function binaryName(t: BuildTarget, version: string): string {
  const base = `crewhaus-${t.platform}-${t.arch}`;
  const versioned = version ? `${base}-${version}` : base;
  return t.platform === "windows" ? `${versioned}.exe` : versioned;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const CLI_ENTRYPOINT_REL = "apps/cli/src/index.ts";

export type BuildBinaryRunner = (
  argv: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type BuildBinaryOptions = {
  readonly target: BuildTarget;
  readonly version?: string;
  readonly outDir?: string;
  /** Test injection point. Defaults to spawning bun via node:child_process. */
  readonly runner?: BuildBinaryRunner;
};

export type BuildBinaryResult = {
  readonly target: BuildTarget;
  readonly outPath: string;
  readonly buildArgv: readonly string[];
};

export async function buildBinary(opts: BuildBinaryOptions): Promise<BuildBinaryResult> {
  const t = opts.target;
  if (!isBuildTarget(t)) {
    throw new SingleBinaryError(
      `unsupported build target: ${t.platform}-${t.arch} (allowed: ${BUILD_MATRIX.map(formatTarget).join(", ")})`,
    );
  }
  const outDir = opts.outDir ?? join(REPO_ROOT, "dist");
  const version = (opts.version ?? "").trim();
  const outPath = join(outDir, binaryName(t, version));
  const argv: string[] = [
    "bun",
    "build",
    "--compile",
    "--target",
    bunCompileTarget(t),
    CLI_ENTRYPOINT_REL,
    "--outfile",
    outPath,
  ];

  const runner = opts.runner ?? defaultRunner;
  const { exitCode, stderr } = await runner(argv, REPO_ROOT);
  if (exitCode !== 0) {
    throw new SingleBinaryError(
      `bun build --compile (${formatTarget(t)}) exited with ${exitCode}: ${stderr.slice(0, 1024)}`,
    );
  }
  return { target: t, outPath, buildArgv: argv };
}

export function isBuildTarget(t: BuildTarget): boolean {
  return BUILD_MATRIX.some((m) => m.platform === t.platform && m.arch === t.arch);
}

export function formatTarget(t: BuildTarget): string {
  return `${t.platform}-${t.arch}`;
}

const defaultRunner: BuildBinaryRunner = async (argv, cwd) => {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve_) => {
    const head = argv[0] ?? "bun";
    const child = spawn(head, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) =>
      resolve_({ exitCode: 1, stdout: "", stderr: String((e as Error).message) }),
    );
    child.on("close", (code) =>
      resolve_({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
};

// ─── package manifest generation ─────────────────────────────────────────────

export type ShaByTarget = Readonly<Partial<Record<string, string>>>;

export type ManifestInputs = {
  readonly version: string;
  readonly homepage: string;
  readonly downloadBaseUrl: string;
  readonly sha256: ShaByTarget;
};

export function renderHomebrewFormula(inputs: ManifestInputs): string {
  const { version, homepage, downloadBaseUrl, sha256 } = inputs;
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new SingleBinaryError(`homebrew version must be semver-shaped: ${version}`);
  }
  const macosArm64 = requireSha(sha256, "macos-arm64");
  const macosX64 = requireSha(sha256, "macos-x64");
  const linuxArm64 = requireSha(sha256, "linux-arm64");
  const linuxX64 = requireSha(sha256, "linux-x64");
  return `class Crewhaus < Formula
  desc "Modular meta-harness — compile a single spec into multiple agent runtimes"
  homepage "${homepage}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${downloadBaseUrl}/crewhaus-macos-arm64-${version}"
      sha256 "${macosArm64}"
    end
    on_intel do
      url "${downloadBaseUrl}/crewhaus-macos-x64-${version}"
      sha256 "${macosX64}"
    end
  end

  on_linux do
    on_arm do
      url "${downloadBaseUrl}/crewhaus-linux-arm64-${version}"
      sha256 "${linuxArm64}"
    end
    on_intel do
      url "${downloadBaseUrl}/crewhaus-linux-x64-${version}"
      sha256 "${linuxX64}"
    end
  end

  def install
    bin.install Dir["*"].first => "crewhaus"
  end

  test do
    system "#{bin}/crewhaus", "--version"
  end
end
`;
}

export function renderDebianControl(inputs: ManifestInputs): string {
  const { version } = inputs;
  return `Package: crewhaus
Version: ${version}
Section: utils
Priority: optional
Architecture: any
Maintainer: CrewHaus Maintainers <maintainers@crewhaus.io>
Depends: libc6 (>= 2.31)
Description: Modular meta-harness — compile a single spec into multiple agent runtimes
 CrewHaus compiles a single high-level harness spec into multiple
 runtime targets (graph, workflow, channel bot, eval, batch worker,
 voice service, browser-driver, research-runner). The binary is a
 self-contained Bun bundle requiring no Node/Bun on the target host.
`;
}

export function renderScoopManifest(inputs: ManifestInputs): unknown {
  const { version, homepage, downloadBaseUrl, sha256 } = inputs;
  const winX64 = requireSha(sha256, "windows-x64");
  return {
    version,
    description: "Modular meta-harness — compile a single spec into multiple agent runtimes",
    homepage,
    license: "MIT",
    architecture: {
      "64bit": {
        url: `${downloadBaseUrl}/crewhaus-windows-x64-${version}.exe`,
        hash: winX64,
      },
    },
    bin: "crewhaus.exe",
  };
}

export function renderWingetManifest(inputs: ManifestInputs): string {
  const { version, homepage, downloadBaseUrl, sha256 } = inputs;
  const winX64 = requireSha(sha256, "windows-x64");
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.4.0.schema.json
PackageIdentifier: CrewHaus.CLI
PackageVersion: ${version}
Publisher: CrewHaus
Author: CrewHaus
PackageName: crewhaus
PackageUrl: ${homepage}
License: MIT
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
    InstallerUrl: ${downloadBaseUrl}/crewhaus-windows-x64-${version}.exe
    InstallerSha256: ${winX64.toUpperCase()}
ManifestType: installer
ManifestVersion: 1.4.0
`;
}

function requireSha(map: ShaByTarget, target: string): string {
  const sha = map[target];
  if (!sha) {
    throw new SingleBinaryError(`missing sha256 for ${target} in package manifest inputs`);
  }
  if (!/^[0-9a-f]{64}$/i.test(sha)) {
    throw new SingleBinaryError(`malformed sha256 for ${target}: ${sha}`);
  }
  return sha;
}

// ─── on-disk manifest writers ────────────────────────────────────────────────

export function packagingDir(): string {
  return join(PACKAGE_ROOT, "packaging");
}

export function writeAllManifests(
  inputs: ManifestInputs,
  root: string = packagingDir(),
): {
  homebrew: string;
  debian: string;
  scoop: string;
  winget: string;
} {
  mkdirSync(join(root, "Formula"), { recursive: true });
  mkdirSync(join(root, "debian"), { recursive: true });
  const homebrew = join(root, "Formula", "crewhaus.rb");
  const debian = join(root, "debian", "control");
  const scoop = join(root, "scoop.json");
  const winget = join(root, "winget.yaml");
  writeFileSync(homebrew, renderHomebrewFormula(inputs), { mode: 0o644 });
  writeFileSync(debian, renderDebianControl(inputs), { mode: 0o644 });
  writeFileSync(scoop, `${JSON.stringify(renderScoopManifest(inputs), null, 2)}\n`, {
    mode: 0o644,
  });
  writeFileSync(winget, renderWingetManifest(inputs), { mode: 0o644 });
  return { homebrew, debian, scoop, winget };
}

// ─── helpers consumed by the binary CLI ─────────────────────────────────────

/** Read a file's sha256 — used by release tooling to populate manifests. */
export async function sha256OfFile(path: string): Promise<string> {
  if (!existsSync(path)) {
    throw new SingleBinaryError(`file not found: ${path}`);
  }
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}
