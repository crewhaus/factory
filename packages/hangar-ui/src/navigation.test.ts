/**
 * The navigator: only the newest navigation finishes. Driven with fake
 * containers and renders that resolve when the test says so, so the order is
 * the test's to choose and nothing waits on a clock.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { createNavigator } from "../assets/js/navigation.js";

type Deferred = { promise: Promise<unknown>; resolve(v?: unknown): void; reject(e: unknown): void };
function deferred(): Deferred {
  let resolve: (v?: unknown) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Container = { route: string; drawn: string[] };

/** A navigator over fake containers, recording everything it is asked to do. */
function harness() {
  const renders = new Map<string, Deferred>();
  const log = {
    mounted: [] as Container[],
    after: [] as string[],
    errors: [] as string[],
    stale: [] as string[],
    signals: new Map<string, AbortSignal>(),
  };
  const nav = createNavigator({
    mount: (route: string) => {
      const container = { route, drawn: [] };
      log.mounted.push(container);
      return container;
    },
    render: async (route: string, container: Container, { signal }: { signal: AbortSignal }) => {
      log.signals.set(route, signal);
      const gate = deferred();
      renders.set(route, gate);
      const value = await gate.promise;
      container.drawn.push(String(value));
      return { harness: route };
    },
    after: (route: string, container: Container, result: { harness: string }) => {
      log.after.push(`${route}:${container.drawn.join(",")}:${result.harness}`);
    },
    isStale: (err: unknown) => err instanceof Error && err.message === "401",
    onStale: (route: string) => {
      log.stale.push(route);
    },
    onError: (err: unknown, container: Container) => {
      log.errors.push(`${container.route}:${(err as Error).message}`);
    },
  });
  const finish = (route: string, value: unknown = "ok") => renders.get(route)?.resolve(value);
  const fail = (route: string, err: Error) => renders.get(route)?.reject(err);
  return { nav, log, finish, fail };
}

describe("createNavigator", () => {
  test("a slow screen the person left never replaces the one they moved to", async () => {
    const { nav, log, finish } = harness();
    const a = nav.navigate("A");
    const b = nav.navigate("B");
    finish("B");
    expect(await b).toBe("done");
    finish("A");
    expect(await a).toBe("superseded");
    // B was mounted after A, its `after` ran once, A's never did.
    expect(log.mounted.map((c) => c.route)).toEqual(["A", "B"]);
    expect(log.after).toEqual(["B:ok:B"]);
    expect(log.signals.get("A")?.aborted).toBe(true);
    expect(log.signals.get("B")?.aborted).toBe(false);
    expect(nav.route()).toBe("B");
  });

  test("the same holds when the slow one finishes first", async () => {
    const { nav, log, finish } = harness();
    const a = nav.navigate("A");
    const b = nav.navigate("B");
    finish("A");
    expect(await a).toBe("superseded");
    expect(log.after).toEqual([]);
    finish("B");
    expect(await b).toBe("done");
    expect(log.after).toEqual(["B:ok:B"]);
  });

  test("an error in a superseded render draws nothing", async () => {
    const { nav, log, fail, finish } = harness();
    const a = nav.navigate("A");
    const b = nav.navigate("B");
    fail("A", new Error("boom"));
    expect(await a).toBe("superseded");
    expect(log.errors).toEqual([]);
    finish("B");
    await b;
    expect(log.errors).toEqual([]);
  });

  test("an error in the current render draws the error, and no `after`", async () => {
    const { nav, log, fail } = harness();
    const a = nav.navigate("A");
    fail("A", new Error("boom"));
    expect(await a).toBe("error");
    expect(log.errors).toEqual(["A:boom"]);
    expect(log.after).toEqual([]);
  });

  test("a 401 leaves the screen stale for the next sign-in, and draws no error", async () => {
    const { nav, log, fail } = harness();
    const a = nav.navigate("A");
    fail("A", new Error("401"));
    expect(await a).toBe("stale");
    expect(log.stale).toEqual(["A"]);
    expect(log.errors).toEqual([]);
  });

  test("a 401 in a superseded render does not mark anything stale", async () => {
    const { nav, log, fail, finish } = harness();
    const a = nav.navigate("A");
    const b = nav.navigate("B");
    fail("A", new Error("401"));
    expect(await a).toBe("superseded");
    expect(log.stale).toEqual([]);
    finish("B");
    await b;
  });

  test("each navigation gets a fresh container and its own signal", async () => {
    const { nav, log, finish } = harness();
    const a = nav.navigate("A");
    finish("A");
    await a;
    const again = nav.navigate("A");
    expect(log.mounted.length).toBe(2);
    expect(log.mounted[0]).not.toBe(log.mounted[1]);
    expect(log.signals.get("A")?.aborted).toBe(false);
    finish("A");
    expect(await again).toBe("done");
    expect(log.after).toEqual(["A:ok:A", "A:ok:A"]);
  });
});
