# @crewhaus/preflight

Typed pre-spawn health checks for harnesses. Instead of spawning a process and
relaying the stack trace it dies with, run the checks first and render a
report: `"will not boot: SLACK_SIGNING_SECRET unset"`.

```ts
import { runPreflight } from "@crewhaus/preflight";

const report = await runPreflight({
  harnessDir: "/path/to/harness", // reads crewhaus.yaml, stats dist/
  env: mergedEnv,                 // the env the spawn would receive
});
if (!report.ok) {
  for (const item of report.blocking) console.error(item.message);
}
```

`PreflightReport` is `{ ok, blocking, items }`; each `PreflightItem` carries a
stable `id`, an `area` (`spec | credentials | channels | mcp | ports | bundle |
durability`), a `level` (`info | warn | blocking`), a `message`, and optional
`remediation` / `envVar` fields (the fleet credentials matrix keys on
`envVar`).

## Areas

| Area | What runs | Blocking when |
|---|---|---|
| `spec` | `parseSpecIssues` from `@crewhaus/spec`, plus caller-injected compiler warnings (this package never runs the compiler itself) | any spec issue — `parseSpec` (and so the compiler) throws on all of them |
| `credentials` | provider env-var matrix over the UNION of every model the spec can route to: `agent.model`, `model_fallbacks`, `model_tiers`, `model_pool` candidates, the `evaluation` judge model, the `budget` degrade model — mapped through the `@crewhaus/model-router` grammar | a required key group is unset (Bedrock, Vertex ADC, and `local/` endpoints are informational — their credentials are ambient or unneeded) |
| `channels` | the channel daemon's boot-gate secret env refs, offline (pure env presence — the exact set the compiled daemon exits 2 on) | an env-ref secret is unset, or a credential value would fail compilation |
| `mcp` | dry-run of boot-time secret-ref resolution via `@crewhaus/mcp-host`, plus lint for `$FOO`/`${FOO}` literals (the MCP transports never expand `$…` values) and credentials pasted inline | an env-ref is unset (the predicted `ConfigError` is the byte-identical one the boot would throw) |
| `ports` | bindability of `gateway.port`, a numeric `PORT` env, and any caller-requested ports | a port is already in use |
| `bundle` | `crewhaus.yaml` vs newest `dist/` mtime — labelled approximate; the `FreshnessComparator` seam accepts an exact spec-hash comparator once bundle manifests record one | never (warn only) |
| `durability` | channel daemon without `CREWHAUS_DEDUP_STORE`; live provider credentials with no `budget:` block | never (warn only) |

## Env injection

Every core function takes an explicit `env: Record<string, string |
undefined>` — nothing reads `process.env` except the `preflightHarness`
convenience wrapper. Pass the MERGED environment the spawn would actually
receive (harness `.env` chain layered under the manager's env), and the same
checks serve tests, CI, and a fleet manager identically.

## Extracted cores

The doctor-compatible credential checks (`buildCredentialChecks`,
`selectedProvider`, `providerCredentialsSatisfied`, `providerEnvStubs`,
`modelCredentialGroups`, `modelCredentialChecks`) and the channel boot-gate
checks (`platformSecretRefs`, `channelEnvChecks`,
`buildChannelEnvSummaryChecks`) preserve the CLI's check semantics and
messages, returning the shared `{ label, pass, warn?, reason? }` shape, so
`crewhaus doctor` and `crewhaus channel verify --offline` can consume them
directly. Channel inputs are structural (`SecretRef` mirrors the IR's
secret-ref shape), so both a compiler-lowered `IrChannels` and
`lowerSpecChannels(rawSpecChannels)` fit.
