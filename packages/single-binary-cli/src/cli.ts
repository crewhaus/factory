/**
 * `bun run build:binary` entry point. Builds the requested target, or
 * the full BUILD_MATRIX when no target flag is passed.
 *
 * Examples:
 *   bun run build:binary --target macos-arm64
 *   bun run build:binary --version 1.0.0   # builds every entry in BUILD_MATRIX
 */
import {
  ARCHES,
  type Arch,
  BUILD_MATRIX,
  type BuildTarget,
  PLATFORMS,
  type Platform,
  buildBinary,
  formatTarget,
} from "./index";

function parseFlag(name: string, argv: string[]): string | undefined {
  const idx = argv.findIndex((a) => a === `--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function parseTarget(value: string): BuildTarget | undefined {
  const [platform, arch] = value.split("-") as [string, string | undefined];
  if (!platform || !arch) return undefined;
  if (!(PLATFORMS as readonly string[]).includes(platform)) return undefined;
  if (!(ARCHES as readonly string[]).includes(arch)) return undefined;
  return { platform: platform as Platform, arch: arch as Arch };
}

async function main() {
  const argv = process.argv.slice(2);
  const version = parseFlag("version", argv) ?? "";
  const targetArg = parseFlag("target", argv);
  const targets: readonly BuildTarget[] = targetArg
    ? (() => {
        const t = parseTarget(targetArg);
        if (!t) {
          console.error(`unknown target: ${targetArg}`);
          process.exit(2);
        }
        return [t];
      })()
    : BUILD_MATRIX;

  for (const t of targets) {
    process.stdout.write(`building crewhaus-${formatTarget(t)}...\n`);
    try {
      const result = await buildBinary({ target: t, version });
      process.stdout.write(`  → ${result.outPath}\n`);
    } catch (err) {
      console.error(`  ✗ ${formatTarget(t)} failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

main();
