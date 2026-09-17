# @crewhaus/tool-crewhaus

CrewHaus's own operations, as deterministic tools — so a manager harness can
supervise a fleet of other harnesses with no model call.

Is this spec valid? Will it compile? What does it grant, and what changed since
yesterday? Is that bundle stale? Did the eval hold the line? What did the week
cost? Is the audit chain intact? Every one of those has a right answer, and a
supervisor that has to spend a model turn to get it is a supervisor that costs
money to watch paint dry.

```yaml
tools:
  - specValidate
  - specCompileCheck
  - harnessInventory
  - bundleFreshness
  - evalBaselineCompare
```

| Tool | What it does |
|---|---|
| `SpecValidate` | Every YAML, schema and cross-field issue in a spec, with the path that owns it |
| `SpecCompileCheck` | Lower and compile in memory — the offline "will this build" check, no bundle written |
| `SpecSummarize` | Shape, models, tools, MCP servers, permissions and declared blocks as structured JSON — `env`/`headers` by key, `sse` URLs cut to origin and path, stdio argv redacted |
| `SpecDiff` | What changed between two specs, semantically, and which changes widen capability |
| `ToolInventory` | The tools a spec grants, builtin vs MCP, with `all-<category>` selectors expanded |
| `PermissionAudit` | Which rule covers each granted tool, and which outward tools no rule names |
| `PreflightRun` | The full preflight against an explicitly supplied env: blocking items, warnings, remediation |
| `HarnessInventory` | The harnesses under a root — name, shape, model, spec path, bundle state |
| `BundleFreshness` | Which compiled bundles are older than their spec, or missing |
| `AuditVerify` | Re-walk the audit log's hash chain and report the first break |
| `EvalBaselineCompare` | The release gate: pass-rate delta, per-sample regressions, threshold verdict |
| `SessionSummarize` | Event counts, tool tallies and errors from a harness's session logs |
| `TraceQuery` | A filtered slice of those events — by kind, time window, or payload substring |
| `CostSummarize` | Cost and token totals by model, by provider and by UTC day |

## The real libraries, not a CLI wrapper

Nothing here shells out to `crewhaus`, and nothing re-implements it. Specs go
through `@crewhaus/spec`, compiles through `@crewhaus/compiler`, preflight
through `@crewhaus/preflight`, chain verification through
`@crewhaus/audit-log`. A tool here cannot drift from the product, because it
*is* the product's code — which is also why `SpecCompileCheck` is worth
trusting: it runs the same `compile()` the CLI runs, and then throws the
bundle away.

## Four properties

**Containment.** Every caller-supplied path goes through `resolveSafe` (copied
from `@crewhaus/tool-fsx`), which refuses anything resolving outside
`process.cwd()`, including via a symlink inside the workspace, and refuses a
path carrying a NUL before any syscall sees it. The discovery walk never
follows a directory symlink, for the same reason.

The boundary has to hold for the libraries too. `runPreflight` will read its
own `<harnessDir>/crewhaus.yaml` given the chance, which is a read this
package's gate never saw — so `PreflightRun` reads that file itself, through
`resolveSafe` and under the size cap, and hands the text over as `specYaml`.
A harness directory whose `crewhaus.yaml` is a symlink out of the workspace is
refused, rather than read and reflected back through the report's findings.

Refusals are bounded too: the path a caller supplied is truncated and stripped
of control characters before it is echoed, and no refusal splices in a node
error, because those carry an absolute path the caller never supplied.

**No ambient environment.** `PreflightRun` takes its environment as an
argument and never reads `process.env`. The environment a supervisor must
check is the one the *spawn* would receive — the harness's own `.env` chain
under the manager's env — not whatever the manager happens to have exported.
There is a test that sets a credential in `process.env` and asserts preflight
still reports it missing.

**Determinism.** Listings sort with plain string comparison, never
`localeCompare`. Timestamps in results come from the data being read, not from
the clock. The one place a clock could enter — the compiler's model-sunset
check — is exposed as an explicit `today` input, so a pipeline can pin it.

**Bounded work.** Every read is size-checked from the file's `stat` *before* a
byte is read, so a refusal costs no memory; the session-log parser walks the
text rather than `split`ting it, so the event cap bounds the parse and not
just the result. `AuditVerify` is the awkward one: `@crewhaus/audit-log`'s
`verify` takes no deadline and no abort signal, so once it starts it runs to
completion. The only honest bound is to measure the chain first and refuse up
front, which is what `maxBytes` does — a size cap standing in for a deadline
this package cannot impose, and worth knowing before you point it at an
enormous log.

**Honest limits.** A permission report that overstates its reach is worse than
none, so each tool says what it cannot see. `PermissionAudit` matches the
tool-name half of a pattern and reports `Bash(git *)` as *conditional* cover
rather than pretending to evaluate future arguments; it also sees only the
spec's rules, not the CLI flags, settings file and builtin floor that also
apply at run time. Where it *can* be exact it is: a pattern the runtime
matcher would refuse to compile is listed under `malformedRules` and scored
the way the engine scores it — a broken `alwaysDeny` or `alwaysAsk` fails
closed and gates every call, a broken `alwaysAllow` is dropped — and under
`mode: plan` the report says outright that no rule is consulted at all,
because the engine decides on the tool's own `readOnly` flag and returns
before the scan. `ToolInventory` can prove an MCP tool names an undeclared
server, but a builtin key is only checked against a `knownTools` list you
supply, because the builtin registry lives in the compiled bundle rather than
in the spec. `BundleFreshness` uses preflight's mtime heuristic and says so —
`stale` means "recompile to be sure", not "proven different". `AuditVerify`
returns `anchorChecked`, because a chain that verifies without an anchor has
not ruled out a dropped tail. `EvalBaselineCompare` reads a results document
without believing it: a declared `passRate` outside 0..1 is discarded in
favour of the samples, one the samples contradict is reported as a note, and a
repeated `sampleId` is named, because samples are matched by id and a repeat
silently shadows its twin.

## What is deliberately not here

Anything that changes a harness. There is no start, stop, compile-to-disk,
deploy or rollback in this package: every tool is `readOnly` and none is
`destructive`. A supervisor built from these tools can *decide* to act; the
acting is somebody else's tool call, and that separation is what makes it safe
to grant the whole set.

Also absent: anything requiring a provider. "It compiles" is not "it runs" —
credentials, rate limits and model availability are live facts no offline
check can answer.

## Layout

`src/lib/` holds the pure logic — the spec projection and its diff, the
permission matcher, the eval gate, the session-log arithmetic — and is where
the behaviour is tested. `src/index.ts` wraps it as tools, `src/paths.ts` is
the containment gate, `src/discover.ts` is the harness walk.

## Safety flags

Thirteen of the fourteen are `readOnly`, non-destructive, `scope: "internal"`
with no declared io capability, and concurrency-safe. `PreflightRun` is the
exception on two counts: it binds each declared port briefly to see whether it
is free, which is real socket I/O, so it declares `scope: "external"` with
`ioCapability: "network"` — and because that bind is *exclusive*, it declares
`concurrencySafe: false`. The runtime parallelises siblings that are
`concurrencySafe && readOnly && !destructive`, and two probes of the same port
in flight at once make the loser report a free port as taken. A blocking item
that is simply false is worse than a slower report.
`src/integration.test.ts` asserts all of that — including that
`auditToolScopes` finds nothing — so a future addition that reaches outside
has to change the assertion deliberately.
