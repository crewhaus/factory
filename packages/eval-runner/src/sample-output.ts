/**
 * Item 20 — per-sample stdout for CONCURRENT eval runs.
 *
 * `runEval` fans out `concurrency` samples (default 4) at once, and every one
 * of them drives the same `runChatLoop`, which streams the model's token
 * deltas straight to `process.stdout`. Unprefixed and unbuffered, N runs
 * writing to one file descriptor splice mid-word:
 *
 *   agent> TheThe capital of Brazil is **Brasília**. capital of Japan is …
 *
 * — three samples in one sentence, unreadable on camera and in CI logs.
 *
 * The fix is a per-sample sink (threaded into `runChatLoop` through its
 * `stdout` seam): output accumulates until a newline, then leaves as ONE
 * whole line tagged with the sample it came from:
 *
 *   [q1] agent> The capital of Brazil is **Brasília**.
 *   [q2] agent> The capital of Japan is **Tokyo** (東京).
 *
 * Lines can still arrive in any order — they are genuinely concurrent — but
 * no line is ever spliced and every line says whose it is. Whitespace-only
 * lines are dropped rather than emitted as a bare tag: paragraph breaks carry
 * no information once each line is labelled, and a fan-out log is read by
 * scanning tags down the left margin.
 *
 * Sequential runs (`concurrency: 1`) never get a writer at all — there is
 * nothing to disambiguate, and their output stays byte-identical to a plain
 * `crewhaus run`.
 */

export type SampleOutputWriter = {
  /** Feed a chunk of the sample's output. Whole lines flush immediately. */
  write(chunk: string): void;
  /** Flush a trailing partial line (a sample that ended mid-line). */
  end(): void;
};

export type SampleOutputWriterOptions = {
  /** Tag prefixed to every emitted line — the sample id. */
  readonly label: string;
  /** Line sink; defaults to stdout. Receives whole lines, newline included. */
  readonly write?: (line: string) => void;
};

/**
 * Line-buffering, label-prefixing writer. One per concurrent sample; call
 * {@link SampleOutputWriter.end} when the sample finishes so a run that ended
 * mid-line still surfaces its tail.
 */
export function createSampleOutputWriter(opts: SampleOutputWriterOptions): SampleOutputWriter {
  const sink = opts.write ?? ((line: string) => void process.stdout.write(line));
  const prefix = `[${opts.label}] `;
  let buffer = "";

  const emit = (line: string): void => {
    // A whitespace-only line would render as a bare tag — drop it.
    if (line.trim() === "") return;
    sink(`${prefix}${line}\n`);
  };

  return {
    write(chunk: string): void {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        // Tolerate CRLF so a Windows-authored tool result doesn't leave a
        // stray \r inside the emitted line.
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        emit(line);
        nl = buffer.indexOf("\n");
      }
    },
    end(): void {
      if (buffer === "") return;
      const tail = buffer;
      buffer = "";
      emit(tail);
    },
  };
}
