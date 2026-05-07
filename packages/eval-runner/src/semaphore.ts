/**
 * Trivial async semaphore — no `p-limit` dep. Acquire returns a release fn;
 * callers MUST call it (use try/finally). When the semaphore would otherwise
 * be over-capacity, acquirers queue FIFO.
 */
export class Semaphore {
  private inflight = 0;
  private readonly waitQueue: Array<() => void> = [];
  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error(`Semaphore capacity must be ≥ 1 (got ${capacity})`);
  }
  async acquire(): Promise<() => void> {
    if (this.inflight < this.capacity) {
      this.inflight += 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waitQueue.push(() => {
        this.inflight += 1;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.inflight -= 1;
    const next = this.waitQueue.shift();
    if (next) next();
  }
  get pending(): number {
    return this.waitQueue.length;
  }
  get active(): number {
    return this.inflight;
  }
}
