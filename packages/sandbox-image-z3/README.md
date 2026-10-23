# @crewhaus/sandbox-image-z3

v0.8.0 (design/0.8.0-provability-release.md §6.4, §13): the curated Z3 image
behind the provability ladder's `smt` checker (`@crewhaus/proof-checker`),
registered into `@crewhaus/sandbox-image-registry` exactly the way
`@crewhaus/sandbox-image-go` registers Go.

```ts
import { ensureZ3SandboxImage, Z3_IMAGE_REF } from "@crewhaus/sandbox-image-z3";
import { listAllowedImageRefs } from "@crewhaus/sandbox-image-registry";
import { createSandbox } from "@crewhaus/sandbox";

ensureZ3SandboxImage(); // idempotent; registerZ3SandboxImage() throws on a second call
const sandbox = createSandbox({ allowedImages: listAllowedImageRefs() }); // now includes Z3_IMAGE_REF
```

| Constant | Value |
|---|---|
| `Z3_IMAGE_ID` | `z3` |
| `Z3_IMAGE_REPO` | `ghcr.io/crewhaus/sandbox-z3` |
| `Z3_IMAGE_TAG` | `0.8.0` |
| `Z3_IMAGE_REF` | `ghcr.io/crewhaus/sandbox-z3:0.8.0` |
| `Z3_SOLVER_VERSION` | `4.16.0` — the Z3 release the image carries |
| `Z3_DEFAULT_ENTRYPOINT` | `z3 -in` — one SMT-LIB 2 script on stdin |
| `Z3_HEALTHCHECK_ARGV` | `z3 --version` |
| `Z3_COLD_START_BUDGET_MS` | 2 000 — one native binary |

**The image is ours.** No suitable upstream image exists, so the release builds
`ghcr.io/crewhaus/sandbox-z3:<version>` from this package's `Dockerfile` (the
`sandbox-images` job in `.github/workflows/release.yml`) and pushes it to GHCR.
It is the official Z3 4.16.0 release binary — downloaded for the build's
architecture (BuildKit's `TARGETARCH`) and checked against a sha256 pinned per
architecture — on distroless `cc-debian13` (glibc, libstdc++; no shell, no
package manager, no network tools), running as uid 65532: about 70 MB. The
build context is empty (`.dockerignore`). To build it locally with the exact
ref the checker runs: `bun scripts/build-sandbox-images.ts z3` from the repo
root. The tag is a constant, not the package version read at runtime: a
compiled `crewhaus` binary cannot read its package.json, and a pinned tag keeps
every release on a solver whose version is known. Bump `Z3_IMAGE_TAG` when the
image changes. A spec cannot swap this image: `provability.formal.image`
overrides the lean4 image only. A library caller can, with
`createDefaultCheckers({ images: { smt } })` or `createSmtChecker({ image })`
from `@crewhaus/proof-checker` — that image must then be on the sandbox
allowlist too, and its Z3 has not met the smt checker's reserved-name probe.

The smt adapter writes the script Z3 runs itself; the model's problem is data
between the adapter's own `check-sat` commands, never a program (see the
proof-checker README).

## Tests

T1/T2 (registration shape, allowlist round-trip through the noop sandbox), T7
(cold-start budget) and T8 (escape-attempt registrations), the
`sandbox-image-go` suite; `dockerfile.test.ts` holds the Dockerfile to its
contract without Docker (the version above, per-architecture sha256s, bases
pinned by digest, a shipped stage with no `RUN`, no shell and no root, the
registry's healthcheck argv). `CREWHAUS_SECTION36_LIVE_DOCKER=1 bun test` also
runs the healthcheck against the real image; the smt checker's live test in
`@crewhaus/proof-checker` runs proofs on it.
