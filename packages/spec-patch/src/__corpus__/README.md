# Hand-edited spec corpus

Specs vendored verbatim from [crewhaus/demos](https://github.com/crewhaus/demos), so the
minimal-diff writer is tested against files people wrote by hand: comments above and beside
keys, block scalars, flow lists and mixed indentation.

| File | Source in crewhaus/demos |
|---|---|
| `procode.crewhaus.yaml` | `starters/showcases/procode/crewhaus.yaml` |
| `trader.crewhaus.yaml` | `starters/trader/crewhaus.yaml` |
| `hybrid-support.crewhaus.yaml` | `starters/hybrid-support/crewhaus.yaml` |
| `expert.crewhaus.yaml` | `starters/expert/crewhaus.yaml` |

`corpus.test.ts` reads every file here. Copy a file again rather than editing it, so it stays
what an author wrote. The demos specs quote no keys, so none here do either.
