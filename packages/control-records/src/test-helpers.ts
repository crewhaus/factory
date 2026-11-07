/** Fixtures for this package's tests. Not compiled, not published. */
import {
  type Dirent,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MachineName } from "@crewhaus/control-contract";
import { type Ledger, controlPaths, harnessLedger } from "./paths";
import { segmentRel } from "./segments";

const roots: string[] = [];

/** A fresh directory that does not sit below any link. */
export function tempDir(name = "control-records-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  roots.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const noWarn = { onWarn: (): void => undefined };

export function runsLedger(root: string, machine?: MachineName): Ledger {
  return harnessLedger(
    root,
    { dir: join(controlPaths(root).controlDir, "runs") },
    machine !== undefined ? { machine } : {},
  );
}

export function deploymentsLedger(root: string, machine?: MachineName): Ledger {
  return harnessLedger(
    root,
    { file: join(controlPaths(root).controlDir, "deployments.jsonl") },
    machine !== undefined ? { machine } : {},
  );
}

export function segmentPath(ledger: Ledger, seg: number): string {
  return join(ledger.root, segmentRel(ledger.records, seg));
}

/** Write a file and its parents, for planting bytes a writer would never produce. */
export function plant(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Every path under `dir` with its bytes or link text: what "nothing changed" compares. */
export function snapshotTree(dir: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isSymbolicLink()) {
        out.set(path, `link:${readlinkSync(path)}`);
      } else if (entry.isDirectory()) {
        out.set(path, "dir");
        walk(path);
      } else {
        out.set(path, `file:${lstatSync(path).size}:${readFileSync(path, "latin1")}`);
      }
    }
  };
  walk(dir);
  return out;
}

/** Control-directory paths as absolute paths. */
export function controlFile(root: string, rel = ""): string {
  return join(root, controlPaths(root).controlDir, rel);
}

/** Every way an operator record can be present and not usable. */
export const UNREADABLE_OPERATOR: Readonly<Record<string, (root: string) => void>> = {
  empty: (root) => plant(controlFile(root, "operator.json"), ""),
  torn: (root) => plant(controlFile(root, "operator.json"), '{"v":1,"rev"'),
  "bad JSON": (root) => plant(controlFile(root, "operator.json"), "not json at all\n"),
  "not an object": (root) => plant(controlFile(root, "operator.json"), "[1,2]\n"),
  "missing desired": (root) =>
    plant(controlFile(root, "operator.json"), jsonLine({ v: 1, rev: 1 })),
  "wrong type": (root) =>
    plant(controlFile(root, "operator.json"), jsonLine({ v: 1, rev: "three", desired: "running" })),
  "v 2": (root) =>
    plant(controlFile(root, "operator.json"), jsonLine({ v: 2, rev: 1, desired: "running" })),
  "over the cap": (root) =>
    plant(
      controlFile(root, "operator.json"),
      jsonLine({ v: 1, rev: 1, desired: "running", pad: "x".repeat(64 * 1024) }),
    ),
  link: (root) => {
    const target = controlFile(root, "elsewhere.json");
    plant(target, jsonLine({ v: 1, rev: 1, desired: "running" }));
    symlinkSync(target, controlFile(root, "operator.json"));
  },
  directory: (root) => mkdirSync(controlFile(root, "operator.json"), { recursive: true }),
  "a file where its directory goes": (root) => plant(controlFile(root), "not a directory"),
  "a file further up its path": (root) => plant(join(root, ".crewhaus", "run"), "not a directory"),
};

/** A promise a test opens by hand, to hold a writer at a hook. */
export function gate(): {
  readonly reached: Promise<void>;
  /** Marks the hook reached and waits to be let go. */
  readonly hold: () => Promise<void>;
  readonly open: () => void;
} {
  let markReached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    hold: async () => {
      markReached();
      await released;
    },
    open: release,
  };
}
