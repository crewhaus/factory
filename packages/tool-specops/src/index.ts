/**
 * @crewhaus/tool-specops - changing a harness spec safely, as deterministic
 * tools.
 *
 * A spec is a file a human maintains. Four questions about changing one have
 * right answers and need no model turn: which edits may be applied and which
 * are refused and WHY (`SpecPatchApply`), what a release expects this spec's
 * author to know (`SpecUpgrade`), what the harness's own logs say to change
 * (`SpecAdvise`), and which of `doctor`'s findings have a mechanical repair
 * (`DoctorFix`).
 *
 * THESE TOOLS ARE THIN, AND THAT IS THE POINT. The CST edit, the
 * OPTIMIZABLE_PATHS allow-list, the advice rules, the upgrade-note detectors
 * and the four doctor fixers all live in `@crewhaus/spec-patch`,
 * `@crewhaus/harness-advice` and `@crewhaus/spec-changelog` - lifted out of
 * `apps/cli` (factory#468) precisely so a tool could reach them. Nothing here
 * re-derives a rule from those packages. What this package adds is the part a
 * library cannot: the schema a model is handed, the validation and refusals
 * in front of it, the containment boundary around every path, and a result
 * shape that can say "I could not tell" instead of guessing.
 *
 * THE SEAM THAT MATTERS. `SpecPatchApply` enforces the optimizer's
 * OPTIMIZABLE_PATHS allow-list - it is the surface an autonomous manager
 * patches, and a path outside the list comes back with the reason it is
 * human-owned rather than a bare "no". `DoctorFix` deliberately does NOT go
 * through that allow-list: its spec edit is one fixed repair
 * (`tool_config.<tool>.scope: external`) which the allow-list does not admit
 * by design, and it is gated instead by being a closed set of four fixers
 * whose every write is re-validated through `parseSpec`. Two different gates,
 * for two different threat models, neither of them a bypass of the other.
 *
 * WHAT THESE TOOLS DO NOT DO. They never run a harness, never reach a
 * provider, and never invent a value: every number in a result came from a
 * file that was read, and every file that could not be read is named in the
 * result rather than counted as empty.
 */

import { basename } from "node:path";
import {
  type AdviceFinding,
  type SessionEvents,
  buildAdviceContext,
  buildSuggestionsFile,
  parseJsonlObjects,
  runAdviceRules,
} from "@crewhaus/harness-advice/advise-rules";
import {
  type FixAction,
  formatFixPlan,
  planCrewhausDirs,
  planEnvStubs,
  planScaffoldSpec,
  planScopeFix,
} from "@crewhaus/harness-advice/doctor-fix";
import { type Spec, parseSpec, parseSpecIssues } from "@crewhaus/spec";
import { UPGRADE_NOTES_TABLE, collectUpgradeNotes } from "@crewhaus/spec-changelog/upgrade";
import {
  OPTIMIZABLE_PATHS,
  OPTIMIZER_REFUSED_LEAVES,
  type SpecPatch,
  applySpecPatch,
  diffSpecYaml,
  humanOwnedReason,
  specHasPath,
  validatePatch,
} from "@crewhaus/spec-patch";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type CapturedWrite, commitWrites, createOverlayFs } from "./lib/overlay-fs";
import {
  MAX_LOG_BYTES,
  compareStrings,
  json,
  loadSpecText,
  readJsonlDirectory,
  renderPath,
  resolveInput,
  specSourceFields,
  writeContained,
} from "./lib/sources";

/** A batch past this is not a review a human is going to do. */
const MAX_PATCHES = 64;
/** Session/audit directories are mined whole; this bounds one call's work. */
const DEFAULT_MAX_FILES = 200;
/**
 * Bytes one mining pass will read across a directory. A per-file cap bounds
 * one file; this bounds the pass, and a harness with more log than this gets
 * told it was truncated rather than quietly mined in part.
 */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Findings returned in one call, before the caller has to narrow. */
const DEFAULT_FINDING_LIMIT = 50;
/**
 * Characters of a captured write echoed back in a dry run. Measured in
 * characters because it bounds a string that goes into a transcript; the
 * `bytes` field beside it is the real UTF-8 size of what would land.
 */
const MAX_PREVIEW_CHARS = 8 * 1024;

const DEFAULT_SESSIONS_DIR = ".crewhaus/sessions";
const DEFAULT_AUDIT_DIR = ".crewhaus/audit";
const DEFAULT_SPEC_FILE = "crewhaus.yaml";
const DEFAULT_CREWHAUS_DIR = ".crewhaus";
const DEFAULT_ENV_FILE = ".env";

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/**
 * Parse a spec, or explain why it will not parse.
 *
 * The YAML-syntax issue is separated from schema issues because the two mean
 * different things to every tool here: a schema-invalid spec can still be
 * mined, diffed and read for upgrade notes, while an unparseable one cannot
 * be read at all - and `collectUpgradeNotes` answers "no notes apply" for
 * both, which is the empty-versus-unreadable confusion this package refuses
 * to pass on.
 */
type ParsedSpec = {
  readonly spec?: Spec;
  /** The YAML syntax error, when the text is not YAML at all. */
  readonly yamlError?: string;
  /** The first schema/cross-field issue, when it is YAML but not a spec. */
  readonly schemaError?: string;
  /**
   * The document is well-formed YAML whose ROOT is not a mapping - a
   * sequence, a scalar, or empty.
   *
   * This is its own answer because it is the exact condition under which
   * every reader that walks a spec as an OBJECT gives up and returns nothing:
   * `@crewhaus/spec-changelog`'s note detectors bail at their
   * `parseSpecObject` and hand back `[]`, which is byte-identical to "no note
   * applies". A schema-INVALID mapping is a different case entirely - the
   * detectors read it fine, which is the whole reason `SpecUpgrade` accepts
   * one - so the two must not share a branch.
   *
   * The zod issue is the discriminator: the Spec union is a
   * `discriminatedUnion`, so a non-mapping root is the only way to get an
   * `invalid_type` issue at the ROOT path. A mapping with a missing or wrong
   * `target` reports `invalid_union_discriminator` at `["target"]`, and any
   * deeper problem reports a non-empty path. Pinned by tests over all four
   * root shapes plus a schema-invalid mapping.
   */
  readonly rootIsNotAMapping?: boolean;
};

function inspectSpec(text: string): ParsedSpec {
  try {
    return { spec: parseSpec(text) };
  } catch {
    const issues = parseSpecIssues(text);
    const syntax = issues.find((i) => i.code === "yaml_syntax");
    if (syntax !== undefined) return { yamlError: syntax.message };
    const first = issues[0];
    const where = first === undefined ? "" : `${renderIssuePath(first.path)}: `;
    const rootTypeIssue =
      first !== undefined && first.code === "invalid_type" && first.path.length === 0;
    return {
      ...(rootTypeIssue ? { rootIsNotAMapping: true } : {}),
      schemaError:
        first === undefined
          ? "the spec did not parse, and the issue list was empty"
          : `${where}${first.message}`,
    };
  }
}

function renderIssuePath(segments: ReadonlyArray<string | number>): string {
  return segments.length > 0 ? segments.join(".") : "<root>";
}

/**
 * Whitelisted paths that share the refused path's first segment.
 *
 * A bare rejection sends an autonomous caller into a retry loop; the entries
 * come straight out of `OPTIMIZABLE_PATHS`, so this hint cannot drift from
 * what the applier will actually accept.
 */
function admissibleNear(target: Spec["target"], path: ReadonlyArray<string>): string[] {
  const entries = OPTIMIZABLE_PATHS[target] ?? [];
  const head = path[0];
  if (head === undefined) return [];
  const near = entries
    .filter((entry) => entry[0] === head || entry[0] === "*")
    .map((entry) => entry.join("."));
  return [...new Set(near)].sort(compareStrings).slice(0, 8);
}

/**
 * The refused leaf that a `remove` at `path` would delete, if any.
 *
 * SAME EDIT, TWO SPELLINGS, ONE GATE. `validatePatch`'s block-level guard
 * (`refusedBlockValueKey`) asks what a patch's VALUE would change, so it
 * returns at its first line for a `remove`, whose value is `undefined` by
 * definition. The consequence is a hole with the shape this repository keeps
 * shipping: `replace`-ing `agent.model_pool.learning` with a block that DROPS
 * `seed` is refused with §6.1's reason, and `remove`-ing that same block -
 * which deletes the same pinned seed - sails through. A routed eval pins that
 * seed; either spelling unpins it.
 *
 * This is the tool's refusal layer, not a second rule: the table below is
 * `OPTIMIZER_REFUSED_LEAVES` itself, imported, so a row added upstream is
 * enforced here on the day it lands. The suffix match mirrors the one the
 * value-side guard uses, because both are asking about the same patterns.
 * (The durable fix belongs in `validatePatch`, which should treat a remove as
 * a value of `{}`; that is a shared package this review did not widen.)
 */
function refusedLeafRemovedBy(
  yamlText: string,
  path: ReadonlyArray<string>,
): { readonly leaf: string; readonly pattern: string } | undefined {
  for (const pattern of OPTIMIZER_REFUSED_LEAVES) {
    const parent = pattern.slice(0, -1);
    const leafKey = pattern[pattern.length - 1];
    if (leafKey === undefined) continue;
    const endsWithParent =
      path.length >= parent.length &&
      parent.every((p, i) => path[path.length - parent.length + i] === p);
    if (!endsWithParent) continue;
    // Only when the document ACTUALLY carries the leaf: removing a block that
    // never held a seed unpins nothing, and refusing it would be a guess.
    const full = [...path, leafKey];
    if (specHasPath(yamlText, full)) {
      return { leaf: full.join("."), pattern: pattern.join(".") };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SpecPatchApply
// ---------------------------------------------------------------------------

const patchInputSchema = z.object({
  path: z
    .array(z.string().min(1))
    .min(1)
    .max(12)
    .describe('the field to change, as a key chain: ["agent","max_tokens"]'),
  op: z
    .enum(["replace", "add", "remove"])
    .optional()
    .describe(
      "omitted, the op is chosen from whether the key is already in the FILE (replace) or not (add) - the distinction the CST enforces and a defaulted field hides",
    ),
  value: z.unknown().optional().describe("the new value; required for replace and add"),
  rationale: z
    .string()
    .max(2000)
    .optional()
    .describe("why, carried into the result for the human reviewing the change"),
});

type PreparedPatch = {
  readonly index: number;
  readonly path: ReadonlyArray<string>;
  /** The op as validated; recomputed against the running text at apply time. */
  readonly op: SpecPatch["op"];
  readonly explicitOp: boolean;
  readonly patch: SpecPatch;
};

export const specPatchApply: RegisteredTool = buildTool({
  name: "SpecPatchApply",
  operativeArgs: [{ field: "path", kind: "path" }],
  description:
    "Apply structured patches to a CrewHaus spec as a comment-preserving CST edit, refusing any path the optimizer allow-list does not admit and naming the reason per path. Use to change a tunable field - a token cap, a threshold, a pool policy - in a spec a human maintains, without reformatting their file. Defaults to a DRY RUN: it returns the patched YAML and the field-level diff and writes nothing until you pass dryRun: false with a path. The batch is applied in memory and re-validated after every patch, so a batch that breaks the schema never reaches the file. It refuses the identity, security and roster fields by design - model rosters, permissions, credentials and prompts are human-owned, and the refusal says which rule owns them.",
  inputSchema: z.object({
    ...specSourceFields,
    patches: z
      .array(patchInputSchema)
      .min(1)
      .max(MAX_PATCHES)
      .describe("applied in order, atomically: either every patch lands or the file is untouched"),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "default TRUE. A dry run returns the patched text from the same applier the write uses; only dryRun: false writes, and only when a path was given",
      ),
  }),
  destructive: true,
  execute: async (input) => {
    const toolName = "SpecPatchApply";
    const loaded = loadSpecText(toolName, input);
    if (!loaded.ok) return loaded.message;
    const original = loaded.value;
    const inspected = inspectSpec(original);
    if (inspected.spec === undefined) {
      return json({
        ok: false,
        applied: 0,
        wrote: false,
        error:
          inspected.yamlError !== undefined
            ? `the spec is not parseable YAML: ${inspected.yamlError}`
            : `the spec does not satisfy the schema, so a patch cannot be validated against it: ${inspected.schemaError}`,
      });
    }
    const spec = inspected.spec;

    const prepared: PreparedPatch[] = input.patches.map((p, index) => {
      const explicitOp = p.op !== undefined;
      const op: SpecPatch["op"] = p.op ?? (specHasPath(original, p.path) ? "replace" : "add");
      return {
        index,
        path: p.path,
        op,
        explicitOp,
        patch: {
          target: spec.target,
          path: p.path,
          op,
          ...(p.value !== undefined ? { value: p.value } : {}),
          ...(p.rationale !== undefined ? { rationale: p.rationale } : {}),
        },
      };
    });

    // Every patch is judged before any is applied, and ALL refusals come back
    // at once: a caller that learns one refusal per round trip is a caller in
    // a retry loop.
    const refused: Array<Record<string, unknown>> = [];
    for (const item of prepared) {
      const dotted = item.path.join(".");
      if (item.op !== "remove" && item.patch.value === undefined) {
        refused.push({
          index: item.index,
          path: dotted,
          reason: `op "${item.op}" needs a value`,
        });
        continue;
      }
      try {
        validatePatch(spec, item.patch);
      } catch (err) {
        const owned = humanOwnedReason(item.path);
        refused.push({
          index: item.index,
          path: dotted,
          reason: (err as Error).message,
          ...(owned !== undefined ? { humanOwned: owned } : {}),
          admissibleNearby: admissibleNear(spec.target, item.path),
        });
        continue;
      }
      // The removal half of the block guard `validatePatch` only applies to
      // values. See `refusedLeafRemovedBy`.
      if (item.op === "remove") {
        const unpinned = refusedLeafRemovedBy(original, item.path);
        if (unpinned !== undefined) {
          refused.push({
            index: item.index,
            path: dotted,
            reason: `removing ${dotted} would delete "${unpinned.leaf}", which is not optimizable: a routed eval PINS ${unpinned.pattern}, so unpinning it makes every later measured delta incomparable. Replace the block carrying the spec's existing seed instead, or remove the seed by hand.`,
            admissibleNearby: admissibleNear(spec.target, item.path),
          });
        }
      }
    }
    if (refused.length > 0) {
      return json({
        ok: false,
        target: spec.target,
        applied: 0,
        wrote: false,
        refused,
        note: "nothing was applied - a batch is all or nothing, so one refused path leaves the file untouched",
      });
    }

    let current = original;
    const applied: Array<Record<string, unknown>> = [];
    for (const item of prepared) {
      // Recomputed against the RUNNING text, not the original: an earlier
      // patch in the same batch can create the key this one addresses, and an
      // "add" onto a key that now exists is refused by the CST.
      const op: SpecPatch["op"] = item.explicitOp
        ? item.op
        : specHasPath(current, item.path)
          ? "replace"
          : "add";
      const patch: SpecPatch = { ...item.patch, op };
      try {
        current = applySpecPatch(current, patch).yaml;
      } catch (err) {
        return json({
          ok: false,
          target: spec.target,
          applied: 0,
          wrote: false,
          failedAt: {
            index: item.index,
            path: item.path.join("."),
            op,
            reason: (err as Error).message,
          },
          note: "nothing was written: the batch is applied to an in-memory document that is re-validated after every patch, and only a batch that survives all of them reaches the file",
        });
      }
      applied.push({ index: item.index, path: item.path.join("."), op });
    }

    const diff = diffSpecYaml(original, current).map((d) => ({
      kind: d.kind,
      path: d.path,
      ...(d.before !== undefined ? { before: d.before } : {}),
      ...(d.after !== undefined ? { after: d.after } : {}),
    }));
    const unchanged = current === original;
    const dryRun = input.dryRun ?? true;

    if (input.path === undefined) {
      return json({
        ok: true,
        target: spec.target,
        applied: applied.length,
        patches: applied,
        changed: !unchanged,
        diff,
        wrote: false,
        wroteReason:
          'the spec was passed inline as "spec", so there is no file to write - the patched text is returned here',
        yaml: current,
      });
    }
    if (dryRun) {
      return json({
        ok: true,
        target: spec.target,
        applied: applied.length,
        patches: applied,
        changed: !unchanged,
        diff,
        wrote: false,
        wroteReason: "dryRun (the default) - pass dryRun: false to write this same text",
        yaml: current,
      });
    }

    if (unchanged) {
      // A no-op write is not free: `BundleFreshness` and the CLI's staleness
      // checks compare the spec's mtime against the compiled bundle's, so
      // rewriting byte-identical content would make every bundle in the fleet
      // look stale. A patch that changed nothing changes nothing on disk.
      return json({
        ok: true,
        target: spec.target,
        applied: applied.length,
        patches: applied,
        changed: false,
        diff,
        wrote: false,
        wroteReason:
          "the patched document is byte-identical to the file, so it was not rewritten - an mtime bump would make the compiled bundle look stale",
      });
    }

    const written = writeContained(toolName, input.path, current);
    if (!written.ok) {
      return json({
        ok: false,
        target: spec.target,
        applied: applied.length,
        patches: applied,
        diff,
        wrote: false,
        error: written.message,
        note: "the patched document is valid; only the write failed. Re-run with dryRun to recover the text",
      });
    }
    return json({
      ok: true,
      target: spec.target,
      applied: applied.length,
      patches: applied,
      changed: !unchanged,
      diff,
      wrote: { path: renderPath(input.path), bytes: written.value },
    });
  },
});

// ---------------------------------------------------------------------------
// SpecUpgrade
// ---------------------------------------------------------------------------

export const specUpgrade: RegisteredTool = buildTool({
  name: "SpecUpgrade",
  description:
    "Report the post-release upgrade notes that actually apply to one spec, and whether every note that applies has been acknowledged (notesCleared). Use after a CLI release to find out what a release changed FOR THIS SPEC - each note's detector runs against the file, so a spec that is unaffected gets an empty list and the releases that were checked. It is read-only and writes nothing. notesCleared is the NOTE gate only, never a go-ahead: it does NOT run the schema migration chain, because the migration engine is not a dependency of this package, so the schema-version drift comes back as undetermined rather than guessed - run `crewhaus upgrade` for that verdict and for the migration itself. A spec no detector could read - unparseable YAML, or a top level that is not a mapping - is a refusal, never the empty note list that would read as a clean bill of health.",
  inputSchema: z.object({
    ...specSourceFields,
    acknowledgedNoteIds: z
      .array(z.string().min(1).max(200))
      .max(64)
      .optional()
      .describe(
        "note ids the caller has already handled. Any applicable note NOT listed here lands in blockedBy and holds `notesCleared` at false - an unknown note fails closed",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadSpecText("SpecUpgrade", input);
    if (!loaded.ok) return loaded.message;
    const text = loaded.value;
    const inspected = inspectSpec(text);
    // `collectUpgradeNotes` answers "[]" for unparseable YAML, which reads
    // exactly like "no notes apply". Refusing here is what keeps the two
    // apart - the caller must not learn "you are up to date" from a file the
    // detectors could not read.
    if (inspected.yamlError !== undefined) {
      return json({
        ok: false,
        error: `the spec is not parseable YAML, so no note detector could run against it: ${inspected.yamlError}`,
      });
    }
    // The SECOND way `collectUpgradeNotes` answers "[]" without looking: every
    // detector starts by reading the document as an object and gives up when
    // the root is a sequence, a scalar, or empty. That is YAML, so the syntax
    // guard above does not catch it, and the empty note list it produces is
    // indistinguishable from a clean bill of health - which an unattended
    // upgrade driver reads as "go". A schema-invalid MAPPING is deliberately
    // still accepted: the detectors read it, and a spec written for an older
    // schema is the main reason to ask for notes at all.
    if (inspected.rootIsNotAMapping === true) {
      return json({
        ok: false,
        error: `the spec's top level is not a mapping (${inspected.schemaError}), so every release-note detector gave up before reading it. The empty note list that produces is NOT "no notes apply" - nothing was checked.`,
      });
    }

    const notes = collectUpgradeNotes(text);
    const acknowledged = new Set(input.acknowledgedNoteIds ?? []);
    const blockedBy = notes.filter((n) => !acknowledged.has(n.id)).map((n) => n.id);
    const specVersion = inspected.spec?.version;

    return json({
      ok: true,
      // The NOTE gate, and ONLY that. Deliberately not a bare `ready`: the
      // go/no-go for an unattended upgrade also needs the schema-migration
      // verdict below, which this package cannot compute, and a boolean
      // called `ready` sitting beside `determined: false` is exactly the
      // "could not tell, answered yes" shape this package exists to refuse.
      notesCleared: blockedBy.length === 0,
      blockedBy,
      // Which releases were CHECKED, so an empty note list is "these
      // detectors ran and none fired", not "nothing looked".
      releasesChecked: UPGRADE_NOTES_TABLE.map((r) => r.release),
      noteCount: notes.length,
      notes: notes.map((n) => ({
        id: n.id,
        release: n.release,
        title: n.title,
        body: n.body,
        acknowledged: acknowledged.has(n.id),
      })),
      specVersion:
        specVersion !== undefined
          ? { known: true, version: specVersion }
          : {
              known: false,
              reason:
                inspected.spec !== undefined
                  ? "the spec carries no `version:` stamp (an unversioned spec reads as v0)"
                  : `the spec does not satisfy the schema, so its version stamp was not read: ${inspected.schemaError}`,
            },
      schemaMigration: {
        determined: false,
        reason:
          "the migration chain and the current schema version live in @crewhaus/migration-engine, which this package does not depend on. Whether this spec is behind, level with, or ahead of the CLI's schema was NOT determined here - run `crewhaus upgrade` (dry-run) for that verdict; it also applies the migration.",
      },
    });
  },
});

// ---------------------------------------------------------------------------
// SpecAdvise
// ---------------------------------------------------------------------------

export const specAdvise: RegisteredTool = buildTool({
  name: "SpecAdvise",
  description:
    "Mine a harness's own session logs with the shipped advice rules and return ranked findings, each with the counts it fired on and either an applyable spec patch or advice text. Use to answer 'what should this spec change' from evidence rather than opinion: every finding carries its thresholds and evidence, and every emitted patch is pre-validated against the same allow-list SpecPatchApply enforces, so a patch here is one that applies. It reports what it could NOT read - unreadable logs, a missing directory, a spec that would not parse - because a clean bill of health from an empty read is the one answer worth nothing. The model_pool reward-scoreboard rules cannot fire here: that store is not a dependency of this package, and the result says so rather than reporting no routing findings.",
  inputSchema: z.object({
    spec: z
      .string()
      .optional()
      .describe("the spec YAML text, inline; without a spec every finding is advice text"),
    path: z.string().optional().describe("path to the spec file instead"),
    sessionsDir: z
      .string()
      .optional()
      .describe(`directory of session .jsonl logs (default ${DEFAULT_SESSIONS_DIR})`),
    auditDir: z
      .string()
      .optional()
      .describe(`directory of audit .jsonl records (default ${DEFAULT_AUDIT_DIR})`),
    maxFiles: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .describe(`.jsonl files read per directory (default ${DEFAULT_MAX_FILES})`),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe(`findings returned (default ${DEFAULT_FINDING_LIMIT}, ranked worst first)`),
    generatedAt: z
      .string()
      .max(64)
      .optional()
      .describe(
        "timestamp stamped into the suggestions payload. Omitted, the payload carries none - this tool has no clock of its own",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const toolName = "SpecAdvise";
    const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;

    const sessionsRel = input.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    const sessionDir = readJsonlDirectory(
      toolName,
      sessionsRel,
      parseJsonlObjects,
      MAX_LOG_BYTES,
      maxFiles,
      DEFAULT_MAX_TOTAL_BYTES,
    );
    const auditRel = input.auditDir ?? DEFAULT_AUDIT_DIR;
    const auditDir = readJsonlDirectory(
      toolName,
      auditRel,
      parseJsonlObjects,
      MAX_LOG_BYTES,
      maxFiles,
      DEFAULT_MAX_TOTAL_BYTES,
    );

    const sessions: SessionEvents[] = sessionDir.files.map((f) => ({
      sessionId: f.name.replace(/\.jsonl$/, ""),
      objects: f.lines,
    }));
    const auditObjects = auditDir.files.flatMap((f) => [...f.lines]);

    // The spec is optional: mining must not block on it, exactly as the CLI's
    // advise does. But a spec that was GIVEN and did not parse is reported -
    // silently downgrading every patch to advice would look like a healthy run.
    let spec: Spec | undefined;
    let specText: string | undefined;
    let specNote: string | undefined;
    if (input.spec !== undefined || input.path !== undefined) {
      const loaded = loadSpecText(toolName, { spec: input.spec, path: input.path });
      if (!loaded.ok) {
        specNote = `${loaded.message} - every finding is advice text, and no patch was proposed`;
      } else {
        const inspected = inspectSpec(loaded.value);
        if (inspected.spec === undefined) {
          specNote = `the spec did not parse (${inspected.yamlError ?? inspected.schemaError}) - every finding is advice text, and no patch was proposed`;
        } else {
          spec = inspected.spec;
          specText = loaded.value;
        }
      }
    }

    const ctx = buildAdviceContext(sessions, auditObjects);
    const specTextForOps = specText;
    const findings: AdviceFinding[] = runAdviceRules(ctx, {
      ...(spec !== undefined ? { spec } : {}),
      ...(spec !== undefined && specTextForOps !== undefined
        ? { specHasPath: (p: readonly string[]) => specHasPath(specTextForOps, p) }
        : {}),
    });
    const limit = input.limit ?? DEFAULT_FINDING_LIMIT;
    const shown = findings.slice(0, limit);
    const suggestions = buildSuggestionsFile(
      findings,
      ctx.sessionIds,
      input.generatedAt ?? "",
    ).suggestions;

    const malformedLines = sessionDir.files.reduce((sum, f) => sum + f.malformed, 0);
    const auditMalformedLines = auditDir.files.reduce((sum, f) => sum + f.malformed, 0);
    const incomplete: string[] = [];
    if (sessionDir.unavailable !== undefined)
      incomplete.push(`sessions: ${sessionDir.unavailable}`);
    if (sessionDir.truncated !== undefined) incomplete.push(`sessions: ${sessionDir.truncated}`);
    // The audit directory is optional context - no shipped rule fires on it,
    // and most harnesses have none - so its ABSENCE is reported under
    // `sources` but only counts against `complete` when the caller named a
    // directory and therefore expected one. A default that is merely absent is
    // not an incomplete read.
    //
    // That exemption covers absence and NOTHING ELSE. A directory that existed
    // and was read in PART is a partial read whoever named it, and it used to
    // ride the same field and the same `input.auditDir !== undefined` gate - so
    // a default `.crewhaus/audit` truncated at maxFiles came back with
    // `complete: true` and an `auditRecords` count of the fraction that was
    // read. Same for lines inside a file that was read: an audit log with
    // corrupt records is not an audit log with fewer records.
    if (auditDir.unavailable !== undefined && input.auditDir !== undefined) {
      incomplete.push(`audit: ${auditDir.unavailable}`);
    }
    if (auditDir.truncated !== undefined) incomplete.push(`audit: ${auditDir.truncated}`);
    for (const u of sessionDir.unreadable) incomplete.push(`sessions/${u.name}: ${u.reason}`);
    for (const u of auditDir.unreadable) incomplete.push(`audit/${u.name}: ${u.reason}`);
    if (malformedLines > 0) {
      incomplete.push(`${malformedLines} session line(s) were not parseable JSON and were skipped`);
    }
    if (auditMalformedLines > 0) {
      incomplete.push(
        `${auditMalformedLines} audit line(s) were not parseable JSON and were skipped`,
      );
    }
    if (specNote !== undefined) incomplete.push(specNote);
    if (findings.length > shown.length) {
      incomplete.push(`${findings.length - shown.length} finding(s) past limit ${limit}`);
    }

    return json({
      ok: true,
      // False whenever anything the rules would have mined was not mined. A
      // caller must never read "0 findings" as "healthy" without this.
      complete: incomplete.length === 0,
      incomplete,
      sessionsMined: sessions.length,
      sessionIds: ctx.sessionIds,
      auditRecords: auditObjects.length,
      findingCount: findings.length,
      patchCount: suggestions.length,
      findings: shown.map((f) => ({
        id: f.id,
        severity: f.severity,
        summary: f.summary,
        evidence: f.evidence,
        counts: f.counts,
        suggestion:
          f.suggestion.kind === "spec-patch"
            ? {
                kind: "spec-patch",
                patch: {
                  target: f.suggestion.patch.target,
                  path: f.suggestion.patch.path,
                  op: f.suggestion.patch.op,
                  value: f.suggestion.patch.value,
                  ...(f.suggestion.patch.rationale !== undefined
                    ? { rationale: f.suggestion.patch.rationale }
                    : {}),
                },
              }
            : { kind: "advice", text: f.suggestion.text },
      })),
      ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
      sources: {
        sessions: {
          dir: sessionDir.dir,
          files: sessionDir.files.length,
          malformedLines,
          unreadable: sessionDir.unreadable,
          ...(sessionDir.unavailable !== undefined ? { unavailable: sessionDir.unavailable } : {}),
          ...(sessionDir.truncated !== undefined ? { truncated: sessionDir.truncated } : {}),
        },
        audit: {
          dir: auditDir.dir,
          files: auditDir.files.length,
          malformedLines: auditMalformedLines,
          unreadable: auditDir.unreadable,
          ...(auditDir.unavailable !== undefined ? { unavailable: auditDir.unavailable } : {}),
          ...(auditDir.truncated !== undefined ? { truncated: auditDir.truncated } : {}),
        },
        spec: {
          given: input.spec !== undefined || input.path !== undefined,
          parsed: spec !== undefined,
          ...(specNote !== undefined ? { reason: specNote } : {}),
        },
        routingScoreboard: {
          read: false,
          reason:
            "the model_pool reward scoreboard lives in @crewhaus/routing-store, which this package does not depend on. The pool rules (policy upgrade, candidate demotion, stale exploitation) mine that store and therefore did NOT run - their silence here is not evidence that routing is healthy. Run `crewhaus advise` for those.",
        },
      },
    });
  },
});

// ---------------------------------------------------------------------------
// DoctorFix
// ---------------------------------------------------------------------------

/** The four mechanical repairs, as ids a caller selects. */
const FIX_IDS = ["scaffold-spec", "crewhaus-dirs", "tool-scope", "env-stubs"] as const;
type FixId = (typeof FIX_IDS)[number];

/**
 * An env var NAME, and nothing else.
 *
 * `planEnvStubs` writes `# ${name}=` verbatim, so a name carrying a newline
 * would append arbitrary lines to the operator's `.env` - including a line
 * that is not commented out. The name is therefore parsed to a shape before
 * it is handed over, and the value side does not exist in this schema at all:
 * there is nowhere to pass a secret to this tool.
 */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
/** A spec name is interpolated into `name: ${x}` in scaffolded YAML. */
const SPEC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const doctorFix: RegisteredTool = buildTool({
  name: "DoctorFix",
  operativeArgs: [
    { field: "specPath", kind: "path", default: DEFAULT_SPEC_FILE },
    { field: "crewhausDir", kind: "path", default: DEFAULT_CREWHAUS_DIR },
    { field: "envPath", kind: "path", default: DEFAULT_ENV_FILE },
  ],
  description:
    "Apply the mechanical repairs `crewhaus doctor` only prints: scaffold a missing spec, create the state directory, mark an outward-reaching tool `scope: external` in the spec, and append COMMENTED env stubs for missing provider credentials. Use when doctor reported a finding that has a deterministic fix and you want it made rather than described. Defaults to a DRY RUN that reports the exact bytes each change would write, produced by running the real fixer against an in-memory overlay - the preview is the write, not a rendering of it. It never writes a credential VALUE (stubs are commented out and there is no field to pass one), never touches a tool it cannot name safely, and applies nothing at all if any selected fix fails.",
  inputSchema: z.object({
    fixes: z
      .array(z.enum(FIX_IDS))
      .min(1)
      .describe(
        "which repairs to run. Order is fixed regardless of how they are listed, so a scaffolded spec exists before a scope fix patches it",
      ),
    specPath: z.string().optional().describe(`the spec file (default ${DEFAULT_SPEC_FILE})`),
    specName: z
      .string()
      .max(64)
      .optional()
      .describe("name for a scaffolded spec (default: the working directory's name)"),
    crewhausDir: z
      .string()
      .optional()
      .describe(`the state directory (default ${DEFAULT_CREWHAUS_DIR})`),
    envPath: z.string().optional().describe(`the env file (default ${DEFAULT_ENV_FILE})`),
    toolNames: z
      .array(z.string().min(1).max(128))
      .max(64)
      .optional()
      .describe("tools to mark scope: external - required by the tool-scope fix"),
    envVars: z
      .array(z.string().min(1).max(128))
      .max(64)
      .optional()
      .describe(
        "env var NAMES to stub, commented out - required by the env-stubs fix. Names only: this tool has no field for a value",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "default TRUE. The dry run executes the same fixers against an in-memory overlay and reports what they wrote; dryRun: false commits those exact bytes",
      ),
  }),
  destructive: true,
  execute: async (input) => {
    const toolName = "DoctorFix";
    const selected = new Set<FixId>(input.fixes);
    const specPath = input.specPath ?? DEFAULT_SPEC_FILE;
    const crewhausDir = input.crewhausDir ?? DEFAULT_CREWHAUS_DIR;
    const envPath = input.envPath ?? DEFAULT_ENV_FILE;
    const specName = input.specName ?? basename(process.cwd());

    // -- input validation, all of it before any planner runs --
    const problems: string[] = [];
    for (const rel of [specPath, crewhausDir, envPath]) {
      const safe = resolveInput(toolName, rel);
      if (!safe.ok) problems.push(safe.message);
    }
    if (selected.has("scaffold-spec") && !SPEC_NAME_RE.test(specName)) {
      problems.push(
        `specName ${JSON.stringify(renderPath(specName))}${input.specName === undefined ? " (defaulted from the working directory's name)" : ""} is not a plain name - it is interpolated into the scaffolded YAML, so it must match ${SPEC_NAME_RE.source}`,
      );
    }
    if (selected.has("tool-scope") && (input.toolNames ?? []).length === 0) {
      problems.push('the "tool-scope" fix needs toolNames');
    }
    if (selected.has("env-stubs") && (input.envVars ?? []).length === 0) {
      problems.push('the "env-stubs" fix needs envVars');
    }
    for (const name of input.envVars ?? []) {
      if (!ENV_NAME_RE.test(name)) {
        problems.push(
          `envVars entry ${JSON.stringify(renderPath(name))} is not an env var name (${ENV_NAME_RE.source}) - a name is written into .env verbatim, so anything else could inject a line`,
        );
      }
    }
    if (problems.length > 0) {
      return json({ ok: false, wrote: false, problems });
    }

    // The only files a fixer reads are a spec and a `.env`; the default cap is
    // the spec cap, which is the larger of the two.
    const fs = createOverlayFs(toolName);
    const actions: FixAction[] = [];
    const skipped: Array<{ readonly fix: FixId; readonly reason: string }> = [];

    /**
     * Plan a fix and RUN it immediately, against the overlay.
     *
     * Planning the whole batch first and applying afterwards was the obvious
     * shape and the wrong one: the scope fixer asks the seam whether the spec
     * exists, and a scaffold planned-but-not-yet-applied has not created it,
     * so a two-phase batch skipped the scope fix with "the spec does not
     * exist" while writing that very spec. Each fix therefore lands in the
     * overlay before the next one is planned - in dry-run and real mode
     * alike, since the overlay is where both of them run.
     */
    const runFix = (action: FixAction | undefined, onSkip: string, fix: FixId): void => {
      if (action === undefined) {
        skipped.push({ fix, reason: onSkip });
        return;
      }
      try {
        action.apply();
      } catch (err) {
        throw new Error(`[${action.check}] ${action.summary} failed: ${(err as Error).message}`);
      }
      actions.push(action);
    };

    // Fixed order, independent of how the caller listed them: the scaffolded
    // spec has to exist before a scope fix reads it, and the overlay is what
    // lets the second see the first.
    try {
      if (selected.has("scaffold-spec")) {
        runFix(
          planScaffoldSpec({ fs, specPath, specName }),
          `"${renderPath(specPath)}" already exists`,
          "scaffold-spec",
        );
      }
      if (selected.has("crewhaus-dirs")) {
        runFix(
          planCrewhausDirs({ fs, crewhausDir }),
          `"${renderPath(crewhausDir)}" already exists`,
          "crewhaus-dirs",
        );
      }
      if (selected.has("tool-scope")) {
        // The spec has to be there to patch. Without this the fixer's apply()
        // throws mid-batch, which is a refusal dressed as a crash.
        if (!fs.exists(specPath)) {
          skipped.push({
            fix: "tool-scope",
            reason: `"${renderPath(specPath)}" does not exist - scaffold it first, or point specPath at the spec`,
          });
        } else {
          const inspected = inspectSpec(fs.read(specPath));
          if (inspected.spec === undefined) {
            skipped.push({
              fix: "tool-scope",
              reason: `"${renderPath(specPath)}" does not parse (${inspected.yamlError ?? inspected.schemaError}), so its target is unknown and no patch can be validated`,
            });
          } else {
            for (const raw of input.toolNames ?? []) {
              runFix(
                planScopeFix({
                  fs,
                  specPath,
                  specTarget: inspected.spec.target,
                  toolName: raw,
                }),
                `${JSON.stringify(renderPath(raw))} is not a plain tool identifier, or is a dynamic mcp__ sink - those are definitionally external and need a human's vetting, not a mechanical stamp`,
                "tool-scope",
              );
            }
          }
        }
      }
      if (selected.has("env-stubs")) {
        runFix(
          planEnvStubs({ fs, envPath, neededVars: input.envVars ?? [] }),
          `every name is already present in "${renderPath(envPath)}", set or commented`,
          "env-stubs",
        );
      }
    } catch (err) {
      return json({
        ok: false,
        wrote: false,
        error: (err as Error).message,
        note: "nothing was written: every fix runs against an in-memory overlay first, and a batch with a failing fix is never committed",
      });
    }

    const captured = fs.captured();

    // THE INVARIANT THIS PACKAGE CLAIMS, ENFORCED WHERE IT BELONGS. DoctorFix
    // is gated not by OPTIMIZABLE_PATHS but by being a closed set of fixers
    // "whose every write is re-validated through parseSpec" - and that was only
    // true of `planScopeFix`, which re-validates inside `applySpecPatch`.
    // `planScaffoldSpec` writes raw text, so a `specName` that is a YAML scalar
    // of the wrong TYPE - `123`, `true`, `1.5`, `0x10`, and above all the
    // DEFAULT, which is the working directory's basename - produced `name: 123`
    // and a spec that does not parse, reported as ok:true and committed.
    // Charset validation could not have caught it: the name passed
    // SPEC_NAME_RE, the DOCUMENT is what failed. So the document is what gets
    // checked, through the same `parseSpec` that is the authority everywhere
    // else - never a second list of names YAML happens to type oddly.
    const specKey = resolveInput(toolName, specPath);
    const specRel = specKey.ok ? specKey.value.rel : specPath;
    for (const w of captured) {
      if (w.kind !== "file" || w.path !== specRel) continue;
      const written = inspectSpec(w.content);
      if (written.spec === undefined) {
        return json({
          ok: false,
          wrote: false,
          error: `the spec these fixes produced does not parse (${written.yamlError ?? written.schemaError}), so it was not written${
            input.specName === undefined
              ? ' - specName defaulted to the working directory\'s name, and YAML does not read every name as a string (a directory called "2026" scaffolds a NUMBER). Pass specName explicitly.'
              : " - pass a specName YAML reads as a string"
          }`,
          note: "nothing was written: every fix runs against an in-memory overlay first, and a batch whose spec would not parse is never committed",
        });
      }
    }

    const changes = captured.map((w: CapturedWrite) =>
      w.kind === "dir"
        ? { kind: "dir" as const, path: w.path }
        : {
            kind: "file" as const,
            path: w.path,
            bytes: Buffer.byteLength(w.content, "utf8"),
            content:
              w.content.length > MAX_PREVIEW_CHARS
                ? `${w.content.slice(0, MAX_PREVIEW_CHARS)}...`
                : w.content,
            ...(w.content.length > MAX_PREVIEW_CHARS ? { contentTruncated: true } : {}),
          },
    );
    const plan = {
      fixes: actions.map((a) => ({ check: a.check, summary: a.summary, diff: a.diff })),
      skipped,
      changes,
    };
    // `formatFixPlan`'s boolean is "these were APPLIED", which is only known
    // AFTER the commit. Building the report beside the plan meant a batch whose
    // commit failed still carried the line "doctor --fix: applied 2 fix(es)"
    // next to `committed: []` - the prose half of the result asserting an
    // outcome the machine half denied, and the half a human reads first.
    const report = (appliedForReal: boolean): string => formatFixPlan(actions, appliedForReal);

    const dryRun = input.dryRun ?? true;
    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        wrote: false,
        ...plan,
        report: report(false),
        note: "these are the exact bytes the fixers produced; dryRun: false commits them unchanged",
      });
    }
    if (captured.length === 0) {
      return json({
        ok: true,
        dryRun: false,
        wrote: false,
        ...plan,
        report: report(true),
        note: "nothing to fix",
      });
    }
    const commit = commitWrites(toolName, captured);
    const fullyCommitted = commit.error === undefined;
    return json({
      ok: fullyCommitted,
      dryRun: false,
      wrote: commit.committed.length > 0,
      committed: commit.committed,
      ...(commit.error !== undefined ? { error: commit.error } : {}),
      ...plan,
      // A failed commit renders the PLAN, not an applied report: the committed
      // list above is the record of what actually landed.
      report: report(fullyCommitted),
      ...(fullyCommitted
        ? {}
        : {
            note: "the commit did not finish, so `report` is the PLAN, not a record of what was applied - `committed` is that record",
          }),
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const SPECOPS_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  doctorFix,
  specAdvise,
  specPatchApply,
  specUpgrade,
]);
