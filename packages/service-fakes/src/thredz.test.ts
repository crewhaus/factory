import { afterEach, describe, expect, test } from "bun:test";
import { MASKED } from "./record";
import { type FakeThredz, type FakeThredzOptions, fakeThredz } from "./thredz";

const fakes: FakeThredz[] = [];
afterEach(async () => {
  while (fakes.length > 0) await (fakes.pop() as FakeThredz).stop();
});

function start(opts: FakeThredzOptions = {}): FakeThredz {
  const fake = fakeThredz(opts);
  fakes.push(fake);
  return fake;
}

describe("fakeThredz", () => {
  test("baseUrl is the /api prefix a harness's thredz.base_url names", () => {
    const fake = start();
    expect(fake.baseUrl).toBe(`${fake.url}/api`);
  });

  test.each(["/wiki/stats", "/keys", "/listeners/usage"])(
    "the status probe's %s has a default reply",
    async (path) => {
      const fake = start();
      const res = await fetch(`${fake.baseUrl}${path}`);
      expect(res.status).not.toBe(404);
      expect(fake.calls().map((call) => `${call.method} ${call.path}`)).toEqual([`GET ${path}`]);
    },
  );

  test("anything unregistered is a 404 with the API's message, and is still recorded", async () => {
    const fake = start();
    const res = await fetch(`${fake.baseUrl}/nothing/here`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Not found" });
    expect(fake.calls()).toHaveLength(1);
  });

  test("a path outside the /api prefix is a 404 and is not recorded", async () => {
    const fake = start();
    expect((await fetch(`${fake.url}/wiki/stats`)).status).toBe(404);
    expect(fake.calls()).toHaveLength(0);
  });

  test("route() replaces a reply, with a value or a function of the call", async () => {
    const fake = start({ routes: { "GET /wiki/stats": { status: 200, body: { articles: 3 } } } });
    expect(await (await fetch(`${fake.baseUrl}/wiki/stats`)).json()).toEqual({ articles: 3 });
    fake.route("GET /wiki/stats", (call) => ({ status: 201, body: { search: call.search } }));
    const res = await fetch(`${fake.baseUrl}/wiki/stats?x=1`);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ search: "?x=1" });
  });

  test("calls() reduces the auth headers to present or absent", async () => {
    const fake = start();
    const planted = ["thz", "not", "real"].join("_");
    await fetch(`${fake.baseUrl}/wiki/stats`, {
      headers: { authorization: `Bearer ${planted}`, "x-api-key": planted },
    });
    await fetch(`${fake.baseUrl}/wiki/stats`);
    const [withKey, without] = fake.calls();
    expect(withKey?.authorization).toBe("present");
    expect(withKey?.apiKeyHeader).toBe("present");
    expect(without?.authorization).toBe("absent");
    expect(without?.apiKeyHeader).toBe("absent");
    expect(JSON.stringify(fake.calls())).not.toContain(planted);
  });

  test("a recorded body holds no credential, and idempotency travels in its header", async () => {
    const fake = start();
    const planted = ["not", "real"].join("-");
    await fetch(`${fake.baseUrl}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "ref-1" },
      body: JSON.stringify({ name: "n", token: planted }),
    });
    const [call] = fake.calls();
    expect(call?.idempotencyKey).toBe("ref-1");
    expect(call?.body).toEqual({ name: "n", token: MASKED });
  });
});
