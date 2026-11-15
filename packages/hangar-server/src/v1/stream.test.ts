/**
 * The v1 event-stream writer, on its own, under fake timers: what each frame carries, the
 * masker on every frame, caps that pause (never end) and resume with the next frame once,
 * the auth frames an abort closes with, the people exit, and one `dispose` for every way
 * a stream ends.
 */
import { describe, expect, test } from "bun:test";
import { type EventEnvelope, encodeCursor } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import type { RequestAccess } from "../access";
import { type StreamBatch, type StreamFrame, peopleExitFrame, v1EventStream } from "./stream";

const AT = "2026-11-14T00:00:00.000Z";
const SECRET = ["hunter2", "plant", "edvalue", "9f3k"].join("-");

type Timer = { at: number; fn: () => void; cancelled: boolean };

/** Timers and a clock that move only when the test says so. */
function fakeClock() {
  let now = Date.parse(AT);
  const queue: Timer[] = [];
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    now: () => now,
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const timer = { at: now + ms, fn, cancelled: false };
        queue.push(timer);
        return timer;
      },
      clearTimeout: (handle: unknown) => {
        (handle as Timer).cancelled = true;
      },
    },
    armed: () => queue.filter((t) => !t.cancelled).length,
    /** Fire every timer due within `ms`, in order, settling the reads between. */
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        await settle();
        const due = queue.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        now = due.at;
        due.fn();
      }
      now = end;
      await settle();
    },
  };
}

const idOf = (seq: number) => encodeCursor({ v: 1, kind: "fleet", epoch: 1, seq });

function frameAt(seq: number, more: Partial<EventEnvelope> = {}): StreamFrame {
  const id = idOf(seq);
  return {
    id,
    event: "run.started",
    data: {
      v: 1,
      id,
      type: "run.started",
      at: AT,
      ingestedAt: AT,
      sensitivity: "internal",
      payload: { state: "running" },
      ...more,
    } as EventEnvelope,
  };
}

const ACCESS: RequestAccess = {
  caller: { principal: "prn_x", actor: null, via: "session" } as never,
  authorize: () => ({ allow: true, grant: "x" }) as never,
  canRead: () => true,
  canReadContent: () => true,
  peopleAllowed: () => false,
};

/** A source of `count` frames, `per` a batch, from just past `after`. */
function source(count: number, per: number, after = 0) {
  let at = after;
  return (): StreamBatch => {
    const frames: StreamFrame[] = [];
    while (frames.length < per && at < count) frames.push(frameAt(++at));
    return { frames, next: idOf(at), more: at < count, done: at >= count };
  };
}

type Parsed = { id?: string; event?: string; data?: Record<string, unknown>; comment?: string };

function parse(text: string): Parsed[] {
  return text
    .split("\n\n")
    .filter((block) => block !== "")
    .map((block) => {
      const out: Parsed = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(": ")) out.comment = line.slice(2);
        else if (line.startsWith("id: ")) out.id = line.slice(4);
        else if (line.startsWith("event: ")) out.event = line.slice(7);
        else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6));
      }
      return out;
    });
}

/** Read a response body as it arrives. */
function collect(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let done = false;
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return;
      }
      text += decoder.decode(chunk.value);
    }
  })();
  return {
    frames: () => parse(text).filter((f) => f.event !== undefined),
    comments: () => parse(text).flatMap((f) => (f.comment !== undefined ? [f.comment] : [])),
    done: () => done,
    cancel: () => reader.cancel(),
  };
}

function open(
  read: (access: RequestAccess) => StreamBatch,
  more: {
    signal?: AbortSignal;
    maxFrames?: number;
    maxMs?: number;
    start?: string;
    recheck?: () => "auth.revoked" | "auth.expired" | undefined;
  } = {},
) {
  const clock = fakeClock();
  let disposed = 0;
  const res = v1EventStream({
    start: more.start ?? idOf(0),
    read,
    signal: more.signal,
    dispose: () => {
      disposed += 1;
    },
    scrub: (text) => text.replaceAll(SECRET, "[env]"),
    accessNow: () => ACCESS,
    timers: clock.timers,
    now: clock.now,
    heartbeatMs: 1000,
    pollMs: 100,
    ...(more.maxFrames !== undefined ? { maxFrames: more.maxFrames } : {}),
    ...(more.maxMs !== undefined ? { maxMs: more.maxMs } : {}),
    ...(more.recheck !== undefined ? { recheck: more.recheck } : {}),
  });
  return { res, clock, body: collect(res), disposed: () => disposed };
}

describe("the frames", () => {
  test("each is id, event and data; data is masked; the body opens with a comment, and pings", async () => {
    let sent = false;
    const s = open(() => {
      if (sent) return { frames: [], next: idOf(1) };
      sent = true;
      return {
        frames: [frameAt(1, { payload: { state: "running", note: SECRET } })],
        next: idOf(1),
      };
    });
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    await s.clock.advance(0);
    expect(s.body.comments()[0]).toBe("open");
    const [frame] = s.body.frames();
    expect(frame?.id).toBe(idOf(1));
    expect(frame?.event).toBe("run.started");
    expect(frame?.data?.["id"]).toBe(idOf(1));
    expect(JSON.stringify(frame?.data)).not.toContain(SECRET);
    expect((frame?.data?.["payload"] as Record<string, unknown>)["note"]).toBe("[env]");
    expect(SCHEMAS.eventFrame.safeParse({ ...frame }).success).toBe(true);
    await s.clock.advance(2500);
    expect(s.body.comments().filter((c) => c === "ping")).toHaveLength(2);
    await s.body.cancel();
  });

  test("a people frame the caller may not see is the withheld gap, with its own cursor and the writer's clock", () => {
    const people = frameAt(4, {
      sensitivity: "people",
      at: "2020-01-01T00:00:00.000Z",
      harness: "hrn_0123456789abcdef",
    });
    const out = peopleExitFrame(people, ACCESS, AT);
    expect(out).toEqual({
      id: idOf(4),
      event: "stream.gap",
      data: {
        v: 1,
        id: idOf(4),
        type: "stream.gap",
        at: AT,
        ingestedAt: AT,
        sensitivity: "internal",
        payload: { reason: "withheld", hidden: ["people"] },
      },
    });
    // A caller the people domain releases it to gets it whole.
    expect(peopleExitFrame(people, { ...ACCESS, peopleAllowed: () => true }, AT)).toBe(people);
    // A people item inside a payload's list is withheld, and the frame says so.
    const listed = frameAt(5, {
      payload: { items: [{ sensitivity: "people", ref: "home/person/psn_x" }, { k: 1 }] },
    });
    const exited = peopleExitFrame(listed, ACCESS, AT);
    expect(exited.data["payload"]).toEqual({ items: [{ k: 1 }] });
    expect((exited.data as unknown as Record<string, unknown>)["hidden"]).toEqual(["people"]);
    const plain = frameAt(6);
    expect(peopleExitFrame(plain, ACCESS, AT)).toBe(plain);
  });
});

describe("caps pause, and never end the stream", () => {
  test("the frame cap ends with stream.pause, and resuming from it gives the next frame once", async () => {
    const s = open(source(10, 4), { maxFrames: 3 });
    await s.clock.advance(0);
    const frames = s.body.frames();
    expect(frames.map((f) => f.event)).toEqual([
      "run.started",
      "run.started",
      "run.started",
      "stream.pause",
    ]);
    const pause = frames[3]?.data as Record<string, unknown>;
    expect(pause["payload"]).toEqual({ reason: "frame-cap", resumeFrom: idOf(3) });
    expect(frames[3]?.id).toBe(idOf(3));
    expect(s.body.done()).toBe(true);
    expect(s.disposed()).toBe(1);
    // The reconnect, from `resumeFrom`.
    const again = open(source(10, 4, 3), { maxFrames: 2, start: idOf(3) });
    await again.clock.advance(0);
    expect(
      again.body
        .frames()
        .slice(0, 2)
        .map((f) => f.id),
    ).toEqual([idOf(4), idOf(5)]);
  });

  test("a cap at the end of a batch resumes past the lines it read without a frame", async () => {
    const s = open(() => ({ frames: [frameAt(1)], next: idOf(7) }), { maxFrames: 1 });
    await s.clock.advance(0);
    const pause = s.body.frames()[1]?.data as Record<string, unknown>;
    expect(pause["payload"]).toEqual({ reason: "frame-cap", resumeFrom: idOf(7) });
  });

  test("the time cap ends with stream.pause, by the injected clock", async () => {
    const s = open(() => ({ frames: [], next: idOf(2) }), { maxMs: 60_000 });
    await s.clock.advance(59_000);
    expect(s.body.done()).toBe(false);
    await s.clock.advance(1_000);
    const last = s.body.frames().at(-1);
    expect(last?.event).toBe("stream.pause");
    expect((last?.data as Record<string, unknown>)["payload"]).toEqual({
      reason: "time-cap",
      resumeFrom: idOf(2),
    });
    expect(s.disposed()).toBe(1);
    expect(s.clock.armed()).toBe(0);
  });
});

describe("how a stream ends", () => {
  test("an abort for an ended session, a revoked one and a refused re-check closes with its auth frame", async () => {
    for (const [reason, event] of [
      ["auth.expired", "auth.expired"],
      ["auth.revoked", "auth.revoked"],
      ["revoked", "auth.revoked"],
    ] as const) {
      const abort = new AbortController();
      const s = open(() => ({ frames: [], next: idOf(0) }), { signal: abort.signal });
      await s.clock.advance(0);
      abort.abort(reason);
      await s.clock.advance(0);
      expect([reason, s.body.frames().map((f) => f.event)]).toEqual([reason, [event]]);
      expect(s.body.done()).toBe(true);
      expect(s.disposed()).toBe(1);
    }
  });

  test("a re-check that refuses before a batch closes with its auth frame, and that batch is never read", async () => {
    for (const refusal of ["auth.revoked", "auth.expired"] as const) {
      let reads = 0;
      let checks = 0;
      const s = open(
        () => {
          reads += 1;
          return { frames: [frameAt(reads)], next: idOf(reads) };
        },
        {
          recheck: () => {
            checks += 1;
            return checks >= 2 ? refusal : undefined;
          },
        },
      );
      await s.clock.advance(1000);
      expect([refusal, reads, checks]).toEqual([refusal, 1, 2]);
      expect(s.body.frames().map((f) => f.event)).toEqual(["run.started", refusal]);
      expect(s.body.done()).toBe(true);
      expect(s.disposed()).toBe(1);
    }
  });

  test("dispose is called exactly once for each of: end, cap, abort, client cancel, a throwing read", async () => {
    const counts: Record<string, number> = {};
    // The run's end.
    const end = open(source(2, 5));
    await end.clock.advance(1000);
    counts["end"] = end.disposed();
    // A cap.
    const cap = open(source(9, 5), { maxFrames: 1 });
    await cap.clock.advance(1000);
    counts["cap"] = cap.disposed();
    // An abort that names no auth frame: the client's own request going away.
    const abort = new AbortController();
    const aborted = open(() => ({ frames: [], next: idOf(0) }), { signal: abort.signal });
    await aborted.clock.advance(0);
    abort.abort();
    await aborted.clock.advance(1000);
    counts["abort"] = aborted.disposed();
    // The client cancels.
    const cancelled = open(() => ({ frames: [], next: idOf(0) }));
    await cancelled.clock.advance(0);
    await cancelled.body.cancel();
    await cancelled.clock.advance(1000);
    counts["cancel"] = cancelled.disposed();
    expect(cancelled.clock.armed()).toBe(0);
    // A read that throws.
    const thrown = open(() => {
      throw new Error("disk gone");
    });
    await thrown.clock.advance(1000);
    counts["throw"] = thrown.disposed();
    expect(thrown.body.done()).toBe(true);
    expect(counts).toEqual({ end: 1, cap: 1, abort: 1, cancel: 1, throw: 1 });
  });

  test("a stream with nothing new reads again after its poll, and at once when a batch says more", async () => {
    let reads = 0;
    const s = open(() => {
      reads += 1;
      return { frames: [], next: idOf(0), more: reads === 1 };
    });
    await s.clock.advance(0);
    expect(reads).toBe(2);
    await s.clock.advance(99);
    expect(reads).toBe(2);
    await s.clock.advance(1);
    expect(reads).toBe(3);
    await s.body.cancel();
  });
});
