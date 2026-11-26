/**
 * A legacy write a person starts carries one `Idempotency-Key`, and the same key when the
 * same action is sent again; a read carries none; and the command menu runs a control
 * through the versioned API's one action, while a row it cannot run is refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { api, onUnauthorized } from "../assets/js/api.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { canRunAction, runOmniAction } from "../assets/js/omnibox.js";

type Sent = { url: string; method: string; key: string | undefined };

const realFetch = globalThis.fetch;
let sent: Sent[] = [];
let answers: number[] = [];

beforeEach(() => {
  sent = [];
  answers = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      key: headers["Idempotency-Key"],
    });
    const status = answers.shift() ?? 200;
    return new Response(status === 200 ? "{}" : "", { status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  onUnauthorized(null);
});

describe("legacy writes", () => {
  test("one write sends one key; sent again after a sign-in, the same key", async () => {
    onUnauthorized(async () => true);
    answers = [401, 200];
    await api.grantApproval("hrn_000000000000000a", "appr_00000000000000a1");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.method).toBe("POST");
    expect(typeof sent[0]?.key).toBe("string");
    expect(sent[1]?.key).toBe(sent[0]?.key);
  });

  test("two writes are two actions, with two keys; a read carries none", async () => {
    await api.grantApproval("hrn_000000000000000a", "appr_00000000000000a1");
    await api.denyApproval("hrn_000000000000000a", "appr_00000000000000a2");
    await api.harnesses();
    expect(sent).toHaveLength(3);
    expect(sent[0]?.key).not.toBe(sent[1]?.key);
    expect(sent[2]?.method).toBe("GET");
    expect(sent[2]?.key).toBeUndefined();
  });
});

describe("the command menu's actions", () => {
  test("a control row runs through one createAction, and its answer is the server's sentence", async () => {
    const made: unknown[] = [];
    const done = await runOmniAction(
      {
        kind: "action",
        title: "Pause new work on support",
        route: "controls.pause",
        operation: "controls.pause",
        params: { id: "hrn_000000000000000a" },
      },
      {
        createAction: (id: string, opts: unknown) => {
          made.push({ id, opts });
          return {
            key: "k",
            run: async () => ({
              ok: true,
              status: 200,
              body: { line: "Paused new work; the daemon confirmed" },
            }),
          };
        },
        executors: {},
      },
    );
    expect(made).toEqual([
      { id: "controls.pause", opts: { params: { h: "hrn_000000000000000a" }, body: {} } },
    ]);
    expect(done).toEqual({ ok: true, words: "Paused new work; the daemon confirmed" });
    expect(canRunAction("controls.pause", "controls.pause")).toBe(true);
  });

  test("a row naming neither a known route nor a known operation is refused, with its reason", async () => {
    expect(canRunAction("procExplode", null)).toBe(false);
    expect(canRunAction("whatever", "controls.retire")).toBe(false);
    const done = await runOmniAction(
      {
        title: "x",
        route: "whatever",
        operation: "controls.retire",
        params: { id: "hrn_000000000000000a" },
      },
      {
        createAction: () => {
          throw new Error("not called");
        },
        executors: {},
      },
    );
    expect(done.ok).toBe(false);
    expect(done.words).toContain("cannot run");
  });
});
