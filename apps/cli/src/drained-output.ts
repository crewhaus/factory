/**
 * 0.8.0 (design/0.8.0-provability-release.md §11, review I11) — output streams
 * whose writes a command awaits before it exits.
 *
 * Bun drops whatever a pipe has not yet taken when the process exits. A verb
 * that writes its result with `process.stdout.write` and then calls
 * `process.exit` hands a pipe — `| jq`, a CI log — the first 64 KiB and no
 * more: `provability check --json` stops being JSON and the long-form report
 * loses its claims and footer, while a file redirect gets every byte. §11's
 * `--json` exists "so a generated report can be gated in CI", which is a pipe.
 *
 * The hard exit itself stays where a verb needs it (a probed sandbox or an
 * imported tool package must not hold the process open past its answer); it
 * just waits for the writes first. Each write's OWN callback is awaited: an
 * empty write's callback can fire before an earlier, larger write has
 * drained, so it proves nothing. A reader that goes away (`| head`) fails the
 * remaining writes with EPIPE, and their callbacks still fire — the wait
 * ends, it does not hang.
 *
 * Side-effect-free (the entry file runs an argv switch on import), so the
 * subprocess test drives it directly.
 */

/** The one method a stream needs here: `write` with a completion callback. */
export type WritableLike = {
  write(chunk: string, callback: (err?: Error | null) => void): unknown;
};

export type DrainedOutput = {
  /** stdout: written now, awaited by {@link DrainedOutput.drained}. */
  readonly out: (text: string) => void;
  /** stderr: the same. */
  readonly err: (text: string) => void;
  /** Resolves once every write so far has been taken by its stream (or failed). */
  readonly drained: () => Promise<void>;
};

export function drainedOutput(
  stdout: WritableLike = process.stdout,
  stderr: WritableLike = process.stderr,
): DrainedOutput {
  const pending: Promise<void>[] = [];
  const writer =
    (stream: WritableLike) =>
    (text: string): void => {
      pending.push(
        new Promise<void>((done) => {
          stream.write(text, () => done());
        }),
      );
    };
  return {
    out: writer(stdout),
    err: writer(stderr),
    drained: async () => {
      await Promise.all(pending);
    },
  };
}
