/**
 * A scoped token is decided on the harness its run is in, by its minting service's
 * authority there as the access records stand now. A service's harness list is fixed when
 * its token is minted, so the narrowing is checked at the authorization function: two
 * access views that differ only in the minting credential's harnesses, one that still
 * holds the run's harness and one that does not.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AccessSnapshot, loadAccessSnapshot, scopedEpochOf } from "@crewhaus/access-control";
import { OPERATIONS, mintRunId } from "@crewhaus/control-contract";
import { type V1Home, v1Home } from "./__test__/v1-home";
import { type AccessView, type Caller, authorizeRequest } from "./access";
import { rowOf } from "./v1/match";

let home: V1Home;
let a: string;
let c: string;
let minter: { secret: string; credential: string; principal: string };
let snapshot: AccessSnapshot;

beforeAll(async () => {
  home = await v1Home();
  a = (await home.harness("scoped-a")).id;
  c = (await home.harness("scoped-c")).id;
  minter = await home.service("minter", [a, c], { contentRead: true });
  const read = loadAccessSnapshot(home.t.hangarRoot);
  if (read.state !== "present") throw new Error(`access ${read.state}`);
  snapshot = read.snapshot;
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

/** The view a request is decided on, over `snap`, with both harnesses registered. */
function viewOf(snap: AccessSnapshot, now: number): AccessView {
  return {
    read: { state: "present", snapshot: snap },
    now,
    domains: new Map(),
    groupsOf: (id) => (id === a || id === c ? [] : undefined),
    harnessIds: () => [a, c],
  };
}

/** The same records, with the minting credential's harnesses set to `harnesses`. */
function withHarnesses(harnesses: readonly string[]): AccessSnapshot {
  const tokens = snapshot.tokens.map((row) =>
    row.id === minter.credential ? { ...row, harnesses: [...harnesses] } : row,
  );
  expect(tokens.filter((row) => row.id === minter.credential)).toHaveLength(1);
  return { ...snapshot, tokens } as AccessSnapshot;
}

describe("a scoped token on the run stream, decided on its run's harness", () => {
  test("allowed while its minting service holds the content permission on that harness, refused once it holds it only on another", () => {
    const op = OPERATIONS.find((row) => row.id === "runs.events");
    if (op === undefined) throw new Error("no runs.events row");
    const run = mintRunId();
    const now = Date.now();
    const caller: Caller = {
      principal: minter.principal,
      actor: { principal: minter.principal, credential: minter.credential },
      via: "scoped",
      scoped: {
        refs: [`${a}/run/${run}`],
        acts: ["run.events.read"],
        exp: now + 60_000,
        ep: scopedEpochOf(snapshot, minter.principal),
      },
    };
    const decide = (snap: AccessSnapshot) =>
      authorizeRequest({
        row: rowOf(op),
        params: { run },
        caller,
        view: viewOf(snap, now),
        targetHarness: a,
      });
    // The credential is live in both views; only its harness list differs.
    expect(decide(withHarnesses([a, c]))).toEqual({ allow: true });
    const narrowed = decide(withHarnesses([c]));
    expect(narrowed.allow).toBe(false);
    expect(narrowed.allow === false && narrowed.refusal.reason).toBe("scoped");
  });
});
