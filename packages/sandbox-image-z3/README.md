# @crewhaus/sandbox-image-z3

The curated Z3 image behind the provability ladder's `smt` checker
([`@crewhaus/proof-checker`](../proof-checker)): the ref the checker runs, the image's
`Dockerfile`, and a registration into `@crewhaus/sandbox-image-registry` exactly the way
`@crewhaus/sandbox-image-go` registers Go. No suitable upstream image exists, so the release
builds this one, and a pinned tag keeps every release on a solver whose version is known.

```ts
import { ensureZ3SandboxImage, Z3_IMAGE_REF } from "@crewhaus/sandbox-image-z3";
import { listAllowedImageRefs } from "@crewhaus/sandbox-image-registry";
import { createSandbox } from "@crewhaus/sandbox";

ensureZ3SandboxImage(); // idempotent; registerZ3SandboxImage() throws on a second call
const sandbox = createSandbox({ allowedImages: listAllowedImageRefs() }); // now includes Z3_IMAGE_REF
```

| Export | Value |
|---|---|
| `Z3_IMAGE_ID` | `z3` |
| `Z3_IMAGE_REPO` | `ghcr.io/crewhaus/sandbox-z3` |
| `Z3_IMAGE_TAG` | `0.8.0` |
| `Z3_IMAGE_REF` | `ghcr.io/crewhaus/sandbox-z3:0.8.0` |
| `Z3_SOLVER_VERSION` | `4.16.0`, the Z3 release the image carries |
| `Z3_DEFAULT_ENTRYPOINT` | `z3 -in`: one SMT-LIB 2 script on stdin |
| `Z3_HEALTHCHECK_ARGV` | `z3 --version` |
| `Z3_COLD_START_BUDGET_MS` | 2 000: one native binary |
| `registerZ3SandboxImage()` | Registers the image and returns its `SandboxImageEntry`; throws if `z3` is already registered |
| `ensureZ3SandboxImage()` | Registers it unless it already is; returns the entry either way |

## How it is wired

proof-checker's smt adapter runs `Z3_IMAGE_REF` by default (re-exported as `DEFAULT_SMT_IMAGE`)
and probes availability with `Z3_HEALTHCHECK_ARGV`. The provability gate builds its own sandbox
with the configured checkers' images on its allowlist (tool-proof's `sandboxImages`), so it does
not need the registry; `ensureZ3SandboxImage()` is for a caller that builds its sandbox from
`listAllowedImageRefs()`. The adapter writes the script Z3 runs itself: the model's problem is
data between the adapter's own `check-sat` commands, never a program (see the proof-checker
README).

## The image

The `sandbox-images` job in `.github/workflows/release.yml` builds
`ghcr.io/crewhaus/sandbox-z3:<release version>` from this package's `Dockerfile`, runs it the way
the sandbox does (no network, read-only root, a `/tmp` tmpfs, uid 65532) on an SMT-LIB problem,
and pushes it to GHCR. A published version tag is never replaced: the job skips a tag that
already exists, and `:latest` moves only for a stable `X.Y.Z`. The image is the official Z3
4.16.0 release binary, downloaded for the build's architecture (BuildKit's `TARGETARCH`) and
checked against a sha256 pinned per architecture, on distroless `cc-debian13` (glibc, libstdc++;
no shell, no package manager, no network tools), running as uid 65532. The build context is
empty (`.dockerignore`).

To build it locally with the exact ref the checker runs: `bun scripts/build-sandbox-images.ts z3`
from the repo root (`docker buildx`, or podman under `CREWHAUS_SANDBOX=podman`).

`Z3_IMAGE_TAG` is a constant, not the package version read at runtime: a compiled `crewhaus`
binary cannot read its package.json. When the image changes, bump `Z3_IMAGE_TAG`; when Z3 does,
change the Dockerfile's `Z3_VERSION` and both sha256s, update `Z3_SOLVER_VERSION` (a test holds
the two in step), and run the proof-checker live test, which fails when the new solver resolves a
built-in name the smt checker's reserved list lacks.

## Limits

- The release publishes `linux/amd64` only, like the target images: an arm64 host runs it
  emulated, or builds it natively with the script above.
- A spec cannot swap this image: `provability.formal.image` overrides the lean4 image only. A
  library caller can, with `createDefaultCheckers({ images: { smt } })` or
  `createSmtChecker({ image })`; that image must then be on the sandbox allowlist too, and its Z3
  has not met the smt checker's reserved-name probe.

## Tests

```sh
bun test src
CREWHAUS_SECTION36_LIVE_DOCKER=1 bun test src   # also runs the healthcheck against the real image
```

`index.test.ts` is the `sandbox-image-go` suite: registration shape and the allowlist round-trip
through the noop sandbox (T1/T2), the cold-start budget (T7) and escape-attempt registrations
(T8). `dockerfile.test.ts` holds the Dockerfile to its contract without Docker: the version
above, per-architecture sha256s checked before unpacking, bases pinned by digest, a shipped stage
with no `RUN`, no shell and no root, an empty build context, and the registry's healthcheck
argv. The live probe uses the image in the local daemon (build it first, or docker pulls the
published tag); proof-checker's `sandbox.live.test.ts` runs proofs on it.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §6.4,
§13.
