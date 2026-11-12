/**
 * Once the access records hold Home's own key, a `<hangarRoot>/token` that no longer
 * matches them would be refused on every request, and `crewhaus hangar open` could not
 * mint a link. Home stops at boot instead, naming the verb that repairs it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAccessSetUp,
  ensureToken,
  localActorOf,
  rotateBootstrap,
} from "@crewhaus/access-control";
import { bearer } from "./__test__/browser";
import { bootTestServer } from "./testkit";

const LOCAL_ACTOR = localActorOf({ username: "tester", hostname: "test-host" });
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A Home directory whose first sign-in already recorded its key. */
async function recordedRoot(): Promise<string> {
  const root = join(mkdtempSync(join(tmpdir(), "hangar-key-")), "hangar");
  scratch.push(root);
  ensureToken(root);
  const setup = await ensureAccessSetUp(root, { localActor: LOCAL_ACTOR });
  if (!setup.ok) throw new Error(setup.reason);
  return root;
}

const copyInto = (src: string) => (dirs: { readonly hangarRoot: string }) =>
  cpSync(src, dirs.hangarRoot, { recursive: true });

describe("Home's own key file and its record", () => {
  test("a deleted key file is not silently minted again: boot stops and names rotate-token", async () => {
    const root = await recordedRoot();
    rmSync(join(root, "token"));
    expect(() => bootTestServer({ prepare: copyInto(root) })).toThrow(
      /is not the key Home recorded .*crewhaus hangar rotate-token/,
    );
  });

  test("a replaced key file stops boot the same way", async () => {
    const root = await recordedRoot();
    writeFileSync(join(root, "token"), `${"ab".repeat(32)}\n`, { mode: 0o600 });
    expect(() => bootTestServer({ prepare: copyInto(root) })).toThrow(
      /crewhaus hangar rotate-token/,
    );
  });

  test("after rotate-token the file's key boots and answers", async () => {
    const root = await recordedRoot();
    rmSync(join(root, "token"));
    const rotated = await rotateBootstrap(root, { localActor: LOCAL_ACTOR });
    if (!rotated.ok) throw new Error(rotated.reason);
    const t = bootTestServer({ prepare: copyInto(root) });
    try {
      const res = await t.fetchRaw("/api/version", { headers: bearer(t.token) });
      expect(res.status).toBe(200);
    } finally {
      await t.stop();
    }
  });

  test("a matching file boots, and a Home with no records yet boots on any file", async () => {
    const root = await recordedRoot();
    const t = bootTestServer({ prepare: copyInto(root) });
    try {
      expect((await t.fetchRaw("/api/version", { headers: bearer(t.token) })).status).toBe(200);
    } finally {
      await t.stop();
    }
    const fresh = bootTestServer({});
    try {
      expect((await fresh.fetchRaw("/api/version", { headers: bearer(fresh.token) })).status).toBe(
        200,
      );
    } finally {
      await fresh.stop();
    }
  });
});
