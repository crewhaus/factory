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
  /**
   * Each pipe has reached its end, so `stdout` (or `stderr`) holds all the
   * process will ever print there. This can lag `status`: the exit and a
   * pipe's last bytes reach the parent as separate events, and a process it
   * started that shares a pipe can keep it open after it is gone.
   */
  stdoutEnded: boolean;
  stderrEnded: boolean;
  /** Both pipes have reached their end. */
  outputEnded: boolean;
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
    stdoutEnded: false,
    stderrEnded: false,
    outputEnded: false,
    exitCode: null,
    startedAt: Date.now(),
    exitedAt: null,
    truncated: false,
  };
  procs.set(id, bg);
  // Fire and forget: the tool returns while the process keeps running.
  void Promise.all([
    pump(spawned.stdout as ReadableStream<Uint8Array>, (t) => append(bg, "stdout", t)).then(() => {
      bg.stdoutEnded = true;
    }),
    pump(spawned.stderr as ReadableStream<Uint8Array>, (t) => append(bg, "stderr", t)).then(() => {
      bg.stderrEnded = true;
    }),
  ]).then(() => {
    bg.outputEnded = true;
  });
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

/** The output a watch reads: one stream, or both. */
export type WatchedStream = "stdout" | "stderr" | "both";

/**
 * Whether a process has finished as far as a watch of `stream` goes: the
 * next look at that output is the last one worth taking.
 *
 * An exited process has finished once the watched pipe has ended too. The
 * exit can reach the parent before the line printed just ahead of it, and a
 * process it started can still hold the pipe and print. Only the watched
 * pipe counts: one that holds just the other pipe cannot print on this one.
 *
 * A stopped one has finished once its own exit has been seen (`exitCode` is
 * set then, to a number even for a death by signal), whatever its pipes are
 * doing. Until then it is still running, whatever ProcessStop asked of it.
 * ProcessStop signals the process alone, so one it started (a script running
 * a server without `exec`) can hold the pipes for as long as it runs, and a
 * wait on them would run to its deadline. The cost is the one 0.7.0 had: a
 * line a stopped process prints as it goes, such as a SIGTERM handler's last
 * words, can reach the parent after its exit and be missed. Stopping the
 * whole process group would let the pipes decide here too.
 */
export function watchFinished(
  bg: Pick<BgProc, "status" | "exitCode" | "stdoutEnded" | "stderrEnded" | "outputEnded">,
  stream: WatchedStream,
): boolean {
  if (bg.status === "running") return false;
  if (bg.status === "killed") return bg.exitCode !== null;
  if (stream === "stdout") return bg.stdoutEnded;
  if (stream === "stderr") return bg.stderrEnded;
  return bg.outputEnded;
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

/**
 * Test-only: {@link __resetRegistryForTest}, then wait (at most `timeoutMs`)
 * until every process it knew of has exited. A test removes its workspace
 * after this, and on Windows a directory that is a live process's cwd cannot
 * be removed (EBUSY), while a kill there returns before the process is gone.
 */
export async function __stopAllForTest(timeoutMs = 5_000): Promise<void> {
  const exits = [...procs.values()].map((bg) => bg.proc.exited);
  __resetRegistryForTest();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(exits),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
