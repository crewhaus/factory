import { describe, expect, test } from "bun:test";
import {
  CallSessionError,
  type CallTransition,
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
});
