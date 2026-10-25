# @crewhaus/sandbox-image-lean4

The curated Lean 4 image behind the provability ladder's `lean4` checker
([`@crewhaus/proof-checker`](../proof-checker)): the ref the checker runs, the image's
`Dockerfile`, and a registration into `@crewhaus/sandbox-image-registry` exactly the way
`@crewhaus/sandbox-image-go` registers Go. A Mathlib image is multi-gigabyte, and elan resolves
toolchains over the network at first use, so the release builds a Mathlib-free image of its own
on a pinned toolchain.

```ts
import { ensureLean4SandboxImage, LEAN4_IMAGE_REF } from "@crewhaus/sandbox-image-lean4";
import { listAllowedImageRefs } from "@crewhaus/sandbox-image-registry";
import { createSandbox } from "@crewhaus/sandbox";

ensureLean4SandboxImage(); // idempotent; registerLean4SandboxImage() throws on a second call
const sandbox = createSandbox({ allowedImages: listAllowedImageRefs() }); // now includes LEAN4_IMAGE_REF
```

| Export | Value |
|---|---|
| `LEAN4_IMAGE_ID` | `lean4` |
| `LEAN4_IMAGE_REPO` | `ghcr.io/crewhaus/sandbox-lean4` |
| `LEAN4_IMAGE_TAG` | `0.8.0` |
| `LEAN4_IMAGE_REF` | `ghcr.io/crewhaus/sandbox-lean4:0.8.0` |
| `LEAN4_TOOLCHAIN_VERSION` | `4.34.1`, the Lean release the image carries |
| `LEAN4_DEFAULT_ENTRYPOINT` | `lean --stdin --json`: one file on stdin, messages as JSON lines |
| `LEAN4_HEALTHCHECK_ARGV` | `lean --version` |
| `LEAN4_COLD_START_BUDGET_MS` | 4 000: the looser bucket, for a large toolchain |
| `registerLean4SandboxImage()` | Registers the image and returns its `SandboxImageEntry`; throws if `lean4` is already registered |
| `ensureLean4SandboxImage()` | Registers it unless it already is; returns the entry either way |

## How it is wired

proof-checker's lean4 adapter runs `LEAN4_IMAGE_REF` by default (re-exported as
`DEFAULT_LEAN4_IMAGE`) and probes availability with `LEAN4_HEALTHCHECK_ARGV`. A spec that needs
Mathlib points `provability.formal.image` at its own image, which must be on the sandbox
allowlist, and the adapter then also accepts `import Mathlib…`. The provability gate builds its
own sandbox with the configured checkers' images on its allowlist (tool-proof's
`sandboxImages`), so it does not need the registry; `ensureLean4SandboxImage()` is for a caller
that builds its sandbox from `listAllowedImageRefs()`. The adapter writes the file Lean
elaborates itself: the model's statement and proof inside one `theorem`, after a deterministic
pre-scan, followed by the adapter's own `#print axioms` (see the proof-checker README).

## The image

The `sandbox-images` job in `.github/workflows/release.yml` builds
`ghcr.io/crewhaus/sandbox-lean4:<release version>` from this package's `Dockerfile`, runs it the
way the sandbox does on a proof, and pushes it to GHCR. A published version tag is never
replaced: the job skips a tag that already exists, and `:latest` moves only for a stable
`X.Y.Z`. The image is the official `leanprover/lean4` 4.34.1 release, downloaded for the build's
architecture (BuildKit's `TARGETARCH`) and checked against a sha256 pinned per architecture, cut
down to what `lean --stdin --json` needs for a file importing Init and Std: `lean`, the shared
libraries it links, each Init and Std module's `.olean`, `.olean.private`, `.olean.server` and
`.ir`, and `cadical`, the SAT solver Std's `bv_decide` runs, with the C++ runtime libraries it
links. No clang/lld, static libraries, lake, Lean or Lake modules, or editor indexes: a fraction
of the full toolchain, on distroless `cc-debian13` (no shell, no package manager, no network
tools), running as uid 65532. The build elaborates one file importing Std with the pruned tree,
a `bv_decide` goal among it, so a toolchain bump that needs another file fails the build rather
than the first proof.

To build it locally with the exact ref the checker runs:
`bun scripts/build-sandbox-images.ts lean4` from the repo root (`docker buildx`, or podman under
`CREWHAUS_SANDBOX=podman`).

`LEAN4_IMAGE_TAG` is a constant, not the package version read at runtime: a compiled `crewhaus`
binary cannot read its package.json. When the image changes, bump `LEAN4_IMAGE_TAG`; when Lean
does, change the Dockerfile's `LEAN_VERSION` and both sha256s, update `LEAN4_TOOLCHAIN_VERSION`
(a test holds the two in step), and run the proof-checker live test.

## Limits

- Proofs may import `Init` and `Std` only; Mathlib needs an image of your own.
- A `bv_decide` proof trusts the compiler, so the checker accepts one only when the harness drops
  `native_decide` from `formal.forbid`.
- The release publishes `linux/amd64` only, like the target images: an arm64 host runs it
  emulated, or builds it natively with the script above.

## Tests

```sh
bun test src
CREWHAUS_SECTION36_LIVE_DOCKER=1 bun test src   # also runs the healthcheck against the real image
```

`index.test.ts` is the `sandbox-image-go` suite: registration shape and the allowlist round-trip
through the noop sandbox (T1/T2), the cold-start budget (T7) and escape-attempt registrations
(T8). `dockerfile.test.ts` holds the Dockerfile to its contract without Docker: the version
above, per-architecture sha256s checked before unpacking, only `lean`, `cadical`, their shared
libraries and the Init and Std modules unpacked, the pruned tree elaborated at build time, bases
pinned by digest, a shipped stage with no `RUN`, no shell and no root, an empty build context,
and the registry's healthcheck argv. The live probe
uses the image in the local daemon (build it first, or docker pulls the published tag);
proof-checker's `sandbox.live.test.ts` runs proofs on it.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §6.4,
§13, §17.
