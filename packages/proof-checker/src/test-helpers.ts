/**
 * Test-only: a scripted `SandboxLike` that records every exec and answers
 * from a queue (or a function), and a scripted stand-in for the `Worker` the
 * builtin runner starts. Excluded from the build by name
 * (scripts/test-only.ts).
 */
import type { SandboxLike } from "./types";

export type ExecCall = {
  readonly image: string;
  readonly argv: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type FakeReply = {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
  /** Throw this instead of returning. */
  readonly throws?: Error;
};

export type FakeSandbox = SandboxLike & { readonly calls: ExecCall[] };

export function fakeSandbox(
  replies: FakeReply[] | ((call: ExecCall) => FakeReply),
  backend = "docker",
): FakeSandbox {
  const calls: ExecCall[] = [];
  const queue = Array.isArray(replies) ? [...replies] : undefined;
  return {
    backend,
    calls,
    async exec(opts) {
      const call: ExecCall = {
        image: opts.image,
        argv: [...opts.argv],
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      };
      calls.push(call);
      const reply =
        queue !== undefined ? queue.shift() : (replies as (c: ExecCall) => FakeReply)(call);
      if (reply === undefined) throw new Error("fakeSandbox: no scripted reply left");
      if (reply.throws !== undefined) throw reply.throws;
      return {
        exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        ...(reply.timedOut !== undefined ? { timedOut: reply.timedOut } : {}),
      };
    },
  };
}

/** What the builtin runner posts to its worker. */
export type WorkerJob = {
  readonly statement: string;
  readonly proof: string;
  readonly timeoutMs: number;
};

/** How a scripted worker behaves; anything left out is silence. */
export type WorkerScript = {
  /** At start-up: say ready (the default), fail, throw from the constructor, or say nothing. */
  readonly start?: "ready" | "silent" | "throw" | { readonly error: string };
  /** The answer to a job: a message to post, an error event, or nothing at all. */
  readonly reply?: (job: WorkerJob) => { readonly post: unknown } | { readonly error: string };
};

export type ScriptedWorkers = {
  readonly jobs: WorkerJob[];
  /** Workers constructed, and workers terminated, so far. */
  readonly spawned: () => number;
  readonly terminated: () => number;
};

/**
 * Run `body` with the global `Worker` replaced by one that follows `script`,
 * so a test sees what the runner posts and decides what the thread answers,
 * with no real thread's timing in the way. Events are dispatched on a later
 * macrotask, as a real worker's are.
 */
export async function withScriptedWorker<T>(
  script: WorkerScript,
  body: (workers: ScriptedWorkers) => Promise<T>,
): Promise<T> {
  const jobs: WorkerJob[] = [];
  let spawned = 0;
  let terminated = 0;
  const later = (fn: () => void): void => {
    setImmediate(fn);
  };
  class ScriptedWorker extends EventTarget {
    private done = false;
    constructor(_url: string | URL) {
      super();
      if (script.start === "throw") throw new Error("workers are not allowed here");
      spawned += 1;
      const start = script.start ?? "ready";
      if (start === "ready") this.emit(new MessageEvent("message", { data: { kind: "ready" } }));
      else if (typeof start === "object") {
        this.emit(new ErrorEvent("error", { message: start.error }));
      }
    }
    postMessage(job: WorkerJob): void {
      jobs.push(job);
      const reply = script.reply?.(job);
      if (reply === undefined) return;
      this.emit(
        "post" in reply
          ? new MessageEvent("message", { data: reply.post })
          : new ErrorEvent("error", { message: reply.error }),
      );
    }
    terminate(): void {
      if (this.done) return;
      this.done = true;
      terminated += 1;
      later(() => this.dispatchEvent(new Event("close")));
    }
    ref(): void {}
    unref(): void {}
    private emit(event: Event): void {
      later(() => {
        if (!this.done) this.dispatchEvent(event);
      });
    }
  }
  const real = globalThis.Worker;
  globalThis.Worker = ScriptedWorker as unknown as typeof Worker;
  try {
    return await body({ jobs, spawned: () => spawned, terminated: () => terminated });
  } finally {
    globalThis.Worker = real;
  }
}
