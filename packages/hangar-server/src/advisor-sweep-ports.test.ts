/**
 * The background gathering of Advisor findings binds no port. Two harnesses ask for a port
 * something else holds: a tick of the sweep gathers both and says nothing about the port,
 * and the port check is never called; an Advisor read a person opens checks it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { join } from "node:path";
import { readAdvisorSnapshot } from "@crewhaus/attention";
import { type V1Home, v1Home } from "./__test__/v1-home";

let home: V1Home;
let held: Server;
let port = 0;
const checked: number[] = [];
const harnesses: { id: string; dir: string }[] = [];

beforeAll(async () => {
  held = createServer();
  await new Promise<void>((resolve) => held.listen({ port: 0, host: "127.0.0.1" }, resolve));
  const address = held.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  port = address.port;
  // `advisorItems` is not injected: the tick runs the gatherer Home ships.
  home = await v1Home({
    checkPort: async (p) => {
      checked.push(p);
      return { port: p, free: false, detail: "EADDRINUSE" };
    },
  });
  for (const name of ["port-a", "port-b"]) {
    const h = await home.harness(name);
    writeFileSync(join(h.dir, ".env"), `PORT=${port}\n`);
    harnesses.push(h);
  }
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
  await new Promise<void>((resolve) => held.close(() => resolve()));
});

describe("the Advisor's background check", () => {
  test("a tick over two harnesses that ask for a port checks none", async () => {
    await home.t.server.scheduler.tick();
    await home.t.server.scheduler.idle();
    expect(harnesses).toHaveLength(2);
    for (const h of harnesses) {
      const snapshot = readAdvisorSnapshot(home.t.hangarRoot, h.id);
      // It was gathered, and holds findings; none of them is about the port.
      expect(snapshot?.items.length).toBeGreaterThan(0);
      expect(snapshot?.items.map((f) => f.id)).not.toContain(`preflight-ports.${port}`);
    }
    expect(checked).toEqual([]);
  }, 20_000);

  test("an Advisor read a person opens checks it", async () => {
    const [a] = harnesses as [{ id: string; dir: string }];
    const res = await home.call("GET", `/api/h/${a.id}/advisor`);
    expect(res.status).toBe(200);
    expect(checked).toEqual([port]);
    expect(JSON.stringify(res.body)).toContain(`preflight-ports.${port}`);
  }, 20_000);
});
