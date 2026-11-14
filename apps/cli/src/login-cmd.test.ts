/**
 * `crewhaus login` and `crewhaus logout` against an in-process Home, with an injected
 * keychain: the code is shown, a member allows it, the sealed token is kept and used by
 * `crewhaus api --server`, and logout revokes it there. Plain HTTP to another computer is
 * refused before anything is sent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadAccessSnapshot, openDeviceRequests } from "@crewhaus/access-control";
import { signInFromBootLink } from "../../../packages/hangar-server/src/__test__/browser";
import { type TestServer, bootTestServer } from "../../../packages/hangar-server/src/testkit";
import { runApiCommand } from "./api-cmd";
import { runLoginCommand } from "./login-cmd";
import { runLogoutCommand } from "./logout-cmd";
import { type SecretsStore, remoteStore } from "./remote-homes";

function memorySecrets(): SecretsStore {
  const kept = new Map<string, string>();
  return {
    get: async (name) => kept.get(name) ?? null,
    set: async (name, value) => {
      kept.set(name, value);
    },
    delete: async (name) => kept.delete(name),
  };
}

let t: TestServer;
let env: Record<string, string>;
let owner: string;
/** Home's clock, moved by hand past each poll interval. */
let offset = 0;

beforeAll(async () => {
  t = bootTestServer({ now: () => Date.now() + offset });
  await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
  const read = loadAccessSnapshot(t.hangarRoot);
  owner = read.state === "present" ? (read.snapshot.owner as string) : "";
  env = { CREWHAUS_HANGAR_ROOT: t.hangarRoot, CREWHAUS_REGISTRY_ROOT: t.registryRoot };
}, 60_000);

afterAll(async () => {
  await t?.stop();
});

describe("crewhaus login", () => {
  test("a code round trip keeps the token; api --server uses it; logout revokes it", async () => {
    const secrets = memorySecrets();
    const origin = new URL(t.server.url).origin;
    let shown = "";
    let allowed = false;
    const login = await runLoginCommand(["--server", origin], {
      env,
      secrets,
      stdout: (text) => {
        shown += text;
      },
      // Each wait: the member allows it once, and Home's clock moves past the interval.
      sleep: async () => {
        offset += 6_000;
        if (allowed) return;
        const code = /enter this code: ([A-Z]{4}-[A-Z]{4})/.exec(shown)?.[1];
        if (code === undefined) throw new Error(`no code shown: ${shown}`);
        const decided = await openDeviceRequests(t.hangarRoot).decide({
          caller: owner,
          code,
          choice: "allow",
        });
        if (!decided.ok) throw new Error(decided.reason);
        allowed = true;
      },
    });
    expect(login.exitCode).toBe(0);
    expect(shown).toContain(`${origin}/#/device`);
    const kept = await remoteStore(t.hangarRoot, secrets).read(origin);
    expect(kept?.token.startsWith("chp_")).toBe(true);
    expect(kept?.credentialRef?.startsWith("crd_")).toBe(true);

    const me = await runApiCommand(["me.get", "--server", origin], { env, secrets });
    expect(me.exitCode).toBe(0);

    const out = await runLogoutCommand(["--server", origin], { env, secrets });
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain("revoked");
    expect(await remoteStore(t.hangarRoot, secrets).read(origin)).toBeUndefined();
    // The revoked token no longer signs in: kept again by hand, Home refuses it.
    await remoteStore(t.hangarRoot, secrets).write({ origin, token: kept?.token as string });
    const after = await runApiCommand(["me.get", "--server", origin], { env, secrets });
    expect(after.exitCode).toBe(50);
  });

  test("plain http to another computer is refused before any request", async () => {
    let calls = 0;
    const out = await runLoginCommand(["--server", "http://192.168.1.20:8740"], {
      env,
      secrets: memorySecrets(),
      fetch: (async () => {
        calls++;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(out.exitCode).toBe(55);
    expect(calls).toBe(0);
    expect(out.lines.join("\n")).toContain("--allow-http");
  });

  test("a denied sign-in exits 51 and keeps nothing", async () => {
    const secrets = memorySecrets();
    const origin = new URL(t.server.url).origin;
    let shown = "";
    const login = await runLoginCommand(["--server", origin], {
      env,
      secrets,
      stdout: (text) => {
        shown += text;
      },
      sleep: async () => {
        offset += 6_000;
        const code = /enter this code: ([A-Z]{4}-[A-Z]{4})/.exec(shown)?.[1] as string;
        await openDeviceRequests(t.hangarRoot)
          .decide({ caller: owner, code, choice: "deny" })
          .catch(() => undefined);
      },
    });
    expect(login.exitCode).toBe(51);
    expect(await remoteStore(t.hangarRoot, secrets).read(origin)).toBeUndefined();
  });
});
