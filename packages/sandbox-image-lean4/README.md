# @crewhaus/sandbox-image-lean4

v0.8.0 (design/0.8.0-provability-release.md §6.4, §13, §17.4): the curated Lean 4
image behind the provability ladder's `lean4` checker
(`@crewhaus/proof-checker`), registered into `@crewhaus/sandbox-image-registry`
exactly the way `@crewhaus/sandbox-image-go` registers Go.

```ts
import { ensureLean4SandboxImage, LEAN4_IMAGE_REF } from "@crewhaus/sandbox-image-lean4";
import { listAllowedImageRefs } from "@crewhaus/sandbox-image-registry";
import { createSandbox } from "@crewhaus/sandbox";

ensureLean4SandboxImage(); // idempotent; registerLean4SandboxImage() throws on a second call
const sandbox = createSandbox({ allowedImages: listAllowedImageRefs() }); // now includes LEAN4_IMAGE_REF
```

| Constant | Value |
|---|---|
| `LEAN4_IMAGE_ID` | `lean4` |
| `LEAN4_IMAGE_REPO` | `ghcr.io/crewhaus/sandbox-lean4` |
| `LEAN4_IMAGE_TAG` | `0.8.0` |
| `LEAN4_IMAGE_REF` | `ghcr.io/crewhaus/sandbox-lean4:0.8.0` |
| `LEAN4_TOOLCHAIN_VERSION` | `4.34.1` — the Lean release the image carries |
| `LEAN4_DEFAULT_ENTRYPOINT` | `lean --stdin --json` — one file on stdin, messages as JSON lines |
| `LEAN4_HEALTHCHECK_ARGV` | `lean --version` |
| `LEAN4_COLD_START_BUDGET_MS` | 4 000 — the looser bucket: a large toolchain |

**Mathlib-free.** A Mathlib image is multi-gigabyte (design §16); the curated
image carries the Lean toolchain alone, so proofs may import `Init` and `Std`. A
spec that needs Mathlib points `provability.formal.image` at its own image (on
the sandbox allowlist), and the lean4 adapter then also accepts `import Mathlib…`.

**The image is ours.** The release builds `ghcr.io/crewhaus/sandbox-lean4:<version>`
from this package's `Dockerfile` (the `sandbox-images` job in
`.github/workflows/release.yml`) and pushes it to GHCR. It is the official
`leanprover/lean4` 4.34.1 release — downloaded for the build's architecture
(BuildKit's `TARGETARCH`), checked against a sha256 pinned per architecture —
cut down to what `lean --stdin --json` needs for a file importing Init and Std:
`lean`, the shared libraries it links, and each Init/Std module's `.olean`,
`.olean.private`, `.olean.server` and `.ir`, plus `cadical`, the SAT solver
Std's `bv_decide` runs, with the C++ runtime it links (about 3 MB; a
`bv_decide` proof trusts the compiler, so the checker accepts one only when the
harness drops `native_decide` from `formal.forbid`). No clang/lld, static libraries,
lake, Lean/Lake modules or editor indexes: about 1 GB of a 3 GB toolchain, on
distroless `cc-debian13` (no shell, no package manager, no network tools),
running as uid 65532. The build elaborates one file importing Std with the
pruned tree (a `bv_decide` goal among it, so cadical runs too), so a toolchain
bump that needs another file fails the build. Not
elan: elan resolves toolchains over the network at first use and wants a
writable home. To build it locally with the exact ref the checker runs:
`bun scripts/build-sandbox-images.ts lean4` from the repo root. The tag is a constant, not
the package version read at runtime: a compiled `crewhaus` binary cannot read its
package.json, and a pinned tag keeps every release on a known toolchain. Bump
`LEAN4_IMAGE_TAG` when the image changes.

The lean4 adapter writes the file Lean elaborates itself — the model's statement
and proof inside one `theorem`, after a deterministic pre-scan, followed by the
adapter's own `#print axioms` (see the proof-checker README).

## Tests

T1/T2 (registration shape, allowlist round-trip through the noop sandbox), T7
(cold-start budget) and T8 (escape-attempt registrations), the
`sandbox-image-go` suite; `dockerfile.test.ts` holds the Dockerfile to its
contract without Docker (the version above, per-architecture sha256s, only Init
and Std unpacked, bases pinned by digest, a shipped stage with no `RUN`, no
shell and no root, the registry's healthcheck argv).
`CREWHAUS_SECTION36_LIVE_DOCKER=1 bun test` also runs the healthcheck against
the real image; the lean4 checker's live test in `@crewhaus/proof-checker` runs
proofs on it.
