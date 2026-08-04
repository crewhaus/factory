# @crewhaus/harness-supervisor

The process layer: how a harness is spawned, watched, restarted, logged, and
adopted. A library — no CLI, no HTTP — driven by the manager server and the
`crewhaus daemon` verbs.

```ts
import {
  buildSpawnPlan,
  createHarnessSupervisor,
  createProcessOps,
  runPreflightGate,
} from "@crewhaus/harness-supervisor";

const supervisor = createHarnessSupervisor({
  harnessDir,
  target: "channel",
  ops: createProcessOps(),
  plan: () => buildSpawnPlan({ harnessDir, target: "channel", processEnv: process.env }),
  gate: (options) => runPreflightGate({ harnessDir, env: spawnEnv, ...options }),
});

await supervisor.adopt();        // re-attach to a daemon a previous manager started
const started = await supervisor.start();
supervisor.subscribe((event) => { /* state | output | exit */ });
await supervisor.stop();         // SIGTERM, then SIGKILL after a 15 s grace
```

## Ops state is harness-local

Everything lives under `<harness>/.crewhaus/run/`, never in a central manager
directory — so `state backup` and `retire` capture run history for free, and a
harness copied to another machine carries its own history with it.

```
.crewhaus/run/
  daemon.json                 runfile: pid + OS start time + argv fingerprint (atomic, 0600)
  daemon.lock                 the start claim, held across preflight (O_EXCL, 0600)
  runs.jsonl                  append-only run ledger (open record + close patch, folded by runId)
  logs/<runId>.log            captured child stdout+stderr
  logs/<runId>.events.jsonl   extracted TraceEvents, already scrubbed
  logs/<runId>.cursor         the pump's byte-exact resume point
  control-token               minted control.v1 bearer, 0600
```

Retention keeps the last 20 runs or 50 MB, configurable per harness in
`.crewhaus/settings.json` under `manager.logRetention`.

## Spawn contracts

| Run class | Shapes | Launch |
|---|---|---|
| `interactive` | cli, browser | `crewhaus run <spec>` when a `crewhaus` bin resolves (harness `node_modules/.bin` first, then PATH), else `bun dist/agent.ts`. Attached, piped stdio, tee'd to the run log. Only this launch can resume a session. |
| `daemon` | channel, managed, crew, voice | `bun dist/daemon.ts`, detached, stdio redirected to the log **file descriptor** (pipes die with the manager). Singleton per harness. |
| `worker` | batch | `bun dist/agent.ts` with daemon-class supervision. |
| `one-shot` | workflow, graph, pipeline, research, eval, onchain, onchain-game | `bun dist/agent.ts`; tracked as a job, never restarted. |
| `mcp-server` | `crewhaus serve --mcp` projections | stdio or HTTP+SSE, port-tracked. |
| `serverless` / `export` | cf-worker / claude-plugin emits | not processes — a deployment record and an inspector target. |

Every spawn: cwd is the **harness root** (never the bundle dir, never a temp
dir), the `.env` chain is merged **under** `process.env`, `CREWHAUS_TRACE=json`
and `CREWHAUS_COST_TRACKING=1` are stamped, the relocation variables
(`CREWHAUS_SESSION_DIR`, `CREWHAUS_DATASETS_DIR`, `CREWHAUS_WATCHME_ROOT`,
`CREWHAUS_SHARED_DIR`) are honoured and reported as overrides, and the
control.v1 token is passed through the ENV — never argv.

## Liveness, adoption, and the pump

A runfile is live only when the pid exists, the OS process start time matches
(within the tolerance a whole-second `ps` forces), and the OS command line
still contains the recorded argv in order. Anything else is stale: the runfile
is cleared, the run is closed in the ledger, and the last log tail is attached.
A runfile restored from a backup fails the start-time check by construction.

`adoptRunning()` returns a pump positioned at the recorded cursor. The cursor
records the byte offset of the last fully consumed text **and** the size of the
events file at that moment, so a manager restart loses nothing (unconsumed
bytes are re-read) and duplicates nothing (events written past the last cursor
write are truncated and re-derived).

The pump runs the same brace-extraction splitter the public `@crewhaus/ui` host
uses — balanced-JSON scanning that never stalls on prose containing braces,
holds back torn lines, and recognises the run-id-less crew kinds — then scrubs
every byte before it leaves the process: values from the harness's own env
become `«NAME»`.

The pump is also where the control plane's port is learned. The plan asks for
`CREWHAUS_CONTROL_PORT=0`, so the daemon's `[control] … listening on
http://host:port` line is the only place the real port exists; the supervisor
parses it out of the captured prose and patches `controlPort` into the runfile.
Recording it here rather than in the console is what lets `crewhaus daemon
wake` / `drain` reach a daemon a shell started, with no console running.

## Exit classification

| Exit | Class | Policy |
|---|---|---|
| 0, or the operator's own SIGTERM | clean | operator stop ⇒ `stopped`; a long-running shape exiting 0 unasked ⇒ "exited cleanly (unexpected)" and the policy decides |
| 20 spec, 21 config, 30 auth, 31 billing, 33 budget | terminal | **never auto-restart** — 33 especially: a restart resets the in-memory budget ledger and re-arms the spend the cap just stopped |
| 36 approval_pending | parked | not a failure — the run is waiting on a human |
| everything else | crash | backoff 500 ms → 30 s, max 5 restarts per rolling 10-minute window, then `crash-looping` (manual start only) with forensics attached |

## Concurrency

Daemons are singleton per harness, under **two** claims. The runfile cannot be
the whole lock — it records a pid, and there is no pid until the spawn, so the
entire preflight run would sit inside the window. `start()` therefore takes
`daemon.lock` with an `O_EXCL` create before the liveness check, and hands the
claim over to the runfile once that exists; a lock whose holder is gone, whose
pid was recycled, or that is simply older than any start can take is broken and
retaken. Two managers starting the same harness in the same second now produce
one daemon, not two.

`stop()` only signals what it holds. A supervisor that never adopted the
running daemon (the other head started it) answers
`{ stopped: false, reason: "not-adopted" }` rather than deleting a live
daemon's lock and reporting success — call `adoptIfRunfile()` first, which
`restart()` does for you.

One **mutating**
job per harness — eval, optimize, flywheel, dream, compile, and one-shot runs
queue; read-only jobs (`doctor`, `audit verify`, `security digest`) bypass. The
global queue runs 3 at a time and persists its pending entries, so queued work
survives a manager restart; work that was *running* when the manager died is
recorded `interrupted` and never silently re-run.

## Testing

Every seam is injectable — `ProcessOps`, `Clock`, the plan builder, the gate,
the scrubber, the id minter — and `./testkit` ships a controllable clock and a
fake `ProcessOps` so the manager server and the CLI can test their own
supervision wiring without spawning anything. The only real spawns in this
package's own suite are four tiny fixture scripts under `fixtures/`, each with
an explicit timeout, covering the things a fake cannot prove: signals, OS start
times, and fd-redirected stdout.
