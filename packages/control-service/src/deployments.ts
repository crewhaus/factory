/**
 * Saved is not deployed. A compile records what it built as a `prepared` deployment; a
 * person activates one, and automatic starts run only the active build. This module is the
 * control plane's half: activation (the activation gates, the two compare-and-sets, the
 * harness's portable identity), the admission a person's start passes through, and the
 * reconciler recovery asks.
 *
 * It never opens a control file directly: the records are control-records', the build's
 * digest is harness-supervisor's, the protected-environment policy is
 * deployment-controller's.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { loadAccessSnapshot } from "@crewhaus/access-control";
import type { CommandReceipt } from "@crewhaus/control-contract";
import { HARNESS_ID_RE, mintId, parseRef } from "@crewhaus/control-contract";
import {
  type LedgerRecord,
  casAppend,
  deploymentsLedger,
  ensureDigestKey,
  keyedDigest,
  readDeployments,
  readHarnessIdentity,
  writeHarnessIdentity,
} from "@crewhaus/control-records";
import { evaluateProtectedEnvGate } from "@crewhaus/deployment-controller/approval-gate";
import {
  type ActiveDeployment,
  type AdmitAnswer,
  BUILD_NOT_ACTIVE_MESSAGE,
  NO_ACTIVE_BUILD_ACTIVATE_MESSAGE,
  activeDeployment,
  artifactOf,
  bootInputsOf,
  buildLinkMessage,
  bundleDirOf,
  collectBuildFiles,
  findSpecPath,
  linkEntriesOf,
  loadEnvChain,
  mergedSpawnEnv,
  readBundleStamp,
  resolveBundle,
  resolvedEntryOf,
  verifyActiveBuild,
} from "@crewhaus/harness-supervisor";
import { bundleDigest, sameRevision, specRevision } from "@crewhaus/ir/policy";
import type { ActivationGate } from "./executor";
import type { Reconciliation } from "./executor";
import type { OutcomeCode } from "./refusal";

/**
 * Whether a stored actor is a service principal in this Home's access records. A record
 * that cannot be read answers false: activation is then judged by the head that asks.
 */
export function isServiceActor(hangarRoot: string, actor: string): boolean {
  if (!actor.startsWith("prn_")) return false;
  try {
    const snapshot = loadAccessSnapshot(hangarRoot);
    if (snapshot.state !== "present") return false;
    return snapshot.snapshot.principals.some((p) => p.id === actor && p.kind === "service");
  } catch {
    return false;
  }
}

/** The core's protected-environment gate's name. It runs first. */
export const PROTECTED_ENVIRONMENT_GATE = "protected-environment";

/** The managed shape's tenants root when its spawn env names none (the emitted default). */
export const MANAGED_DEFAULT_TENANTS_ROOT = "/tmp/crewhaus-tenants";

/** Where activation gates were not run: a start that recorded and activated what was there. */
export const GATES_NOT_RUN = "not-run";

/** The spec's `name:`, read from its header, for the approvals file. */
function specNameOf(harnessDir: string): string | undefined {
  const path = findSpecPath(harnessDir);
  if (path === undefined) return undefined;
  try {
    const match = /^name:[ \t]*["']?([^"'\s#]+)/m.exec(readFileSync(path, "utf8"));
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Why a protected environment refuses a build that names no spec revision. */
export function noSpecRevisionMessage(environment: string): string {
  return `This build names no spec revision, so an approval for "${environment}" can't bind to it. Run crewhaus compile, then crewhaus deploy activate.`;
}

/** Shown when an activation decided from records another activation changed first. */
export const ACTIVATION_RACED_MESSAGE = "another activation landed first; run it again";

/**
 * The core's activation gate: activation into a protected environment takes the same
 * approval quorum every pin move takes, bound to the deployment's spec revision. A build
 * that names no well-formed spec revision is refused there, since no approval can bind to
 * it.
 */
export const protectedEnvironmentGate: ActivationGate = {
  name: PROTECTED_ENVIRONMENT_GATE,
  check: async ({ harnessDir, deployment }) => {
    const environment = deployment["environment"];
    if (typeof environment !== "string" || environment === "") return { ok: true };
    const artifact = deployment["artifact"] as { specHash?: unknown } | undefined;
    const specHash = typeof artifact?.specHash === "string" ? artifact.specHash : "";
    const specName = specNameOf(harnessDir) ?? "";
    let answer: Awaited<ReturnType<typeof evaluateProtectedEnvGate>>;
    try {
      answer = await evaluateProtectedEnvGate({
        harnessRoot: harnessDir,
        specName,
        toEnv: environment,
        toVersion: String(deployment["id"]),
        specHash,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `the protected-environment policy can't be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (!answer.protected) return { ok: true };
    if (!sameRevision(specHash, specHash)) {
      return { ok: false, reason: noSpecRevisionMessage(environment), verb: "crewhaus compile" };
    }
    if (answer.decision.satisfied) return { ok: true };
    return {
      ok: false,
      reason: `"${environment}" is a protected environment: ${answer.decision.reason}`,
      verb: `crewhaus deploy activate ${String(deployment["id"])} --environment ${environment}`,
    };
  },
};

/** The env chain as names and a keyed digest of their names and bytes: never a value. */
async function envChainOf(
  harnessDir: string,
  key: CryptoKey,
): Promise<{ readonly files: readonly string[]; readonly digest: string }> {
  const chain = loadEnvChain(harnessDir, { nodeEnv: process.env["NODE_ENV"] });
  const files: string[] = [];
  const parts: string[] = [];
  for (const ref of chain.refs) {
    if (!ref.present) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(ref.path);
    } catch {
      continue;
    }
    files.push(ref.declaredAs);
    parts.push(ref.declaredAs, createHash("sha256").update(bytes).digest("hex"));
  }
  return { files, digest: await keyedDigest(key, "env-chain", parts) };
}

/** A managed harness's tenants root, absolute: its spawn env's, else the emitted default. */
function tenantsRootOf(harnessDir: string): string {
  const env = mergedSpawnEnv(process.env, harnessDir).env;
  const named = env["CREWHAUS_TENANTS_ROOT"];
  const root = typeof named === "string" && named !== "" ? named : MANAGED_DEFAULT_TENANTS_ROOT;
  return root.startsWith("/") ? root : `${harnessDir}/${root}`;
}

/** The id the harness is known by: its registry row's, else `harness.json`'s, else new. */
function harnessIdFor(harnessDir: string, registryId: string | undefined): string {
  if (registryId !== undefined && HARNESS_ID_RE.test(registryId)) return registryId;
  const identity = readHarnessIdentity(harnessDir);
  if (identity.state === "present") return identity.identity.id;
  return `hrn_${randomBytes(8).toString("hex")}`;
}

/**
 * Write `harness.json` when it is absent: the registry row's id when the directory is
 * registered, else a fresh one. Answers the id the harness is known by.
 *
 * First consumers: activation and `crewhaus deploy activate`, which names the harness in its
 * receipt's target.
 */
export function ensureHarnessIdentity(
  harnessDir: string,
  registryId?: string,
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string } {
  const existing = readHarnessIdentity(harnessDir);
  if (existing.state === "present") return { ok: true, id: existing.identity.id };
  if (existing.state === "unreadable") return { ok: false, reason: existing.reason };
  const written = writeHarnessIdentity(
    harnessDir,
    { id: harnessIdFor(harnessDir, registryId) },
    { ifAbsent: true },
  );
  return written.ok ? { ok: true, id: written.identity.id } : written;
}

export type ActivationRequest = {
  readonly harnessDir: string;
  /** The `dep_` id to activate. */
  readonly dep: string;
  /** The stored actor ref that activates (a `prn_`, or `local:#<digest>`). */
  readonly actor: string;
  /** True when the actor is a service principal: activation is a person's act. */
  readonly actorIsService?: boolean;
  /** The receipt id of the command that activates. */
  readonly cmd: string;
  /** The activation gates, in composition order; none when the start path activates. */
  readonly gates: readonly ActivationGate[] | typeof GATES_NOT_RUN;
  readonly environment?: string;
  /** Whether reboot recovery starts this build. Default true. */
  readonly autostart?: boolean;
  /** The registry row's id, when the directory is registered. */
  readonly registryId?: string;
  readonly now?: () => number;
};

export type ActivationAnswer =
  | { readonly ok: true; readonly record: LedgerRecord; readonly superseded: readonly string[] }
  | {
      readonly ok: false;
      readonly code: OutcomeCode;
      readonly message: string;
      /** The deployment as it stands, when the refusal is about it. */
      readonly current?: LedgerRecord;
      /** The verb that does what was refused, when one does. */
      readonly verb?: string;
    };

/**
 * Activate a prepared deployment: run the activation gates against it, move it to `active`
 * with a compare-and-set, then move every other active deployment to `superseded`. Each row
 * restates the whole record. Writes `harness.json` when it is absent. A digest key that
 * cannot be read refuses before anything is written. The environment and the gates are
 * decided from one read of the records, and the compare-and-set applies only while the
 * active deployments are still the ones that read saw, at the same generations; otherwise
 * it refuses with `conflict` and the activation can be run again.
 *
 * First consumers: `crewhaus deploy activate`, Home's activate route and a person's start.
 */
export async function activateDeployment(request: ActivationRequest): Promise<ActivationAnswer> {
  const now = request.now ?? (() => Date.now());
  if (request.actorIsService === true) {
    return {
      ok: false,
      code: "forbidden",
      message: "activating a deployment is a person's act; a service principal cannot do it",
    };
  }
  const read = readDeployments(request.harnessDir);
  if (read.state === "unreadable") {
    return {
      ok: false,
      code: "unavailable",
      message: `the deployment records can't be read: ${read.reason}`,
    };
  }
  const prepared =
    read.state === "present" ? read.records.find((r) => r["id"] === request.dep) : undefined;
  if (prepared === undefined) {
    return {
      ok: false,
      code: "not_found",
      message: `no deployment ${request.dep} in this harness`,
    };
  }
  if (prepared["state"] !== "prepared") {
    return {
      ok: false,
      code: "conflict",
      message: `${request.dep} is ${String(prepared["state"])}, not prepared`,
      current: prepared,
    };
  }
  const key = await ensureDigestKey(request.harnessDir);
  if (key.state !== "present") {
    return {
      ok: false,
      code: "unavailable",
      message: "the harness's digest key cannot be read; nothing was done",
    };
  }

  // The environment the activation moves: the one it names, else the one the active build
  // runs in, so leaving the name out never leaves out that environment's gate.
  const actives =
    read.state === "present" ? read.records.filter((r) => r["state"] === "active") : [];
  const environment =
    request.environment ?? environmentOf(read.state === "present" ? read.active : undefined);
  const candidate: LedgerRecord = {
    ...prepared,
    ...(environment !== undefined ? { environment } : {}),
  };
  // Every protected environment whose active build this activation replaces takes its
  // quorum for this build, whatever the activation names and whichever gates it runs.
  for (const other of new Set(actives.map(environmentOf))) {
    if (other === undefined || other === environment) continue;
    const verdict = await protectedEnvironmentGate.check({
      harnessDir: request.harnessDir,
      deployment: { ...prepared, environment: other },
      actor: request.actor,
      now: now(),
    });
    if (!verdict.ok) {
      return {
        ok: false,
        code: "conflict",
        message: verdict.reason,
        current: prepared,
        ...(verdict.verb !== undefined ? { verb: verdict.verb } : {}),
      };
    }
  }
  const gateNames: string[] = [];
  if (request.gates === GATES_NOT_RUN && environment !== undefined) {
    // A start that activates what it found never moves a protected environment without
    // that environment's quorum.
    const verdict = await protectedEnvironmentGate.check({
      harnessDir: request.harnessDir,
      deployment: candidate,
      actor: request.actor,
      now: now(),
    });
    if (!verdict.ok) {
      return {
        ok: false,
        code: "conflict",
        message: verdict.reason,
        current: prepared,
        ...(verdict.verb !== undefined ? { verb: verdict.verb } : {}),
      };
    }
  }
  if (request.gates !== GATES_NOT_RUN) {
    for (const gate of request.gates) {
      const verdict = await gate.check({
        harnessDir: request.harnessDir,
        deployment: candidate,
        actor: request.actor,
        now: now(),
      });
      if (!verdict.ok) {
        return {
          ok: false,
          code: "conflict",
          message: verdict.reason,
          current: prepared,
          ...(verdict.verb !== undefined ? { verb: verdict.verb } : {}),
        };
      }
      gateNames.push(gate.name);
    }
  }

  const identity = ensureHarnessIdentity(request.harnessDir, request.registryId);
  const artifact = prepared["artifact"] as { shape?: unknown } | undefined;
  const envChain = await envChainOf(request.harnessDir, key.hmac);
  const next: LedgerRecord = {
    ...candidate,
    ...(identity.ok ? { harness: identity.id } : {}),
    state: "active",
    activatedBy: request.actor,
    activatedAt: new Date(now()).toISOString(),
    autostart: request.autostart ?? true,
    gates: request.gates === GATES_NOT_RUN ? GATES_NOT_RUN : gateNames,
    ...(artifact?.shape === "managed" ? { tenantsRoot: tenantsRootOf(request.harnessDir) } : {}),
    envChain,
    cmd: request.cmd,
  };
  Reflect.deleteProperty(next, "gen");
  Reflect.deleteProperty(next, "claim");
  const ledger = deploymentsLedger(request.harnessDir);
  const moved = await casAppend(ledger, request.dep, "prepared", next, {
    inState: "active",
    exactly: read.state === "present" ? read.activeGens : [],
  });
  if (!moved.ok) return { ok: false, code: "unavailable", message: moved.reason };
  if (!moved.applied && moved.precondition === "changed") {
    return {
      ok: false,
      code: "conflict",
      message: ACTIVATION_RACED_MESSAGE,
      ...(moved.current !== null ? { current: moved.current } : {}),
    };
  }
  if (!moved.applied) {
    return {
      ok: false,
      code: "conflict",
      message: `${request.dep} was moved by another command first`,
      ...(moved.current !== null ? { current: moved.current } : {}),
    };
  }
  const superseded = await supersedeEarlier(
    request.harnessDir,
    request.dep,
    String(next["activatedAt"]),
  );
  return { ok: true, record: moved.record, superseded };
}

/** A record's `environment`, when it names one. */
function environmentOf(record: LedgerRecord | undefined): string | undefined {
  const environment = record?.["environment"];
  return typeof environment === "string" && environment !== "" ? environment : undefined;
}

/** Whether active row `a` was activated before `b`: by `activatedAt`, then by id. */
function activatedBefore(
  a: { readonly at: string; readonly id: string },
  b: { readonly at: string; readonly id: string },
): boolean {
  return a.at < b.at || (a.at === b.at && a.id < b.id);
}

/**
 * Move every active deployment activated before `dep` to `superseded`, each row restating
 * its whole record. One activated after it is left alone, so two activations that land
 * together leave the later one active, whichever finishes first.
 *
 * First consumer: {@link activateDeployment}, after its own compare-and-set.
 */
export async function supersedeEarlier(
  harnessDir: string,
  dep: string,
  activatedAt: string,
): Promise<string[]> {
  const superseded: string[] = [];
  const after = readDeployments(harnessDir);
  if (after.state !== "present") return superseded;
  const ledger = deploymentsLedger(harnessDir);
  const mine = { at: activatedAt, id: dep };
  for (const record of after.records) {
    if (record["state"] !== "active" || record["id"] === dep) continue;
    const id = String(record["id"]);
    const at = typeof record["activatedAt"] === "string" ? record["activatedAt"] : "";
    if (!activatedBefore({ at, id }, mine)) continue;
    const rest: LedgerRecord = { ...record, state: "superseded" };
    const answer = await casAppend(ledger, id, "active", rest);
    if (answer.ok && answer.applied) superseded.push(id);
  }
  return superseded;
}

/** The stamp `crewhaus compile` writes into a bundle's manifest, when there is one. */
function compiledWithOf(bundleDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(`${bundleDir}/package.json`, "utf8")) as {
      crewhaus?: { compiledWith?: unknown };
    };
    const value = manifest.crewhaus?.compiledWith;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Shown when a start finds a bundle at the harness root that no compile recorded. */
export const ROOT_BUNDLE_UNRECORDED_MESSAGE =
  "A build at the harness root is recorded only by crewhaus compile. Compile it again (crewhaus compile <spec> -o .), then start it.";

/**
 * The boot inputs the saved spec names (its stdio MCP servers' local files), read the way
 * compile reads them from the lowered spec. Undefined when the spec cannot be read.
 */
function bootInputsOfSpec(harnessDir: string, specPath: string | undefined): string[] | undefined {
  if (specPath === undefined) return [];
  try {
    const parsed: unknown = Bun.YAML.parse(readFileSync(specPath, "utf8"));
    return bootInputsOf(harnessDir, parsed);
  } catch {
    return undefined;
  }
}

/**
 * The `prepared` record a start would write for the build on disk, read without writing:
 * the bundle, its resolver configuration and the boot inputs the saved spec names. A bundle
 * at the harness root is recorded only by compile, which knows the files it wrote; a build
 * whose files hold a link is refused, naming it. The record names a spec revision only when
 * the bundle's stamped manifest names the saved spec's, so it never claims spec text the
 * build did not come from.
 */
function currentBuildRecord(
  harnessDir: string,
  target: string,
  registryId: string | undefined,
): { readonly record: LedgerRecord } | { readonly message: string } {
  const bundle = resolveBundle(harnessDir, target);
  if (bundle === undefined) return { message: "no compiled bundle found" };
  const entry = relative(harnessDir, bundle.entryPath).split("\\").join("/");
  if (bundleDirOf(entry) === ".") return { message: ROOT_BUNDLE_UNRECORDED_MESSAGE };
  const specPath = findSpecPath(harnessDir);
  const bootInputs = bootInputsOfSpec(harnessDir, specPath);
  if (bootInputs === undefined) {
    return {
      message:
        "The spec can't be read, so the files it starts with can't be recorded. Fix crewhaus.yaml, then start it.",
    };
  }
  const artifactBase = { entry, bootInputs };
  const files = collectBuildFiles(harnessDir, artifactBase);
  if (!Array.isArray(files)) return { message: `the build can't be read: ${files.unreadable}` };
  const [link] = linkEntriesOf(files);
  if (link !== undefined) return { message: buildLinkMessage(link) };
  let saved: string | undefined;
  try {
    saved = specPath === undefined ? undefined : specRevision(readFileSync(specPath, "utf8"));
  } catch {
    saved = undefined;
  }
  const stamped = readBundleStamp(bundle.bundleDir)?.specHash;
  const specHash = sameRevision(stamped, saved) ? saved : undefined;
  const compiledWith = compiledWithOf(bundle.bundleDir);
  const identity = readHarnessIdentity(harnessDir);
  const harness =
    registryId !== undefined
      ? registryId
      : identity.state === "present"
        ? identity.identity.id
        : undefined;
  return {
    record: {
      state: "prepared",
      ...(harness !== undefined ? { harness } : {}),
      artifact: {
        digest: bundleDigest(files),
        ...(specHash !== undefined ? { specHash } : {}),
        ...(compiledWith !== undefined ? { compiledWith } : {}),
        shape: target,
        ...artifactBase,
      },
      preparedBy: "start",
    },
  };
}

/** Record the build on disk as a `prepared` deployment ({@link currentBuildRecord}). */
async function recordCurrentBuild(
  harnessDir: string,
  target: string,
  registryId: string | undefined,
  now: () => number,
): Promise<{ readonly id: string } | { readonly message: string }> {
  const current = currentBuildRecord(harnessDir, target, registryId);
  if ("message" in current) return current;
  const id = mintId("dep", { now: now() });
  const answer = await casAppend(deploymentsLedger(harnessDir), id, null, {
    id,
    ...current.record,
  });
  if (!answer.ok) return { message: answer.reason };
  if (!answer.applied) return { message: "the deployment could not be recorded" };
  return { id };
}

/** The head a person's start comes from. */
export type StartHead = "cli-direct" | "group" | "home" | "server" | "sdk";

export type AdmitOptions = {
  readonly head: StartHead;
  /** The entry the launch runs, posix, relative to the harness; resolved from the target
   *  when absent. */
  readonly entry?: string;
  /** True when the harness had no deployment record when the start began, before any
   *  compile the start ran recorded one. */
  readonly ledgerAbsent?: boolean;
  /** The stored actor ref that starts it. */
  readonly actor: string;
  readonly registryId?: string;
  /** The receipt of the start, when there is one. */
  readonly cmd?: string;
  readonly now?: () => number;
  /** Decide every refusal without writing: answer `{ ok: true }` where the start would
   *  record and activate. A restart asks this before it stops a running daemon. */
  readonly decideOnly?: boolean;
};

function deploymentOfRecord(record: LedgerRecord): ActiveDeployment | undefined {
  const artifact = record["artifact"] as { digest?: unknown; specHash?: unknown } | undefined;
  if (typeof artifact?.digest !== "string") return undefined;
  return {
    id: String(record["id"]),
    ...(typeof artifact.specHash === "string" ? { specHash: artifact.specHash } : {}),
    digest: artifact.digest,
    record,
  };
}

/** The newest prepared deployment whose build is the one on disk and the one the launch
 *  runs, when there is one. A build whose files hold a link is never one. */
function preparedMatchingBuild(
  harnessDir: string,
  entry: string | undefined,
): { readonly id: string } | undefined {
  const read = readDeployments(harnessDir);
  if (read.state !== "present") return undefined;
  for (let i = read.records.length - 1; i >= 0; i--) {
    const record = read.records[i] as LedgerRecord;
    if (record["state"] !== "prepared") continue;
    const artifact = artifactOf(record);
    if (artifact === undefined) continue;
    if (entry !== undefined && artifact.entry !== entry) continue;
    const files = collectBuildFiles(harnessDir, artifact);
    if (!Array.isArray(files) || linkEntriesOf(files).length > 0) continue;
    if (bundleDigest(files) === artifact.digest) return { id: String(record["id"]) };
  }
  return undefined;
}

async function recordAndActivate(
  harnessDir: string,
  target: string,
  options: AdmitOptions,
  autostart: boolean,
): Promise<AdmitAnswer> {
  if (options.decideOnly === true) {
    // What would be activated, decided without recording it.
    if (preparedMatchingBuild(harnessDir, options.entry ?? resolvedEntryOf(harnessDir, target))) {
      return { ok: true };
    }
    const current = currentBuildRecord(harnessDir, target, options.registryId);
    return "message" in current ? { ok: false, message: current.message } : { ok: true };
  }
  const now = options.now ?? (() => Date.now());
  // A prepared record of exactly this build (a compile's, with its boot inputs and policy
  // revision) is activated as it is; otherwise the build is recorded first.
  const recorded =
    preparedMatchingBuild(harnessDir, options.entry ?? resolvedEntryOf(harnessDir, target)) ??
    (await recordCurrentBuild(harnessDir, target, options.registryId, now));
  if ("message" in recorded) return { ok: false, message: recorded.message };
  const activated = await activateDeployment({
    harnessDir,
    dep: recorded.id,
    actor: options.actor,
    cmd: options.cmd ?? recorded.id,
    gates: GATES_NOT_RUN,
    autostart,
    ...(options.registryId !== undefined ? { registryId: options.registryId } : {}),
    now,
  });
  if (!activated.ok) return { ok: false, message: activated.message };
  const deployment = deploymentOfRecord(activated.record);
  return deployment !== undefined ? { ok: true, deployment } : { ok: true };
}

/**
 * Whether a person's start may run the build on disk, by head:
 *
 * | Found | Start |
 * |---|---|
 * | no deployment record at all | record the build and activate it, not autostarted, from any head |
 * | the build is the active one | runs |
 * | otherwise, `cli-direct` (`crewhaus daemon start|restart`) | records the build and activates it, never into a protected environment |
 * | otherwise (Home, a group start, the server, the SDK) | refused: the build is not active |
 *
 * A build whose files hold a link is refused, naming it. With `decideOnly`, every refusal
 * is answered and nothing is recorded or activated.
 *
 * First consumers: the CLI's and Home's supervisor builders, as `SupervisorOptions.admit`.
 */
export async function admitExplicitStart(
  harnessDir: string,
  target: string,
  options: AdmitOptions,
): Promise<AdmitAnswer> {
  const read = readDeployments(harnessDir);
  if (read.state === "unreadable") {
    return { ok: false, message: `The deployment records can't be read (${read.reason}).` };
  }
  if (read.state === "absent") return recordAndActivate(harnessDir, target, options, false);
  // A harness with no record when this start began, whose only records are what this
  // start's own compile prepared, is still a harness from before deployments.
  if (
    options.ledgerAbsent === true &&
    read.active === undefined &&
    read.records.every((r) => r["state"] === "prepared")
  ) {
    return recordAndActivate(harnessDir, target, options, false);
  }
  const check = verifyActiveBuild(harnessDir, target, options.entry);
  if (check.ok) return { ok: true, deployment: check.deployment };
  if (options.head !== "cli-direct") {
    return {
      ok: false,
      message:
        check.reason === "no-active"
          ? NO_ACTIVE_BUILD_ACTIVATE_MESSAGE
          : check.reason === "link"
            ? check.message
            : BUILD_NOT_ACTIVE_MESSAGE,
    };
  }
  const environment = activeDeployment(harnessDir)?.record["environment"];
  if (typeof environment === "string" && environment !== "") {
    // A start never activates into an environment that takes a quorum.
    const protectedEnv = await evaluateProtectedEnvGate({
      harnessRoot: harnessDir,
      specName: specNameOf(harnessDir) ?? "",
      toEnv: environment,
      toVersion: "start",
      specHash: "",
    }).then(
      (answer) => answer.protected,
      () => true,
    );
    if (protectedEnv) {
      return {
        ok: false,
        message: `The active build is in the protected environment "${environment}". Activate this build there with crewhaus deploy activate --environment ${environment}.`,
      };
    }
  }
  return recordAndActivate(harnessDir, target, options, true);
}

/** The `dep_` id a receipt's target names, when it names a deployment. */
export function deploymentIdOf(target: string): string | undefined {
  const parsed = parseRef(target);
  if ("error" in parsed || parsed.kind !== "deployment") return undefined;
  return parsed.id;
}

/**
 * Did an activation happen? The deployment active with this receipt's id as its `cmd` is
 * `done`; still `prepared` is `not-done`; anything else is `unknown`.
 */
export function reconcileActivation(
  receipt: CommandReceipt,
  ctx: { readonly harnessDir: string },
): Reconciliation {
  const dep = deploymentIdOf(receipt.target);
  if (dep === undefined) return "unknown";
  const read = readDeployments(ctx.harnessDir);
  if (read.state !== "present") return "unknown";
  const record = read.records.find((r) => r["id"] === dep);
  if (record === undefined) return "unknown";
  if (record["state"] === "active" && record["cmd"] === receipt.id) return "done";
  if (record["state"] === "prepared") return "not-done";
  return "unknown";
}
