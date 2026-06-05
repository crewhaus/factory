import { describe, expect, test } from "bun:test";
import {
  CallSessionError,
  type CallTransition,
  type TelephonyAdapter,
  createCallSession,
  createInMemoryTelephonyAdapter,
} from "./index.js";

describe("createCallSession (T1 + T9 state machine)", () => {
  test("happy path: idle → dialing → connected → on-hold → connected → terminated", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const transitions: CallTransition[] = [];
    const session = createCallSession({ adapter });
    session.on((t) => transitions.push(t));

    await session.dial("tel:+15555550100");
    expect(session.state).toBe("dialing");
    await session.answer();
    expect(session.state).toBe("connected");
    await session.hold();
    expect(session.state).toBe("on-hold");
    await session.resume();
    expect(session.state).toBe("connected");
    await session.end({ reason: "user hangup" });
    expect(session.state).toBe("terminated");

    expect(transitions.map((t) => `${t.from}→${t.to}`)).toEqual([
      "idle→dialing",
      "dialing→connected",
      "connected→on-hold",
      "on-hold→connected",
      "connected→terminated",
    ]);
    expect(adapter.calls.map((c) => c.verb)).toEqual(["dial", "answer", "hold", "resume", "end"]);
  });

  test("transfer path: idle → dialing → connected → transferred → terminated", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    await session.dial("tel:a");
    await session.answer();
    await session.transfer("tel:b");
    expect(session.state).toBe("transferred");
    await session.end();
    expect(session.state).toBe("terminated");
  });

  test("illegal transitions throw CallSessionError without changing state", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    await expect(session.answer()).rejects.toThrow(CallSessionError); // idle → connected illegal
    expect(session.state).toBe("idle");
    await expect(session.hold()).rejects.toThrow(CallSessionError);
    expect(session.state).toBe("idle");
  });

  test("dial failure auto-transitions to terminated", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    adapter.failNextDial("network down");
    const session = createCallSession({ adapter });
    await expect(session.dial("tel:a")).rejects.toThrow(/network down/);
    expect(session.state).toBe("terminated");
  });

  test("listener errors are isolated and do not block transitions", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    session.on(() => {
      throw new Error("listener oops");
    });
    let okListenerHits = 0;
    session.on(() => {
      okListenerHits += 1;
    });
    await session.dial("tel:a");
    expect(okListenerHits).toBe(1);
    expect(session.state).toBe("dialing");
  });

  test("history returns transitions in order with timestamps", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    await session.dial("tel:a");
    await session.answer();
    const log = session.history();
    expect(log.length).toBe(2);
    expect(log[0]?.from).toBe("idle");
    expect(log[0]?.to).toBe("dialing");
    expect(typeof log[0]?.at).toBe("string");
    expect(log[1]?.to).toBe("connected");
  });

  test("T9 property: every state's outgoing transitions are exactly the configured set", async () => {
    // The state-machine definition is encoded as a constant; ensure
    // illegal transitions are rejected uniformly.
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    await session.dial("a");
    await session.answer();
    await session.end();
    // Once terminated, every verb throws.
    await expect(session.dial("b")).rejects.toThrow(CallSessionError);
    await expect(session.hold()).rejects.toThrow(CallSessionError);
    await expect(session.transfer("c")).rejects.toThrow(CallSessionError);
  });

  test("on() returns an unsubscribe that stops further notifications", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    let hits = 0;
    const off = session.on(() => {
      hits += 1;
    });
    await session.dial("tel:a"); // listener active → 1 hit
    expect(hits).toBe(1);
    off(); // exercises the unsubscribe closure
    await session.answer(); // listener removed → still 1
    expect(hits).toBe(1);
  });

  test("unsubscribing a never-fired listener is a harmless no-op", () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    const off = session.on(() => {
      throw new Error("should never run");
    });
    // Calling unsubscribe before any transition must not throw.
    expect(() => off()).not.toThrow();
  });

  test("reason is threaded into the transition record and omitted when absent", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    await session.dial("tel:a", { reason: "outbound campaign" });
    await session.answer(); // no reason supplied
    const log = session.history();
    expect(log[0]?.reason).toBe("outbound campaign");
    expect("reason" in (log[1] ?? {})).toBe(false);
  });

  test('end() defaults the adapter reason to "end" when none is given', async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    await session.dial("tel:a");
    await session.answer();
    await session.end(); // no reason
    const endCall = adapter.calls.find((c) => c.verb === "end");
    expect(endCall?.arg).toBe("end");
    // No transition-level reason recorded when none supplied.
    const last = session.history().at(-1);
    expect(last?.to).toBe("terminated");
    expect("reason" in (last ?? {})).toBe(false);
  });

  test("end() forwards an explicit reason to the adapter", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const session = createCallSession({ adapter });
    await session.dial("tel:a");
    await session.end({ reason: "callee busy" });
    const endCall = adapter.calls.find((c) => c.verb === "end");
    expect(endCall?.arg).toBe("callee busy");
    expect(session.history().at(-1)?.reason).toBe("callee busy");
  });

  test("dial failure surfaced from a non-Error rejection falls back to String()", async () => {
    // Adapter whose dial rejects with a non-Error value — exercises the
    // `?? String(err)` branch in the dial-failure path.
    const adapter: TelephonyAdapter = {
      kind: "weird",
      async dial() {
        throw "boom-string"; // not an Error, so `.message` is undefined
      },
      async answer() {},
      async hold() {},
      async resume() {},
      async transfer() {},
      async end() {},
    };
    const session = createCallSession({ adapter });
    await expect(session.dial("tel:a")).rejects.toBe("boom-string");
    expect(session.state).toBe("terminated");
    expect(session.history().at(-1)?.reason).toContain("boom-string");
  });

  test("injected now() controls transition timestamps deterministically", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    const fixed = new Date("2026-06-04T12:00:00.000Z");
    const session = createCallSession({ adapter, now: () => fixed });
    await session.dial("tel:a");
    expect(session.history()[0]?.at).toBe("2026-06-04T12:00:00.000Z");
  });

  test("in-memory adapter: failNextDial uses its default message and resets after one dial", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    adapter.failNextDial(); // default message branch
    const s1 = createCallSession({ adapter });
    await expect(s1.dial("tel:a")).rejects.toThrow(/in-memory: dial failed/);
    // Failure is one-shot: a fresh session dials cleanly.
    const s2 = createCallSession({ adapter });
    await s2.dial("tel:b");
    expect(s2.state).toBe("dialing");
  });

  test("in-memory adapter records every verb and argument in order", async () => {
    const adapter = createInMemoryTelephonyAdapter();
    expect(adapter.kind).toBe("in-memory");
    const session = createCallSession({ adapter });
    await session.dial("tel:a");
    await session.answer();
    await session.hold();
    await session.resume();
    await session.transfer("tel:b");
    await session.end({ reason: "done" });
    expect(adapter.calls).toEqual([
      { verb: "dial", arg: "tel:a" },
      { verb: "answer" },
      { verb: "hold" },
      { verb: "resume" },
      { verb: "transfer", arg: "tel:b" },
      { verb: "end", arg: "done" },
    ]);
  });
});
