/**
 * `crewhaus api` against an in-process Home: over Home's own socket with Home's own key,
 * Home's key sent only to the running Home on this computer (on Windows over loopback to
 * a loopback IP address, nowhere but the socket elsewhere), and with `--server` through a
 * personal token kept for that Home. Each refusal ends with the control band's exit for its code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_FILENAME, openAccess, openDeviceRequests } from "@crewhaus/access-control";
import { PROTOCOL_ID } from "@crewhaus/control-contract";
import { signInFromBootLink } from "../../../packages/hangar-server/src/__test__/browser";
import { makeFixtureHarness } from "../../../packages/hangar-server/src/fixture";
import { type TestServer, bootTestServer } from "../../../packages/hangar-server/src/testkit";
import { closestOperations, runApiCommand } from "./api-cmd";
import { type HangarLock, writeHangarLock } from "./hangar-cmd";
import { type SecretsStore, remoteStore } from "./remote-homes";

function memorySecrets(): SecretsStore & { readonly kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    get: async (name) => kept.get(name) ?? null,
    set: async (name, value) => {
      kept.set(name, value);
    },
    delete: async (name) => kept.delete(name),
  };
}

let t: TestServer;
let harness: string;
let env: Record<string, string>;
const APPR = "appr_00000000000000c1";

beforeAll(async () => {
  t = bootTestServer();
  const owner = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
  void owner;
  const dir = makeFixtureHarness(join(t.harnessesRoot, "alpha"), {
    specName: "alpha",
    approvals: [
      {
        id: APPR,
        toolName: "SendMessage",
        inputHash: "h",
        input: { channel: "ops" },
        runId: "run_00000000000000a0",
        sessionId: "sess_00000000000000aa",
        surface: "daemon",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  harness = (res.body["entry"] as { id: string }).id;
  env = { CREWHAUS_HANGAR_ROOT: t.hangarRoot, CREWHAUS_REGISTRY_ROOT: t.registryRoot };
}, 60_000);

afterAll(async () => {
  await t?.stop();
});

describe("crewhaus api on this computer", () => {
  test("harnesses.list prints the list", async () => {
    const out = await runApiCommand(["harnesses.list"], { env });
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.lines.join("\n")) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toContain(harness);
  });

  test("404 exits 56, and 409 exits 53", async () => {
    const missing = await runApiCommand(["harnesses.get", "--param", "h=nope"], { env });
    expect(missing.exitCode).toBe(56);
    const ref = `${harness}/decision/${APPR}`;
    const first = await runApiCommand(
      ["decisions.resolve", "--param", `ref=${ref}`, "--body-file", "-"],
      { env, readStdin: async () => JSON.stringify({ choice: "deny" }) },
    );
    expect(first.exitCode).toBe(0);
    const second = await runApiCommand(
      ["decisions.resolve", "--param", `ref=${ref}`, "--body-file", "-"],
      { env, readStdin: async () => JSON.stringify({ choice: "grant" }) },
    );
    expect(second.exitCode).toBe(53);
  });

  test("an unknown operation exits 55 naming the closest ones", async () => {
    const out = await runApiCommand(["harness.list"], { env });
    expect(out.exitCode).toBe(55);
    expect(out.lines.join("\n")).toContain("harnesses.list");
    expect(closestOperations("harness.list")[0]).toBe("harnesses.list");
  });
});

describe("crewhaus api on this computer sends Home's key only to the running Home", () => {
  // A key-shaped value built from parts: never a real credential.
  const key = ["hk", "_", "q".repeat(40)].join("");
  const LOOPBACK = "http://127.0.0.1:47999";
  const LIVE: HangarLock = { pid: 4242, startedAt: "", port: 47999, url: LOOPBACK };
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  /** A Home directory holding Home's key and, when given, a lock; never a socket. */
  const homeWith = (lock: HangarLock | undefined): Record<string, string> => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-api-local-"));
    scratch.push(root);
    writeFileSync(join(root, TOKEN_FILENAME), `${key}\n`, { mode: 0o600 });
    if (lock !== undefined) writeHangarLock(root, lock);
    return { CREWHAUS_HANGAR_ROOT: root };
  };

  /** A fetch that records each request and answers as Home does: discovery without a
   *  credential gets the sign-in methods and no operations, and a key gets a 401. */
  const counting = () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      seen.push({ url: String(input), authorization });
      if (authorization === null) {
        return new Response(
          JSON.stringify({ protocol: PROTOCOL_ID, signIn: { methods: ["browser", "device"] } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ error: { code: "unauthenticated", message: "sign in" } }),
        { status: 401 },
      );
    };
    return { seen, fetch: fake as unknown as typeof fetch };
  };

  test("a lock whose process is gone exits 52 and sends nothing, on every platform", async () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const wire = counting();
      const out = await runApiCommand(["harnesses.list"], {
        env: homeWith(LIVE),
        fetch: wire.fetch,
        isPidAlive: () => false,
        platform,
      });
      expect(out.exitCode).toBe(52);
      expect(out.lines.join("\n")).toContain("Home is not running on this computer");
      expect(wire.seen).toHaveLength(0);
    }
  });

  test("a lock with no address, and no lock at all, each exit 52 and send nothing", async () => {
    for (const lock of [{ ...LIVE, url: "" }, undefined]) {
      for (const platform of ["linux", "win32"] as const) {
        const wire = counting();
        const out = await runApiCommand(["harnesses.list"], {
          env: homeWith(lock),
          fetch: wire.fetch,
          isPidAlive: () => true,
          platform,
        });
        expect(out.exitCode).toBe(52);
        expect(out.lines.join("\n")).toContain("Home is not running on this computer");
        expect(wire.seen).toHaveLength(0);
      }
    }
  });

  for (const platform of ["linux", "darwin"] as const) {
    test(`on ${platform}, a running Home without its socket is refused here and sent nothing`, async () => {
      const env = homeWith(LIVE);
      for (const args of [["harnesses.list"], ["harnesses.list", "--json"]]) {
        const wire = counting();
        const out = await runApiCommand(args, {
          env,
          fetch: wire.fetch,
          isPidAlive: () => true,
          platform,
        });
        expect(out.exitCode).toBe(50);
        expect(wire.seen).toHaveLength(0);
        const text = out.lines.join("\n");
        expect(text).toContain("Home is running without its own socket");
        expect(text).toContain("this computer's key was not sent");
        expect(text).toContain("too long");
      }
    });
  }

  test("on Windows, a running Home at a loopback IP gets the key once, at that address", async () => {
    // Guards the other direction: Home's own key reaches a running Home where it
    // has no socket, so a change that drops the key everywhere fails here.
    for (const url of [LOOPBACK, "http://127.5.6.7:47999", "http://[::1]:47999"]) {
      const wire = counting();
      const out = await runApiCommand(["harnesses.list"], {
        env: homeWith({ ...LIVE, url }),
        fetch: wire.fetch,
        isPidAlive: () => true,
        platform: "win32",
      });
      expect(out.exitCode).toBe(50);
      expect(wire.seen).toHaveLength(1);
      expect(wire.seen[0]?.authorization).toBe(`Bearer ${key}`);
      expect(wire.seen[0]?.url).toStartWith(`${url}/`);
    }
  });

  test("on Windows, a running Home at any other address is sent nothing", async () => {
    for (const host of ["192.168.1.5", "0.0.0.0", "localhost", "home.example"]) {
      const wire = counting();
      const out = await runApiCommand(["harnesses.list"], {
        env: homeWith({ ...LIVE, url: `http://${host}:47999` }),
        fetch: wire.fetch,
        isPidAlive: () => true,
        platform: "win32",
      });
      expect(out.exitCode).toBe(50);
      expect(wire.seen).toHaveLength(0);
      expect(out.lines.join("\n")).toContain("not a loopback address");
    }
  });
});

describe("crewhaus api --server", () => {
  test("uses the kept personal token; a refusal for a role exits 51; none kept exits 50", async () => {
    const secrets = memorySecrets();
    const origin = new URL(t.server.url).origin;
    const none = await runApiCommand(["harnesses.list", "--server", origin], { env, secrets });
    expect(none.exitCode).toBe(50);
    // A viewer of the whole Home, signed in from another computer.
    const read = openAccess(t.hangarRoot).load();
    const owner = read.state === "present" ? (read.snapshot.owner as string) : "";
    const granted = await openAccess(t.hangarRoot).grant(
      { principal: owner },
      { member: "Vee", create: true, role: "viewer", scope: "home" },
    );
    if (!granted.ok) throw new Error(granted.reason);
    const devices = openDeviceRequests(t.hangarRoot);
    const start = await devices.start({});
    if (!start.ok) throw new Error(start.reason);
    await devices.decide({
      caller: granted.result.principal,
      code: start.userCode,
      choice: "allow",
    });
    const polled = await devices.poll(start.pollRef);
    if (!polled.ok || polled.state !== "allowed") throw new Error("no token");
    await remoteStore(t.hangarRoot, secrets).write({
      origin,
      token: polled.secret,
      credentialRef: polled.token.id,
    });
    const listed = await runApiCommand(["harnesses.list", "--server", origin], { env, secrets });
    expect(listed.exitCode).toBe(0);
    const refused = await runApiCommand(
      ["controls.pause", "--param", `h=${harness}`, "--server", origin],
      { env, secrets },
    );
    expect(refused.exitCode).toBe(51);
  });
});
