/**
 * `<hangarRoot>/home.sock`: Home's own socket. It exists while Home runs, only its owner
 * can open it, it takes Home's own key whatever else is set, a stale one is replaced, a
 * file that is not a socket is never touched, and it is gone after `stop()`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bearer } from "./__test__/browser";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

const POSIX = process.platform !== "win32";
const viaSocket = (path: string, sock: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost${path}`, { ...init, unix: sock } as RequestInit);

describe.skipIf(!POSIX)("home.sock (skipped on Windows: Home creates no socket there)", () => {
  test("exists at 0600 and takes Home's own key; gone after stop()", async () => {
    const t = bootTestServer({});
    servers.push(t);
    const sock = join(t.hangarRoot, "home.sock");
    expect(t.server.socketPath).toBe(sock);
    expect(lstatSync(sock).isSocket()).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    const ok = await viaSocket("/api/version", sock, { headers: bearer(t.token) });
    expect(ok.status).toBe(200);
    const none = await viaSocket("/api/version", sock);
    expect(none.status).toBe(401);
    await t.server.stop();
    expect(existsSync(sock)).toBe(false);
  });

  test("takes Home's own key even with a forwarding header, which TCP refuses", async () => {
    const t = bootTestServer({});
    servers.push(t);
    const headers = { ...bearer(t.token), "x-forwarded-for": "203.0.113.9" };
    expect((await t.fetchRaw("/api/version", { headers })).status).toBe(401);
    const sock = join(t.hangarRoot, "home.sock");
    expect((await viaSocket("/api/version", sock, { headers })).status).toBe(200);
  });

  test("a socket left at the path is replaced", async () => {
    let leftover: { stop(): void } | undefined;
    let staleInode = 0;
    const t = bootTestServer({
      prepare: ({ hangarRoot }) => {
        const path = join(hangarRoot, "home.sock");
        leftover = Bun.listen({ unix: path, socket: { data() {} } });
        staleInode = lstatSync(path).ino;
      },
    });
    servers.push(t);
    try {
      const sock = join(t.hangarRoot, "home.sock");
      expect(staleInode).toBeGreaterThan(0);
      expect(lstatSync(sock).ino).not.toBe(staleInode);
      expect((await viaSocket("/api/version", sock, { headers: bearer(t.token) })).status).toBe(
        200,
      );
    } finally {
      leftover?.stop();
    }
  });

  test("a file at the path that is not a socket is left alone, and Home warns", async () => {
    const t = bootTestServer({
      prepare: ({ hangarRoot }) => writeFileSync(join(hangarRoot, "home.sock"), "not a socket"),
    });
    servers.push(t);
    const kept = join(t.hangarRoot, "home.sock");
    expect(readFileSync(kept, "utf8")).toBe("not a socket");
    expect(t.server.socketPath).toBeUndefined();
    expect(t.warnings.some((w) => w.includes("is not a socket"))).toBe(true);
    await t.server.stop();
    expect(readFileSync(kept, "utf8")).toBe("not a socket");
  });

  test("a --no-auth Home opens no socket", async () => {
    const t = bootTestServer({ noAuth: true });
    servers.push(t);
    expect(t.server.socketPath).toBeUndefined();
    expect(existsSync(join(t.hangarRoot, "home.sock"))).toBe(false);
  });
});
