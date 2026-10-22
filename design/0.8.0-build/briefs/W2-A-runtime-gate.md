# W2-A — the provability gate in `runtime-core` (design §5.1, §5.3, §5.4; PR train 5)

You own: `packages/runtime-core/**` (incl. new test files). Small, reported edits allowed in
`packages/run-context` or `packages/trace-event-bus` only if strictly needed.
Contracts already committed: `ProvabilityTurn`, `RunProvability`, and `provability?:
RunProvability` on `RunChatLoopOptions` (search `0.8.0` in packages/runtime-core/src/index.ts);
the `provability_graded` trace event type and event-log kind; failure class `"provability"`,
`EXIT_CODES.provability = 37`; audit kind `provability_evaluated`. `@crewhaus/provability`
(built in wave 1) exports `unverifiedBundle`, `summarizeBundle`, renderers etc. — read its
`src/index.ts`. runtime-core may import from it (the dependency is already declared).

## The gate

Read `runEvaluatedTurn` (~line 9250) and `runCommitteeOrTurn` (~9590) and their two call
sites: the single-turn path (`await runCommitteeOrTurn(messages)` ~9750) and the REPL path
(`await runEvaluatedTurn(messages)` ~10050). Do NOT restructure the evaluation/cascade code.
Add `runProvableTurn(messages, inner)` and use it at both call sites with the inner function
each site used before. Without `opts.provability` it must be exactly `inner(messages)` (zero
behaviour change — prove it with an existing-suite run).

Per verification pass (`retryIndex` 0..):
1. Abort check first (turn/run aborted → return the attempt un-verified, exactly as the
   evaluation loop does).
2. `out.spinner.start("verifying")`; `bundle = await provability.verify({ finalText, messages,
   isSynthetic, usage, bus, servedModel?, profile?, turnNumber: runContext.turnNumber,
   retryIndex, sessionId: runContext.sessionId, signal })` in try/catch. A THROW is
   infrastructure failure: log a warning + an `error` event-log line (mirror the evaluation
   catch), then use `unverifiedBundle(...)` from @crewhaus/provability — the answer stands
   (fail-open) and the verdict is `unverified`. Stop the spinner in finally.
3. Persist: `bundlePath = await provability.persist?.(bundle, { sessionId, turnNumber })` —
   catch + warn on failure, never fatal.
4. Publish `provability_graded` (summary fields + `maxRetries` + `bundlePath?` +
   `judgeModel?`/`judgeCostUsdMicros?` + `escalatedTo?` when this failing pass escalates), and
   `logEvent("provability_graded", { ...summary, turnNumber, bundlePath? })`. If
   `opts.justificationAuditSink` is present, append `{ kind: "provability_evaluated", payload:
   { ...summary, turnNumber, sessionId } }` — widen `JustificationAuditSink`'s `kind` union to
   `"permission_justification_evaluated" | "provability_evaluated"` (AuditLog accepts both) and
   swallow+warn append failures like the justification path does. Call `onBundle?.(bundle,
   bundlePath)`.
5. Render: when `render !== "none"` and `renderBundle` exists, `text = renderBundle(bundle,
   bundlePath)`. `footerTarget` "stream" (default) → write it to the run output after the
   answer (`out.write`), on its own line; "reply" → carry it out of `runProvableTurn` so the
   single-turn path appends it (separated by a blank line) to the text the run RETURNS. The
   footer must never be appended to `messages` / the transcript (the model must not read its
   own footer next turn). Render ONLY the final standing pass (not every failed retry) — but a
   final failing `note`/exhausted verdict IS rendered (with ✗).
6. Verdict handling:
   - `pass`, `unverified`, or `onFail: "note"` → return the attempt.
   - `halt` → classified terminal stop: `FailureReport { class: "provability", title:
     "provability gate failed", detail: "<met>/<n> claims met the <level> floor (threshold
     <t>)…", remediation: "cite the evidence each claim rests on, lower provability.threshold,
     or soften provability.on_fail to retry/note", exitCode: EXIT_CODES.provability }`;
     `await publishRunFailed(report)`; throw `new RunFailedError(report)` (render the ✗ footer
     first). Mirror the evaluation halt path exactly.
   - `retry` → if `retryIndex >= maxRetries` return the attempt (the failing event trail tells
     the story); else push `markSynthetic({ role: "user", content: provability.nudge(bundle) })`,
     `logEvent("user_message", { content, synthetic: true })`, and `attempt = await
     inner(messages)` (so evaluation re-grades the new answer too), loop.
   - `escalate` → with a pool: target = `resolveRosterArm(provability.escalateTo)` ?? the pool's
     strongest (`poolRouter.escalation()`); push the nudge (synthetic) and run
     `runEscalationStage(messages, target, undefined, "provability: escalated after a failing
     verdict", false, true)` (read its signature and the cascade code for how a fallible
     escalation that throws is handled — on failure the answer stands, note semantics); counts
     against `maxRetries`. Without a pool: warn ONCE and use note semantics.
7. Spend: nothing new is metered here (the judge waiver meters itself on `bus`).

## Tests (`packages/runtime-core/src/provability-gate.test.ts`)
Read `evaluation.test.ts` / `cascade.test.ts` for the fake-adapter harness and reuse it. Cover:
absent option = identical behaviour; pass; fail→retry→pass (the second model call sees the
synthetic nudge; nudge not in the returned text); retries exhausted (last answer stands, one
event per pass, retryIndex increments); halt (RunFailedError with exit 37, `run_failed`
event-log line, class "provability"); note; verifier throws → unverified, answer stands, warning
logged; escalate with a pool (forced onto the escalation arm) and without one (single warning,
note semantics); footer "stream" written to output after the answer and "reply" appended to the
returned single-turn text with a blank line, never in `messages`; `render: "none"` writes
nothing; `persist` path appears in the event; persist throwing is non-fatal; audit sink record;
`provability_graded` event-log line; ordering with `evaluation` (an evaluation retry happens
INSIDE a provability pass; a provability retry re-runs the evaluated turn); abort mid-turn;
REPL path too (one turn through the REPL loop). Update any test pinning trace kinds,
event-log kinds or the watchme kind partition (`watchme-capture.test.ts`,
`observability.test.ts`) if your new events need it.

Verify: `bunx tsc -b` in packages/runtime-core AND in every package that imports runtime-core
types you changed (`JustificationAuditSink` implementers: grep). `bun test` in
packages/runtime-core (the whole suite — it is large; let it run). biome on your files.
