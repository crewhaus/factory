import { describe, expect, test } from "bun:test";
import { OPERATIONS, PROTOCOL_HEADER } from "../index.js";
import { buildPath, createClient, errorOf, makeSeal, readSse } from "./index.js";

type Seen = { url: string; init: RequestInit | undefined };

function recorder(answer: (url: string, init?: RequestInit) => Response) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, init });
    return answer(url, init);
  };
  return { seen, fetch };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A discovery document that names paths no real table has, so a built path proves its source. */
const PLANTED = {
  protocol: "crewhaus.hangar.v1",
  signIn: { methods: ["browser", "device"] },
  operations: [
    {
      id: "things.get",
      method: "GET",
      path: "/api/v1/planted/{h}/things",
      permission: "h.read",
      receipt: "none",
      idempotency: "none",
    },
    {
      id: "decisions.resolve",
      method: "POST",
      path: "/api/v1/somewhere/{ref}/decide",
      permission: "h.decision.resolve",
      receipt: "harness",
      idempotency: "accepted",
    },
  ],
};

describe("paths come from the operation table", () => {
  test("a planted discovery table is the only source of a path", async () => {
    const { seen, fetch } = recorder((url) =>
      url.endsWith("/api/v1") ? json(PLANTED) : json({ items: [] }),
    );
    const client = createClient({ baseUrl: "http://home.test/", token: "t", fetch });
    const answer = await client.call("things.get", {
      params: { h: "support" },
      query: { limit: 2 },
    });
    expect(answer.ok).toBe(true);
    expect(seen.map((s) => s.url)).toEqual([
      "http://home.test/api/v1",
      "http://home.test/api/v1/planted/support/things?limit=2",
    ]);
    // Discovery is read once.
    await client.call("things.get", { params: { h: "other" } });
    expect(seen.filter((s) => s.url.endsWith("/api/v1"))).toHaveLength(1);
  });

  test("a {ref} spans three segments, each encoded", async () => {
    const { seen, fetch } = recorder((url) =>
      url.endsWith("/api/v1") ? json(PLANTED) : json({ ok: true }),
    );
    const client = createClient({ baseUrl: "http://home.test", fetch });
    await client.call("decisions.resolve", {
      params: { ref: "hrn_0123456789abcdef/decision/appr_0123456789abcdef" },
      body: { choice: "grant" },
      idempotencyKey: "act-1",
    });
    const last = seen.at(-1) as Seen;
    expect(last.url).toBe(
      "http://home.test/api/v1/somewhere/hrn_0123456789abcdef/decision/appr_0123456789abcdef/decide",
    );
    const headers = new Headers(last.init?.headers);
    expect(headers.get("idempotency-key")).toBe("act-1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(last.init?.body).toBe('{"choice":"grant"}');
    expect(buildPath("/a/{ref}/b", { ref: "x/y/z" })).toBe("/a/x/y/z/b");
    expect(buildPath("/a/{h}", { h: "a/b" })).toBe("/a/a%2Fb");
    expect(buildPath("/a/{h}", {})).toBeUndefined();
  });

  test("a table handed in is used without asking Home", async () => {
    const { seen, fetch } = recorder(() => json({ items: [] }));
    const client = createClient({ baseUrl: "http://home.test", fetch, operations: OPERATIONS });
    await client.call("harnesses.list");
    expect(seen.map((s) => s.url)).toEqual(["http://home.test/api/v1/harnesses"]);
  });

  test("an unknown operation or a missing param sends nothing", async () => {
    const { seen, fetch } = recorder(() => json({}));
    const client = createClient({ baseUrl: "http://home.test", fetch, operations: OPERATIONS });
    const unknown = await client.call("nope.nothing");
    expect(unknown.ok === false && unknown.error.code).toBe("invalid");
    const missing = await client.call("harnesses.get");
    expect(missing.ok === false && missing.error.code).toBe("invalid");
    expect(seen).toHaveLength(0);
  });
});

describe("headers and envelopes", () => {
  test("every request carries the protocol header and the bearer", async () => {
    const { seen, fetch } = recorder(() => json(PLANTED));
    const client = createClient({ baseUrl: "http://home.test", token: "tok", fetch });
    await client.discover();
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get(PROTOCOL_HEADER)).toBe("crewhaus.hangar.v1");
    expect(headers.get("authorization")).toBe("Bearer tok");
  });

  test("a v1 error envelope, a legacy error and a bare status each parse", async () => {
    const envelope = {
      error: { code: "forbidden", message: "no", retryable: false, needs: "h.read" },
    };
    expect(errorOf(403, envelope)).toMatchObject({ code: "forbidden", needs: "h.read" });
    expect(errorOf(409, { error: "taken", code: "already_decided" })).toMatchObject({
      code: "already_decided",
      message: "taken",
    });
    expect(errorOf(404, undefined)).toMatchObject({ code: "not_found" });
    expect(errorOf(500, "boom")).toMatchObject({ code: "internal", message: "boom" });
    const { fetch } = recorder((url) =>
      url.endsWith("/api/v1") ? json(PLANTED) : json(envelope, 403),
    );
    const answer = await createClient({ baseUrl: "http://h", fetch }).call("things.get", {
      params: { h: "x" },
    });
    expect(answer).toMatchObject({ ok: false, status: 403, error: { code: "forbidden" } });
  });

  test("a failed discovery is not kept", async () => {
    let up = false;
    const { fetch } = recorder(() => (up ? json(PLANTED) : json({ error: "down" }, 503)));
    const client = createClient({ baseUrl: "http://h", fetch });
    expect((await client.discover()).ok).toBe(false);
    up = true;
    expect((await client.discover()).ok).toBe(true);
  });

  test("a network failure answers unavailable, never throws", async () => {
    const client = createClient({
      baseUrl: "http://h",
      fetch: async () => {
        throw new Error("refused");
      },
      operations: OPERATIONS,
    });
    const answer = await client.call("harnesses.list");
    expect(answer.ok === false && answer.error.code).toBe("unavailable");
  });
});

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function frames(chunks: readonly string[]) {
  const out = [];
  for await (const frame of readSse(streamOf(chunks))) out.push(frame);
  return out;
}

describe("server-sent events", () => {
  test("frames split across chunks read whole; heartbeats are skipped", async () => {
    expect(
      await frames([
        ": heartbeat\n\n",
        "id: c1\nev",
        "ent: run.queued\nda",
        'ta: {"a":1}\n',
        "\n: ping\n\nid: c2\r",
        "\nevent: run.started\r\ndata: one\r\ndata: two\r\n\r\n",
        "id: c3\ndata: cut off",
      ]),
    ).toEqual([
      { id: "c1", event: "run.queued", data: '{"a":1}' },
      { id: "c2", event: "run.started", data: "one\ntwo" },
    ]);
  });

  test("a multi-byte character split across chunks decodes whole", async () => {
    const bytes = new TextEncoder().encode("data: é\n\n");
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    const out = [];
    for await (const frame of readSse(split)) out.push(frame);
    expect(out).toEqual([{ data: "é" }]);
  });

  test("events() sends the cursor it resumes from", async () => {
    const { seen, fetch } = recorder(
      () => new Response(streamOf(["id: c9\ndata: x\n\n"]), { status: 200 }),
    );
    const client = createClient({ baseUrl: "http://h", fetch, operations: OPERATIONS });
    const out = [];
    for await (const frame of client.events("/api/v1/events", { after: "c8" })) out.push(frame);
    expect(out).toEqual([{ id: "c9", data: "x" }]);
    expect(new Headers(seen[0]?.init?.headers).get("last-event-id")).toBe("c8");
  });
});

describe("sealing", () => {
  test("a seal opens only for its own operation", async () => {
    const pair = await makeSeal();
    expect(Object.keys(pair.seal).sort()).toEqual(["crv", "kty", "x", "y"]);
    await expect(pair.open({ alg: "nope" }, "auth.device.poll")).rejects.toThrow();
  });
});
