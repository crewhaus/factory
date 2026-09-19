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

/**
 * Bun's --target string for a given (platform, arch) pair.
 *
 * Linux/Windows x64 compile against Bun's `-baseline` runtime so the binary
 * runs on x64 CPUs/VMs without AVX2 (older servers, some cloud/CI hosts). Those
 * baseline builds are genuinely AVX-free, distinct binaries.
 *
 * macOS x64 deliberately stays on the default target: Bun ships NO AVX-free
 * macOS build (`bun-darwin-x64-baseline.zip` contains the byte-identical binary
 * as `bun-darwin-x64.zip`), so `-baseline` would be a pure no-op there. The real
 * macOS hazard is an Apple-Silicon host running the x64 binary under Rosetta 2
 * (which emulates a pre-AVX CPU); those users are steered to the native arm64
 * binary by the Homebrew formula instead. arm64 has no baseline variant.
 */
export function bunCompileTarget(t: BuildTarget): string {
  const baseline = t.arch === "x64" && t.platform !== "macos";
  return `bun-${t.platform}-${t.arch}${baseline ? "-baseline" : ""}`;
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
    // Embed the version: inside a compiled binary import.meta.url points
    // into the virtual /$bunfs tree, so the CLI's runtime ../package.json
    // read cannot work — `crewhaus --version` uses this constant instead.
    ...(version ? ["--define", `CREWHAUS_EMBEDDED_VERSION=${JSON.stringify(version)}`] : []),
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

/**
 * Everything in a package manifest that is a fact about the PRODUCT rather
 * than about the release.
 *
 * These four renderers used to hard-code crewhaus's identity — the Ruby class
 * name, the binary name inside every download URL, `Package: crewhaus`, the
 * winget PackageIdentifier — which meant nothing else could use them and any
 * other project had to copy them. Lifting the identity out changes no bytes
 * for crewhaus itself: `CREWHAUS_PRODUCT` below holds exactly the strings that
 * were inline, and `index.test.ts` pins all four rendered files in full so a
 * drift of one space fails.
 */
export type ProductIdentity = {
  /** The executable's name: it appears in every download URL, in the Homebrew
   *  install and test lines, as the Debian `Package:` and as the scoop `bin`. */
  readonly binaryName: string;
  /** The Ruby class in the Homebrew formula. Homebrew requires it to match the
   *  formula's filename, so it is not derivable from `binaryName` in general. */
  readonly formulaClass: string;
  /** One line. Homebrew's `desc`, scoop's `description`, Debian's
   *  `Description:` head and winget's `ShortDescription` are all this string. */
  readonly shortDescription: string;
  /** An SPDX identifier. */
  readonly license: string;
  readonly debian: {
    readonly section: string;
    readonly maintainer: string;
    readonly depends: string;
    /** The continuation lines under `Description:`. Each is emitted with the
     *  single leading space the control format requires — pass the text
     *  WITHOUT it, because a line that loses that space stops being a
     *  continuation and makes the paragraph unparseable. */
    readonly longDescription: readonly string[];
  };
  readonly winget: {
    readonly packageIdentifier: string;
    readonly publisher: string;
    readonly author: string;
    readonly longDescription: string;
    readonly tags: readonly string[];
  };
  /**
   * Lines emitted as a comment inside the formula's `on_macos` block, without
   * the leading `# `.
   *
   * crewhaus's explains why an Apple-Silicon host is served the arm64 binary
   * even when Homebrew reports an Intel CPU, and it is not decoration: an
   * x86_64 Homebrew under Rosetta reports `Hardware::CPU.intel?`, Rosetta
   * emulates a pre-AVX CPU, and Bun's macOS x64 runtime needs AVX2. That cost
   * this project a shipped bug. It is a property of Bun-compiled binaries, so
   * a product that is not one should pass its own note or none.
   */
  readonly homebrewMacosNote?: readonly string[] | undefined;
};

/** crewhaus's own identity — byte-for-byte what these renderers used to inline. */
export const CREWHAUS_PRODUCT: ProductIdentity = {
  binaryName: "crewhaus",
  formulaClass: "Crewhaus",
  shortDescription: "Modular meta-harness — compile a single spec into multiple agent runtimes",
  license: "Apache-2.0",
  debian: {
    section: "utils",
    maintainer: "CrewHaus Maintainers <maintainers@crewhaus.ai>",
    depends: "libc6 (>= 2.31)",
    longDescription: [
      "CrewHaus compiles a single high-level harness spec into multiple",
      "runtime targets (graph, workflow, channel bot, eval, batch worker,",
      "voice service, browser-driver, research-runner). The binary is a",
      "self-contained Bun bundle requiring no Node/Bun on the target host.",
    ],
  },
  winget: {
    packageIdentifier: "CrewHaus.CLI",
    publisher: "CrewHaus",
    author: "CrewHaus",
    longDescription:
      "CrewHaus compiles a single high-level harness spec into multiple runtime targets.",
    tags: ["cli", "llm", "agent-framework"],
  },
  homebrewMacosNote: [
    "An x86_64 Homebrew running under Rosetta 2 on Apple Silicon reports",
    "Hardware::CPU.intel?, but the x64 binary then executes under Rosetta — which",
    "emulates a pre-AVX (Westmere) CPU. Bun's macOS x64 runtime requires AVX2 and",
    'there is no AVX-free macOS Bun build, so it warns ("CPU lacks AVX support")',
    "and may crash. Serve the native arm64 binary on every Apple-Silicon host,",
    "translated or not. Genuine Intel Macs (AVX2-capable) still get the x64 build.",
  ],
};

export type ManifestInputs = {
  readonly version: string;
  readonly homepage: string;
  readonly downloadBaseUrl: string;
  readonly sha256: ShaByTarget;
  /** Defaults to {@link CREWHAUS_PRODUCT}, so every existing caller is unchanged. */
  readonly product?: ProductIdentity | undefined;
};

export function renderHomebrewFormula(inputs: ManifestInputs): string {
  const { version, homepage, downloadBaseUrl, sha256 } = inputs;
  const product = inputs.product ?? CREWHAUS_PRODUCT;
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new SingleBinaryError(`homebrew version must be semver-shaped: ${version}`);
  }
  const macosArm64 = requireSha(sha256, "macos-arm64");
  const macosX64 = requireSha(sha256, "macos-x64");
  const linuxArm64 = requireSha(sha256, "linux-arm64");
  const linuxX64 = requireSha(sha256, "linux-x64");
  const note = (product.homebrewMacosNote ?? []).map((line) => `    # ${line}\n`).join("");
  return `class ${product.formulaClass} < Formula
  desc "${product.shortDescription}"
  homepage "${homepage}"
  version "${version}"
  license "${product.license}"

  on_macos do
${note}    if Hardware::CPU.physical_cpu_arm64?
      url "${downloadBaseUrl}/${product.binaryName}-macos-arm64-${version}"
      sha256 "${macosArm64}"
    else
      url "${downloadBaseUrl}/${product.binaryName}-macos-x64-${version}"
      sha256 "${macosX64}"
    end
  end

  on_linux do
    on_arm do
      url "${downloadBaseUrl}/${product.binaryName}-linux-arm64-${version}"
      sha256 "${linuxArm64}"
    end
    on_intel do
      url "${downloadBaseUrl}/${product.binaryName}-linux-x64-${version}"
      sha256 "${linuxX64}"
    end
  end

  def install
    bin.install Dir["*"].first => "${product.binaryName}"
  end

  test do
    system "#{bin}/${product.binaryName}", "--version"
  end
end
`;
}

export function renderDebianControl(inputs: ManifestInputs): string {
  const { version } = inputs;
  const product = inputs.product ?? CREWHAUS_PRODUCT;
  // Each continuation line carries the single leading space the control format
  // requires. A line that loses it stops being a continuation and the
  // paragraph no longer parses, which is why the caller supplies the text
  // without it rather than being trusted to remember.
  const body = product.debian.longDescription.map((line) => ` ${line}\n`).join("");
  return `Package: ${product.binaryName}
Version: ${version}
Section: ${product.debian.section}
Priority: optional
Architecture: any
Maintainer: ${product.debian.maintainer}
Depends: ${product.debian.depends}
Description: ${product.shortDescription}
${body}`;
}

export function renderScoopManifest(inputs: ManifestInputs): unknown {
  const { version, homepage, downloadBaseUrl, sha256 } = inputs;
  const product = inputs.product ?? CREWHAUS_PRODUCT;
  const winX64 = requireSha(sha256, "windows-x64");
  return {
    version,
    description: product.shortDescription,
    homepage,
    license: product.license,
    architecture: {
      "64bit": {
        url: `${downloadBaseUrl}/${product.binaryName}-windows-x64-${version}.exe`,
        hash: winX64,
      },
    },
    bin: `${product.binaryName}.exe`,
  };
}

export function renderWingetManifest(inputs: ManifestInputs): string {
  const { version, homepage, downloadBaseUrl, sha256 } = inputs;
  const product = inputs.product ?? CREWHAUS_PRODUCT;
  const winX64 = requireSha(sha256, "windows-x64");
  const tags = product.winget.tags.map((tag) => `  - ${tag}\n`).join("");
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.4.0.schema.json
PackageIdentifier: ${product.winget.packageIdentifier}
PackageVersion: ${version}
Publisher: ${product.winget.publisher}
Author: ${product.winget.author}
PackageName: ${product.binaryName}
PackageUrl: ${homepage}
License: ${product.license}
ShortDescription: ${product.shortDescription}
Description: |
  ${product.winget.longDescription}
Tags:
${tags}Installers:
  - Architecture: x64
    InstallerType: portable
    InstallerUrl: ${downloadBaseUrl}/${product.binaryName}-windows-x64-${version}.exe
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
