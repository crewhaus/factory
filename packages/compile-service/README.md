# @crewhaus/compile-service

Check and compile a draft spec without registering or writing anything
([#514](https://github.com/crewhaus/factory/issues/514),
[#513](https://github.com/crewhaus/factory/issues/513)). A person editing a draft in Home, or
running `crewhaus lint`, sees every problem at once, and can try a build, before anything touches a
harness.

The design is in [module brief 334](https://github.com/crewhaus/docs/blob/main/module-briefs/334-compile-service.md).

## What it offers

| Export | What it does |
|---|---|
| `checkSpec(yamlText, opts?)` | One result: every schema issue (or every cross-field issue once the schema passes), the settings the schema does not know, the lowering's refusal, tool errors, warnings marked informational or not, IR-pass findings, feature support for the spec's shape, the credentials each model slot needs (names, and presence when `opts.env` is given) and the schema that answered. A spec with an unknown setting, or newer than this schema, gets `readOnly` with the reason. Synchronous; never throws for anything a spec can contain. |
| `compileDraft(yamlText, opts)` | The files a build would hold (with the pinned `package.json` `crewhaus compile` writes beside a local bundle), their `bundleDigest` and the provenance stamp. Writes nothing, registers nothing. `emitAs: "cf-worker"` builds as `crewhaus compile --emit-as cf-worker` does. |
| `runCheckStages(yamlText, opts?)` | The one check pipeline: parse, lower, the IR passes (collect-all), the tool check, the compile warnings, the model-plan checks and the budget-period note. `checkSpec` and `crewhaus lint` both call it, once each. |
| `checkResultOf(yamlText, stages, opts?)` | The `checkSpec` result for stages already run. |
| `bundle-stamp` exports | `buildBundlePackageJson`, `collectCrewhausDeps`, `BundleSpecStamp`, and `specRevision` / `bundleDigest` / `bundleManifestText` re-exported from `@crewhaus/ir/policy`. |
| `emitCfWorkerBundle`, `INFORMATIONAL_COMPILE_WARNING_CODES`, `auditModelPlan` | The Worker build switch, the warning codes `--strict` never fails on, and the model-plan checks, moved here from the CLI (which re-exports them). |

`@crewhaus/compile-service/check-build` holds `compile --check`'s engine (`runCompileCheck`, with
the caller's manifest rule injected) and `checkBuild(files, opts)`, which writes a bundle held in
memory into a fresh directory under `tmpRoot` (every path checked to stay inside it first) and runs
the same three steps: the shape assertion, `bun install`, and a credential-free boot. Every
subprocess goes through the required `runner`; none is used implicitly.

## Boundaries

`checkSpec` and `compileDraft` read no file, open no socket, start no process, read no registry and,
with `today` set, read no clock. Credentials appear by name and presence only, never by value. The
package imports no harness registry or spec registry; a test holds that, and another runs both
functions with an empty `HOME` and working directory and checks nothing was written.

It carries the compiler and every emitter, so it is heavy by design: a compiled harness never
imports it, and Home loads it on first use. Its consumers today are `crewhaus` and
`@crewhaus/hangar-server`.
