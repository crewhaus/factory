# @crewhaus/tool-safety

The guards tool packages import instead of each hand-rolling its own. An audit of the 0.7.0 builtins found the same defects in dozens of packages that share no code: caller-supplied regexes that freeze the process, output capped only after it was buffered, a compressed response inflated to gigabytes, and a FIFO that blocks a read for ever. Each helper here closes one of those, once.

Zero runtime dependencies: Bun and `node:*` only. **Bun only** — it uses Bun Workers and `Bun.spawn`, so it is not for the cf-worker targets.

```ts
import { runRegex, screenUserRegex } from "@crewhaus/tool-safety/regex";
import { spawnBounded, readResponseBounded, withRawBody, readFileBounded } from "@crewhaus/tool-safety/streams";
```

## `./regex`: caller-supplied regular expressions

A regex written by the model, or by an operator, runs on text the model or a remote party controls. A synchronous `RegExp` call can't be interrupted. No timer fires and no abort signal is seen, so every session and heartbeat in the process waits for it to finish.

### Running a pattern: `runRegex` and `openRegexSession`

```ts
const outcome = await runRegex({ op: "testEach", pattern, flags, inputs: lines, deadlineMs: 1000 });
if (outcome.status === "ok") {
  report(outcome.result.matched);                           // definite
} else {
  reportUndetermined(describeRegexOutcome(outcome), outcome); // never "no matches"
}
```

The match runs in a Bun Worker. At the deadline the worker is terminated and the caller gets `timeout`.

| `op` | What it does | `result` |
|---|---|---|
| `test` | Checks whether the pattern matches `input` anywhere | `{ matched }` |
| `matchAll` | Finds every match (`g` implied), up to `maxMatches` | `{ matches, truncated, truncatedBy? }` |
| `replace` | Replaces with a string replacement, supporting `$&` `$1` `$<n>` `` $` `` `$'` `$$` | `{ output, replacements }` |
| `split` | Behaves like `String.prototype.split`, captures included | `{ pieces, truncated, truncatedBy? }` |
| `testEach` | Runs one pattern over many inputs | `{ matched: indexes, scanned, truncated }` |
| `firstMatchingRule` | Runs many patterns over many inputs and finds the first rule that hits each input | `{ ruleIndexes }` (-1 = none) |

`replace`, `split` and `matchAll` give the same answers as the built-in methods; `run.test.ts` compares them across a battery of patterns, inputs and replacement templates. The batch ops (`testEach` and `firstMatchingRule`) exist so a tool that scans many lines pays for one round trip, not one per line.

For warm reuse, open a session: `const s = openRegexSession(); … await s.run(req); … s.close();`. Runs on a session are queued, never concurrent. Measured on an Apple-silicon Mac with Bun 1.3.14:

- A warm session run costs about **0.02 ms**.
- A one-shot `runRegex`, which starts a worker, costs about **2.2 ms**.
- `testEach` over 10 000 log lines takes **4.3 ms**, against 0.3 ms for a synchronous loop. Most of the difference is copying the inputs to the worker.

`runRegex` is a one-run session.

### The answer is tri-state

Only `status: "ok"` carries a definite answer. Every other status means the helper could not tell:

| `status` | Meaning |
|---|---|
| `rejected` | The pattern was refused before running (`code`: `pattern-too-long`, `invalid-flags`, `flag-not-allowed`, `invalid-syntax`, `nested-quantifier`, `overlapping-alternation`, `unanalysable`). Report it as invalid input. |
| `input-too-large` / `output-too-large` | A cap would be exceeded. A replace is refused, never cut short. |
| `timeout` | The deadline passed. Batch ops add `completed` and `partial`, which cover the inputs answered before the stop. |
| `gave-up` | The engine abandoned an `exec` and reported "no match" (see below). Batch ops add `index` and `partial`. |
| `error` | `busy`, `worker-unavailable`, `worker-crashed`, `exec-threw` or `closed`. |

`regexVerdict(outcome)` maps a `test` outcome to `"matched" | "not-matched" | "undetermined"`. How to surface `undetermined` depends on the kind of tool:

- **A gate** (`Assert notMatches`, a secret scan, a policy check) fails closed: "could not verify".
- **A search** (`Grep`, `TableQuery`, `JsonQuery`) returns the matches it has and names the inputs it did not scan. It never says "no matches".
- **A classifier or router** (`RuleClassify`, `ErrorClassify`, `GlCodeSuggest`) returns no label and gives the reason. It does not fall back to the default label.
- **A validator** (JSON Schema `pattern`) reports an error that is not a verdict. It does not report "invalid".

### What JavaScriptCore does with a pathological pattern

JavaScriptCore stops a match after a fixed backtracking budget and returns `null`, the same value as "no match". Measured on Bun 1.3.14, it throws no exception, and it leaves `lastIndex` and `RegExp.lastMatch` exactly as a genuine failure would. This holds under every flag (`"" g y d u v`). **A give-up can't be detected from the return value.**

The only difference is cost. Every give-up measured took 0.4–3 s, while a genuine no-match over the input sizes admitted here takes microseconds to milliseconds. So the worker times every `exec`, and reports a `null` that took at least `giveUpMs` (default 100) as `gave-up`, never as a no-match. This is a heuristic, and it errs in one direction: a genuinely slow no-match is also reported `gave-up`. That outcome is undetermined, which is safe. Every give-up measured was far above the threshold.

### The static screen: `screenUserRegex` and `compileUserRegex`

Both are synchronous; the screen suits a zod `refine`. They check length, flags and syntax, then screen for the shapes that make backtracking exponential:

- `nested-quantifier` flags a repeated group whose body can match a varying amount of text, with nothing that marks where one repetition ends. Examples: `(a+)+`, `(\w{1,})*`, `(\w+\s?)+`, `(.*a){12}`, `(a?){30}`. Safely delimited nesting is accepted: in `(\w+\.)+`, `(\d{1,3}\.){3}`, `(?:\r?\n)+` and `(<[^>]*>)*`, a character the varying parts cannot match ends each repetition.
- `overlapping-alternation` flags a repeated group containing an alternation whose branches can start with the same character: `(a|a)*`, `(\w|\d)*`, `(a|ab)*`. Case folding under `i` is taken into account, including `ſ`/`s` and `K`/`k`. `(a|b)*` and `(foo|bar)+` are accepted.

**The screen is the second layer, never the first.** It recognises known shapes; it can't prove a pattern is fast. Polynomial patterns get through by design: `\s+$` on a long run of spaces is quadratic, and `(?:a|b)*(?:a|b)*(?:a|b)*(?:a|b)*!|x` passes the screen yet makes JavaScriptCore give up (see `run.test.ts`). The deadline and the give-up timing bound those. `compileUserRegex` returns a `RegExp` for callers that need one, but running it synchronously over untrusted, caller-sized text is still unbounded.

### Termination bounds the caller's thread, not the worker's CPU

At the deadline the caller's event loop is free. The worker thread, though, can't be preempted inside the regex engine: it stops at the next termination check, which comes after the current `exec` returns.

- For an exponential pattern, the backtracking budget ends the `exec` within about 0.4–3 s of one core.
- For a polynomial pattern over a long input, it can take seconds to minutes. `\s+$|x` on 80 000 spaces takes 3.7 s.

`maxInputChars` (default 1 000 000) bounds this. `regexWorkerCounts()` reports such `runaway` threads. While `maxRunawayWorkers` (default 2) of them are still running, new runs are refused as `error`/`busy` instead of stacking more burning threads. Terminated workers are `unref`ed and never hold the process open.

### Why the worker is a string

`bun build --compile` embeds only statically imported modules, so a worker started from a separate file URL would be missing from a single-file binary. The worker is created from an inline source string through a Blob URL. `compiled-binary.test.ts` builds a real binary and runs it from a directory with no source tree.

## `./streams`: bounded reading

### `collectBounded(stream, { maxBytes, tailBytes?, onChunk?, signal? })`

`collectBounded` applies the cap as bytes arrive. Past the cap it still reads to the end, because a child blocked on a full pipe never exits, but it counts the bytes and drops them. The result reports `truncated`, `totalBytes`, `omittedBytes`, an optional `tail`/`tailText`, and `complete` (whether the end of the stream was reached). An error is returned in `error`, not thrown.

### `spawnBounded({ cmd, cwd, env, stdin, timeoutMs, maxStdoutBytes, maxStderrBytes, signal, … })`

`spawnBounded` runs argv without a shell. The child leads its own process group, and a timeout or abort sends SIGTERM to the whole group, then SIGKILL after `killGraceMs`. On Windows it runs `taskkill /T /F`, best effort.

The result carries `exitCode` (null when signalled), `signal`, `timedOut`, `aborted`, `stdout`/`stderr` with their `…Truncated` flags and byte counts, and `outputComplete`.

When a grandchild keeps a pipe open after the child exits, reading stops after `drainGraceMs`. The helper returns the bytes that did arrive, with `outputComplete: false`. It never reports an empty string as if it were the output.

`onOverflow: "kill"` stops a producer at its cap. That grandchild itself is not killed after a normal exit, because it may be a daemon the command meant to start.

### `readResponseBounded(res, { maxBytes })` with `withRawBody(init)`

Measured on Bun 1.3.14: unless a request passes `decompress: false`, `fetch` inflates a gzip, deflate, br or zstd body in native code before JavaScript sees a byte. A 65 KB gzip body put 273 MB on the heap before the first `read()` returned. Bun also **keeps** the `Content-Encoding` header, and it keeps `Content-Length` at the compressed size, so the response gives no sign it was decoded.

The bound therefore has to start at the request. Fetch with `withRawBody({...})`, and this reader decodes the body itself, stopping the decoder once `maxBytes` of decoded output exist. Against 1 GiB bombs it decoded the cap plus one 16 KiB chunk, with peak RSS up about 20–25 MB, in all four codings. Without `withRawBody`, the same bombs cost +1.5 GB (gzip) and +3.5 GB (br) before any reader saw them.

The reader refuses a body the runtime already decoded, with the code `auto-decompressed`. It detects that when the body runs past its own `Content-Length`, or when a gzip or zstd body lacks its magic bytes. A double-decoded br or deflate body surfaces as `decode-error` instead. The memory is spent by then, so the check exists to make a missing `withRawBody` fail a test. Every adopting package should keep a gzip-bomb test against a local server.

### `readFileBounded(path, { maxBytes, followSymlinks? })` and `readFileBoundedSync`

The helper reads at most `maxBytes` plus one byte (to tell whether more exists); it never reads the whole file and then slices. A FIFO, socket, device or directory is refused with `not-regular-file` and its `kind` **before it is opened**. Opening a FIFO unblocks whoever is waiting to write it, and opening some devices has side effects.

The open descriptor is checked again with `fstat`, and it must be the same file (`dev`/`ino`) as the one checked. The open uses `O_NONBLOCK`, so a path swapped for a FIFO between the two checks cannot block. `followSymlinks: false` refuses a symlink and opens with `O_NOFOLLOW`.

## Adopting it

| Finding(s) | Replace | With |
|---|---|---|
| flag-truth-1#5, security-1#2, security-2#1, security-6#6, security-8#9, security-8#12, security-9#7, security-12#1, flag-truth-2#6, security-5#20 | `new RegExp(callerPattern)` + synchronous `test`/`exec`/`replace` | `screenUserRegex` in the input schema, plus `runRegex`/a session with a batch op at run time. Surface non-`ok` as undetermined (see above). |
| security-10#0 | a literal regex with an overlap (`\s+[^:]*`) | Fix the literal and cap line length. `runRegex({ op: "testEach" })` is the fallback if the pattern must stay. |
| security-8#7, security-8#8, security-10#9 | `new Response(proc.stdout).text()` + `capText` | `spawnBounded`, reporting `outputComplete: false` as unreadable. |
| security-6#8, security-12#4 | `collectStream` → `new Response(stream).text()` | `collectBounded` (with `onOverflow: "kill"` semantics where the output past the cap is worthless). |
| security-5#7, security-9#4 | `fetch(url)` + a capped reader | `fetch(url, withRawBody(init))` + `readResponseBounded`, plus a local gzip-bomb test. |
| security-12#3, flag-truth-6#5 | `Buffer.allocUnsafe(size)` + read all | `readFileBounded` / `readFileBoundedSync`. |
| security-11#8 | line reads with no byte budget | `readFileBounded` for the budget; the per-line cap stays in the tool. |
| flag-truth-6#4, security-12#8 | a preview capped by lines only | The UTF-8-safe cut in `collectBounded` is the model; the preview fix itself lives in `tool-result-store`. |
