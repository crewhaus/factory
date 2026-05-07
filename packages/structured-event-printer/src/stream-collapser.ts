/**
 * Collapses a burst of `model_stream_token` events into a single rolling
 * line on stderr. The line is rewritten in place via `\r` while tokens are
 * still arriving, then finalized on `model_response` (or any non-streaming
 * event) so subsequent events print on their own line.
 *
 * Designed for `stream.isTTY === true`. When stderr is piped to a file we
 * suppress the rolling line entirely — periodic `\r`-rewrites turn into
 * noise on disk; the JSON Lines mode is the right choice there.
 */
import type { TraceEvent } from "@crewhaus/trace-event-bus";

export type CollapserOptions = {
  /** Where to write rolling-line updates. Defaults to process.stderr. */
  sink?: (chunk: string) => void;
  /** Whether to use carriage returns (TTY) or skip rolling lines (non-TTY). */
  isTty?: boolean;
};

export class StreamCollapser {
  private readonly sink: (chunk: string) => void;
  private readonly isTty: boolean;
  private chunkCount = 0;
  private deltaChars = 0;
  private active = false;

  constructor(opts: CollapserOptions = {}) {
    this.sink =
      opts.sink ??
      ((chunk: string) => {
        process.stderr.write(chunk);
      });
    this.isTty = opts.isTty ?? Boolean(process.stderr.isTTY);
  }

  /**
   * Returns true when the event was absorbed by the collapser (caller should
   * NOT print it normally), false when the caller should continue with its
   * own formatter.
   */
  consume(ev: TraceEvent): boolean {
    if (ev.kind === "model_stream_token") {
      this.chunkCount += 1;
      this.deltaChars += ev.deltaChars;
      this.active = true;
      if (this.isTty) {
        this.sink(`\r[stream] chunks=${this.chunkCount} chars=${this.deltaChars}`);
      }
      return true;
    }
    if (this.active) {
      this.finalize();
    }
    return false;
  }

  finalize(): void {
    if (!this.active) return;
    if (this.isTty) {
      this.sink(`\r[stream] chunks=${this.chunkCount} chars=${this.deltaChars} (done)\n`);
    } else {
      this.sink(`[stream] chunks=${this.chunkCount} chars=${this.deltaChars} (done)\n`);
    }
    this.chunkCount = 0;
    this.deltaChars = 0;
    this.active = false;
  }
}
