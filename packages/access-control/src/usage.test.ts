/**
 * The usage record: when a token or a device last authenticated, written at most once a
 * minute per id, in its own file, never in the access ledgers or the revision.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_KINDS, accessPaths } from "./paths";
import { homeFixture, ok, removeTempDirs, tempDir } from "./test-helpers";
import { USAGE_THROTTLE_MS, type UsageRecord, createUsageRecorder, readUsage } from "./usage";
import { listDevices, listTokens } from "./views";

afterAll(removeTempDirs);

function counting(root: string) {
  const writes: UsageRecord[] = [];
  const write = (r: string, record: UsageRecord): boolean => {
    writes.push(record);
    writeFileSync(join(r, accessPaths().usage), JSON.stringify(record));
    expect(r).toBe(root);
    return true;
  };
  return { writes, write };
}

function accessBytes(root: string): Record<string, string> {
  const paths = accessPaths();
  const out: Record<string, string> = {};
  for (const kind of LEDGER_KINDS) {
    const file = join(root, paths.ledgers[kind]);
    out[kind] = existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  out["revision"] = readFileSync(join(root, paths.revision), "utf8");
  return out;
}

async function serviceHome() {
  const home = await homeFixture();
  const minted = ok(
    await home.access.mintServiceToken(home.actor, {
      service: "bot",
      permissions: [],
      harnesses: [],
    }),
  );
  return { home, credential: minted.token.id };
}

describe("the usage record", () => {
  test("a recorded use shows as lastUsedAt on the token and device lists", async () => {
    const { home, credential } = await serviceHome();
    const { write } = counting(home.root);
    const recorder = createUsageRecorder(home.root, { now: home.clock.now, write });
    await recorder.record({ credential, device: "dev_01m76e6f05hp514w9j4v3qymka" });
    const usage = readUsage(home.root);
    const at = new Date(home.clock.now()).toISOString();
    const token = listTokens(home.snapshot(), home.clock.now(), usage).find(
      (t) => t.id === credential,
    );
    expect(token?.lastUsedAt).toBe(at);
    const devices = listDevices(
      [
        {
          id: "dev_01m76e6f05hp514w9j4v3qymka",
          state: "active",
          at,
          by: home.owner,
          principal: home.owner,
          deviceJwk: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) },
        },
      ],
      usage,
    );
    expect(devices[0]?.lastUsedAt).toBe(at);
    // Without the record, nothing is claimed.
    expect(
      listTokens(home.snapshot(), home.clock.now()).find((t) => t.id === credential)?.lastUsedAt,
    ).toBeUndefined();
  });

  test("two uses within a minute write once; a third after it writes again", async () => {
    const { home, credential } = await serviceHome();
    const { writes, write } = counting(home.root);
    const recorder = createUsageRecorder(home.root, { now: home.clock.now, write });
    await recorder.record({ credential });
    home.clock.advance(USAGE_THROTTLE_MS - 1);
    await recorder.record({ credential });
    expect(writes).toHaveLength(1);
    home.clock.advance(1);
    await recorder.record({ credential });
    expect(writes).toHaveLength(2);
    expect(writes[1]?.credentials[credential]).toBe(new Date(home.clock.now()).toISOString());
  });

  test("a fresh process inside the minute does not write again", async () => {
    const { home, credential } = await serviceHome();
    const first = counting(home.root);
    await createUsageRecorder(home.root, { now: home.clock.now, write: first.write }).record({
      credential,
    });
    home.clock.advance(30_000);
    const second = counting(home.root);
    await createUsageRecorder(home.root, { now: home.clock.now, write: second.write }).record({
      credential,
    });
    expect(first.writes).toHaveLength(1);
    expect(second.writes).toHaveLength(0);
  });

  test("an unreadable usage file reads as empty and never throws", async () => {
    const { home } = await serviceHome();
    writeFileSync(join(home.root, accessPaths().usage), "{not json");
    expect(readUsage(home.root)).toEqual({ v: 1, credentials: {}, devices: {} });
    writeFileSync(
      join(home.root, accessPaths().usage),
      JSON.stringify({ v: 1, credentials: { crd_x: "soon", other: "2026-01-01T00:00:00Z" } }),
    );
    expect(readUsage(home.root).credentials).toEqual({});
  });

  test("a write failure is one warning, never an error", async () => {
    const { home, credential } = await serviceHome();
    const warnings: string[] = [];
    const recorder = createUsageRecorder(home.root, {
      now: home.clock.now,
      write: () => false,
      onWarn: (m) => warnings.push(m),
    });
    await recorder.record({ credential });
    home.clock.advance(USAGE_THROTTLE_MS);
    await recorder.record({ credential });
    expect(warnings).toHaveLength(1);
  });

  test("the access ledgers and the revision are byte-identical before and after", async () => {
    const { home, credential } = await serviceHome();
    const before = accessBytes(home.root);
    await createUsageRecorder(home.root, { now: home.clock.now }).record({ credential });
    expect(existsSync(join(home.root, accessPaths().usage))).toBe(true);
    expect(accessBytes(home.root)).toEqual(before);
  });

  test("a root with no access records writes nothing and creates nothing", async () => {
    const root = tempDir();
    const { writes, write } = counting(root);
    await createUsageRecorder(root, { write }).record({ credential: "crd_x" });
    expect(writes).toHaveLength(0);
    expect(existsSync(join(root, "access"))).toBe(false);
  });
});
