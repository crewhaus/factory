/**
 * A Home with sign-in on, an owner signed in through the boot link, and helpers to call the
 * versioned API as a session, a service token or a personal token.
 */
import { join } from "node:path";
import { loadAccessSnapshot, openAccess, openDeviceRequests } from "@crewhaus/access-control";
import { makeFixtureHarness } from "../fixture";
import { type BootOptions, type TestServer, bootTestServer } from "../testkit";
import { bearer, signInFromBootLink } from "./browser";

export type V1Home = {
  readonly t: TestServer;
  readonly owner: string;
  readonly session: string;
  /** Register a fixture harness and answer its id and directory. */
  harness(
    name: string,
    opts?: Parameters<typeof makeFixtureHarness>[1],
  ): Promise<{ id: string; dir: string }>;
  /** Call the API with a bearer (the owner's session by default). */
  call(
    method: string,
    path: string,
    opts?: { body?: unknown; secret?: string | null; headers?: Record<string, string> },
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }>;
  /** A service token over these harnesses, with these permissions. */
  service(
    name: string,
    harnesses: readonly string[],
    opts?: { permissions?: readonly string[]; contentRead?: boolean },
  ): Promise<{ secret: string; credential: string; principal: string }>;
  /** A member with this role on the whole Home, signed in with a personal token. */
  member(
    name: string,
    role: string,
    opts?: { readOnly?: boolean; scope?: string },
  ): Promise<{ principal: string; secret: string; credential: string }>;
};

export async function v1Home(opts: BootOptions = {}): Promise<V1Home> {
  const t = bootTestServer(opts);
  const browser = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
  const read = loadAccessSnapshot(t.hangarRoot);
  if (read.state !== "present" || read.snapshot.owner === undefined) throw new Error("no owner");
  const owner = read.snapshot.owner;
  const access = () => openAccess(t.hangarRoot);
  const call: V1Home["call"] = async (method, path, o = {}) => {
    const secret = o.secret === undefined ? browser.session : o.secret;
    const res = await t.fetchRaw(path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(secret !== null ? bearer(secret) : {}),
        ...(o.headers ?? {}),
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      body = { text };
    }
    return { status: res.status, body, headers: res.headers };
  };
  return {
    t,
    owner,
    session: browser.session,
    async harness(name, o) {
      const dir = makeFixtureHarness(join(t.harnessesRoot, name), { specName: name, ...o });
      const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
      const id = (res.body["entry"] as { id: string }).id;
      return { id, dir };
    },
    call,
    async service(name, harnesses, o = {}) {
      const done = await access().mintServiceToken(
        { principal: owner },
        {
          service: name,
          permissions: [...(o.permissions ?? [])],
          harnesses: [...harnesses],
          ...(o.contentRead === true ? { contentRead: true } : {}),
        },
      );
      if (!done.ok) throw new Error(done.reason);
      return {
        secret: done.result.secret,
        credential: done.result.token.id,
        principal: done.result.principal,
      };
    },
    async member(name, role, o = {}) {
      const granted = await access().grant(
        { principal: owner },
        { member: name, create: true, role, scope: o.scope ?? "home" },
      );
      if (!granted.ok) throw new Error(granted.reason);
      const devices = openDeviceRequests(t.hangarRoot);
      const start = await devices.start({ ...(o.readOnly === true ? { readOnly: true } : {}) });
      if (!start.ok) throw new Error(start.reason);
      const decided = await devices.decide({
        caller: granted.result.principal,
        code: start.userCode,
        choice: "allow",
      });
      if (!decided.ok) throw new Error(decided.reason);
      const polled = await devices.poll(start.pollRef);
      if (!polled.ok || polled.state !== "allowed") throw new Error("no personal token");
      return {
        principal: granted.result.principal,
        secret: polled.secret,
        credential: polled.token.id,
      };
    },
  };
}
