/**
 * `crewhaus api` against an in-process Home: over Home's own socket with Home's own key
 * (loopback where there is no socket), and with `--server` through a personal token kept
 * for that Home. Each refusal ends with the control band's exit for its code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openAccess, openDeviceRequests } from "@crewhaus/access-control";
import { signInFromBootLink } from "../../../packages/hangar-server/src/__test__/browser";
import { makeFixtureHarness } from "../../../packages/hangar-server/src/fixture";
import { type TestServer, bootTestServer } from "../../../packages/hangar-server/src/testkit";
import { closestOperations, runApiCommand } from "./api-cmd";
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
