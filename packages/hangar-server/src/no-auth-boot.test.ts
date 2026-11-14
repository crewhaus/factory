/**
 * Starting Home from code with sign-in off: refused, before anything is bound, when a
 * trusted proxy is set, anyone other than the owner has access, or it would listen beyond
 * this computer; a fresh Home on loopback starts.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { acceptInvite, signInFromBootLink } from "./__test__/browser";
import { type HangarServer, startHangarServer } from "./server";
import { bootTestServer } from "./testkit";

const scratch: string[] = [];
let serveSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  serveSpy?.mockRestore();
  serveSpy = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "hangar-no-auth-"));
  scratch.push(dir);
  return dir;
}

/** Start Home with sign-in off, and answer the refusal it threw, if any. */
function startRefused(
  root: string,
  registryRoot: string,
  listen: { readonly hostname?: string; readonly lanHost?: string } = {},
): string | undefined {
  let started: HangarServer | undefined;
  try {
    started = startHangarServer({
      root,
      registryRoot,
      port: 0,
      noAuth: true,
      ...listen,
      env: { CREWHAUS_WATCHME_ROOT: join(root, "..", "watchme") },
      onWarn: () => undefined,
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  void started.stop();
  return undefined;
}

describe("a library start with sign-in off", () => {
  test("is refused when a trusted proxy is set, and binds nothing", async () => {
    const ws = workspace();
    const root = join(ws, "hangar");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("proxy-secret-parts")),
    ).toString("hex");
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({
        access: {
          trustedProxy: {
            header: "X-Auth-User",
            hosts: [],
            peers: ["127.0.0.0/8"],
            secretDigest: digest,
          },
        },
      }),
    );
    serveSpy = spyOn(Bun, "serve");
    const refusal = startRefused(root, join(ws, "registry"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("--no-auth");
    expect(refusal).toContain("trusted proxy");
    expect(serveSpy).toHaveBeenCalledTimes(0);
    expect(existsSync(join(root, "home.sock"))).toBe(false);
  });

  test("is refused when someone other than the owner has access, and binds nothing", async () => {
    const t = bootTestServer();
    let stopped = false;
    try {
      await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
      const access = openAccess(t.hangarRoot);
      const read = loadAccessSnapshot(t.hangarRoot);
      if (read.state !== "present") throw new Error("no access records");
      const invite = await access.createInvite(
        { principal: read.snapshot.owner as string },
        { role: "viewer", scope: "home" },
      );
      if (!invite.ok) throw new Error(invite.reason);
      await acceptInvite(t.fetchRaw, invite.result.code, "Vee");
      // Stopped, not removed: the next start reads the same Home.
      await t.server.stop();
      stopped = true;
      serveSpy = spyOn(Bun, "serve");
      const refusal = startRefused(t.hangarRoot, t.registryRoot);
      expect(refusal).toBeDefined();
      expect(refusal).toContain("--no-auth");
      expect(refusal).toContain("access to this Home");
      expect(serveSpy).toHaveBeenCalledTimes(0);
      expect(existsSync(join(t.hangarRoot, "home.sock"))).toBe(false);
    } finally {
      if (!stopped) await t.server.stop();
      rmSync(t.workspace, { recursive: true, force: true });
    }
  });

  test("is refused when it would listen beyond this computer, and binds nothing", () => {
    const listens: Array<{ readonly hostname?: string; readonly lanHost?: string }> = [
      { hostname: "0.0.0.0" },
      { hostname: "::" },
      { hostname: "192.168.1.20" },
      { lanHost: "192.168.1.20" },
    ];
    for (const listen of listens) {
      const ws = workspace();
      const root = join(ws, "hangar");
      // Never really bound, even if the start went ahead: the spy stands in for the socket.
      serveSpy = spyOn(Bun, "serve").mockImplementation(() => {
        throw new Error("Bun.serve was reached");
      });
      const refusal = startRefused(root, join(ws, "registry"), listen);
      const label = JSON.stringify(listen);
      expect(`${label}: ${refusal === undefined ? "started" : "refused"}`).toBe(
        `${label}: refused`,
      );
      expect(refusal).toContain("--no-auth");
      expect(refusal).toContain("beyond loopback");
      expect(serveSpy).toHaveBeenCalledTimes(0);
      expect(existsSync(join(root, "home.sock"))).toBe(false);
      serveSpy.mockRestore();
      serveSpy = undefined;
    }
  });

  test("starts on a fresh Home", async () => {
    const ws = workspace();
    const server = startHangarServer({
      root: join(ws, "hangar"),
      registryRoot: join(ws, "registry"),
      port: 0,
      noAuth: true,
      env: { CREWHAUS_WATCHME_ROOT: join(ws, "watchme") },
      onWarn: () => undefined,
    });
    expect(server.noAuth).toBe(true);
    await server.ready;
    await server.stop();
  });
});
