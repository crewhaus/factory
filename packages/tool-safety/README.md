# @crewhaus/tool-safety

The guards tool packages import instead of each hand-rolling its own. An audit of the 0.7.0 builtins found the same defects in dozens of packages that share no code: caller-supplied regexes that freeze the process, output capped only after it was buffered, a compressed response inflated to gigabytes, a FIFO that blocks a read for ever, a write that follows a planted symlink out of the workspace, and a model that picks any environment variable as a credential. Each helper here closes one of those, once.

Zero runtime dependencies: Bun and `node:*` only. **Bun only.** It uses Bun Workers, `Bun.spawn`, `node:fs` and Bun's `decompress: false` fetch option, so the tools a cf-worker target bundles (`tool-fetch`, `tool-web`, `tool-message-channel`, `tool-image-generation`, `tool-todo`) must not depend on it. `edge-targets.test.ts` reads each target's `EDGE_TOOL_IMPORTS` and fails if one of them reaches this package through its dependencies. An edge tool needs its own bound.

```ts
import { runRegex, screenUserRegex } from "@crewhaus/tool-safety/regex";
import { spawnBounded, readResponseBounded, decodeBody, fetchRaw, readFileBounded, openRegularFile } from "@crewhaus/tool-safety/streams";
import { openForRead, joinRel, writeFileSafe, appendContained, walkContained, copyTreeSafe, checkRelocatedLinks } from "@crewhaus/tool-safety/fs";
import { resolveCredentialEnv, checkEnvReveal, redactKnownSecrets, redactUrlCredentials } from "@crewhaus/tool-safety/env";
```

## `./regex`: caller-supplied regular expressions

A regex written by the model, or by an operator, runs on text the model or a remote party controls. A synchronous `RegExp` call can't be interrupted. No timer fires and no abort signal is seen, so every session and heartbeat in the process waits for it to finish.

### Running a pattern: `runRegex` and `openRegexSession`

```ts
const outcome = await runRegex({
  op: "testEach", pattern, flags, inputs: lines,
  deadlineMs: 1000, signal: ctx.signal, runawayKey: ctx.sessionId,
});
if (outcome.status === "ok") {
  report(outcome.result.matched);                           // definite
} else {
  reportUndetermined(describeRegexOutcome(outcome), outcome); // never "no matches"
}
```

The match runs in a Bun Worker. At the deadline, or when `signal` fires, the worker is terminated and the caller gets `timeout` (or `error`/`aborted`).

| `op` | What it does | `result` |
|---|---|---|
| `test` | Checks whether the pattern matches `input` anywhere | `{ matched }` |
| `matchAll` | Finds every match (`g` implied), up to `maxMatches` | `{ matches, truncated, truncatedBy? }` |
| `replace` | Replaces with a string replacement, supporting `$&` `$1` `$<n>` `` $` `` `$'` `$$` | `{ output, replacements }` |
| `split` | Behaves like `String.prototype.split`, captures included | `{ pieces, truncated, truncatedBy? }` |
| `testEach` | Runs one pattern over many inputs | `{ matched: indexes, scanned, truncated, undetermined }` |
| `firstMatchingRule` | Runs many patterns over many inputs and finds the first rule that hits each input | `{ ruleIndexes, undetermined }` (-1 = none, null = undetermined) |
| `testMatrix` | Runs every pattern against every input | `{ matched, undetermined }`, one index list per pattern |
| `replaceEach` | Runs one `replace` over many inputs; `maxOutputChars` caps all outputs together | `{ outputs, replacements, undetermined }` |

`replace`, `split` and `matchAll` give the same answers as the built-in methods; `run.test.ts` compares them across a battery of patterns, inputs and replacement templates. The batch ops exist so a tool that scans many lines, or many rules, pays for one round trip, not one per line.

**Batch options.** A batch op takes `onGiveUp`. `"stop"` (the default) ends the batch at the first input the engine gives up on, as `gave-up` with `partial` answers before it. `"skip"` lists that input in `undetermined` and answers the rest while the deadline allows; in `firstMatchingRule`, an input is undetermined as soon as one rule before the matching one could not be answered. `maxItemChars` (default 65 536) is the longest single input a batch runs: past it, `"stop"` refuses the request as `input-too-large` with the `index`, and `"skip"` reports the input as undetermined without running it. `firstMatchingRule` and `testMatrix` also cap the patterns' combined length (`maxTotalPatternChars`, default 100 000).

**A synchronous evaluator** (a `runChecks` predicate, a `rows.filter(...)` callback, a JSON Schema `pattern`) cannot await a worker. Run the batch first, then evaluate against the answers:

1. Walk the rules and the rows, and collect every distinct (pattern, flags) and every value it will be tested on.
2. Run one `testMatrix` with `onGiveUp: "skip"`.
3. Evaluate synchronously, looking each (pattern, value) answer up. An answer in `undetermined`, or missing because the run did not finish, is undetermined, and the evaluator treats it as the tool's kind requires (see below).

For warm reuse, open a session: `const s = openRegexSession(); … await s.run(req); … s.close();`. Runs on a session are queued, never concurrent. Measured on an Apple-silicon Mac with Bun 1.3.14:

- A warm session run costs about **0.02 ms**, or **0.07 ms** under `i`. The pattern's screen is cached after its first run; that first screen costs 0.01–0.3 ms for everyday patterns and at most a few milliseconds (see the screen below).
- A one-shot `runRegex`, which starts a worker, costs about **2.3 ms**.
- `testEach` over 10 000 log lines takes **4.3 ms**, against 0.3 ms for a synchronous loop. Most of the difference is copying the inputs to the worker.

`runRegex` is a one-run session.

### The answer is tri-state

Only `status: "ok"` carries a definite answer. Every other status means the helper could not tell:

| `status` | Meaning |
|---|---|
| `rejected` | The pattern was refused before running (`code`: `pattern-too-long`, `invalid-flags`, `flag-not-allowed`, `invalid-syntax`, `nested-quantifier`, `overlapping-alternation`, `unanalysable`). Report it as invalid input. |
| `input-too-large` / `output-too-large` | A cap would be exceeded. A replace is refused, never cut short. |
| `timeout` | The deadline passed, while screening or while matching. Batch ops add `completed` and `partial`, which cover the inputs answered before the stop. |
| `gave-up` | The engine abandoned an `exec` and reported "no match" (see below). Batch ops add `index` and `partial`. |
| `error` | `busy`, `aborted`, `worker-unavailable`, `worker-crashed`, `exec-threw` or `closed`. |

`regexVerdict(outcome)` maps a `test` outcome to `"matched" | "not-matched" | "undetermined"`. How to surface `undetermined` depends on the kind of tool:

- **A gate** (`Assert notMatches`, a secret scan, a policy check) fails closed: "could not verify".
- **A search** (`Grep`, `TableQuery`, `JsonQuery`) returns the matches it has and names the inputs it did not scan. It never says "no matches".
- **A classifier or router** (`RuleClassify`, `ErrorClassify`, `GlCodeSuggest`) returns no label and gives the reason. It does not fall back to the default label.
- **A validator** (JSON Schema `pattern`) reports an error that is not a verdict. It does not report "invalid".

### What JavaScriptCore does with a pathological pattern

JavaScriptCore stops a match after a fixed backtracking budget and returns `null`, the same value as "no match". Measured on Bun 1.3.14, it throws no exception, and it leaves `lastIndex` and `RegExp.lastMatch` exactly as a genuine failure would. This holds under every flag (`"" g y d u v`). **A give-up can't be detected from the return value.**

The only difference is cost. Every give-up measured took 0.4–3 s, while a genuine no-match over the input sizes admitted here takes microseconds to milliseconds. So the worker times every `exec`, and reports a `null` that took at least `giveUpMs` (default 100) as `gave-up`, never as a no-match. This is a heuristic, and it errs in one direction: a genuinely slow no-match is also reported `gave-up`. That outcome is undetermined, which is safe. Every give-up measured was far above the threshold.

### The static screen: `screenUserRegex` and `compileUserRegex`

Both are synchronous, so the screen suits a zod `refine`. They check length, flags and syntax, then screen every repeated group for the shapes that make backtracking exponential. A repeated group is accepted when each repetition ends in exactly one place and matches its text in exactly one way. Everything else is refused:

- `nested-quantifier`: a repetition can end in more than one place, or split its text more than one way. Examples: `(a+)+`, `(\w{1,})*`, `(\w+\s?)+`, `(.*a){12}`, `(a?){30}`, and `(?:,\d+\d*)*`. In the last one the delimiter fixes where each repetition ends, but `\d+\d*` can still split `12` two ways, and the splits multiply; the screen used to accept it, and JavaScriptCore gives up on it. Safe nesting is accepted: `(\w+\.)+`, `(\d{1,3}\.){3}`, `(?:\r?\n)+`, `(<[^>]*>)*`, `(?:\d+[a-z]+)*`.
- `overlapping-alternation`: two branches of a repeated alternation can match the same text. Examples: `(a|a)*`, `(\w|\d)*`, `(?:\.(?:ab|a[bc]))*`. Branches that start alike but must differ are accepted: `(?:ab|ac)+`, `[0-9]|[1-9][0-9]` between delimiters, and semver's `0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*`. Case folding under `i` is taken into account, including `ſ`/`s` and `K`/`k`.

A repetition with a small upper bound is accepted when the number of ways through it stays at 1 024 or fewer, however ambiguous each repetition is. The canonical IPv4 regex repeats `(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}`, which has 216. Unicode property escapes (`\p{L}`) and `v`-mode classes are modelled from what the engine matches over U+0000–U+00FF and the whitespace above it, so `^\p{L}+(?:[ '-]\p{L}+)*$` is seen as delimited. `screen.test.ts` holds the refused and must-accept batteries. A fuzzer over millions of generated patterns found no accepted pattern slow on pumped input.

**The screen is the second layer, never the first.** It recognises exponential shapes; it can't prove a pattern is fast. Polynomial patterns get through by design: `\s+$` on a long run of spaces is quadratic. The deadline and the give-up timing bound those. `compileUserRegex` returns a `RegExp` for callers that need one, but running it synchronously over untrusted, caller-sized text is still unbounded.

**The screen's own cost is bounded.** It runs on the caller's thread, not in the worker, so it charges every step to a work budget (`limits.maxScreenWork`, default 200 000 units). A pattern that exhausts the budget is refused as `unanalysable`. Measured on an Apple-silicon Mac, the worst 1 000-character patterns found take about 5 ms, where the old screen took up to 4.4 s under `i`. The engine's own compile also runs on the caller's thread, and a `v`-mode set operation over a property (`[\p{L}--[a-z]]`) costs it 1–3.5 ms. Those operations, and property escapes inside classes, are charged to the budget before anything is compiled. The first `i` screen in a process builds a case-folding index once, in about 13 ms. Verdicts are cached (512 entries, keyed by pattern, flags and limits), so a refine followed by a run, or the same rule on every call, costs a lookup. The many-pattern ops yield to the event loop between rules and stop at the deadline.

### Termination bounds the caller's thread, not the worker's CPU

At the deadline the caller's event loop is free. The worker thread, though, can't be preempted inside the regex engine: it stops at the next termination check, which comes after the current `exec` returns.

- For an exponential pattern, the backtracking budget ends the `exec` within about 0.4–3 s of one core.
- For a polynomial pattern, it grows with the input. `\s+$` costs about 0.6 ns × n² here: 64 000 characters take 2.4 s, and 1 000 000 about ten minutes.

`regexWorkerCounts()` reports such `runaway` threads. While `maxRunawayWorkers` (default 2) of them are still running for the same `runawayKey`, new runs under that key are refused as `error`/`busy` instead of stacking more burning threads. Pass the session id as `runawayKey`, so one session's hostile patterns leave the others alone. Past `maxRunawayWorkersTotal` (8) across all keys, every run is `busy`. Terminated workers are `unref`ed and never hold the process open.

**How long `busy` lasts** is how long the abandoned `exec` still has to run, so it is set by the size of one input. A batch runs one `exec` per input, so `maxItemChars` (default 65 536, about 2.5 s here for a quadratic pattern) bounds it. A single-input op is bounded by `maxInputChars` (default 1 000 000, up to ten minutes). Choose these per tool: 64 KiB per line or cell suits `Grep` and `TableQuery`, and a document-sized `test` or `replace` should cap its input at what the tool really needs.

### Why the worker is a string

`bun build --compile` embeds only statically imported modules, so a worker started from a separate file URL would be missing from a single-file binary. The worker is created from an inline source string through a Blob URL. `compiled-binary.test.ts` builds a real binary and runs it from a directory with no source tree.

## `./streams`: bounded reading

Every budget is parsed before anything is read. A `maxBytes` that is NaN, negative or missing throws a `RangeError`. It used to become NaN, and every file and stream then read as empty and complete, so a scanner handed `Number(config.maxBytes)` with the key unset reported "nothing found". The same applies to `tailBytes`, `position`, `timeoutMs` and the grace periods.

A caller's `AbortSignal` is watched without ever being left listener-less. Measured on Bun 1.3.14, removing the last listener from an `AbortSignal.timeout()` signal cancels its timer for good. A helper that added and removed its own listener therefore disarmed the caller's deadline for the next call it was passed to.

### `collectBounded(stream, { maxBytes, tailBytes?, onChunk?, signal? })`

`collectBounded` applies the cap as bytes arrive. Past the cap it still reads to the end, because a child blocked on a full pipe never exits, but it counts the bytes and drops them. The result reports `truncated`, `totalBytes`, `omittedBytes`, an optional `tail`/`tailText`, and `complete` (whether the end of the stream was reached). An error is returned in `error`, not thrown.

### `spawnBounded({ cmd, cwd, env, stdin, timeoutMs, maxStdoutBytes, maxStderrBytes, signal, … })`

`spawnBounded` runs argv without a shell. The child leads its own process group. A timeout or abort sends SIGTERM to the whole group, then SIGKILL after `killGraceMs`, even when the child itself has already exited: another member of its group may ignore SIGTERM. On Windows it runs `taskkill /T /F`, best effort. `timeoutMs: Infinity` means no timeout.

The result carries:

- `exitCode` (null when signalled) and `signal`, `timedOut`, `aborted`;
- `stdout`/`stderr` as text, `stdoutRaw`/`stderrRaw` as the exact bytes kept, with their `…Truncated` flags, byte counts and `…OmittedBytes`;
- `outputComplete`;
- `spawnError` and `spawnErrorCode` (`ENOENT` for a command that is not installed) when it could not start.

The caps are in bytes. For a cap in characters, collect three bytes per character (no UTF-16 code unit takes more than three bytes of UTF-8), cut the decoded text, and add the bytes of the text cut off to `…OmittedBytes`.

When a grandchild keeps a pipe open after the child exits, reading stops after `drainGraceMs`. The helper returns the bytes that did arrive, with `outputComplete: false`. It never reports an empty string as if it were the output.

`onOverflow: "kill"` stops a producer at its cap. That grandchild itself is not killed after a normal exit, because it may be a daemon the command meant to start.

**When the host goes away.** A child in its own group does not get the terminal's Ctrl-C. So while a command runs, its group is killed if the host exits (`process.exit`, or the event loop ending), and on SIGINT, SIGTERM or SIGHUP when nothing else in the process listens for that signal; the host then dies of the signal as it would have. A host with its own handler keeps its policy. Adopters must pass `ctx.signal`, so a turn aborted by the first Ctrl-C kills the group. `setHostExitCleanup(false)` turns the hooks off.

### `readResponseBounded(res, { maxBytes, signal?, idleTimeoutMs? })`, `decodeBody` and `fetchRaw`

Measured on Bun 1.3.14: unless a request passes `decompress: false`, `fetch` inflates a gzip, deflate, br or zstd body in native code before JavaScript sees a byte. A 65 KB gzip body put 273 MB on the heap before the first `read()` returned. Bun also **keeps** the `Content-Encoding` header, and it keeps `Content-Length` at the compressed size, so the response gives no sign it was decoded.

The bound therefore has to start at the request. Fetch with `fetchRaw(input, init)`, or with `withRawBody(init)` as the init of the **final** `fetch` call. Bun ignores `decompress` inside a `Request`'s own init, so `fetch(new Request(url, withRawBody({})))` is inflated anyway; a pinned-fetch helper that passes a `Request` should call `fetchRaw(request)`. This reader then decodes the body itself, stopping the decoder once `maxBytes` of decoded output exist. Against 1 GiB bombs it decoded the cap plus one 16 KiB chunk, with peak RSS up about 20–25 MB, in all four codings. Without the raw body, the same bombs cost +1.5 GB (gzip) and +3.5 GB (br) before any reader saw them.

Every read is raced against `signal` and `idleTimeoutMs`, so a server that sends one chunk and stalls cannot hold the reader: it ends as `aborted` or `stalled`.

`decodeBody(res, options)` yields the decoded chunks as they are produced, at most `maxBytes` in all, and sets `outcome` when the iteration ends. Use it for a reader that works as bytes arrive: `SseRead` feeds each chunk to its event decoder, and a large `DownloadFile` writes each chunk to a `beginAtomicWrite` writer instead of holding the body. `readResponseBounded` is `decodeBody`, collected.

The reader refuses a body the runtime already decoded, with the code `auto-decompressed`. It detects that when the body runs past its own `Content-Length`, or when a gzip or zstd body lacks its magic bytes. A double-decoded br or deflate body surfaces as `decode-error` instead. The memory is spent by then, so the check exists to make a missing raw body fail a test. Every adopting package should keep a gzip-bomb test against a local server.

### `readFileBounded(path, { maxBytes, position?, followSymlinks? })`, `readFileBoundedSync` and `openRegularFile`

The helper reads at most `maxBytes` plus one byte (to tell whether more exists), from `position` (default 0); it never reads the whole file and then slices. A FIFO, socket, device or directory is refused with `not-regular-file` and its `kind` **before it is opened**. Opening a FIFO unblocks whoever is waiting to write it, and opening some devices has side effects.

The open descriptor is checked again with `fstat`, and it must be the same file (`dev`/`ino`) as the one checked. The open uses `O_NONBLOCK`, so a path swapped for a FIFO between the two checks cannot block. `followSymlinks: false` refuses a symlink and opens with `O_NOFOLLOW`.

`openRegularFile(path)` (and `openRegularFileAsync`) makes the same checks and returns the open descriptor with its `stats`, for a reader that streams: `ReadLines` up to line N, `TailFile` from `size − n`, `SplitFile`'s source. `readOpenedFileSync(opened, { maxBytes, position })` reads from it. The caller closes it.

## `./fs`: the leaf, not just the directory

The containment resolver copied into the tool packages checks the path the caller NAMED. The audit's defects were in everything after that: `package.json` joined onto a contained directory and read through a planted link, `baselines.json` written through a dangling one, a temp name like `<golden>.tmp-<pid>` that a link was already waiting at, and a copy that wrote through a symlinked directory under its destination. Every function here takes a root and a path relative to it (or absolute inside it). Each one resolves the path the way the kernel does, links included, and requires the place it physically lands to be inside the root's realpath.

Every refusal is a `SafeFsFailure`: `{ ok: false, code, reason, path }`. The `reason` names the caller's path and why (`escapes-root`, `is-symlink`, `not-regular-file` with its `kind`, `exists`, `changed` …). It never names where an escaping path led or what is there, because a tool result is also a transcript, a trace and an eval report.

### Resolving: `resolveContained(root, path, { followLeaf? })`

The path is resolved one component at a time. After a link, `..` climbs from the link's TARGET: `a/b/y/..` with `y -> ../..` lands two levels above `a/b`, not at `a/b`, which is where folding the text would put it (security-11#5). A dangling link is followed too, because `open(O_CREAT)` through it creates its target. A missing tail is allowed, so a destination can be checked before it exists. Do I/O on the returned `real`.

### Reading: `openForRead(root, path, { maxBytes, position?, followLeafSymlink? })`, `openForReadSync` and `openForReadFd`

This returns at most `maxBytes` of a regular file whose physical location is inside the root. A leaf linked out of the root is refused, whatever directory it was joined onto (security-9#2, security-7#1, security-7#12, security-5#2, flag-truth-3#6). The open refuses a FIFO or device before opening it, as `readFileBounded` does. An in-root link at the leaf is followed unless `followLeafSymlink: false`.

A leaf joined onto a contained directory is spelled with `joinRel(dir.rel, "package.json")`. A template string gives `/package.json` when the directory is the root itself (`rel` is ""), and that absolute path is refused as outside the workspace, with a reason that says so.

**A directory swapped mid-read.** Node has no `openat`, so the open walks the path again, and a directory on it swapped for a link between the check and the open used to be followed. The review's two-process race read the outside file in 262 of 52 230 reads. Now the open descriptor is asked where it really is: `realpath` of `/dev/fd/<fd>` names the open file on macOS and, through `/proc/self/fd`, on Linux. Unless that is inside the root, nothing is read. The same race then leaked nothing in 142 503 reads on macOS and 171 775 on Linux. Where the descriptor cannot be asked (Windows, a Linux without `/proc`), the identity of every directory on the path and of the leaf is compared after the open instead. That narrows the window without closing it.

`openForReadFd(root, path)` makes every one of these checks and hands over the descriptor, for a reader that streams (`ReadLines`, `TailFile`). The caller closes it.

### Writing: `writeFileSafe(root, path, data, { overwrite, createParents?, mode?, leafSymlink? })`

- The destination's directory is resolved physically and must be inside the root. With `createParents`, each missing directory is created one at a time, never with a recursive `mkdir` that follows links.
- A leaf that is a symlink is refused, dangling or not. `leafSymlink: "follow-contained"` instead writes to where an in-root link leads, and the link stays a link. A leaf that is a FIFO, device or directory is refused.
- The bytes go to a temp created with `O_CREAT|O_EXCL|O_NOFOLLOW` under a random name beside the destination, and the temp is renamed into place. `O_EXCL` fails on any existing name, a planted link included, so nothing is written through it (security-9#3, security-8#13, security-2#0). Without `overwrite`, the temp is hard-linked into place, so a file that appeared meanwhile is kept, not clobbered.
- An overwrite keeps the replaced file's permission bits: an edited script stays executable, and a 0600 file stays 0600 (security-6#11). The setuid, setgid and sticky bits are dropped, as an in-place write by an unprivileged user drops them.

`beginAtomicWrite` is the same with the bytes streamed in: `writer.write(chunk)` any number of times, then `commit()` or `abort()`. Use it for a download.

The temp needs a place beside the destination, so `writeFileSafe` refuses a file in a directory it cannot write, with `permission-denied`, even when the file itself is writable. This is by design: that write could only be done in place, which is neither atomic nor safe from a link swapped in at the leaf.

### Appending: `appendContained(root, path, data, { createParents?, create?, mode? })`

This appends in place: to a JSONL index that every run adds to, or to touch a file. A rewrite through a temp would cost O(n) and race other appenders. A link or special file at the leaf is refused. An existing file is opened without `O_CREAT`, with `O_NOFOLLOW|O_NONBLOCK`, and must be the very file that was checked, in the directory that was checked. A missing one is created with `O_EXCL`. Nothing is written until those checks pass; a file created in the wrong place is removed there, and one that already existed is left alone. One `write` is atomic against other appenders, so keep a record to one append.

### New files at exact names: `createExclusive(root, path, { mode?, createParents? })`

This creates a new file and returns its open descriptor. Anything already at the name is refused, including a dangling link. As with every file this module creates, where the new file really landed is asked of its descriptor. If a directory was swapped to put it elsewhere, it is removed there, before a byte is written. Use it for part files, partials and temps (flag-truth-6#1, security-11#1). `ensureDirContained(root, path, { symlinks? })` creates a directory the same way; `symlinks: "refuse"` refuses any link on the way, for a layout whose directories must be real, such as a trash can (security-10#2).

### Walking: `walkContained(root, start, { maxEntries, maxDepth, maxVisited?, filter? })`

This is the one walk. It never follows a symlink. Every entry is `lstat`ed and reported with its `kind` (`file`, `directory`, `symlink`, `fifo`, `socket` …). A link carries its target text and whether it physically leads inside the root. A directory swapped for a link while it was listed is reported in `unreadable`, and so is one that could not be read. A truncated walk says why (`max-entries`, `max-depth` or `max-visited`). The order is depth-first and sorted by raw name, so it is the same on every machine.

### Copying: `copyTreeSafe(srcRoot, src, dstRoot, dst, { symlinks, maxEntries, maxBytes?, overwrite?, specials?, createParents?, dryRun? })`

The whole copy is planned before a byte is written. Every source entry is `lstat`ed, never followed. Every destination path is checked, not just the destination root: an existing link anywhere on it is refused (security-11#0, flag-truth-6#0). With `symlinks: "copy-contained"`, each link is resolved from its NEW location, the way the kernel will, taking into account the directories and links the copy is about to create. A link that would lead outside the destination root is refused (security-11#2). `"skip"` leaves links out and lists them; `"refuse"` fails the copy. Budgets and conflicts fail the copy before anything is written.

During the write, each entry is checked against the directory that was planned. If a directory is swapped for a link mid-copy, the copy stops, removes the entry it had just made through the swap, and reports how many entries were already copied.

On Linux each file's bytes are copied by the kernel, between the two verified descriptors (`/proc/self/fd/<n>`): a clone on btrfs and XFS, `copy_file_range` on ext4. On macOS they are copied in 1 MiB chunks. There, copying between `/dev/fd` paths failed on 64 MiB and changed modes (measured on Bun 1.3.14), and a clone by path would re-walk the path the plan checked. A multi-gigabyte copy therefore blocks for as long as the disk takes, and it is synchronous.

### Moving: `checkRelocatedLinks(srcRoot, src, dstRoot, dst, { maxLinks?, maxVisited? })`

A rename moves links to a new depth, where a relative target means something else. This check judges every link in the tree from where the rename will put it, before the rename. It reads nothing but link text and applies no content budget. On a 60 601-entry tree it took 66 ms, where `copyTreeSafe(…, { dryRun: true })` took 381 ms and refused at MovePath's default of 50 000 entries. A destination the rename would replace is consulted only for paths the moved tree lacks, which can only refuse more.

### Kinds: `probeKind(absPath)`, `assertRegularFile(absPath)` and `fileKind(stats)`

These tell what a path is without opening it: a `stat` never blocks on a FIFO, but an `open` does (flag-truth-6#3, security-11#7, security-6#12, security-7#8). `assertRegularFile` throws a `SafeFsError` for code that hands the path to something else. To read the file, use `openForRead`, which re-checks the open descriptor.

### What `./fs` cannot do

Node has no `openat` or `mkdirat`. What this module does instead:

- **Reads** are checked on the open descriptor, which closes the directory-swap race on macOS and Linux (see Reading).
- **Files it creates** are found through their descriptor, and removed where they really are when a swap put them outside.
- **The rename or link that puts a temp in place**, and `mkdir`, are still checked after the call by comparing the directory's identity (`dev`/`ino`). What they created through the swap is then removed while the name still leads to it; they are not prevented. Identity rather than spelling is compared because a case-insensitive volume makes `Docs` and `docs` one directory.
- **A hard link** inside the root to a file outside it is that file under an inside name. No containment by path can tell it apart.

## `./env`: credentials and the environment

### `resolveCredentialEnv(name, { allowed, purpose, configKey, env? })`

A tool may read a credential from environment variable `name` only if the operator listed exactly that name in `allowed`, which comes from tool_config. The model may choose among the listed names but can never add one. Today the model can name `ANTHROPIC_API_KEY` as a bearer token for an allow-listed origin, sign a forged JWT with the app's secret, or override the operator's `token_env`. The egress classifier sees only the name. (config-delivery#4, flag-truth-3#1, flag-truth-4#2, flag-truth-2#0, security-8#4, security-10#8, flag-truth-5#11, security-8#20.)

```ts
const cred = resolveCredentialEnv(input.auth.envVar, {
  allowed: cfg.authEnvs,                      // tool_config, never tool input
  purpose: "the HttpRequest auth profile",
  configKey: "tool_config.http.auth_envs",
});
if (!cred.ok) return refuse(cred.reason);    // names the key to set; never a value
```

The result is `{ ok: true, name, value }`, or a refusal with a `code` and a `reason`:

- `missing-name`: no name was given.
- `invalid-name`: the value is not a variable name, or it looks like a pasted token. It is never quoted back.
- `not-allowed`: the name is not listed. The refusal is worded identically whether or not the variable is set, so the call cannot probe which variables exist.
- `unset`: the name is listed but unset or empty.

A package whose config has one `token_env` passes `[cfg.tokenEnv, ...cfg.tokenEnvs]` as `allowed`.

**Adopt this only where tool_config arrives.** Today agent-level tool_config never reaches about 62 shipped tools (config-delivery#0, including tool-http, tool-codehost, tool-notify, tool-obs and tool-defi). In those packages `allowed` would always be empty, and every auth, token, webhook and signing call would be refused with `not-allowed`. Adoption there waits for that fix. There is deliberately no default allow-list: a list the operator did not write is the model choosing again. A package whose list is empty should warn at registration, naming the config key to set, so the refusal is not the first sign.

### `checkEnvReveal(name, { allowed, configKey })`

Answers whether a tool that reports on variables (EnvInspect) may show a value. The name must be listed, and never credential-shaped, listed or not (flag-truth-4#1, security-8#3, docs-claims#6). Presence and length are all a model learns about a key. `tool_config.proc.env_reveal` needs a config channel that tool-proc does not have yet (it registers no config), so EnvInspect adopts this together with one.

### `isCredentialShapedName(name)` and `credentialShapeOf(name)`

One heuristic for "this name holds a credential": KEY, TOKEN, SECRET, PASSWORD, PASSPHRASE, CREDENTIAL, PAT, AUTH, DSN and the like, whole words or run together (`PGPASSWORD`, `apiKey`, `x-api-key`), plus URLs that carry one (`DATABASE_URL`, `SLACK_WEBHOOK_URL`). It flags everything the repo's other copies flag. Those copies are the compiler's and preflight's `CREDENTIAL_SHAPED_KEY_RE`, tool-secrets' `SECRETISH_KEY_RE`, tool-crewhaus's CLI-flag regex, and ir's and spec-patch's `isCredentialKey`. `names.test.ts` finds them by shape and checks this. `PWD` and `OLDPWD` are the only exceptions. It is deliberately broad: a false positive hides a harmless value, and a false negative shows a key.

`looksLikePastedSecret(value)` spots a "name" that is really a token (`ghp_…`, `sk_live_…`, `AKIA…`, a long random string).

### Redaction

- `redactKnownSecrets(text, values)` and `createSecretRedactor(values)` replace each known secret in text. They also catch its URL-encoded, base64, base64url and JSON-escaped spellings and a trimmed copy. A composite, such as a Basic header's `base64(user:secret)`, cannot be derived from the secret alone, so pass it as a value of its own.
- `redactKnownSecretsDeep(value, values)` redacts every string in a result object, keys included, and the result still round-trips through JSON.
- `redactUrlCredentials(url)` replaces the whole userinfo and the value of each query or fragment parameter whose name is credential-shaped (`token`, `api_key`, `X-Amz-Signature`, `access_token` …) or whose value looks like a token. Everything else is left as written. `redactUrlCredentialsInText(text)` does this for every URL in an error message or a log line.

A secret in a URL's PATH, such as a Slack webhook's, is not recognisable by shape; `redactKnownSecrets` catches it when the value is known.

## Adopting it

| Finding(s) | Replace | With |
|---|---|---|
| flag-truth-1#5, security-1#2, security-2#1, security-6#6, security-8#9, security-8#12, security-9#7, security-12#1, flag-truth-2#6, security-5#20 | `new RegExp(callerPattern)` + synchronous `test`/`exec`/`replace` | `screenUserRegex` in the input schema, plus `runRegex`/a session with a batch op at run time, passing `signal: ctx.signal` and `runawayKey`. A synchronous evaluator runs one `testMatrix` first and looks answers up (see above). Surface non-`ok` as undetermined. |
| security-10#0 | a literal regex with an overlap (`\s+[^:]*`) | Fix the literal and cap line length. `runRegex({ op: "testEach" })` is the fallback if the pattern must stay. |
| security-8#7, security-8#8, security-10#9 | `new Response(proc.stdout).text()` + `capText` | `spawnBounded` with `signal: ctx.signal`, reporting `outputComplete: false` as unreadable. A chars cap becomes three bytes per char (see above); `stdoutRaw` serves binary output. |
| security-6#8, security-12#4 | `collectStream` → `new Response(stream).text()` | `collectBounded` (with `onOverflow: "kill"` semantics where the output past the cap is worthless). |
| security-5#7 (tool-notify) | `fetch(url)` + a capped reader | `fetchRaw(url, init)` (or `fetchRaw(request)` in `pinnedFetch`) + `readResponseBounded`, plus a local gzip-bomb test. `SseRead` and a large `DownloadFile` use `decodeBody`. |
| security-9#4 (tool-fetch) | — | **Not adoptable here.** `tool-fetch` ships in the cf-worker targets, and `edge-targets.test.ts` refuses this package in its dependencies. Its fix must also work on workerd, which has no `decompress: false`. |
| security-12#3, flag-truth-6#5 | `Buffer.allocUnsafe(size)` + read all | `readFileBounded` / `readFileBoundedSync`. |
| security-11#8 | line reads with no byte budget | `openForReadFd` (or `openRegularFile` for a path already contained) for the checked descriptor, then the tool's own streaming read with a per-line byte cap. |
| flag-truth-6#4, security-12#8 | a preview capped by lines only | The UTF-8-safe cut in `collectBounded` is the model; the preview fix itself lives in `tool-result-store`. |
| flag-truth-6#3, security-11#7, security-6#12, security-7#8 | `statSync` / `openSync` + `readFileSync` of a caller-named path | `openForRead` (or `assertRegularFile` before handing the path on). |
| security-9#2, security-7#1, security-7#12, security-5#2, flag-truth-3#6 | `readFileSync(join(dir.real, "package.json"))` after containing only `dir` | `openForRead(root, joinRel(dir.rel, "package.json"), { maxBytes })`, which also works when `dir` is the root. For a directory of leaves (AuditVerify), `walkContained` first, refusing any entry whose `kind` is not `file`. |
| security-7#0, flag-truth-4#3, security-6#7, flag-truth-3#3, security-6#11 | `writeFileSync(join(dir.real, leaf))`, `mkdirSync({ recursive: true })`, `Bun.write(tmp)` + rename | `writeFileSafe(root, joinRel(dir.rel, leaf), data, { overwrite, createParents })`. An append-only file (eval-report's `index.jsonl`, TouchFile) uses `appendContained`. |
| security-2#0, security-9#3, security-8#13, flag-truth-6#1, security-11#1 | a derived temp, partial or part name opened with `"w"` | `writeFileSafe` / `beginAtomicWrite` (random temp, `O_EXCL`), or `createExclusive` for a file that must be new. |
| flag-truth-6#0, security-11#0, security-11#2 | `buildPlan` + `mkdirSync` + `copyFileSync` + `symlinkSync(readlinkSync(…))` | `copyTreeSafe(…, { symlinks: "copy-contained" })`. MovePath runs `checkRelocatedLinks` before its `renameSync`, since a rename moves links to a new depth too; its EXDEV fallback is the real copy, then a delete. |
| security-11#5 | a lexical `path.resolve(dir, linkTarget)` check of staged links | `walkContained(staging, ".")` and refuse any entry with `link.inside === false`. |
| flag-truth-6#2, security-11#3 | `zip -r` without `-y` | Add `-y` to the argv. `walkContained` can refuse a source holding a link that leads out. |
| security-10#2 | `mkdirSync(trash, { recursive: true })` | `ensureDirContained(root, trashRel, { symlinks: "refuse" })`. The owner check stays in the tool. |
| config-delivery#4, flag-truth-3#1, flag-truth-4#2, flag-truth-2#0, security-8#4, security-10#8, flag-truth-5#11, security-8#20 | `process.env[input.envVar]`, `input.tokenEnv ?? cfg.tokenEnv` | `resolveCredentialEnv(name, { allowed: <tool_config list>, purpose, configKey })`, plus `redactKnownSecretsDeep` on everything returned. |
| flag-truth-4#1, security-8#3, docs-claims#6 | `reveal` from tool input | `checkEnvReveal(name, { allowed: <tool_config list>, configKey })`. |
