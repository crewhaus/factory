/** Fixtures for this package's tests. Not compiled, not published. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type AccessHandle, type SetUpResult, ensureAccessSetUp, openAccess } from "./access";
import type { AccessHarness } from "./projection";
import { type AccessSnapshot, loadAccessSnapshot } from "./snapshot";

const roots: string[] = [];

export function tempDir(name = "access-control-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  roots.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const T0 = Date.parse("2026-11-01T00:00:00.000Z");
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** A clock a test moves by hand. */
export function fakeClock(start = T0): {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

export const LOCAL = "local:max@laptop";
/** A token shaped like the one Home mints, built at runtime. */
export const BOOTSTRAP_TOKEN = ["0123456789abcdef", "fedcba9876543210"].join("").repeat(2);

export type Harness = AccessHarness & { readonly name: string };

let harnessCount = 0;

export function harnessId(): string {
  harnessCount += 1;
  return `hrn_${harnessCount.toString(16).padStart(16, "0")}`;
}

export type Fixture = {
  readonly base: string;
  readonly root: string;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly harnesses: Harness[];
  readonly access: AccessHandle;
  readonly owner: string;
  readonly setup: SetUpResult;
  readonly actor: { readonly principal: string };
  addHarness(name: string, groups?: readonly string[], create?: boolean): Harness;
  snapshot(): AccessSnapshot;
};

/** A Hangar root with its token, set up as `LOCAL`, and a mutable harness list. */
export async function homeFixture(
  options: { readonly token?: boolean; readonly harnesses?: readonly (readonly string[])[] } = {},
): Promise<Fixture> {
  const base = tempDir();
  const root = join(base, "hangar");
  mkdirSync(root);
  if (options.token !== false)
    writeFileSync(join(root, "token"), `${BOOTSTRAP_TOKEN}\n`, { mode: 0o600 });
  const clock = fakeClock();
  const harnesses: Harness[] = [];
  const addHarness = (name: string, groups: readonly string[] = [], create = true): Harness => {
    const dir = join(base, name);
    if (create) mkdirSync(dir, { recursive: true });
    const harness = { id: harnessId(), dir, groups: [...groups], name };
    harnesses.push(harness);
    return harness;
  };
  for (const [index, groups] of (options.harnesses ?? []).entries())
    addHarness(`h${index}`, groups);
  const setUp = await ensureAccessSetUp(root, { localActor: LOCAL, now: clock.now });
  if (!setUp.ok) throw new Error(setUp.reason);
  const access = openAccess(root, { now: clock.now, harnesses: () => harnesses });
  const owner = setUp.result.owner;
  return {
    base,
    root,
    clock,
    harnesses,
    access,
    owner,
    setup: setUp.result,
    actor: { principal: owner },
    addHarness,
    snapshot: () => {
      const read = loadAccessSnapshot(root);
      if (read.state !== "present") throw new Error(`snapshot ${read.state}`);
      return read.snapshot;
    },
  };
}

/** Throw unless the answer is `ok`, and hand back its result. */
export function ok<T>(answer: { ok: true; result: T } | { ok: false; reason: string }): T {
  if (!answer.ok) throw new Error(`expected ok, got: ${answer.reason}`);
  return answer.result;
}

/** Every regular file under `dir`, relative, sorted. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

/** Every file under `dir`, read whole, keyed by its path relative to `dir`. */
export function treeOf(dir: string): Record<string, string> {
  return Object.fromEntries(
    filesUnder(dir).map((rel) => [rel, readFileSync(join(dir, rel), "utf8")]),
  );
}

/** Lines in one ledger file, or 0 when it is absent. */
export function rowCount(root: string, rel: string): number {
  try {
    return readFileSync(join(root, rel), "utf8")
      .split("\n")
      .filter((line) => line !== "").length;
  } catch {
    return 0;
  }
}

export function projectionPath(harness: AccessHarness): string {
  return join(harness.dir, ".crewhaus", "run", "control", "approvers.json");
}

export function readProjection(harness: AccessHarness): Record<string, unknown> {
  return JSON.parse(readFileSync(projectionPath(harness), "utf8")) as Record<string, unknown>;
}
