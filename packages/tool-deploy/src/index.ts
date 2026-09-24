/**
 * @crewhaus/tool-deploy — moving a spec version between environments in the
 * LOCAL registry, as deterministic tools: register-and-pin, roll back, and
 * say what is pinned where.
 *
 * Three tools, and one that is deliberately absent.
 *
 *   SpecPin        register a spec's current content as a version (content-
 *                  gated, so re-registering unchanged content is a no-op) and
 *                  pin that version to an environment, or to a tenant's
 *                  overlay of one.
 *   DeployRollback repoint an environment at an earlier version. Destructive,
 *                  dry-run by default.
 *   DeployInspect  read-only: versions, pins, tenant overlays, and whether the
 *                  thing each pin points at is actually still there.
 *
 *   DeployPromote  NOT BUILT. Its `protected_envs` guard — "refuse unless the
 *                  permission rule for toEnv resolved to an explicit allow" —
 *                  cannot be implemented by a tool. A tool sees its arguments
 *                  and its `tool_config`; it never sees how the permission
 *                  engine resolved the call, so an `alwaysAllow
 *                  DeployPromote(*)` satisfies the "explicit allow" half and
 *                  the guard becomes decoration on a tool whose whole purpose
 *                  is to be guarded. Building it would ship something that
 *                  LOOKS like a protection. Until the contract question is
 *                  settled, promote stays in `crewhaus deploy promote`, which
 *                  runs where the decision is known. `SpecPin` covers the
 *                  honest half: pin a known version to a named environment.
 *
 * Five properties hold across the package.
 *
 *   1. THE REAL PACKAGES. The storage layout, the name/version/environment
 *      grammars, the `vN` numbering, the content-hash gate, the changelog and
 *      the rollback orchestration belong to @crewhaus/spec-registry,
 *      @crewhaus/spec-changelog and @crewhaus/deployment-controller. None of
 *      them is restated here: the grammars are enforced by letting the adapter
 *      reject the input (the read that fetches the current pin is also the
 *      call that validates the environment name), the hash is the changelog
 *      package's own `contentHash`, and the next version is its `nextVersion`.
 *      This package contributes the schema, the containment, the refusals and
 *      the result shape.
 *   2. CONTAINMENT REACHES THE LEAVES, ON EVERY PATH THAT OPENS ONE.
 *      `paths.ts` is a verbatim copy of @crewhaus/tool-pkg's, and every path
 *      the REGISTRY opens goes through it — not just the root the caller
 *      named. `manifest.json`, `<v>.yaml`, `CHANGELOG.md` and
 *      `_tenants/<id>/<name>.json` are all written with `writeFileSync`,
 *      which follows a symlink at the name; containing the directory and not
 *      its leaves contains nothing. A READ is not exempt: `DeployInspect`'s
 *      tenant view once reached `_tenants/<id>/<name>.json` with no
 *      containment at all, and a symlink planted there returned a file from
 *      outside the workspace as that tenant's pinned version.
 *   3. COULD NOT DETERMINE IS NOT NO — AND IT IS NOT YES EITHER. A manifest
 *      that could not be parsed is never "this spec has no versions"; a
 *      `manifest.json` that is a dangling symlink is never an absent one (the
 *      registry's own `existsSync` cannot tell those apart, which is why it
 *      is probed with `lstat` first); a registry root that could not be
 *      listed is never an empty registry; a list of environments the adapter
 *      cannot enumerate for a tenant is never that tenant's pins. The same
 *      applies to `aliasForTenant`'s fallback, which was read as a definite
 *      answer in BOTH directions: as "this tenant is already pinned here" and
 *      as "this tenant is pinned elsewhere, so moving it destroys a binding".
 *      The overlay file's NAME is probed — never parsed — because its absence
 *      is the one thing that settles it.
 *   3b. NOTHING THIS PACKAGE DID NOT WRITE IS ECHOED RAW. A manifest's keys,
 *      a `listSpecs` directory name and a caller's `actor` reach the same
 *      model's context a refusal message does, so they go through the same
 *      `render`. Every grammar involved is the registry's, and none of them
 *      admits what `render` removes.
 *   4. A PIN IS ONLY AS GOOD AS WHAT IT POINTS AT. `registry.list()` reads the
 *      manifest and nothing else, so `deployment-controller`'s only rollback
 *      guard — `list(name).includes(version)` — passes for a version whose
 *      `<v>.yaml` is gone. The pin is written, the record reads like a
 *      successful deploy, and the environment points at nothing. Every version
 *      these tools pin to is FETCHED before anything is repointed at it.
 *   5. WHAT THIS BUILD CANNOT DO, IT SAYS. @crewhaus/audit-log is not a
 *      dependency, and it is the only place a deployment history exists. So
 *      no `deployment_action` record is appended and none is read back; both
 *      are reported as not done, by name, next to the change that did happen.
 *      Nothing here writes a substitute log.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createDeploymentController } from "@crewhaus/deployment-controller";
import { autoRegisterSpecVersion, nextVersion } from "@crewhaus/spec-changelog";
import { type RegistryAdapter, createFileBackedRegistry } from "@crewhaus/spec-registry";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  AUDIT_LOG_UNAVAILABLE,
  DEFAULT_REGISTRY_RELDIR,
  DEPLOY_HISTORY_UNAVAILABLE,
  MANIFEST_FILENAME,
  type ResolvedName,
  type TenantOverlayState,
  VERSION_DIFF_UNAVAILABLE,
  type VersionState,
  classifyRegistryError,
  containSpecPaths,
  containTenantPaths,
  predictRegistration,
  probeTenantOverlay,
  probeVersion,
  readManifest,
  resolveName,
} from "./lib/registry";
import {
  type Failure,
  type Loaded,
  contain,
  fail,
  json,
  probeName,
  refusal,
  render,
  renderAll,
  renderOpt,
  renderStrings,
  sample,
} from "./lib/result";

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

/** Longest actor label accepted, for the same reason paths are bounded. */
const MAX_ACTOR_CHARS = 200;

/** Ceiling on how many specs one DeployInspect answer enumerates. */
const DEFAULT_SPEC_LIMIT = 200;

const registryDirField = z
  .string()
  .optional()
  .describe(`the file-backed spec registry root (default: ${DEFAULT_REGISTRY_RELDIR})`);

const tenantField = z
  .string()
  .optional()
  .describe(
    'a tenant id — reads and writes the tenant\'s overlay pin instead of the global one. NOTE: @crewhaus/spec-registry\'s aliasForTenant falls back to the GLOBAL pin when the tenant\'s overlay does not cover the environment, and does not report which it returned. The result therefore carries a scope: "global-tenant-has-no-overlay" when this tenant has no overlay file at all (so the value IS the global pin and this tenant has no binding of its own), and "tenant-or-global" when it may be either.',
  );

/**
 * A registry opened at a contained root, with every path a call for this spec
 * can open already proved to stay in the workspace.
 */
type Opened = {
  readonly registry: RegistryAdapter;
  readonly rootRel: string;
  readonly rootAbs: string;
  readonly name: ResolvedName;
};

/**
 * Resolve the spec name, contain the registry root and every leaf under it,
 * and hand back an adapter pointed at the REAL (symlink-resolved) root.
 *
 * `knownVersions` is the set of version files the call may touch. It is
 * passed in rather than read here because the two writers need different
 * sets: a rollback touches one version, a registration reads every stored one
 * and writes the next.
 */
function open(
  tool: string,
  rawName: string,
  registryDirRel: string | undefined,
  knownVersions: ReadonlyArray<string>,
  tenant: string | undefined,
): Loaded<Opened> {
  const name = resolveName(rawName);
  if (!name.ok) return name;
  const rootRel = registryDirRel ?? DEFAULT_REGISTRY_RELDIR;
  // `contain`, not `containExistingDir`: SpecPin legitimately creates the
  // registry on first use. Existence is reported by the caller, not required.
  const root = contain(tool, rootRel);
  if (!root.ok) return root;
  const specPaths = containSpecPaths(tool, root.value, name.value.registryName, knownVersions);
  if (specPaths !== undefined) return specPaths;
  if (tenant !== undefined) {
    if (tenant.includes("\u0000")) {
      return fail("bad-input", `tenant id "${render(tenant)}" contains a NUL byte`);
    }
    const tenantPaths = containTenantPaths(tool, root.value, tenant, name.value.registryName);
    if (tenantPaths !== undefined) return tenantPaths;
  }
  return {
    ok: true,
    value: {
      // The adapter is given the REAL root. Operating on the already-resolved
      // path closes most of the check-to-use window between the containment
      // proof above and the syscalls the adapter makes.
      registry: createFileBackedRegistry({ rootDir: root.value.real }),
      rootRel: root.value.rel === "" ? "." : root.value.rel,
      rootAbs: root.value.real,
      name: name.value,
    },
  };
}

/**
 * The environment's current pin, and honestly labelled scope.
 *
 * This read is also the ENVIRONMENT NAME'S VALIDATION: `aliasFor` runs the
 * registry's own `ensureSafeEnv`, so an environment outside the grammar is
 * rejected by the package that owns the grammar rather than by a second regex
 * here. Every caller runs this before it writes anything.
 */
type CurrentPin = {
  readonly version: string | undefined;
  /**
   * `global` for a non-tenant call.
   *
   * For a tenant call, `aliasForTenant` silently falls back to the global pin
   * and does not say which one it returned. That ambiguity is REPORTED, never
   * guessed at — but it is not always present, and treating it as if it were
   * is its own defect. The tenant's overlay FILE is probed by name (never
   * parsed), and its absence settles the question in one direction: with no
   * overlay file, the value can only be the global pin and this tenant has no
   * binding of its own. That is `global-tenant-has-no-overlay`. With a file
   * there — or a name that could not be classified — the value may be either,
   * and the scope stays `tenant-or-global`.
   */
  readonly scope: "global" | "tenant-or-global" | "global-tenant-has-no-overlay";
  /** The overlay probe behind `scope`, for the result and for `decidePin`. */
  readonly overlay?: TenantOverlayState;
};

async function currentPin(
  opened: Opened,
  environment: string,
  tenant: string | undefined,
): Promise<Loaded<CurrentPin>> {
  try {
    const version =
      tenant !== undefined
        ? await opened.registry.aliasForTenant(tenant, opened.name.registryName, environment)
        : await opened.registry.aliasFor(opened.name.registryName, environment);
    if (tenant === undefined) return { ok: true, value: { version, scope: "global" } };
    const overlay = probeTenantOverlay(opened.rootAbs, tenant, opened.name.registryName);
    return {
      ok: true,
      value: {
        version,
        scope: overlay.state === "absent" ? "global-tenant-has-no-overlay" : "tenant-or-global",
        overlay,
      },
    };
  } catch (err) {
    return classifyRegistryError(
      err,
      `the current pin for "${render(opened.name.registryName)}" in "${render(environment)}"`,
    );
  }
}

/** The `currentPinScope` note a result carries, so the label is never bare. */
function scopeNote(current: CurrentPin): string | undefined {
  switch (current.scope) {
    case "global":
      return undefined;
    case "global-tenant-has-no-overlay":
      return "this tenant has no overlay file for this spec, so @crewhaus/spec-registry's aliasForTenant can only have returned the GLOBAL pin. The value above is not this tenant's own binding.";
    default:
      return `@crewhaus/spec-registry's aliasForTenant returns the tenant's overlay when one covers this environment and the global pin when it does not, without saying which${current.overlay?.state === "unknown" ? `, and ${current.overlay.reason}` : ""}. The value above may be either.`;
  }
}

/** The name fields every result carries, so the mapping is never invisible. */
function nameFields(name: ResolvedName): Record<string, unknown> {
  return {
    spec: render(name.given),
    registryName: render(name.registryName),
    ...(name.mapped
      ? {
          nameWasMapped: `"${render(name.given)}" is stored as "${render(name.registryName)}" by @crewhaus/spec-changelog's registrySpecName; that mapped name is what every check and every pin below acted on`,
        }
      : {}),
  };
}

/** A version state, flattened for a result field. */
function versionReport(state: VersionState): Record<string, unknown> {
  switch (state.state) {
    case "retrievable":
      return { retrievable: true, bytes: state.bytes };
    case "missing":
      return { retrievable: false, problem: "its file is not in the registry" };
    case "unreadable":
      return { retrievable: false, problem: state.reason };
  }
}

// ---------------------------------------------------------------------------
// SpecPin
// ---------------------------------------------------------------------------

/**
 * The pin decision, shared by the preview and the real write.
 *
 * It is a function of the target version, so the real path calls it TWICE:
 * once before registering (against the predicted version, so a call that will
 * be refused is refused before anything is written) and once after (against
 * the version that was really registered). Both calls are this function —
 * there is no second copy of the rule that decides whether a pin may move.
 *
 * `aliasForTenant`'S ANSWER IS NOT A STATEMENT ABOUT THE TENANT, IN EITHER
 * DIRECTION. It is the tenant's overlay when one covers the environment and
 * the GLOBAL pin when it does not, and the adapter never says which. So the
 * comparison against `target` has two wrong readings, and this function has
 * been burned by both:
 *
 *   EQUAL read as "already pinned, nothing to do" leaves a tenant that asked
 *   for an explicit pin with no overlay at all, silently following the global
 *   pin the next time it moves. So under a tenant the overlay is always
 *   written; it is idempotent, and writing it is the difference between "acme
 *   is pinned to v1" and "acme happens to resolve to v1 today".
 *
 *   DIFFERENT read as "this tenant is pinned elsewhere, so moving it destroys
 *   a binding" is the mirror image, and it is worse, because it REFUSES. A
 *   tenant with no overlay has no binding to destroy: writing its first
 *   overlay leaves the global pin exactly where it was, still readable and
 *   still recoverable. Refusing that with `code: "conflict"` and "the previous
 *   binding would exist nowhere afterwards" states something about the tenant
 *   that is simply false, and pushes the caller to `repin:true` — the flag
 *   whose whole meaning is "I accept losing the binding this replaces".
 *
 * Which reading applies is settled by the overlay probe behind
 * `current.scope`, not by the version comparison: `global-tenant-has-no-
 * overlay` means the file is not there, so the conflict cannot exist. Any
 * other tenant scope leaves the ambiguity, and the refusal then SAYS it is
 * ambiguous rather than asserting a tenant pin.
 */
type PinDecision =
  | {
      readonly kind: "set";
      readonly from: string | undefined;
      readonly to: string;
      /** True when `from` equals `to`: the write is what makes the pin explicit. */
      readonly madeExplicit?: boolean;
      /** True when this writes a tenant's FIRST overlay; `from` is the global pin. */
      readonly firstTenantOverlay?: boolean;
    }
  | { readonly kind: "unchanged"; readonly at: string }
  | { readonly kind: "refuse"; readonly failure: Failure };

function decidePin(current: CurrentPin, target: string, repin: boolean): PinDecision {
  if (current.version === target) {
    return current.scope === "global"
      ? { kind: "unchanged", at: target }
      : { kind: "set", from: current.version, to: target, madeExplicit: true };
  }
  // No overlay file means the value above is the global pin and this tenant
  // has no binding of its own — there is nothing to conflict with, and the
  // global pin is not touched by writing the overlay. `from` is deliberately
  // `undefined`: reporting the global pin as the version this tenant is
  // moving FROM is the same false claim in a quieter place.
  if (current.scope === "global-tenant-has-no-overlay") {
    return { kind: "set", from: undefined, to: target, firstTenantOverlay: true };
  }
  if (current.version !== undefined && !repin) {
    return {
      kind: "refuse",
      failure: fail(
        "conflict",
        current.scope === "global"
          ? `that environment is already pinned to "${render(current.version)}" and would be repointed at "${render(target)}". @crewhaus/spec-registry has no unpin and keeps no pin history, so the previous binding would exist nowhere afterwards except this tool's answer. Pass repin:true to move it — the previous version is returned so you can put it back.`
          : `that environment RESOLVES to "${render(current.version)}" for this tenant and would be repointed at "${render(target)}". @crewhaus/spec-registry's aliasForTenant does not say whether "${render(current.version)}" is this tenant's own overlay or the global pin showing through, and this tenant does have an overlay file, so it may be either. The registry has no unpin and keeps no pin history, so if it IS the tenant's own it would exist nowhere afterwards except this tool's answer. Pass repin:true to move it — the version above is returned so you can put it back. DeployInspect reports the same value with the same caveat.`,
      ),
    };
  }
  return { kind: "set", from: current.version, to: target };
}

export const specPin: RegisteredTool = buildTool({
  name: "SpecPin",
  operativeArgs: [
    { field: "registryDir", kind: "path" },
    { field: "specFile", kind: "path" },
    { field: "env", kind: "id", within: "name" },
  ],
  description:
    "Register a spec file's current content as a version in the local spec registry and pin that version to an environment (or to a tenant's overlay of one). Registration is @crewhaus/spec-changelog's autoRegisterSpecVersion: content-hashed, so re-registering unchanged content is a no-op that reports the version already holding it, and each new version appends a distilled entry to the per-spec CHANGELOG.md beside the manifest. Pinning is @crewhaus/spec-registry's own. It REFUSES to move a pin that already exists unless repin:true (the registry has no unpin and no pin history, so the previous binding would survive nowhere else) — but a tenant's FIRST overlay is not such a move: with no overlay file the version aliasForTenant returned is the global pin showing through its fallback, nothing of the tenant's is replaced, and the global pin is not touched, so it is written rather than refused. It refuses a spec name that maps onto the shared \"spec\" fallback directory, refuses when the manifest cannot be read or is a symlink (an unreadable manifest is never treated as 'no versions'), and refuses when any path the registry would open — the spec directory, its manifest, its changelog, a version file, a tenant overlay — resolves outside the workspace. NO AUDIT RECORD IS WRITTEN: @crewhaus/audit-log is not a dependency of this package, and the result says so next to the pin that did change. dryRun changes nothing and previews the same pin decision the real call makes.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .describe(
        "the spec's name as the spec spells it; it is mapped onto the registry's grammar and the result reports the mapped name",
      ),
    specFile: z
      .string()
      .min(1)
      .describe("path to the spec YAML whose current content should be registered"),
    env: z
      .string()
      .optional()
      .describe(
        "the environment alias to pin the registered version to; omit to register the version without moving any pin",
      ),
    tenant: tenantField,
    registryDir: registryDirField,
    repin: z
      .boolean()
      .optional()
      .describe("allow repointing an environment that is already pinned (default false)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("report what WOULD happen and change nothing (default false)"),
  }),
  // The repin path repoints an environment, and the binding it replaces is
  // kept nowhere. Declared destructive so the floor treats it that way.
  destructive: true,
  requireJustification: true,
  execute: async (input) => {
    const tool = "SpecPin";
    const dryRun = input.dryRun ?? false;
    const repin = input.repin ?? false;

    // The spec file first: there is no point containing a registry for a
    // registration whose input cannot be read.
    const specFile = contain(tool, input.specFile);
    if (!specFile.ok) return refusal(tool, specFile.code, specFile.reason);
    const fileProbe = probeName(specFile.value.real);
    if (fileProbe.kind === "absent" || (fileProbe.kind === "symlink" && fileProbe.dangling)) {
      return refusal(tool, "missing", `"${render(input.specFile)}" does not exist`);
    }
    if (fileProbe.kind === "directory") {
      return refusal(tool, "not-a-directory", `"${render(input.specFile)}" is a directory`);
    }
    let yaml: string;
    try {
      yaml = readFileSync(specFile.value.real, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return refusal(
        tool,
        "unreadable",
        `"${render(input.specFile)}" could not be read (${code ?? (err as Error).message})`,
      );
    }

    // Contain the root and the leaves. The version files are not known yet, so
    // this first pass contains what does not depend on them; the manifest read
    // below then yields the version list and the set is re-contained in full.
    const first = open(tool, input.name, input.registryDir, [], input.tenant);
    if (!first.ok) return refusal(tool, first.code, first.reason);

    const manifestState = await readManifest(
      first.value.registry,
      first.value.rootAbs,
      first.value.name,
    );
    if (manifestState.state === "unknown") {
      return refusal(
        tool,
        manifestState.failure.code,
        `${manifestState.failure.reason} — refusing to register into a registry whose manifest cannot be read. An unreadable manifest is not an empty one, and registering against it would write a fresh manifest over whatever is there.`,
        nameFields(first.value.name),
      );
    }
    const versions = manifestState.state === "known" ? manifestState.manifest.versions : [];
    const candidate = nextVersion(versions);

    // Now the full path set: every stored version (autoRegisterSpecVersion
    // reads them all to content-match) plus the one it may write.
    const opened = open(
      tool,
      input.name,
      input.registryDir,
      [...versions, candidate],
      input.tenant,
    );
    if (!opened.ok) return refusal(tool, opened.code, opened.reason);
    const { registry, name, rootAbs, rootRel } = opened.value;

    const prediction = await predictRegistration(
      registry,
      name.registryName,
      versions,
      yaml,
      candidate,
    );
    const predictedVersion = prediction.outcome === "undetermined" ? undefined : prediction.version;

    const common = {
      tool,
      ...nameFields(name),
      registryDir: render(rootRel),
      ...(input.tenant !== undefined ? { tenant: render(input.tenant) } : {}),
      registryHadManifest: manifestState.state === "known",
    };

    // --- register-only: no env, so no pin decision at all -------------------
    if (input.env === undefined) {
      if (dryRun) {
        return json({
          ...common,
          status: "preview",
          dryRun: true,
          registration: prediction,
          pin: { changed: false, reason: "no env was given, so no pin was considered" },
          nothingWasChanged: true,
        });
      }
      const registered = await register(registry, rootAbs, name, yaml);
      if (!registered.ok) return refusal(tool, registered.code, registered.reason, common);
      return json({
        ...common,
        status: "registered",
        dryRun: false,
        registration: registered.value,
        predictionHeld: predictionHeld(prediction, registered.value),
        pin: { changed: false, reason: "no env was given, so no pin was moved" },
      });
    }

    const env = input.env;
    const before = await currentPin(opened.value, env, input.tenant);
    if (!before.ok) return refusal(tool, before.code, before.reason, common);

    const scopeText = scopeNote(before.value);
    const pinContext = {
      currentPin: renderOpt(before.value.version) ?? null,
      currentPinScope: before.value.scope,
      ...(scopeText !== undefined ? { currentPinScopeNote: scopeText } : {}),
    };

    // Pre-check against the PREDICTED version: a call that the pin guard will
    // refuse should refuse before a version is written, not after.
    if (predictedVersion !== undefined) {
      const early = decidePin(before.value, predictedVersion, repin);
      if (early.kind === "refuse") {
        return refusal(tool, early.failure.code, early.failure.reason, {
          ...common,
          env: render(env),
          ...pinContext,
          wouldPinTo: render(predictedVersion),
          registration: renderStrings(prediction),
          nothingWasChanged: true,
        });
      }
    } else if (!repin && before.value.version !== undefined) {
      // THE HOLE THE PRE-CHECK ABOVE USED TO LEAVE. With no predicted version
      // there was nothing to pre-check, so the call fell through, REGISTERED a
      // version, and only then hit the pin guard — returning
      // `registered-not-pinned` for a call that was always going to be
      // refused, having minted a version nothing can unregister.
      //
      // The target is unknown, but the QUESTION is not: with an existing pin
      // and no `repin`, the only outcome that does not refuse is "the content
      // is already stored at exactly the version this environment points at".
      // That is answerable, and answerable with the rule already in use — the
      // same `predictRegistration`, over the single version in question — so
      // no second content-identity rule appears here.
      const atCurrent = await predictRegistration(
        registry,
        name.registryName,
        [before.value.version],
        yaml,
        candidate,
      );
      if (atCurrent.outcome !== "unchanged") {
        return refusal(
          tool,
          atCurrent.outcome === "undetermined" ? "unreadable" : "conflict",
          `${prediction.outcome === "undetermined" ? prediction.reason : "the registration outcome could not be predicted"} — so this call would register a version and then be refused by the pin guard, because "${render(env)}" is already pinned to "${render(before.value.version)}" and repin was not set. ${atCurrent.outcome === "undetermined" ? `Whether this content is the one already pinned there could not be established either: ${atCurrent.reason}.` : "This content is not the version pinned there, so the pin would have had to move."} Nothing was registered. Pass repin:true to move the pin, or fix the unreadable version file.`,
          {
            ...common,
            env: render(env),
            ...pinContext,
            registration: renderStrings(prediction),
            nothingWasChanged: true,
          },
        );
      }
    }

    if (dryRun) {
      const decision =
        predictedVersion === undefined
          ? {
              kind: "undetermined",
              reason: prediction.outcome === "undetermined" ? prediction.reason : "",
            }
          : decidePin(before.value, predictedVersion, repin);
      return json({
        ...common,
        status: "preview",
        dryRun: true,
        env: render(env),
        ...pinContext,
        registration: renderStrings(prediction),
        pinDecision: renderStrings(decision as Record<string, unknown>),
        nothingWasChanged: true,
        auditRecord: AUDIT_LOG_UNAVAILABLE,
      });
    }

    const registered = await register(registry, rootAbs, name, yaml);
    if (!registered.ok)
      return refusal(tool, registered.code, registered.reason, { ...common, env });
    const version = registered.value.version;
    // The residual this design cannot close: `autoRegisterSpecVersion`
    // re-reads the manifest and picks the next version ITSELF, so between the
    // read that produced the contained set and the write, another process
    // could have added a version and moved the target. The same inputs give
    // the same answer, so this fires only under a concurrent writer — and
    // then it is reported rather than left as a write to a path this call
    // never proved contained.
    const containmentNote =
      registered.value.status === "registered" &&
      !versions.includes(version) &&
      version !== candidate
        ? `the version written ("${render(version)}") is not the one this call contained ("${render(candidate)}") — another writer changed the registry in between, so that file's path was not proved to stay inside the workspace. Re-run DeployInspect to confirm the registry.`
        : undefined;

    // Re-decide against the version that was ACTUALLY registered. Same
    // function, and the answer can differ from the pre-check if the
    // prediction did not hold — in which case the registration stands and the
    // pin does not, which is what this reports.
    const decision = decidePin(before.value, version, repin);
    if (decision.kind === "refuse") {
      return json({
        ...common,
        status: "registered-not-pinned",
        dryRun: false,
        env: render(env),
        registration: renderStrings(registered.value),
        predictionHeld: predictionHeld(prediction, registered.value),
        ...pinContext,
        pin: { changed: false, code: decision.failure.code, reason: decision.failure.reason },
      });
    }
    if (decision.kind === "unchanged") {
      return json({
        ...common,
        status: "unchanged",
        dryRun: false,
        env: render(env),
        registration: renderStrings(registered.value),
        predictionHeld: predictionHeld(prediction, registered.value),
        ...pinContext,
        pin: {
          changed: false,
          at: render(decision.at),
          reason: "that environment already pinned this version",
        },
      });
    }

    try {
      if (input.tenant !== undefined) {
        await registry.pinForTenant(input.tenant, name.registryName, env, version);
      } else {
        await registry.pin(name.registryName, env, version);
      }
    } catch (err) {
      const f = classifyRegistryError(
        err,
        `pinning "${render(name.registryName)}" "${render(env)}" → "${render(version)}"`,
      );
      return json({
        ...common,
        status: "registered-not-pinned",
        dryRun: false,
        env: render(env),
        registration: renderStrings(registered.value),
        predictionHeld: predictionHeld(prediction, registered.value),
        ...pinContext,
        pin: { changed: false, code: f.code, reason: f.reason },
      });
    }

    // Assert on what happened, not on what was asked for: read the alias back.
    const after = await currentPin(opened.value, env, input.tenant);
    const landed = after.ok ? after.value.version : undefined;
    return json({
      ...common,
      status: "pinned",
      dryRun: false,
      env: render(env),
      registration: renderStrings(registered.value),
      predictionHeld: predictionHeld(prediction, registered.value),
      ...(containmentNote !== undefined ? { containmentNote } : {}),
      pin: {
        changed: true,
        from: renderOpt(decision.from) ?? null,
        to: render(decision.to),
        fromScope: before.value.scope,
        ...(scopeText !== undefined ? { fromScopeNote: scopeText } : {}),
        ...(decision.madeExplicit === true
          ? {
              // Two different facts, so two different sentences: with no
              // overlay file the fallback is not an ambiguity, it is settled.
              madeExplicit:
                before.value.scope === "global-tenant-has-no-overlay"
                  ? "this tenant has no overlay file for this spec, so the version it RESOLVED to was the global pin showing through @crewhaus/spec-registry's fallback, not a pin of its own. The overlay was written, which is what makes the pin the tenant's own rather than one that follows the global pin the next time it moves."
                  : "the tenant already RESOLVED to this version, but @crewhaus/spec-registry could not say whether that was the tenant's own overlay or the global pin showing through. The overlay was written, which is what makes the pin the tenant's own rather than one that follows the global pin the next time it moves.",
            }
          : {}),
        ...(decision.firstTenantOverlay === true
          ? {
              firstTenantOverlay: `this tenant had no overlay file for this spec, so it had no pin of its own to replace: "${render(env)}" was resolving through @crewhaus/spec-registry's fallback to the GLOBAL pin${before.value.version === undefined ? "" : ` ("${render(before.value.version)}")`}, which this write did not touch and which is still there. "from" is null for that reason — reporting the global pin as the version this tenant moved from would be a binding this tenant never had.`,
            }
          : {}),
      },
      verified: landed === version,
      ...(landed === version
        ? {}
        : {
            verificationProblem: after.ok
              ? `the alias reads back as ${landed === undefined ? "unpinned" : `"${render(landed)}"`} rather than "${render(version)}"`
              : after.reason,
          }),
      auditRecord: AUDIT_LOG_UNAVAILABLE,
    });
  },
});

type Registration = { readonly status: "registered" | "unchanged"; readonly version: string };

/** `autoRegisterSpecVersion`, with its throws classified rather than escaping. */
async function register(
  registry: RegistryAdapter,
  rootAbs: string,
  name: ResolvedName,
  yaml: string,
): Promise<Loaded<Registration>> {
  try {
    const result = await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootAbs,
      // The DISPLAY name: autoRegisterSpecVersion applies registrySpecName
      // itself, and handing it the already-mapped name would map twice. The
      // mapping is idempotent today, but relying on that is exactly the kind
      // of coupling that breaks quietly.
      specName: name.given,
      yaml,
    });
    return { ok: true, value: { status: result.status, version: result.version } };
  } catch (err) {
    return classifyRegistryError(err, `registering "${render(name.registryName)}"`);
  }
}

/**
 * Did the dry-run prediction match what `autoRegisterSpecVersion` really did?
 *
 * Reported rather than assumed. The prediction is built from the changelog
 * package's own `contentHash` over the same stored bytes, but it is still a
 * second evaluation of a decision that package owns; if the two ever disagree
 * the tool says so instead of presenting the prediction as the outcome.
 */
function predictionHeld(
  prediction: Awaited<ReturnType<typeof predictRegistration>>,
  actual: Registration,
): boolean | string {
  if (prediction.outcome === "undetermined") return "not predicted";
  const predictedStatus = prediction.outcome === "unchanged" ? "unchanged" : "registered";
  return predictedStatus === actual.status && prediction.version === actual.version
    ? true
    : `predicted ${predictedStatus} ${prediction.version}, got ${actual.status} ${actual.version}`;
}

// ---------------------------------------------------------------------------
// DeployRollback
// ---------------------------------------------------------------------------

/**
 * Words a caller will reach for that this build cannot resolve.
 *
 * "previous" is the one the survey sketch assumed exists. It does not, and it
 * cannot here: the registry manifest stores one version per environment with
 * no history, and the only record of what an environment used to point at is
 * the @crewhaus/audit-log `deployment_action` chain, which this package does
 * not depend on. Silently treating "previous" as a literal version name would
 * refuse with "version not in registry", which reads like a typo rather than
 * a missing capability — so it is named and refused for the real reason.
 */
const RELATIVE_VERSION_WORDS = new Set(["previous", "prev", "last", "prior", "before", "back"]);

type RollbackPlan = {
  readonly registryName: string;
  readonly env: string;
  readonly toVersion: string;
  readonly currentPin: string | undefined;
  readonly currentPinScope: CurrentPin["scope"];
  /** What that scope means, so the label is never left to be interpreted. */
  readonly currentPinScopeNote: string | undefined;
  readonly target: VersionState;
  readonly knownVersions: ReadonlyArray<string>;
  /** True when the environment already points at `toVersion`. */
  readonly noop: boolean;
};

/**
 * The selection, run by BOTH the preview and the real call — never a parallel
 * preview. Everything that can refuse a rollback refuses here, so a dry run
 * that reports a plan is a dry run whose real counterpart will act.
 */
async function planRollback(
  opened: Opened,
  environment: string,
  toVersion: string,
  tenant: string | undefined,
  knownVersions: ReadonlyArray<string>,
): Promise<Loaded<RollbackPlan>> {
  const { registry, rootAbs, name } = opened;
  if (knownVersions.length === 0) {
    return fail(
      "missing",
      `the registry has no versions for "${render(name.registryName)}" — there is nothing to roll back to. Register one with SpecPin first.`,
    );
  }
  if (!knownVersions.includes(toVersion)) {
    const shown = sample([...knownVersions].sort(), 20);
    return fail(
      "bad-input",
      `"${render(toVersion)}" is not a version this registry has seen for "${render(name.registryName)}". Rolling back to an unregistered version would write no pin and read as a successful deploy. Known versions: ${renderAll(
        shown.shown,
      )
        .map((v) => `"${v}"`)
        .join(
          ", ",
        )}${shown.total > shown.shown.length ? ` (+${shown.total - shown.shown.length} more)` : ""}.`,
    );
  }
  // Manifest-listed is not the same as present. `deployment-controller`'s only
  // guard is `list(name).includes(version)`, which the check above already
  // mirrors; this is the one it does not have.
  const target = await probeVersion(registry, rootAbs, name.registryName, toVersion);
  if (target.state !== "retrievable") {
    const why =
      target.state === "missing"
        ? "its file is not in the registry, although the manifest still lists it"
        : target.reason;
    return fail(
      target.state === "missing" ? "missing" : "unreadable",
      `"${render(toVersion)}" is listed in the manifest for "${render(name.registryName)}" but ${why} — refusing to repoint "${render(environment)}" at a version whose content cannot be fetched. The pin would be written and the environment would resolve to nothing.`,
    );
  }
  const before = await currentPin(opened, environment, tenant);
  if (!before.ok) return before;
  return {
    ok: true,
    value: {
      registryName: name.registryName,
      env: environment,
      toVersion,
      currentPin: before.value.version,
      currentPinScope: before.value.scope,
      currentPinScopeNote: scopeNote(before.value),
      target,
      knownVersions,
      // Only a GLOBAL pin can be concluded to be already there. Under a
      // tenant this equality may be the global pin showing through
      // `aliasForTenant`'s fallback, and skipping the write would leave the
      // tenant with no overlay — still following the global pin, which is the
      // opposite of a rollback that was asked for by tenant.
      noop: before.value.scope === "global" && before.value.version === toVersion,
    },
  };
}

export const deployRollback: RegisteredTool = buildTool({
  name: "DeployRollback",
  operativeArgs: [
    { field: "registryDir", kind: "path" },
    { field: "env", kind: "id", within: "name" },
  ],
  description:
    "Repoint an environment (or a tenant's overlay of one) at an earlier registered version of a spec, through @crewhaus/deployment-controller's rollback. DESTRUCTIVE: @crewhaus/spec-registry has no unpin and keeps no pin history, so the binding this replaces survives nowhere afterwards. dryRun defaults to TRUE and runs the same selection the real call runs. It REFUSES a relative version word such as \"previous\" (the registry keeps one version per environment with no history; the only record of what an environment used to point at is the @crewhaus/audit-log deployment_action chain, which this package does not depend on — use DeployInspect to pick a version by name), refuses a version this registry has never seen, refuses a version the manifest lists but whose file cannot be fetched (that pin would be written and the environment would resolve to nothing, reading as a successful deploy), refuses when the manifest cannot be read, and refuses when any path the registry would open resolves outside the workspace. NO AUDIT RECORD IS WRITTEN: @crewhaus/audit-log is not a dependency of this package, and the result says so next to the pin that did change.",
  inputSchema: z.object({
    name: z.string().min(1).describe("the spec's name as the spec spells it"),
    env: z.string().min(1).describe("the environment whose pin should be repointed"),
    toVersion: z
      .string()
      .min(1)
      .describe(
        'the exact registered version to roll back to (e.g. "v3"); relative words like "previous" are refused because this build has no pin history to resolve them against',
      ),
    tenant: tenantField,
    registryDir: registryDirField,
    actor: z
      .string()
      .optional()
      .describe("who is performing the rollback; echoed in the deployment record"),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "report what WOULD happen and change nothing. Defaults to TRUE: this tool takes an explicit dryRun:false to act.",
      ),
  }),
  destructive: true,
  requireJustification: true,
  execute: async (input) => {
    const tool = "DeployRollback";
    const dryRun = input.dryRun ?? true;

    if (input.actor !== undefined && input.actor.length > MAX_ACTOR_CHARS) {
      return refusal(tool, "bad-input", `actor is longer than ${MAX_ACTOR_CHARS} characters`);
    }
    // Refuse the relative word on the PARSED value, before it is ever used as
    // a version name or a path component.
    if (RELATIVE_VERSION_WORDS.has(input.toVersion.trim().toLowerCase())) {
      return refusal(
        tool,
        "bad-input",
        `"${render(input.toVersion)}" is not a version name, and this build cannot resolve a relative one: @crewhaus/spec-registry stores one version per environment with no history, and the record of what an environment used to point at lives only in the @crewhaus/audit-log deployment_action chain, which @crewhaus/tool-deploy does not depend on. Run DeployInspect to see the registered versions and pass one by name.`,
      );
    }

    // First pass with no version files; the manifest read yields the list.
    const first = open(tool, input.name, input.registryDir, [], input.tenant);
    if (!first.ok) return refusal(tool, first.code, first.reason);
    const manifestState = await readManifest(
      first.value.registry,
      first.value.rootAbs,
      first.value.name,
    );
    if (manifestState.state === "unknown") {
      return refusal(
        tool,
        manifestState.failure.code,
        `${manifestState.failure.reason} — refusing to roll back against a manifest that cannot be read. An unreadable manifest is not one with no versions, and treating it as empty would refuse a version that is really there.`,
        nameFields(first.value.name),
      );
    }
    if (manifestState.state === "absent") {
      return refusal(
        tool,
        "missing",
        `there is no registry entry for "${render(first.value.name.registryName)}" under "${render(first.value.rootRel)}" — no ${MANIFEST_FILENAME}, so no versions and no pins.`,
        nameFields(first.value.name),
      );
    }
    const versions = manifestState.manifest.versions;

    const opened = open(tool, input.name, input.registryDir, versions, input.tenant);
    if (!opened.ok) return refusal(tool, opened.code, opened.reason);
    const { registry, name, rootRel } = opened.value;

    const common = {
      tool,
      ...nameFields(name),
      registryDir: render(rootRel),
      env: render(input.env),
      ...(input.tenant !== undefined ? { tenant: render(input.tenant) } : {}),
      ...(input.actor !== undefined ? { actor: render(input.actor) } : {}),
    };

    const plan = await planRollback(
      opened.value,
      input.env,
      input.toVersion,
      input.tenant,
      versions,
    );
    if (!plan.ok) return refusal(tool, plan.code, plan.reason, common);

    const planReport = {
      toVersion: render(plan.value.toVersion),
      currentPin: renderOpt(plan.value.currentPin) ?? null,
      currentPinScope: plan.value.currentPinScope,
      ...(plan.value.currentPinScopeNote !== undefined
        ? { currentPinScopeNote: plan.value.currentPinScopeNote }
        : {}),
      targetVersion: versionReport(plan.value.target),
      registeredVersions: {
        shown: renderAll([...plan.value.knownVersions].sort().slice(0, 50)),
        total: plan.value.knownVersions.length,
      },
    };

    if (plan.value.noop) {
      // Writing the pin anyway would succeed and return a record that reads
      // like a rollback, when nothing moved. Reported as its own status.
      return json({
        ...common,
        status: "unchanged",
        dryRun,
        plan: planReport,
        reason: `"${render(input.env)}" already points at "${render(plan.value.toVersion)}"; no pin was written. Writing it would have returned a record that reads like a rollback when nothing moved.`,
        nothingWasChanged: true,
      });
    }

    if (dryRun) {
      return json({
        ...common,
        status: "preview",
        dryRun: true,
        plan: planReport,
        nothingWasChanged: true,
        auditRecord: AUDIT_LOG_UNAVAILABLE,
      });
    }

    const controller = createDeploymentController({
      registry,
      // No `auditLog`: see AUDIT_LOG_UNAVAILABLE. The controller treats it as
      // optional and simply does not append; nothing here fabricates one.
      ...(input.tenant !== undefined ? { tenantId: input.tenant } : {}),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
    });
    let record: Awaited<ReturnType<typeof controller.rollback>>;
    try {
      record = await controller.rollback(name.registryName, input.env, plan.value.toVersion);
    } catch (err) {
      const f = classifyRegistryError(
        err,
        `rolling "${render(name.registryName)}" "${render(input.env)}" back to "${render(plan.value.toVersion)}"`,
      );
      return refusal(tool, f.code, f.reason, { ...common, plan: planReport });
    }

    // Read the alias back rather than trusting the record.
    const after = await currentPin(opened.value, input.env, input.tenant);
    const landed = after.ok ? after.value.version : undefined;
    return json({
      ...common,
      status: "rolled-back",
      dryRun: false,
      plan: planReport,
      // The controller's own payload, kept verbatim in SHAPE (rebuilding it
      // would be a second copy of a type that package owns) with its strings
      // neutralised: `fromVersion` comes out of the manifest and `actor` out
      // of the caller, and both reach the same reader as every other field.
      record: renderStrings(record),
      verified: landed === plan.value.toVersion,
      ...(landed === plan.value.toVersion
        ? {}
        : {
            verificationProblem: after.ok
              ? `the alias reads back as ${landed === undefined ? "unpinned" : `"${render(landed)}"`} rather than "${render(plan.value.toVersion)}"`
              : after.reason,
          }),
      auditRecord: AUDIT_LOG_UNAVAILABLE,
    });
  },
});

// ---------------------------------------------------------------------------
// DeployInspect
// ---------------------------------------------------------------------------

export const deployInspect: RegisteredTool = buildTool({
  name: "DeployInspect",
  description:
    "Read-only: what is pinned where in the local spec registry. Reports each spec's registered versions, its environment pins, and — for every pin — whether the version it points at can actually be fetched, because @crewhaus/spec-registry's list() reads the manifest and nothing else, so a pin can point at a version whose file is gone. With a tenant, reports the tenant's effective alias per environment with both limits stated: whether an overlay file exists for that spec at all (its name is probed, never parsed), and that the environments listed are the spec's GLOBAL pins, because @crewhaus/spec-registry exposes no way to enumerate the environments a tenant's overlay covers — an environment pinned ONLY for that tenant is not listed unless env names it. The tenant's overlay path is contained before it is read, like every other path these tools open. An environment name outside the registry's own grammar is refused rather than reported as unpinned. A registry root that is absent is reported as absent and a root or manifest that could not be read is reported as unread — neither is ever reported as an empty registry. Two things this build cannot show are named rather than omitted: the deployment history (it lives only in the @crewhaus/audit-log deployment_action chain, which this package does not depend on) and a field-level diff between two versions (that is @crewhaus/spec-patch's diffSpecYaml — use SpecDiff; the per-spec CHANGELOG.md beside the manifest already carries the diff recorded at registration).",
  inputSchema: z.object({
    name: z
      .string()
      .optional()
      .describe("a single spec to inspect; omit to enumerate every spec in the registry"),
    env: z
      .string()
      .optional()
      .describe("report only this environment's pin, instead of every environment"),
    tenant: tenantField,
    registryDir: registryDirField,
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`most specs to enumerate (default ${DEFAULT_SPEC_LIMIT})`),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const tool = "DeployInspect";
    const limit = input.limit ?? DEFAULT_SPEC_LIMIT;
    const rootRel = input.registryDir ?? DEFAULT_REGISTRY_RELDIR;
    const root = contain(tool, rootRel);
    if (!root.ok) return refusal(tool, root.code, root.reason);
    const shownRoot = root.value.rel === "" ? "." : root.value.rel;

    const unavailable = {
      deployHistory: { available: false, reason: DEPLOY_HISTORY_UNAVAILABLE },
      versionDiff: { available: false, reason: VERSION_DIFF_UNAVAILABLE },
    };

    // The root's NAME, before anything reads through it. `listSpecs` probes
    // with `existsSync`, so a dangling symlink root answers `[]` — an empty
    // registry that is really a door.
    const rootProbe = probeName(root.value.abs);
    if (rootProbe.kind === "absent") {
      return json({
        tool,
        status: "ok",
        registryDir: render(shownRoot),
        registry: { present: false, reason: `"${render(rootRel)}" does not exist` },
        ...unavailable,
      });
    }
    if (rootProbe.kind === "unreadable") {
      return refusal(
        tool,
        "unreadable",
        `"${render(rootRel)}" could not be examined (${rootProbe.code})`,
      );
    }
    if (rootProbe.kind === "symlink" && rootProbe.dangling) {
      return refusal(
        tool,
        "unreadable",
        `"${render(rootRel)}" is a symlink whose target does not exist — @crewhaus/spec-registry follows it and would report an empty registry, which is not the same answer as "this registry has no specs".`,
      );
    }
    if (rootProbe.kind === "file" || rootProbe.kind === "other") {
      return refusal(tool, "not-a-directory", `"${render(rootRel)}" is not a directory`);
    }

    const registry = createFileBackedRegistry({ rootDir: root.value.real });

    // Which specs. A named one is resolved through the same mapping the
    // writers use; otherwise the adapter enumerates.
    let givenNames: string[];
    let named: ResolvedName | undefined;
    if (input.name !== undefined) {
      const resolved = resolveName(input.name);
      if (!resolved.ok) return refusal(tool, resolved.code, resolved.reason);
      named = resolved.value;
      givenNames = [resolved.value.registryName];
    } else {
      try {
        givenNames = [...(await registry.listSpecs())].sort();
      } catch (err) {
        const f = classifyRegistryError(err, `the registry root "${render(rootRel)}"`);
        // An unlistable root is not an empty one.
        return refusal(tool, f.code, `${f.reason} — this is "could not list", not "no specs".`);
      }
    }

    const specs: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    let envChecked = false;
    for (const registryName of givenNames.slice(0, limit)) {
      // Contain what the enumeration handed back, not only what the caller
      // typed: `listSpecs` is a `readdir`, and a directory entry can be a
      // symlink pointing anywhere.
      const paths = containSpecPaths(tool, root.value, registryName, []);
      if (paths !== undefined) {
        skipped.push({ spec: render(registryName), code: paths.code, reason: paths.reason });
        continue;
      }
      const name: ResolvedName = named ?? {
        given: registryName,
        registryName,
        mapped: false,
      };
      const state = await readManifest(registry, root.value.real, name);
      if (state.state === "unknown") {
        // Not "no versions": this spec's answer is that it could not be read.
        specs.push({
          ...nameFields(name),
          present: "unknown",
          code: state.failure.code,
          reason: state.failure.reason,
        });
        continue;
      }
      if (state.state === "absent") {
        specs.push({
          ...nameFields(name),
          present: false,
          reason: `no ${MANIFEST_FILENAME} under "${render(path.join(shownRoot, registryName))}"`,
        });
        continue;
      }
      const manifest = state.manifest;
      if (input.env !== undefined && !envChecked) {
        // The environment grammar belongs to @crewhaus/spec-registry, so it is
        // enforced by ASKING the adapter rather than by a second ENV_REGEX
        // here. `readManifest` has just proved this spec name grammatical, so
        // a SpecRegistryError out of `aliasFor` can only be about the
        // environment. Without this, an environment the registry could never
        // pin came back as `envNotPinned` — a definite "this environment has
        // no pin", which reads as an environment that exists.
        envChecked = true;
        try {
          await registry.aliasFor(registryName, input.env);
        } catch (err) {
          const f = classifyRegistryError(err, `the environment "${render(input.env)}"`);
          if (f.code === "bad-input") {
            return refusal(
              tool,
              "bad-input",
              `${f.reason} — no pin can exist under that name, so reporting it as "not pinned" would answer a question about an environment that cannot be.`,
            );
          }
        }
      }
      const envs = Object.keys(manifest.pins)
        .filter((e) => input.env === undefined || e === input.env)
        .sort();
      // The versions about to be OPENED come out of the manifest — a file on
      // disk, so a value in it is no more trusted than a caller's argument.
      // `<root>/<name>/<v>.yaml` is contained before it is probed, because a
      // pin reading "../../../elsewhere" would otherwise be `lstat`ed and
      // read outside the workspace on the strength of what a file said.
      const probeVersions = [...new Set(envs.map((e) => manifest.pins[e] as string))];
      const versionPaths = containSpecPaths(tool, root.value, registryName, probeVersions);
      if (versionPaths !== undefined) {
        specs.push({
          ...nameFields(name),
          present: "unknown",
          code: versionPaths.code,
          reason: `a version this spec pins to resolves outside the workspace, so its pins were not examined: ${versionPaths.reason}`,
        });
        continue;
      }
      const pins: Array<Record<string, unknown>> = [];
      for (const environment of envs) {
        const version = manifest.pins[environment] as string;
        pins.push({
          env: render(environment),
          version: render(version),
          ...versionReport(await probeVersion(registry, root.value.real, registryName, version)),
        });
      }
      const entry: Record<string, unknown> = {
        ...nameFields(name),
        present: true,
        versions: {
          shown: renderAll([...manifest.versions].sort().slice(0, 50)),
          total: manifest.versions.length,
        },
        pins,
        ...(input.env !== undefined && !Object.hasOwn(manifest.pins, input.env)
          ? { envNotPinned: render(input.env) }
          : {}),
      };
      if (input.tenant !== undefined) {
        // `aliasForTenant` OPENS `<root>/_tenants/<id>/<name>.json`, and a
        // symlink at that name is followed like any other. The two writers
        // contain it through `open()`; this read used to reach it with no
        // containment at all, so a planted link returned a file from outside
        // the workspace as this tenant's pinned version. Containing the
        // directory the caller named and not the leaf contains nothing —
        // whether the leaf is written or only read.
        const tenantPaths = containTenantPaths(tool, root.value, input.tenant, registryName);
        entry["tenant"] =
          tenantPaths !== undefined
            ? {
                id: render(input.tenant),
                read: false,
                code: tenantPaths.code,
                reason: `this tenant's overlay was NOT read: ${tenantPaths.reason}`,
              }
            : await tenantView(
                registry,
                root.value.real,
                registryName,
                input.tenant,
                input.env !== undefined ? [input.env] : Object.keys(manifest.pins).sort(),
                input.env !== undefined,
              );
      }
      specs.push(entry);
    }

    return json({
      tool,
      status: "ok",
      registryDir: render(shownRoot),
      registry: { present: true },
      specs: { shown: specs, total: givenNames.length },
      ...(skipped.length > 0 ? { skipped } : {}),
      ...unavailable,
    });
  },
});

/**
 * A tenant's effective alias per environment, with both limits stated.
 *
 * `aliasForTenant` returns the tenant's overlay when one covers the
 * environment and the GLOBAL pin when it does not, and does not say which.
 * The overlay file is never PARSED here — the pin rule stays the registry's —
 * but its NAME is probed, exactly as `manifest.json`'s is, because its absence
 * is the one thing that settles the ambiguity.
 *
 * THE SECOND LIMIT IS THE ENVIRONMENT LIST, and leaving it unsaid was a
 * silent under-report. `@crewhaus/spec-registry` exposes no way to enumerate
 * the environments a tenant's overlay covers, so the list below is the spec's
 * GLOBAL pins — and `pinForTenant` does not require a global pin for the
 * environment it writes. An environment pinned ONLY for this tenant therefore
 * has no entry here, and an empty `effective` is not "this tenant resolves
 * nothing". Both are now said in the answer, with the way to ask about a
 * specific environment.
 */
async function tenantView(
  registry: RegistryAdapter,
  rootAbs: string,
  registryName: string,
  tenant: string,
  envs: ReadonlyArray<string>,
  envWasNamed: boolean,
): Promise<Record<string, unknown>> {
  const overlay = probeTenantOverlay(rootAbs, tenant, registryName);
  const effective: Array<Record<string, unknown>> = [];
  for (const environment of envs) {
    try {
      const version = await registry.aliasForTenant(tenant, registryName, environment);
      effective.push({ env: render(environment), effectiveVersion: renderOpt(version) ?? null });
    } catch (err) {
      const f = classifyRegistryError(
        err,
        `the tenant alias for "${render(registryName)}" in "${render(environment)}"`,
      );
      effective.push({ env: render(environment), effectiveVersion: null, problem: f.reason });
    }
  }
  return {
    id: render(tenant),
    overlayFile:
      overlay.state === "unknown"
        ? { state: "unknown", reason: overlay.reason }
        : { state: overlay.state },
    effective,
    environmentsListed: envWasNamed
      ? "the one environment this call named"
      : "the spec's GLOBAL pins",
    note:
      overlay.state === "absent"
        ? "this tenant has no overlay file for this spec, so every effectiveVersion above is the GLOBAL pin showing through @crewhaus/spec-registry's fallback — this tenant has no pin of its own here."
        : `effectiveVersion is @crewhaus/spec-registry's aliasForTenant: the tenant's overlay when one covers that environment, otherwise the global pin. The adapter does not report which, so a value here is not evidence that this tenant has an overlay for that environment.${overlay.state === "unknown" ? ` Whether an overlay file exists at all could not be established: ${overlay.reason}.` : ""}`,
    ...(envWasNamed
      ? {}
      : {
          incompleteBecause:
            "@crewhaus/spec-registry exposes no way to enumerate the environments a tenant's overlay covers, so the list above is the spec's global pins. pinForTenant does not require a global pin for the environment it writes, so an environment pinned ONLY for this tenant is NOT listed here — pass env to ask about one by name. An empty list is 'no globally pinned environment', not 'this tenant resolves nothing'.",
        }),
  };
}

/** Every tool this package registers, in the order a catalog should list them. */
export const DEPLOY_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  deployInspect,
  deployRollback,
  specPin,
]);
