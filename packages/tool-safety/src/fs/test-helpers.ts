import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A workspace and an "outside" beside it, as the audit's proofs lay them
 * out: `<base>/ws` is the root, `<base>/outside` holds what must never be
 * read, written or deleted through the root. `base` is left as `mkdtemp`
 * returned it, which on macOS is itself reached through the `/var ->
 * /private/var` link, so every test also runs with a root that is not its
 * own realpath.
 */
export type Fixture = {
  readonly base: string;
  readonly ws: string;
  readonly outside: string;
  cleanup(): void;
};

export function fixture(label: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), `tool-safety-${label}-`));
  const ws = join(base, "ws");
  const outside = join(base, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE\n");
  return { base, ws, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function mkfifo(path: string): void {
  const made = Bun.spawnSync(["mkfifo", path]);
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
}

export const posix = process.platform !== "win32";

/**
 * Whether the volume holding `dir` folds case (macOS's default APFS does,
 * Linux CI's ext4 does not). Tests of case-folded spellings run only there.
 */
export function caseInsensitive(dir: string): boolean {
  const probe = join(dir, ".case-probe");
  writeFileSync(probe, "");
  try {
    return existsSync(join(dir, ".CASE-PROBE"));
  } finally {
    rmSync(probe, { force: true });
  }
}
