/**
 * The background-process registry: the processes THIS harness started, and
 * nothing else. No tool here can see or touch a process the harness did not
 * start, which is what keeps `ProcessList` a description of the harness's
 * own work rather than a view of the machine.
 *
 * Ids are a plain counter (`proc_1`, `proc_2`, ...) rather than random hex:
 * the same sequence of calls produces the same ids, so a transcript replays
 * identically and a test can assert on them.
 *
 * Reap policy. An exited process is KEPT, so its final output can still be
 * read after it is gone — the common case of "it died, what did it say?".
 * Entries leave the registry in exactly three ways: the caller reaps one
 * with `ProcessStop({ reap: true })`, a new start evicts the oldest
 * finished entries once the table is full, or the host process exits (at
 * which point any survivor is SIGKILLed so a session never leaks children).
 */

/** Per-stream retained output for one background process. */
const MAX_STREAM_CHARS = 256_000;
/** How many entries the table holds before evicting finished ones. */
export const MAX_RETAINED_PROCS = 64;

export type BgStatus = "running" | "exited" | "killed";

export type BgProc = {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly label: string | undefined;
  readonly proc: ReturnType<typeof Bun.spawn>;
  stdout: string;
  stderr: string;
  /** Characters already handed back by a previous ProcessOutput poll. */
  stdoutReturned: number;
  stderrReturned: number;
  status: BgStatus;
  exitCode: number | null;
  readonly startedAt: number;
  exitedAt: number | null;
  truncated: boolean;
};

const procs = new Map<string, BgProc>();
let nextId = 1;
let cleanupInstalled = false;

function ensureCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  // Synchronous, and therefore safe in an exit handler: never leave a live
  // child behind when the session ends.
  process.on("exit", () => {
    for (const bg of procs.values()) {
      if (bg.status === "running") {
        try {
          bg.proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
}

function append(bg: BgProc, stream: "stdout" | "stderr", chunk: string): void {
  const next = bg[stream] + chunk;
  if (next.length <= MAX_STREAM_CHARS) {
    bg[stream] = next;
    return;
  }
  // Keep the tail: for a long-running process the recent output is the
  // interesting one, and the cursor moves with the window so a poll never
  // re-reads text it already returned.
  const drop = next.length - MAX_STREAM_CHARS;
  bg[stream] = next.slice(drop);
  const cursor = stream === "stdout" ? "stdoutReturned" : "stderrReturned";
  bg[cursor] = Math.max(0, bg[cursor] - drop);
  bg.truncated = true;
}

async function pump(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk: (text: string) => void,
): Promise<void> {
  if (stream === null || stream === undefined) return;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) onChunk(decoder.decode(chunk, { stream: true }));
    const tail = decoder.decode();
    if (tail.length > 0) onChunk(tail);
  } catch {
    // Stream torn down because the process was killed — stop draining.
  }
}

/** Evict finished entries, oldest first, until the table has room. */
function evictFinished(): number {
  let evicted = 0;
  while (procs.size >= MAX_RETAINED_PROCS) {
    const victim = [...procs.values()].find((p) => p.status !== "running");
    if (victim === undefined) break; // every entry is live: keep them all.
    procs.delete(victim.id);
    evicted++;
  }
  return evicted;
}

export type StartResult =
  | { readonly ok: true; readonly proc: BgProc; readonly evicted: number }
  | { readonly ok: false; readonly message: string };

export function startBackground(
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly stdin?: string;
    readonly label?: string;
  },
): StartResult {
  ensureCleanup();
  const evicted = evictFinished();
  if (procs.size >= MAX_RETAINED_PROCS) {
    return {
      ok: false,
      message: `the background table is full (${MAX_RETAINED_PROCS} live processes) — stop one first`,
    };
  }
  const id = `proc_${nextId++}`;
  let spawned: ReturnType<typeof Bun.spawn>;
  try {
    spawned = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const bg: BgProc = {
    id,
    argv: [...argv],
    cwd: options.cwd,
    label: options.label,
    proc: spawned,
    stdout: "",
    stderr: "",
    stdoutReturned: 0,
    stderrReturned: 0,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    exitedAt: null,
    truncated: false,
  };
  procs.set(id, bg);
  // Fire and forget: the tool returns while the process keeps running.
  void pump(spawned.stdout as ReadableStream<Uint8Array>, (t) => append(bg, "stdout", t));
  void pump(spawned.stderr as ReadableStream<Uint8Array>, (t) => append(bg, "stderr", t));
  void spawned.exited.then((code) => {
    if (bg.status === "running") bg.status = "exited";
    bg.exitCode = code;
    bg.exitedAt = Date.now();
  });
  return { ok: true, proc: bg, evicted };
}

export function getProc(id: string): BgProc | undefined {
  return procs.get(id);
}

/** Every entry, in start order — a stable order, unlike Map iteration on
 *  a table that has had entries evicted. */
export function listProcs(): BgProc[] {
  return [...procs.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

function idNumber(id: string): number {
  const n = Number.parseInt(id.slice("proc_".length), 10);
  return Number.isNaN(n) ? 0 : n;
}

export function reapProc(id: string): boolean {
  return procs.delete(id);
}

export function markKilled(bg: BgProc): void {
  if (bg.status === "running") {
    bg.status = "killed";
    bg.exitedAt = Date.now();
  }
}

/** Test-only: kill every live process and empty the table, including the id
 *  counter, so each test file starts from the same state. */
export function __resetRegistryForTest(): void {
  for (const bg of procs.values()) {
    if (bg.status === "running") {
      try {
        bg.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  procs.clear();
  nextId = 1;
}
