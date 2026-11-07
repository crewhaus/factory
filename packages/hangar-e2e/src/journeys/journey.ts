/** What every journey is, and the scope that cleans up after one. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Home, bootHome } from "../boot";
import { type Fleet, type SeedFleetOptions, seedFleet } from "../seed/fleet";
import { type HomeAddress, type OpenSessionOptions, type Session, openSession } from "../session";

export const SHARDS = ["smoke", "axe", "system"] as const;
export type Shard = (typeof SHARDS)[number];

export type Journey = {
  readonly id: string;
  readonly shard: Shard;
  /** What it holds true, and so what its failure means. */
  readonly proves: string;
  run(scope: JourneyScope): Promise<void>;
};

/** What a journey opens, closed in reverse order whatever happened. */
export type JourneyScope = {
  /** A temporary directory, removed afterwards. */
  tempDir(prefix?: string): string;
  /** Seed a fleet in a temporary directory. */
  fleet(opts: Omit<SeedFleetOptions, "now"> & { readonly now?: number }): Promise<Fleet>;
  /** Boot Home over a fleet. */
  home(fleet: Fleet): Home;
  /**
   * Open a session, closed afterwards. A failed journey keeps its trace. When the
   * journey ends, the session failing fails the journey, even if the journey never
   * asked or the failure came after it last asked.
   */
  session(home: HomeAddress, opts?: OpenSessionOptions): Promise<Session>;
  /** Run this when the journey ends. */
  defer(cleanup: () => Promise<void> | void): void;
};

/** Run a journey in a fresh scope, check every session it opened, and close everything. */
export async function runJourney(journey: Journey): Promise<void> {
  const cleanups: Array<() => Promise<void> | void> = [];
  const sessions: Session[] = [];
  const scope: JourneyScope = {
    tempDir: (prefix = "hangar-e2e-") => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      return dir;
    },
    fleet: (opts) => seedFleet(scope.tempDir("hangar-e2e-fleet-"), { now: Date.now(), ...opts }),
    home: (fleet) => {
      const home = bootHome(fleet);
      cleanups.push(() => home.stop());
      return home;
    },
    session: async (home, opts = {}) => {
      const session = await openSession(home, { label: journey.id, ...opts });
      sessions.push(session);
      return session;
    },
    defer: (cleanup) => {
      cleanups.push(cleanup);
    },
  };
  let failed = false;
  try {
    await journey.run(scope);
    for (const session of sessions) session.assertClean();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    for (const session of sessions) {
      await session.close(failed ? { trace: "keep" } : {});
    }
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

/** The journeys a shard runs. Unset means all. An unknown or empty shard throws. */
export function selectJourneys(
  journeys: readonly Journey[],
  shard: string | undefined,
): readonly Journey[] {
  if (shard === undefined || shard === "") return journeys;
  if (!SHARDS.includes(shard as Shard)) {
    throw new Error(`HANGAR_E2E_SHARD is ${shard}; it must be one of ${SHARDS.join(", ")}`);
  }
  const selected = journeys.filter((journey) => journey.shard === shard);
  if (selected.length === 0) throw new Error(`shard ${shard} selects no journey`);
  return selected;
}
