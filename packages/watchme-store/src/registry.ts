/**
 * The cross-harness registry at `<globalRoot>/harnesses.json` (global root
 * default `~/.crewhaus/watchme`; the CLI overrides via `CREWHAUS_WATCHME_ROOT`
 * or `--root`). One JSON document `{v:1, harnesses: HarnessEntry[]}`, absolute
 * dirs, upsert-by-dir, tmp+rename atomic writes, tolerant reads.
 *
 * `list()` prunes tolerantly: an entry whose directory has vanished (harness
 * deleted, volume unmounted) is dropped from the RETURNED list and reported
 * via `onWarn` — the file itself is only rewritten by `register`/`deregister`,
 * so a read never races a concurrent writer.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessEntry } from "./types.js";

export type HarnessRegistry = {
  /** Upsert by (absolute) dir: a re-register keeps `registeredAt` and
   *  refreshes `lastSeen` + the descriptive fields. tmp+rename atomic. */
  register(entry: Omit<HarnessEntry, "registeredAt" | "lastSeen">): void;
  deregister(dir: string): void;
  /** Tolerant-pruning: entries whose dir vanished are dropped + reported. */
  list(): HarnessEntry[];
};

export type HarnessRegistryOptions = {
  /** Clock for `registeredAt`/`lastSeen`; injected so tests are deterministic. */
  readonly now?: () => number;
  /** Receives one line per pruned vanished-dir entry. Default: `console.error`. */
  readonly onWarn?: (message: string) => void;
};

const REGISTRY_FILENAME = "harnesses.json";

function isEntry(rec: unknown): rec is HarnessEntry {
  if (typeof rec !== "object" || rec === null) return false;
  const e = rec as Record<string, unknown>;
  return (
    typeof e["dir"] === "string" &&
    typeof e["specName"] === "string" &&
    typeof e["target"] === "string" &&
    typeof e["registeredAt"] === "number" &&
    typeof e["lastSeen"] === "number"
  );
}

/** Open the registry rooted at `globalRoot` (created lazily on first write). */
export function openHarnessRegistry(
  globalRoot: string,
  opts: HarnessRegistryOptions = {},
): HarnessRegistry {
  const path = join(globalRoot, REGISTRY_FILENAME);
  const now = opts.now ?? Date.now;
  const onWarn = opts.onWarn ?? ((message: string) => console.error(message));

  const readAll = (): HarnessEntry[] => {
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const harnesses = (parsed as Record<string, unknown>)["harnesses"];
        if (Array.isArray(harnesses)) return harnesses.filter(isEntry);
      }
    } catch {
      // Unreadable → treated as empty; the next write rewrites it whole.
    }
    return [];
  };

  const writeAll = (entries: HarnessEntry[]): void => {
    if (!existsSync(globalRoot)) mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
    const sorted = [...entries].sort((a, b) => a.dir.localeCompare(b.dir));
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, harnesses: sorted }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmp, path);
  };

  return {
    register(entry: Omit<HarnessEntry, "registeredAt" | "lastSeen">): void {
      const dir = resolve(entry.dir);
      const entries = readAll();
      const existing = entries.find((e) => e.dir === dir);
      const next: HarnessEntry = {
        ...entry,
        dir,
        registeredAt: existing?.registeredAt ?? now(),
        lastSeen: now(),
      };
      writeAll([...entries.filter((e) => e.dir !== dir), next]);
    },
    deregister(dir: string): void {
      const absolute = resolve(dir);
      writeAll(readAll().filter((e) => e.dir !== absolute));
    },
    list(): HarnessEntry[] {
      const alive: HarnessEntry[] = [];
      for (const entry of readAll()) {
        if (existsSync(entry.dir)) {
          alive.push(entry);
        } else {
          onWarn(`watchme-store: registry entry for vanished dir ${entry.dir} dropped`);
        }
      }
      return alive;
    },
  };
}
