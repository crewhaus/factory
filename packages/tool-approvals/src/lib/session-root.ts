/**
 * Knowing when `<harness>/.crewhaus/sessions` is NOT where this harness's
 * approvals live — so an absent ledger there is never reported as "nothing is
 * parked".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SECOND RESOLVER
 * ---------------------------------------------------------------------------
 * The session root is not fixed. `@crewhaus/feedback-distill`'s
 * `resolveSessionsDirs` documents the runtime precedence — explicit dirs →
 * per-tenant roots → `CREWHAUS_SESSION_DIR` → `<root>/.crewhaus/sessions` —
 * and `@crewhaus/hangar-server`'s `resolveSessionRoot` applies the same
 * override from the harness's own `.env` chain, noting that a harness which
 * relocated its session root "relocated its approvals too". Neither is a
 * dependency of this package (see the README), and re-deriving the override —
 * the `.env` chain, its precedence, its quoting — is precisely the second
 * implementation that drifts.
 *
 * So this module does NOT resolve anything. It answers one strictly weaker
 * question: is there positive evidence that this harness relocates its session
 * root? It looks for the KEY `CREWHAUS_SESSION_DIR`, never at the value, and
 * never follows it anywhere. On a hit, the caller reports the ledger's contents
 * as UNKNOWN instead of as an empty inbox, and names the variable so a human
 * can look in the right place.
 *
 * Deliberately conservative in the safe direction. A commented-out assignment
 * yields a false "unknown", which costs an operator one look; a missed
 * assignment would yield a false "nothing is parked", which costs a run that
 * stays parked forever. It is also deliberately incomplete: `manager.envFiles`
 * shared chain files and per-tenant session roots are not inspected, so a hit
 * here is evidence and a miss is not proof. That is why it only ever fires on
 * an ABSENT ledger, where the alternative answer is a zero nobody should trust.
 */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import * as path from "node:path";
import { isInside, workspaceRoot } from "../paths";

/** The variable the runtime and the hangar both read to relocate a session
 *  root. Named, never resolved, by this package. */
export const SESSION_DIR_ENV = "CREWHAUS_SESSION_DIR";

/** The harness-local chain files, in the order `loadEnvChain` reads them. A
 *  shared `manager.envFiles` entry is out of scope — see the module note. */
export const ENV_CHAIN_FILES: readonly string[] = Object.freeze([".env", ".env.local"]);

/** Enough of an env file to find a key assignment in; past this it is not one. */
const MAX_ENV_BYTES = 256 * 1024;

/**
 * True when `text` assigns {@link SESSION_DIR_ENV} on some line.
 *
 * Matches the KEY at the start of a line (optionally `export`-prefixed) up to
 * its `=`. The VALUE is never read, so nothing here has an opinion about
 * quoting, escaping or interpolation — the three things an env-file parser is
 * for, and the three this module must not have a second copy of.
 */
export function declaresSessionDir(text: string): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    if (body.slice(0, eq).trim() === SESSION_DIR_ENV) return true;
  }
  return false;
}

/** Never through a link at the leaf (one was resolved and checked already),
 *  never blocking on a FIFO; both 0 on Windows. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Read at most {@link MAX_ENV_BYTES} of an env file.
 *
 * `undefined` for anything that is not a readable regular file — failures are
 * silent BY DESIGN: this is a corroborating probe, and the caller's answer is
 * already "unknown". The harness directory was checked against the workspace
 * by the caller; the file in it may be a link. One that leads OUTSIDE the
 * workspace (`.env -> /elsewhere/.env`) is not read, because even the one bit
 * this probe reports about it is a read of a file the caller never named
 * (security-2#2), and `"outside"` says so, because "not read" is not "does not
 * relocate the session root". A link that stays inside is followed: a shared
 * `.env` linked into each harness is common.
 */
function readCapped(file: string, rootReal: string | undefined): string | "outside" | undefined {
  let real = file;
  try {
    if (lstatSync(file).isSymbolicLink()) {
      real = realpathSync(file);
      if (rootReal === undefined || !isInside(rootReal, real)) return "outside";
    }
  } catch {
    return undefined; // not there, or a link to nothing
  }
  let fd: number;
  try {
    fd = openSync(real, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const size = stat.size;
    const take = Math.min(size, MAX_ENV_BYTES);
    const buf = Buffer.alloc(take);
    const read = readSync(fd, buf, 0, take, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * A sentence naming why this harness's approvals may not live at
 * `<dir>/.crewhaus/sessions`, or `undefined` when there is no such evidence.
 *
 * `env` is the environment the tool itself is running in: a tool call inside a
 * harness's own runtime sees that harness's spawn env, and `CREWHAUS_SESSION_DIR`
 * being set there is the strongest signal available without resolving anything.
 */
export function sessionRootRelocation(
  harnessDirReal: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  root: string = workspaceRoot(),
): string | undefined {
  const fromEnv = env[SESSION_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return `${SESSION_DIR_ENV} is set in this process's environment, which moves the session root (and the approvals ledger with it) away from the path read above`;
  }
  let rootReal: string | undefined;
  try {
    rootReal = realpathSync(root);
  } catch {
    rootReal = undefined;
  }
  for (const name of ENV_CHAIN_FILES) {
    const text = readCapped(path.join(harnessDirReal, name), rootReal);
    if (text === "outside") {
      return `the harness's ${name} is a link to a file outside the workspace, which is not read here, so whether it assigns ${SESSION_DIR_ENV} (and moves the session root and the approvals ledger with it) is unknown`;
    }
    if (text !== undefined && declaresSessionDir(text)) {
      return `the harness's ${name} assigns ${SESSION_DIR_ENV}, which moves the session root (and the approvals ledger with it) away from the path read above`;
    }
  }
  return undefined;
}
