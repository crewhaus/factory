import { describe, expect, test } from "bun:test";
import { Semaphore } from "./semaphore";

describe("Semaphore — queueing and introspection", () => {
  test("queues over-capacity acquirers and wakes them FIFO on release", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const r0 = await sem.acquire(); // takes the only slot
    expect(sem.active).toBe(1);
    expect(sem.pending).toBe(0);

    // Two more acquirers must queue.
    const p1 = sem.acquire().then((release) => {
      order.push(1);
      return release;
    });
    const p2 = sem.acquire().then((release) => {
      order.push(2);
      return release;
    });

    // Let the microtask queue settle; both are still waiting.
    await Promise.resolve();
    expect(sem.pending).toBe(2);
    expect(sem.active).toBe(1);

    r0(); // releasing wakes the first waiter (FIFO)
    const r1 = await p1;
    expect(order).toEqual([1]);
    expect(sem.active).toBe(1);
    expect(sem.pending).toBe(1);

    r1(); // wakes the second waiter
    const r2 = await p2;
    expect(order).toEqual([1, 2]);
    expect(sem.pending).toBe(0);

    r2();
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);
  });

  test("release with an empty queue simply frees a slot", async () => {
    const sem = new Semaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    expect(sem.active).toBe(2);
    a();
    expect(sem.active).toBe(1);
    b();
    expect(sem.active).toBe(0);
    // A subsequent acquire takes the fast path (inflight < capacity).
    const c = await sem.acquire();
    expect(sem.active).toBe(1);
    c();
  });
});
