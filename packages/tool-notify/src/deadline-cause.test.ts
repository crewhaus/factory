/**
 * A deadline is reported when the deadline's timer caused the failure, and
 * only then. `describeFailure` used to ask the clock, so any error that
 * settled after the deadline's time — but before its timer callback ran, as
 * on a starved event loop — was reported as "deadline elapsed" and the real
 * cause was lost. None of these race a timer against real I/O: a synchronous
 * spin holds the timer back, and a real timeout is awaited on its event.
 */
import { expect, test } from "bun:test";
import {
  DeadlineElapsedError,
  _setDnsTxtResolver,
  describeFailure,
  lookupTxt,
  startDeadline,
} from "./net";

/** Hold the event loop, so a timer due meanwhile cannot run. */
function busy(ms: number): void {
  const started = performance.now();
  while (performance.now() - started < ms) {
    // spin
  }
}

const aborted = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

test("a transport error that arrives after the deadline's time is reported as itself", () => {
  const deadline = startDeadline(5);
  busy(25);
  // The clock says the time is up; the timer has not run.
  expect({ expired: deadline.expired(), timedOut: deadline.timedOut() }).toEqual({
    expired: true,
    timedOut: false,
  });
  expect(describeFailure(new TypeError("fetch failed: ECONNRESET"), deadline)).toBe(
    "TypeError: fetch failed: ECONNRESET (the deadline had also elapsed)",
  );
  deadline.cancel();
});

test("the deadline's own timer is reported as a deadline, as its reason or as an abort", async () => {
  const deadline = startDeadline(1);
  await aborted(deadline.signal);
  expect(deadline.timedOut()).toBe(true);
  expect(deadline.signal.reason).toBeInstanceOf(DeadlineElapsedError);
  const bodyAbort = new Error("the read was aborted before the body ended");
  bodyAbort.name = "AbortError";
  expect([
    describeFailure(deadline.signal.reason, deadline),
    describeFailure(bodyAbort, deadline),
  ]).toEqual([
    "deadline elapsed before the send completed",
    "deadline elapsed before the send completed",
  ]);
  deadline.cancel();
});

test("an outer deadline forwarded into an inner one is still a deadline", async () => {
  const overall = startDeadline(1);
  const inner = startDeadline(60_000, overall.signal);
  await aborted(inner.signal);
  expect(inner.timedOut()).toBe(true);
  expect(describeFailure(inner.signal.reason, inner)).toBe(
    "deadline elapsed before the send completed",
  );
  inner.cancel();
  overall.cancel();
});

test("a runtime cancel is an abort, not a deadline, whatever its reason looks like", () => {
  const seen: string[] = [];
  for (const reason of [undefined, { crewhausTimeout: "turn", limitMs: 1 }]) {
    const outer = new AbortController();
    const deadline = startDeadline(60_000, outer.signal);
    outer.abort(reason);
    expect(deadline.timedOut()).toBe(false);
    seen.push(describeFailure(deadline.signal.reason, deadline));
    deadline.cancel();
  }
  // The object reason used to print as "[object Object]".
  expect(seen).toEqual([
    "the send was aborted before it completed",
    "the send was aborted before it completed",
  ]);
});

test("a DNS answer that arrives late is still the answer, and only the timer is a deadline", async () => {
  try {
    _setDnsTxtResolver(() => {
      busy(25);
      const err = new Error("queryTxt ENOTFOUND gone.example") as Error & { code?: string };
      err.code = "ENOTFOUND";
      return Promise.reject(err);
    });
    const late = startDeadline(5);
    // 0.7.0 answered "unknown: hit the deadline" here, off the clock alone.
    expect(await lookupTxt("gone.example", late)).toEqual({ outcome: "nxdomain" });
    late.cancel();

    _setDnsTxtResolver(() => new Promise<never>(() => undefined));
    const hung = startDeadline(5);
    expect(await lookupTxt("hangs.example", hung)).toEqual({
      outcome: "unknown",
      reason: 'the lookup of "hangs.example" hit the deadline',
    });
    hung.cancel();
  } finally {
    _setDnsTxtResolver(undefined);
  }
});
