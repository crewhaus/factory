/**
 * Test-only: a scripted `SandboxLike` that records every exec and answers
 * from a queue (or a function). Excluded from the build by name
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
