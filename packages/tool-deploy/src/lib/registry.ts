/**
 * The registry seam: everything these three tools must establish BEFORE
 * `@crewhaus/spec-registry`, `@crewhaus/deployment-controller` or
 * `@crewhaus/spec-changelog` are allowed to touch a file.
 *
 * WHAT IS NOT HERE. The storage layout, the name/version/environment
 * grammars, the pin rule, the content-hash gate, the `vN` numbering, the
 * changelog rendering and the promote/rollback orchestration all belong to
 * those three packages and are not restated. There is no second manifest
 * parser here (`@crewhaus/tool-lifecycle` has one because it does not depend
 * on the registry; this package does, so it asks the adapter), no second
 * content hash, and no second next-version rule.
 *
 * WHAT IS HERE, AND WHY EACH PIECE HAD TO BE.
 *
 *   1. THE NAME THE REGISTRY WILL ACTUALLY USE. A caller names a spec the way
 *      the spec does ("Brewbird Support"); the registry stores it under
 *      `registrySpecName`'s mapping ("Brewbird-Support"). Every containment
 *      check, every refusal message and every result field below is built on
 *      the MAPPED name, because that is the one the filesystem sees. Acting
 *      on the caller's spelling while the store acts on the mapped one is the
 *      parse-then-act-on-the-original defect, and here it is worse than
 *      cosmetic: the mapping is many-to-one, so "a b" and "a-b" land in the
 *      same directory and a rollback aimed at one can repoint the other.
 *   2. THE PATHS THE REGISTRY OPENS. `spec-registry` does not export its
 *      filenames, so they are mirrored here — and asserted against the real
 *      adapter in `lib.test.ts` rather than trusted, so a rename upstream
 *      fails a test here instead of silently un-containing a write.
 *   3. A TRI-STATE MANIFEST READ. `loadManifest` returns an empty manifest
 *      for a file that is not there, and throws for one it cannot parse. Both
 *      answers matter and they are different; neither may become "no
 *      versions".
 *   4. THE DANGLING-SYMLINK PROBE. The registry's readers use `existsSync`,
 *      which follows links, so a dangling `manifest.json` reads as an absent
 *      one — an empty manifest, a clean "no versions", and a write that lands
 *      on the link's target. That is the one case where absence and a door
 *      are spelled the same, so it is probed with `lstat` instead.
 */
import { join } from "node:path";
import { contentHash, registrySpecName } from "@crewhaus/spec-changelog";
import type { Manifest, RegistryAdapter } from "@crewhaus/spec-registry";
import { SpecRegistryError } from "@crewhaus/spec-registry";
import type { SafePath } from "../paths";
import { type Failure, type Loaded, containUnder, fail, probeName, render } from "./result";

/** Default registry root, matching `@crewhaus/spec-registry`'s file backend. */
export const DEFAULT_REGISTRY_RELDIR = ".crewhaus/specs";

/**
 * `@crewhaus/spec-registry`'s on-disk names, mirrored because the package
 * keeps them private. Containment cannot be done without knowing them, and a
 * path that is not known is a path that is not contained. `lib.test.ts` puts
 * a version through the real adapter and asserts these three names are where
 * it landed, so an upstream rename breaks a test rather than a boundary.
 */
export const MANIFEST_FILENAME = "manifest.json";
export const TENANTS_DIRNAME = "_tenants";
export const CHANGELOG_FILENAME = "CHANGELOG.md";
export const versionFilename = (version: string): string => `${version}.yaml`;

/**
 * The deploy history this build cannot show, named where it would have been.
 *
 * `@crewhaus/audit-log` is not a dependency of this package (a standing
 * maintainer decision), and it is the only place a deployment's history is
 * kept: `deployment-controller` appends `kind: "deployment_action"` records
 * there and NOWHERE else, because the registry manifest stores only the
 * CURRENT pin per environment. So these tools cannot append a deployment
 * record and cannot read one back. Both are reported as not done rather than
 * approximated — a hand-rolled JSONL beside the registry would be a second,
 * unchained "audit log" disagreeing with the real one, which is worse than
 * none.
 */
export const AUDIT_LOG_UNAVAILABLE =
  "not written — @crewhaus/audit-log is not a dependency of @crewhaus/tool-deploy, so this tool " +
  "could not append the deployment_action record that @crewhaus/deployment-controller writes when " +
  "it is given an AuditLog. The registry pin below DID change; only its audit entry is missing. " +
  "Run the change through `crewhaus deploy` (which wires the real log) when the audit chain matters.";

export const DEPLOY_HISTORY_UNAVAILABLE =
  "not available — a spec's deployment history lives only in the @crewhaus/audit-log chain " +
  "(kind: deployment_action); the registry manifest keeps just the current pin per environment. " +
  "@crewhaus/audit-log is not a dependency of @crewhaus/tool-deploy, so no history was read. This " +
  "is 'not read', not 'no deployments'. Read it with the AuditVerify tool (@crewhaus/tool-crewhaus) " +
  "or `crewhaus audit`.";

export const VERSION_DIFF_UNAVAILABLE =
  "not available — a field-level diff between two registry versions is @crewhaus/spec-patch's " +
  "diffSpecYaml, which is not a dependency of @crewhaus/tool-deploy. Use the SpecDiff tool " +
  "(@crewhaus/tool-crewhaus). The per-version CHANGELOG.md beside the manifest already carries the " +
  "diff that @crewhaus/spec-changelog rendered at registration time.";

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

/** A caller's spec name and the name the registry will really use for it. */
export type ResolvedName = {
  /** As the caller wrote it. */
  readonly given: string;
  /** `registrySpecName(given)` — the directory component, and what we act on. */
  readonly registryName: string;
  /** True when the mapping changed the name, so the result can say so. */
  readonly mapped: boolean;
};

/**
 * Put a caller's spec name through `@crewhaus/spec-changelog`'s own mapping —
 * the one `autoRegisterSpecVersion` uses — and refuse the two results a
 * caller must never get silently.
 *
 * The `"spec"` fallback is the dangerous one. `registrySpecName` returns it
 * for any name with nothing usable left after sanitising ("///", "…", ".."),
 * so every such spec lands in ONE shared directory: a pin for one silently
 * repoints another. That is a collision the caller cannot see from their own
 * input, so it is refused rather than mapped.
 */
export function resolveName(given: string): Loaded<ResolvedName> {
  if (given.includes("\u0000")) {
    return fail("bad-input", `spec name "${render(given)}" contains a NUL byte`);
  }
  if (given.trim() === "") {
    return fail("bad-input", "spec name is empty");
  }
  const registryName = registrySpecName(given);
  if (registryName === "spec" && given !== "spec") {
    return fail(
      "bad-input",
      `spec name "${render(given)}" has nothing the registry can use, so @crewhaus/spec-changelog's registrySpecName maps it to the shared fallback "spec" — where it would share a directory, a manifest and every environment pin with every other unmappable name. Give the spec a name containing letters, digits, "_", "." or "-".`,
    );
  }
  return { ok: true, value: { given, registryName, mapped: registryName !== given } };
}

// ---------------------------------------------------------------------------
// containment
// ---------------------------------------------------------------------------

/**
 * Every path under the registry root that a call for `name` can open — the
 * spec directory, its manifest, its changelog, and one file per version
 * involved — contained through the same `resolveSafe` the root used.
 *
 * `versions` must include any version the call may WRITE as well as the ones
 * it may read: `autoRegisterSpecVersion` reads every stored version to
 * content-match, then writes the next one.
 */
export function containSpecPaths(
  toolName: string,
  root: SafePath,
  registryName: string,
  versions: ReadonlyArray<string>,
): Failure | undefined {
  const rels = [
    registryName,
    `${registryName}/${MANIFEST_FILENAME}`,
    `${registryName}/${CHANGELOG_FILENAME}`,
    ...versions.map((v) => `${registryName}/${versionFilename(v)}`),
  ];
  return containUnder(toolName, root, rels);
}

/** The tenant overlay directory and file a tenant-scoped call reads or writes. */
export function containTenantPaths(
  toolName: string,
  root: SafePath,
  tenantId: string,
  registryName: string,
): Failure | undefined {
  return containUnder(toolName, root, [
    TENANTS_DIRNAME,
    `${TENANTS_DIRNAME}/${tenantId}`,
    `${TENANTS_DIRNAME}/${tenantId}/${registryName}.json`,
  ]);
}

// ---------------------------------------------------------------------------
// the tenant overlay — its NAME only
// ---------------------------------------------------------------------------

/**
 * Whether this tenant has an overlay FILE for this spec at all.
 *
 * WHY THIS EXISTS. `aliasForTenant` returns the tenant's overlay value when
 * one covers the environment and the GLOBAL pin when one does not, and never
 * says which. Read as a statement about the tenant, that answer is a guess —
 * and a guess in both directions: `@crewhaus/tool-deploy` already refuses to
 * read an equal value as "this tenant is already pinned here, nothing to do",
 * and it must equally refuse to read a DIFFERENT value as "this tenant is
 * pinned to something else, so moving it destroys a binding". A tenant with
 * no overlay file has no binding to destroy, and writing one does not touch
 * the global pin.
 *
 * WHAT THIS IS NOT. It is not a second overlay reader: the file is never
 * opened, parsed, or consulted for a version. Only the NAME is probed — the
 * same thing `readManifest` does to `manifest.json`, for the same reason and
 * at the same path this package already mirrors, contains and asserts against
 * the real adapter in `lib.test.ts`. The pin rule stays the registry's.
 *
 * ABSENCE IS THE ONLY DEFINITE ANSWER, and that is deliberate. No file means
 * `aliasForTenant` can only have returned the global pin. A file that IS
 * there may still not cover the environment asked about, so it settles
 * nothing and is reported as ambiguous rather than as a tenant pin.
 */
export type TenantOverlayState =
  | { readonly state: "absent" }
  | { readonly state: "present" }
  | { readonly state: "unknown"; readonly reason: string };

export function probeTenantOverlay(
  rootAbs: string,
  tenantId: string,
  registryName: string,
): TenantOverlayState {
  const abs = join(rootAbs, TENANTS_DIRNAME, tenantId, `${registryName}.json`);
  const probe = probeName(abs);
  switch (probe.kind) {
    case "absent":
      return { state: "absent" };
    case "file":
      return { state: "present" };
    case "unreadable":
      return {
        state: "unknown",
        reason: `the overlay file for tenant "${render(tenantId)}" could not be examined (${probe.code})`,
      };
    case "symlink":
      // The registry probes it with `existsSync`, which follows the link: a
      // dangling one reads as "no overlay" and the alias falls through to the
      // global pin, while `pinForTenant` through the same name CREATES the
      // target. Neither "absent" nor "present" is the truth here.
      return {
        state: "unknown",
        reason: `the overlay file for tenant "${render(tenantId)}" is a symlink${probe.dangling ? " whose target does not exist" : ""}, so whether this tenant has an overlay cannot be established from its name`,
      };
    default:
      return {
        state: "unknown",
        reason: `the overlay path for tenant "${render(tenantId)}" is not a regular file`,
      };
  }
}

// ---------------------------------------------------------------------------
// reads that can fail
// ---------------------------------------------------------------------------

/**
 * Classify anything thrown by the registry adapter.
 *
 * A `SpecRegistryError` is the adapter rejecting the INPUT (a name, version
 * or environment outside its grammar, or a version that is not there) — that
 * is `bad-input`, and the caller can fix it. Everything else is the host
 * failing to answer: EACCES, ELOOP, a half-written manifest that will not
 * parse. Those are `unreadable`, and the one thing they must never become is
 * a confident empty answer.
 */
export function classifyRegistryError(err: unknown, what: string): Failure {
  if (err instanceof SpecRegistryError) {
    // `render` on the adapter's own message, not only on `what`: the message
    // quotes the offending name, version or environment VERBATIM
    // (`invalid version "<the caller's string>"`), so it carries the
    // caller's or the manifest's text straight into the answer. Bounded and
    // neutralised here means there is no path by which an unvalidated string
    // reaches the reader just because another package formatted it.
    return fail("bad-input", `${what}: ${render(err.message)}`);
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== undefined) {
    return fail("unreadable", `${what} could not be read (${code})`);
  }
  return fail("unreadable", `${what} could not be read (${render((err as Error).message)})`);
}

/**
 * Read a spec's manifest, keeping absent, unreadable and empty apart.
 *
 * `existence` is the `lstat` fact about `<root>/<name>/manifest.json`, taken
 * BEFORE the adapter reads it. It is what turns the adapter's one empty-ish
 * answer into three: there is no manifest, there is a manifest, or there is a
 * symlink that goes nowhere and would read as either.
 */
export type ManifestState =
  | { readonly state: "absent" }
  | { readonly state: "known"; readonly manifest: Manifest }
  | { readonly state: "unknown"; readonly failure: Failure };

export async function readManifest(
  registry: RegistryAdapter,
  rootAbs: string,
  name: ResolvedName,
): Promise<ManifestState> {
  const manifestAbs = join(rootAbs, name.registryName, MANIFEST_FILENAME);
  const probe = probeName(manifestAbs);
  if (probe.kind === "unreadable") {
    return {
      state: "unknown",
      failure: fail(
        "unreadable",
        `the registry manifest for "${render(name.registryName)}" could not be examined (${probe.code})`,
      ),
    };
  }
  if (probe.kind === "symlink") {
    // The registry probes with `existsSync`, which follows the link: a
    // dangling one answers "absent" and the manifest reads as `{versions: [],
    // pins: {}}` — a clean, wrong "this spec has no versions and no pins" —
    // while a `put` through the same name CREATES the link's target. A live
    // link is refused for the same reason in reverse: the manifest being read
    // is not the one at this registry's own path.
    return {
      state: "unknown",
      failure: fail(
        "unreadable",
        `the registry manifest for "${render(name.registryName)}" is a symlink${probe.dangling ? " whose target does not exist" : ""} — @crewhaus/spec-registry follows it, so ${probe.dangling ? "the read returns an empty manifest that is indistinguishable from a spec with no versions, and a write creates the link's target" : "the versions and pins reported would be the link target's, not this registry's"}. Replace the link with the real manifest.`,
      ),
    };
  }
  if (probe.kind === "directory" || probe.kind === "other") {
    return {
      state: "unknown",
      failure: fail(
        "unreadable",
        `the registry manifest for "${render(name.registryName)}" is not a regular file`,
      ),
    };
  }
  // Absent is settled by the `lstat` above, not by the adapter: the adapter
  // answers with an EMPTY manifest, which is also what a readable-but-empty
  // one looks like, and the caller needs to know there is no file at all.
  if (probe.kind === "absent") return { state: "absent" };
  let manifest: Manifest;
  try {
    manifest = await registry.manifest(name.registryName);
  } catch (err) {
    return {
      state: "unknown",
      failure: classifyRegistryError(
        err,
        `the registry manifest for "${render(name.registryName)}"`,
      ),
    };
  }
  // Shape defence: the adapter `JSON.parse`s without validating, so a
  // hand-edited manifest can hand back `versions: null`. An unusable shape is
  // "could not determine", not "nothing registered".
  if (!Array.isArray(manifest.versions) || manifest.versions.some((v) => typeof v !== "string")) {
    return {
      state: "unknown",
      failure: fail(
        "unreadable",
        `the registry manifest for "${render(name.registryName)}" has a "versions" field that is not an array of strings`,
      ),
    };
  }
  if (
    typeof manifest.pins !== "object" ||
    manifest.pins === null ||
    Array.isArray(manifest.pins) ||
    Object.values(manifest.pins).some((v) => typeof v !== "string")
  ) {
    return {
      state: "unknown",
      failure: fail(
        "unreadable",
        `the registry manifest for "${render(name.registryName)}" has a "pins" field that is not a map of environment to version string`,
      ),
    };
  }
  return { state: "known", manifest };
}

/**
 * Whether a manifest-listed version's BYTES are actually retrievable.
 *
 * `registry.list()` reads the manifest's `versions` array and nothing else,
 * so a version whose `<v>.yaml` was deleted, truncated to a link, or made
 * unreadable is still "in the registry" as far as every caller of `list` is
 * concerned — including `deployment-controller.rollback`, whose only guard is
 * `list(name).includes(version)`. Pinning an environment to such a version
 * succeeds, writes a pin, and returns a record that reads exactly like a
 * successful deploy, while the environment now points at nothing. So the
 * bytes are fetched before anything is repointed at them.
 */
export type VersionState =
  | { readonly state: "retrievable"; readonly bytes: number }
  | { readonly state: "missing" }
  | { readonly state: "unreadable"; readonly reason: string };

export async function probeVersion(
  registry: RegistryAdapter,
  rootAbs: string,
  registryName: string,
  version: string,
): Promise<VersionState> {
  const abs = join(rootAbs, registryName, versionFilename(version));
  const probe = probeName(abs);
  if (probe.kind === "absent") return { state: "missing" };
  if (probe.kind === "unreadable") {
    return { state: "unreadable", reason: `its file could not be examined (${probe.code})` };
  }
  if (probe.kind === "symlink" && probe.dangling) {
    return { state: "missing" };
  }
  if (probe.kind === "directory" || probe.kind === "other") {
    return { state: "unreadable", reason: "its path is not a regular file" };
  }
  try {
    const yaml = await registry.get(registryName, version);
    return { state: "retrievable", bytes: Buffer.byteLength(yaml, "utf8") };
  } catch (err) {
    if (err instanceof SpecRegistryError) {
      // The probe above already established the file IS there, so this is the
      // registry refusing the version NAME — a manifest listing something
      // outside its own grammar. Reporting that as "missing" would send a
      // caller looking for a deleted file that is sitting right there.
      return { state: "unreadable", reason: "@crewhaus/spec-registry rejects that version name" };
    }
    const code = (err as NodeJS.ErrnoException).code;
    return {
      state: "unreadable",
      reason: `its file could not be read (${code ?? (err as Error).message})`,
    };
  }
}

// ---------------------------------------------------------------------------
// registration prediction
// ---------------------------------------------------------------------------

/**
 * What `autoRegisterSpecVersion` WOULD do, for the dry-run path.
 *
 * `dryRun` must run the same selection code as the real path, and for the
 * PIN it does — both go through the same `plan*` function below and the same
 * adapter. Registration is the one step where it cannot: the decision lives
 * inside `autoRegisterSpecVersion`, which decides and writes in one call,
 * and there is no way to ask it without letting it write.
 *
 * So the prediction is built from the package's OWN exported `contentHash`
 * over the package's own stored bytes — not from a second hashing rule — and
 * it is labelled a prediction everywhere it appears. The real path then
 * reports what `autoRegisterSpecVersion` actually returned AND whether the
 * prediction held (`predictionHeld`), so if the two ever diverge the tool
 * says so instead of quietly reporting the wrong one. `lib.test.ts` pins the
 * agreement across the first-version, unchanged and changed cases.
 */
export type RegistrationPrediction =
  | { readonly outcome: "unchanged"; readonly version: string }
  | { readonly outcome: "register"; readonly version: string }
  | { readonly outcome: "undetermined"; readonly reason: string };

export async function predictRegistration(
  registry: RegistryAdapter,
  registryName: string,
  versions: ReadonlyArray<string>,
  yaml: string,
  nextVersionName: string,
): Promise<RegistrationPrediction> {
  const hash = contentHash(yaml);
  let matched: string | undefined;
  for (const v of versions) {
    let stored: string;
    try {
      stored = await registry.get(registryName, v);
    } catch (err) {
      if (err instanceof SpecRegistryError) continue; // gone: autoRegister skips it too
      // A version that could not be READ might be the one holding this exact
      // content. Reporting "would register a new version" would then be a
      // prediction of a write that will not happen — so say we do not know.
      return {
        outcome: "undetermined",
        reason: `version "${render(v)}" could not be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}), so this content may or may not already be stored`,
      };
    }
    // Later matches win, exactly as autoRegisterSpecVersion resolves them.
    if (contentHash(stored) === hash) matched = v;
  }
  return matched !== undefined
    ? { outcome: "unchanged", version: matched }
    : { outcome: "register", version: nextVersionName };
}
