#!/usr/bin/env bun
/**
 * Generate the Homebrew / apt / Scoop / Winget package manifests from the
 * binaries already built into `dist/` by `build:binary`. Run AFTER the build.
 * Used by the release workflow (.github/workflows/release.yml) so the manifest
 * generation is a single, unit-tested command rather than inline YAML.
 *
 *   bun src/manifests.ts --version 1.2.3 \
 *     --download-base-url https://github.com/crewhaus/factory/releases/download/v1.2.3 \
 *     --dist <repo>/dist --out <repo>/packaging
 *
 * Prints a JSON summary ({version, downloadBaseUrl, sha256, written}) to stdout
 * so CI can capture the sha map and the written paths.
 */
import { join, resolve } from "node:path";
import {
  BUILD_MATRIX,
  type ShaByTarget,
  binaryName,
  formatTarget,
  packagingDir,
  sha256OfFile,
  writeAllManifests,
} from "./index";

function flag(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const version = flag("version", argv);
  if (!version) {
    console.error("✗ --version is required (e.g. --version 1.2.3)");
    process.exit(1);
  }
  const homepage = flag("homepage", argv) ?? "https://github.com/crewhaus/factory";
  const downloadBaseUrl =
    flag("download-base-url", argv) ??
    `https://github.com/crewhaus/factory/releases/download/v${version}`;
  const distDir = resolve(flag("dist", argv) ?? join(import.meta.dir, "..", "..", "..", "dist"));
  const outArg = flag("out", argv);
  const outDir = outArg ? resolve(outArg) : packagingDir();

  // sha256 every built binary. A missing file is a hard error — the manifests
  // must never reference an asset that was not actually built and uploaded.
  const sha256: Record<string, string> = {};
  for (const t of BUILD_MATRIX) {
    const file = join(distDir, binaryName(t, version));
    sha256[formatTarget(t)] = await sha256OfFile(file);
  }

  const inputs = { version, homepage, downloadBaseUrl, sha256: sha256 as ShaByTarget };
  const written = writeAllManifests(inputs, outDir);

  console.log(JSON.stringify({ version, downloadBaseUrl, sha256, written }, null, 2));
}

main().catch((err) => {
  console.error(`✗ manifest generation failed: ${(err as Error).message}`);
  process.exit(1);
});
