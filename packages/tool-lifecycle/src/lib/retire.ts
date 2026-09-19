/**
 * `HarnessRetire`'s half of the retirement: the facts the tool must establish
 * before `@crewhaus/harness-lifecycle` is allowed to move anything, and the
 * `RetirementSteps` seam the package asks its host to supply.
 *
 * The package owns the orchestration — the order of the steps, the refusal on
 * an active deployment pin, the abort-before-destruction gate, and the
 * `retirement.json` written into the archive. None of that is re-decided
 * here. What lives here is what a HOST has to answer: where are the pins,
 * what can this build actually do, and did the bytes arrive.
 *
 * WHAT THIS BUILD CANNOT DO, AND SAYS SO. Three of the five steps the CLI
 * wires need packages `@crewhaus/tool-lifecycle` does not depend on. Rather
 * than reporting them as successes (a step that returns `ok: true` for work
 * nobody did is the exact "could not determine reported as fine" failure this
 * repository keeps paying for), they return `ok: false` with the reason. The
 * package then aborts before the destructive move, which is the correct
 * outcome: the audit chain has not been verified, so nothing should be moved
 * on the strength of it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { RetirementSteps, StepOutcome } from "@crewhaus/harness-lifecycle";
import { renderPath } from "./result";
import type { Tree } from "./tree";

/** Where a harness keeps its durable state, by convention. */
export const STATE_RELDIR = ".crewhaus";

/**
 * Where `@crewhaus/harness-lifecycle` moves the live state dir inside the
 * archive. The package does not export this name, so it is mirrored here —
 * and asserted at run time rather than trusted: if the archived tree is not
 * found at this path the tool reports that it could not verify the archive,
 * never that it verified one. `index.test.ts` pins the coupling so a rename
 * upstream fails a test here instead of silently skipping verification.
 */
export const ARCHIVED_STATE_DIRNAME = "crewhaus-state";

/** The manifest this tool writes into the archive before anything moves. */
export const STATE_MANIFEST_FILENAME = "state-manifest.json";

/** Default registry root, matching `@crewhaus/spec-registry`'s file backend. */
export const DEFAULT_REGISTRY_RELDIR = ".crewhaus/specs";

export const AUDIT_VERIFY_UNAVAILABLE =
  "not performed — @crewhaus/audit-log is not a dependency of @crewhaus/tool-lifecycle, so this " +
  "tool cannot verify the harness's audit chain. Run the AuditVerify tool (@crewhaus/tool-crewhaus) " +
  "against the same directory first; it walks the real chain.";

export const COMPLIANCE_EVIDENCE_UNAVAILABLE =
  "not performed — @crewhaus/compliance-controls is not a dependency of @crewhaus/tool-lifecycle, " +
  "so no final compliance-evidence bundle was collected. Collect it with the CLI " +
  "(`crewhaus compliance evidence`) before retiring if your framework requires one.";

// ---------------------------------------------------------------------------
// registry pins
// ---------------------------------------------------------------------------

/**
 * What is known about a spec's registry entry.
 *
 * `unknown` exists because the alternative is unthinkable: a manifest that
 * could not be parsed, reported as "no pins", retires a harness that an
 * environment is still pointing at. An unreadable manifest and an absent one
 * are different answers and are kept different all the way to the result.
 */
export type PinState =
  | { readonly state: "absent" }
  | {
      readonly state: "known";
      readonly pins: Record<string, string>;
      readonly versions: ReadonlyArray<string>;
    }
  | { readonly state: "unknown"; readonly reason: string };

/** A spec name is a directory component: never a path, never a traversal. */
export function specNameIsSafe(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\u0000") &&
    name !== "." &&
    name !== ".." &&
    !name.split(/[/\\]/).includes("..")
  );
}

/**
 * Read `<registryDir>/<spec>/manifest.json` — the file-backed
 * `@crewhaus/spec-registry` layout (`{ versions: [...], pins: { env: version } }`).
 *
 * Only the FILE is read here; the rule that active pins block a retirement
 * belongs to `buildRetirementPlan` in `@crewhaus/harness-lifecycle` and is
 * not restated. Anything that is not a well-formed manifest resolves to
 * `unknown`, never to an empty pin set.
 */
export function readRegistryPins(registryDirAbs: string, spec: string): PinState {
  const manifestPath = path.join(registryDirAbs, spec, "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent" };
    return {
      state: "unknown",
      reason: `the registry manifest for "${renderPath(spec)}" could not be read (${code ?? "unknown error"})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      state: "unknown",
      reason: `the registry manifest for "${renderPath(spec)}" is not valid JSON (${(err as Error).message})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      state: "unknown",
      reason: `the registry manifest for "${renderPath(spec)}" is not a JSON object`,
    };
  }
  const record = parsed as Record<string, unknown>;
  const rawPins = record["pins"];
  const rawVersions = record["versions"];
  const pins: Record<string, string> = {};
  if (rawPins !== undefined) {
    if (typeof rawPins !== "object" || rawPins === null || Array.isArray(rawPins)) {
      return {
        state: "unknown",
        reason: `the registry manifest for "${renderPath(spec)}" has a "pins" field that is not an object`,
      };
    }
    for (const [env, version] of Object.entries(rawPins as Record<string, unknown>)) {
      if (typeof version !== "string") {
        return {
          state: "unknown",
          reason: `the registry manifest for "${renderPath(spec)}" pins "${renderPath(env)}" to something that is not a version string`,
        };
      }
      pins[env] = version;
    }
  }
  let versions: string[] = [];
  if (rawVersions !== undefined) {
    if (!Array.isArray(rawVersions) || rawVersions.some((v) => typeof v !== "string")) {
      return {
        state: "unknown",
        reason: `the registry manifest for "${renderPath(spec)}" has a "versions" field that is not an array of strings`,
      };
    }
    versions = [...(rawVersions as string[])].sort();
  }
  return { state: "known", pins, versions };
}

// ---------------------------------------------------------------------------
// the step seam
// ---------------------------------------------------------------------------

export type StateManifest = {
  readonly writtenAt: string;
  readonly harnessDir: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly complete: boolean;
  readonly unreadable: Tree["unreadable"];
  readonly entries: Tree["entries"];
};

export type BuildStepsOptions = {
  /** The fingerprint of `.crewhaus` taken BEFORE anything moves. */
  readonly stateTree: Tree | undefined;
  readonly harnessDir: string;
  readonly pinState: PinState;
  readonly now: () => Date;
};

/**
 * The `RetirementSteps` this build can honestly supply.
 *
 * `backupState` does not make a second copy of the state: the package's own
 * archive step MOVES the live directory into the archive, so a copy beside it
 * would double the bytes and prove nothing. What it writes instead is the
 * per-file sha256 manifest taken before the move, which is what makes the
 * move checkable afterwards — and it refuses (ok: false, which aborts before
 * anything is destroyed) when that fingerprint is incomplete.
 */
export function buildRetireSteps(opts: BuildStepsOptions): RetirementSteps {
  return {
    async backupState(archiveDir: string): Promise<StepOutcome & { readonly tarball?: string }> {
      const tree = opts.stateTree;
      if (tree === undefined) {
        return {
          step: "backupState",
          ok: true,
          detail: `no ${STATE_RELDIR} directory under ${renderPath(opts.harnessDir)} — nothing to fingerprint`,
        };
      }
      if (!tree.complete) {
        return {
          step: "backupState",
          ok: false,
          detail: `${tree.unreadable.length} entry(ies) under ${STATE_RELDIR} could not be read, so the archive could not be fingerprinted: ${tree.unreadable
            .slice(0, 3)
            .map((u) => `${u.rel} (${u.reason})`)
            .join("; ")}`,
        };
      }
      const manifest: StateManifest = {
        writtenAt: opts.now().toISOString(),
        harnessDir: opts.harnessDir,
        fileCount: tree.fileCount,
        totalBytes: tree.totalBytes,
        complete: tree.complete,
        unreadable: tree.unreadable,
        entries: tree.entries,
      };
      const manifestPath = path.join(archiveDir, STATE_MANIFEST_FILENAME);
      try {
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      } catch (err) {
        return {
          step: "backupState",
          ok: false,
          detail: `the state manifest could not be written to the archive: ${(err as Error).message}`,
        };
      }
      return {
        step: "backupState",
        ok: true,
        detail: `fingerprinted ${tree.fileCount} file(s), ${tree.totalBytes} byte(s) → ${STATE_MANIFEST_FILENAME}`,
        tarball: manifestPath,
      };
    },

    async complianceEvidence(): Promise<StepOutcome> {
      return { step: "complianceEvidence", ok: false, detail: COMPLIANCE_EVIDENCE_UNAVAILABLE };
    },

    async auditVerify(): Promise<StepOutcome> {
      return { step: "auditVerify", ok: false, detail: AUDIT_VERIFY_UNAVAILABLE };
    },

    async pushKnowledge(): Promise<StepOutcome> {
      // Never planned by this tool: knowledge sharing is the KnowledgeSync
      // tool's job, and doing it here would push a harness's memories on the
      // way out of a call whose subject is deletion.
      return {
        step: "pushKnowledge",
        ok: true,
        detail:
          "skipped — run the KnowledgeSync tool before retiring if the lessons should outlive the harness",
      };
    },

    async tombstoneRegistry(): Promise<StepOutcome> {
      const pin = opts.pinState;
      if (pin.state === "absent") {
        // True, and the only case this build can honestly report as done:
        // there is no registry entry, so there is nothing to tombstone.
        return {
          step: "tombstoneRegistry",
          ok: true,
          detail: "no registry entry for this spec — nothing to tombstone",
        };
      }
      if (pin.state === "unknown") {
        return { step: "tombstoneRegistry", ok: false, detail: pin.reason };
      }
      if (pin.versions.length === 0 && Object.keys(pin.pins).length === 0) {
        return {
          step: "tombstoneRegistry",
          ok: true,
          detail: "the registry entry holds no versions and no pins — nothing to tombstone",
        };
      }
      return {
        step: "tombstoneRegistry",
        ok: false,
        detail: `${pin.versions.length} registered version(s) and ${Object.keys(pin.pins).length} pin(s) remain, and @crewhaus/spec-registry is not a dependency of @crewhaus/tool-lifecycle, so this tool cannot delete them. Remove them first (crewhaus registry delete), then retire — retiring now would leave a registry entry pointing at state that no longer exists.`,
      };
    },
  };
}

/**
 * Wrap a step set so every outcome is kept.
 *
 * `runRetirement` THROWS on the step that fails, and the retirement log it
 * writes into the archive only exists for the abort paths that get that far —
 * so a caller of the tool would otherwise be told "the tombstone failed" with
 * no record of the three steps that succeeded before it. Recording here means
 * a refused retirement reports the same per-step outcomes a completed one
 * does, which is what makes it possible to tell how far it got.
 */
export function recordSteps(steps: RetirementSteps): {
  readonly steps: RetirementSteps;
  readonly recorded: StepOutcome[];
} {
  const recorded: StepOutcome[] = [];
  const keep = <T extends StepOutcome>(outcome: T): T => {
    recorded.push({ step: outcome.step, ok: outcome.ok, detail: outcome.detail });
    return outcome;
  };
  return {
    recorded,
    steps: {
      backupState: async (archiveDir) => keep(await steps.backupState(archiveDir)),
      complianceEvidence: async (archiveDir) => keep(await steps.complianceEvidence(archiveDir)),
      auditVerify: async () => keep(await steps.auditVerify()),
      pushKnowledge: async (archiveDir) => keep(await steps.pushKnowledge(archiveDir)),
      tombstoneRegistry: async () => keep(await steps.tombstoneRegistry()),
    },
  };
}

/** Read back a state manifest written by `backupState`. */
export function readStateManifest(archiveDir: string): StateManifest | undefined {
  const p = path.join(archiveDir, STATE_MANIFEST_FILENAME);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StateManifest;
  } catch {
    return undefined;
  }
}
