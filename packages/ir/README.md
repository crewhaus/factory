# @crewhaus/ir

The compiler's typed intermediate representation: one variant per harness shape
(`IrNode`), the loop projection (`projectLoop`) and the bundle README renderer.
Emitters consume the IR, never the raw spec.

## `@crewhaus/ir/slots`

`enumerateModelSlots(ir)` lists every model a lowered harness can call, one row
per slot: the primary model of each agent, step, node or role, its pool
candidates (the shadow arm included), tiers and fallback chains, the profiles a
sub-agent's Task call may pick, every judge (a judge the consumer defaults, such
as the justification judge's, with the model it runs), compaction, the degrade
target and the grounding model. Each row carries a label, the model string, its
kind, its `models:` profile and whether a downshift may swap it. A sub-agent
whose turns go to a remote peer is listed as kind `federation`, with the peer's
URL in place of a model: a reader that prices or resolves models skips it.

`auxModelsFor` and `primarySlot` are the views `doctor --models` and
`model right-size` read. The module is pure: no `node:` import, no file, no
pricing table, no clock.

## `@crewhaus/ir/support`

What each shape does with each setting a spec can declare, generated from the
compiler by `scripts/gen-support-manifest.ts` (never edited by hand). The same
data ships as `@crewhaus/ir/support-manifest.json` for readers in other
languages. The package's main entry does not load it.

A cell, per setting and shape (and per `<shape>@cf-worker` build), is one of:

- `wired`: the setting changes what the harness does, in its compiled bundle,
  in `crewhaus run`, or through a CLI verb that reads it (`via` says which:
  `bundle`, `interpreter` or `toolchain`; `structure` for a key the shape
  itself requires; `construction` for a safety setting a Cloudflare Worker
  meets by how it runs, so the build is the same with or without it);
- `degraded`: it takes effect, with a note the compiler prints;
- `unwired`: the shape accepts it and does not use it, and the compiler says so;
- `rejected`: the shape does not accept it;
- `authoring`: it records a decision and changes no compiled byte, by design.

`since` is the release whose compiler first gave the cell its status.

Readers:

- `declaredFeatures(spec)`: the settings a parsed spec declares, with their paths.
- `featureSupport({shape, declared, compiledWith})`: what they do for one
  harness, given the crewhaus version its bundle was compiled with. A harness
  with no build, or one built before this manifest existed, reads `unknown`
  with a note and `crewhaus compile` as the command that answers it; a build
  by a newer release than this one reads `unknown` with a note to update this
  CrewHaus, and no command. A shape the manifest does not list, and a cell it
  does not hold, read `unknown` too: never "supported" or "unsupported". A
  setting that took effect in a later release than the build reads
  `recompile`.
- `supportDescriptor({feature, shape, compiledWith})`: the same as a capability
  descriptor (`{supported: true}`, `{supported: false, reason, verb}` or
  `{supported: "unknown", reason}`).
