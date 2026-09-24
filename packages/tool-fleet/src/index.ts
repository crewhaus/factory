/**
 * @crewhaus/tool-fleet — the harnesses on this machine, as deterministic
 * tools: register them, ask what the queue did, recompile a stale bundle,
 * see which CLI version each one is actually running, and manage the hooks
 * that wrap a start.
 *
 * Five properties hold across the package.
 *
 *   1. THE REAL STORES. The registry file is written by
 *      `@crewhaus/harness-registry` and by nothing else here: its atomic
 *      tmp+rename, its 0600 mode and its fingerprint-checked
 *      read-merge-write retry are what keep two sessions and a running
 *      manager from losing each other's rows, and a read-modify-write of
 *      `harnesses.json` in this package would defeat all three. Bundle
 *      staleness is `@crewhaus/harness-supervisor`'s spec-hash comparison,
 *      the recompile is its `compileIfStale`, the hook grammar is its
 *      `parseManagerHook`, the job fold is its `createFileJobStore`. Nothing
 *      here is a second copy of any of them.
 *   2. AN EMPTY STORE AND AN UNREADABLE ONE ARE DIFFERENT ANSWERS. Every
 *      store these tools read answers a file it could not open with an empty
 *      result, because each is read on a boot path that must not die on a
 *      typo. That is the right posture there and a lie in a report, so each
 *      file's CONDITION is probed before anything is concluded from an empty
 *      result — and a mutation against a registry or a settings file that
 *      could not be parsed is refused, because the next write would heal it
 *      wholesale and take every row, group, tag and note with it.
 *   3. A BUNDLE THAT COULD NOT BE JUDGED IS NOT A FRESH BUNDLE. The
 *      supervisor recompiles on `stale`; `unknown` and `unstamped` it treats
 *      as "not stale" and carries on with `{ ok: true }`. Reported as
 *      success, that is how ten of eleven harnesses sat on last month's CLI
 *      with every status line green. Here those two states are a THIRD
 *      verdict — `undetermined` — and a real recompile on one is refused by
 *      name rather than reported as a no-op success.
 *   4. THE IDENTITY KEY IS THE ID, NOT THE PATH. A relocate changes the
 *      directory and keeps the `hrn_` id, which inverts the key every other
 *      call uses. So an id is validated as an id before it is passed
 *      anywhere (the registry silently treats a non-`hrn_` string as a
 *      DIRECTORY and resolves it against the working directory), a relocate
 *      is looked up by id and verified afterwards to leave exactly one entry
 *      carrying it, and a register that finds a row under the other spelling
 *      of the same directory refreshes THAT row instead of adding a second
 *      one.
 *   5. CONTAINMENT, AND ONE NAMED EXCEPTION. Every path a CALLER supplies
 *      goes through `resolveSafe` — the verbatim `@crewhaus/tool-pkg` copy —
 *      and so does every leaf underneath it that is actually OPENED, not
 *      only the ones a write lands on. The four that matter are named in no
 *      schema and are handed back by a library that finds them with
 *      `existsSync`, which follows a symlink: `crewhaus.yaml`, the bundle
 *      directory with its entry and manifest, `.crewhaus/settings.json` and
 *      `.crewhaus/run/hooks.json`. Reading one that leads out of the
 *      workspace reports another harness's identity as this one's; the
 *      bundle directory is worse, because the recompile WRITES into it.
 *      The exception is deliberate and cannot be moved by an input: the two
 *      machine-wide files (`<registryRoot>/harnesses.json`,
 *      `<hangarRoot>/jobs.jsonl`) are resolved from the environment, because
 *      a registry that only ever saw the current workspace would not be a
 *      registry. Each is reported, absolute, in every result that read it.
 *
 * WHAT THIS PACKAGE DOES NOT DO. It does not install or switch a CLI version
 * (that is `@crewhaus/chvm` and the npm registry — see `CliVersionPin`), it
 * never starts, stops or cancels anything (the job ledger is read-only here,
 * and no cancel route exists in the store), and it does not execute a hook.
 */

import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import * as path from "node:path";
import {
  HARNESS_ID_RE,
  type HangarHarnessEntry,
  type HangarRegistry,
  openHangarRegistry,
} from "@crewhaus/harness-registry";
import {
  type JobRecord,
  type JobState,
  MANAGER_HOOK_NAMES,
  type ManagerHookName,
  compileIfStale,
  compileOutDir,
  createFileJobStore,
  createProcessOps,
  hookLogPath,
  readHookRunLog,
  readManagerSettings,
  runPrepareCommand,
} from "@crewhaus/harness-supervisor";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type CliResolution,
  type FreshnessView,
  externalBinRefusal,
  freshnessOf,
  readSpecFacts,
  resolveCli,
  spawnEnv,
} from "./lib/bundle";
import {
  countByState,
  filterJobs,
  jobView,
  ledgerBlockedBy,
  probeLedger,
  sortJobs,
} from "./lib/jobs";
import { entryView, mutationBlockedBy, probeRegistryFile, sortEntries } from "./lib/registry";
import {
  type Loaded,
  compareStrings,
  contain,
  containExistingDir,
  containUnder,
  containWritePaths,
  isInside,
  json,
  refusal,
  renderPath,
  renderStorePath,
  renderText,
  sample,
} from "./lib/result";
import { jobLedgerPath, registryFilePath } from "./lib/roots";
import {
  managerBlock,
  parseDeclaration,
  probeSettings,
  settingsAbsPath,
  settingsRelPath,
  splitWarning,
  timeoutView,
  viewHook,
  withHook,
  writeBlockedBy,
  writeSettingsFile,
} from "./lib/settings";
import { type SafePath, workspaceRoot } from "./paths";

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

/**
 * `dryRun` defaults to TRUE on every mutating action in this package.
 *
 * Uniform on purpose: these tools edit files a running manager also writes,
 * and a caller who has to type `dryRun: false` has been told once, in the
 * schema, what class of call they are making. The preview is produced by the
 * same selection code the real call uses — the same registry lookup, the
 * same staleness verdict, the same parsed hook — never by a parallel
 * description of it.
 */
const dryRunField = z
  .boolean()
  .optional()
  .describe(
    "report what WOULD happen and change nothing. Defaults to TRUE: a mutating action takes an explicit dryRun:false to act.",
  );

/** How long a `--version` probe may run before it is killed. */
const VERSION_PROBE_TIMEOUT_MS = 15_000;

/** Longest job listing returned in one call, unless the caller lowers it. */
const DEFAULT_JOB_LIMIT = 100;

/** Cap on harnesses inspected by one CliVersionPin call. */
const MAX_FLEET = 500;

/** Resolve a harness directory that must exist, inside the workspace. */
function harnessDir(tool: string, rel: string): Loaded<SafePath> {
  // `findHarnessRoot` is deliberately NOT used to walk up from the given
  // directory: it climbs four levels looking for a spec and would happily
  // land outside the workspace this tool is contained to, which is the one
  // direction containment cannot follow. The directory the caller names IS
  // the harness root, and a missing spec there is its own reported answer.
  return containExistingDir(tool, rel);
}

/**
 * Open the machine registry, capturing the warnings it would otherwise
 * swallow.
 *
 * `list()` PERSISTS missing-directory stamps and pre-v2 lifts, and when that
 * write fails (a root-owned `~/.crewhaus`, a read-only home, a full disk) it
 * degrades to an un-persisted view and reports it through `onWarn` — whose
 * default is silence, because the hook path must stay quiet. A tool that
 * drops those warnings tells an operator the registry was updated when it
 * was not.
 */
function openRegistry(intent: "read" | "mutate"): {
  registry: HangarRegistry;
  warnings: string[];
  /** What the ENVIRONMENT says about writes, never the forced-read handle's
   *  own flag — a result that reported `writesDisabled: true` because this
   *  call asked for a read-only handle would be describing itself. */
  writesDisabled: boolean;
} {
  const warnings: string[] = [];
  const onWarn = (message: string): void => {
    warnings.push(message);
  };
  // Constructing a handle touches no file, so asking for two is free.
  const live = openHangarRegistry({ onWarn });
  if (intent === "mutate") return { registry: live, warnings, writesDisabled: live.disabled };
  // A READ MUST NOT WRITE. `list()` persists missing-directory stamps and a
  // pre-v2 lift, so merely reporting the fleet edits a machine-wide file —
  // and `CliVersionPin` declares `readOnly: true`, which a permission layer
  // acts on. `CREWHAUS_NO_REGISTRY` is the library's OWN opt-out: every
  // write becomes a no-op while the computed view (including the freshly
  // stamped `missingSince`) is identical, so this is that switch rather
  // than a second reader written here.
  const reading = openHangarRegistry({
    onWarn,
    env: { ...process.env, CREWHAUS_NO_REGISTRY: "1" },
  });
  return { registry: reading, warnings, writesDisabled: live.disabled };
}

/**
 * Perform a registry WRITE and report a write that could not land.
 *
 * `openHangarRegistry`'s setters THROW when the rename fails — a root-owned
 * `~/.crewhaus`, a read-only home, a full disk — and only `list()` degrades
 * instead (it passes `degradeOnWriteError`). An exception out of `execute`
 * reaches the caller as a bare `EACCES: permission denied, open …` with no
 * tool, no code and, for a multi-field `update`, no word about which of the
 * several setters had already landed. The write itself is still atomic
 * (tmp+rename), so a failure means the document on disk is the one that was
 * there.
 */
function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Refuse a string that is not an `hrn_` id, rather than let it be a path. */
function idRefusal(tool: string, given: string): string {
  return refusal(
    tool,
    "bad-input",
    `"${renderPath(given)}" is not a harness id. An id is \`hrn_\` plus 16 hex characters; @crewhaus/harness-registry treats any other string as a DIRECTORY and resolves it against the working directory, so passing one here would quietly act on a different entry — or on none.`,
  );
}

/**
 * Both spellings of a contained directory.
 *
 * The registry keys on `resolve(dir)` — lexical, symlinks intact — while
 * containment hands back the real path. On a machine where the workspace is
 * reached through a symlink (macOS `/tmp` → `/private/tmp` is the everyday
 * case) those differ, and a lookup with one spelling misses a row written
 * with the other. Both are tried before concluding a directory is not
 * registered, and both are checked before adding a row that would be the
 * second one for the same directory.
 */
function spellings(safe: SafePath): string[] {
  return safe.abs === safe.real ? [safe.real] : [safe.real, safe.abs];
}

function findByDir(registry: HangarRegistry, safe: SafePath): HangarHarnessEntry[] {
  const found: HangarHarnessEntry[] = [];
  for (const spelling of spellings(safe)) {
    const entry = registry.get(spelling);
    if (entry !== undefined && !found.some((e) => e.id === entry.id)) found.push(entry);
  }
  return found;
}

// ---------------------------------------------------------------------------
// HarnessRegister
// ---------------------------------------------------------------------------

const updateFields = {
  groups: z.array(z.string().min(1)).optional().describe("replace the entry's group membership"),
  tags: z.array(z.string().min(1)).optional().describe("replace the entry's tags"),
  pinned: z.boolean().optional().describe("pin the entry so a prune leaves it alone"),
  hidden: z
    .boolean()
    .optional()
    .describe("hide from the manager's default Library view (the entry stays registered)"),
  notes: z.string().max(4000).optional().describe("replace the entry's free-text notes"),
  group: z.string().min(1).optional().describe("with `order`: the group whose boot order to set"),
  order: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("this member's 1-based boot order inside `group`; omit with `group` to clear it"),
};

export const harnessRegister: RegisteredTool = buildTool({
  name: "HarnessRegister",
  operativeArgs: [
    { field: "dir", kind: "path" },
    { field: "from", kind: "path" },
    { field: "id", kind: "id" },
  ],
  description:
    "Add, remove, relocate, list and annotate the harnesses in this machine's registry (<registryRoot>/harnesses.json, from CREWHAUS_REGISTRY_ROOT or ~/.crewhaus — never a caller-supplied path). Every write goes through @crewhaus/harness-registry's own atomic tmp+rename with its read-merge-write retry, so a concurrent session or a running manager cannot lose your edit or you theirs. A relocate keeps the hrn_ id and changes only the directory, and the result proves it: the tool re-reads the registry and reports how many entries carry that id. It REFUSES to mutate a registry file that exists but did not parse (the library reads it as empty and the next write replaces it), refuses when CREWHAUS_NO_REGISTRY has turned writes into silent no-ops, refuses an `id` that is not an hrn_ id, and refuses to add a second row for a directory already registered under its other spelling. A register reads the harness's crewhaus.yaml for its name and shape and refuses one that a symlink puts outside the workspace, rather than recording another harness's identity. A write that the filesystem refuses is REPORTED, and a multi-field update — which is one atomic write per field — names which fields landed and which did not. dryRun defaults to true.",
  inputSchema: z.object({
    action: z
      .enum(["list", "register", "remove", "relocate", "update"])
      .describe("what to do; `list` is the only one that never writes"),
    dir: z
      .string()
      .optional()
      .describe(
        "for `register`, the harness directory; for `relocate`, the NEW directory. Inside the workspace, and it must exist.",
      ),
    id: z.string().optional().describe("the hrn_ id of the entry to act on"),
    from: z
      .string()
      .optional()
      .describe("for `relocate`/`remove`/`update` without an id: the entry's CURRENT directory"),
    specName: z
      .string()
      .min(1)
      .optional()
      .describe("recorded spec name (default: read from the harness's crewhaus.yaml)"),
    target: z
      .string()
      .min(1)
      .optional()
      .describe("recorded shape (default: read from the harness's crewhaus.yaml)"),
    filterGroup: z.string().min(1).optional().describe("`list`: only entries in this group"),
    filterTag: z.string().min(1).optional().describe("`list`: only entries carrying this tag"),
    includeHidden: z
      .boolean()
      .optional()
      .describe("`list`: include entries hidden from the Library view (default true)"),
    ...updateFields,
    dryRun: dryRunField,
  }),
  destructive: true,
  execute: async (input) => {
    const tool = "HarnessRegister";
    const action = input.action;
    const dryRun = input.dryRun ?? true;
    const root = workspaceRoot();
    const file = probeRegistryFile(registryFilePath());

    if (input.id !== undefined && !HARNESS_ID_RE.test(input.id)) return idRefusal(tool, input.id);

    // `list` gets a handle whose writes are no-ops: the schema calls it "the
    // only one that never writes", and `registry.list()` would otherwise
    // persist missing-directory stamps and a pre-v2 lift on a reporting call.
    const { registry, warnings, writesDisabled } = openRegistry(
      action === "list" ? "read" : "mutate",
    );
    const base = {
      tool,
      action,
      registryFile: file.path,
      registryFileState: file.state,
      ...(file.detail !== undefined ? { registryFileDetail: file.detail } : {}),
      ...(file.rawHarnessCount !== undefined ? { rawHarnessCount: file.rawHarnessCount } : {}),
      writesDisabled,
    };
    const warned = (): Record<string, unknown> =>
      warnings.length > 0 ? { registryWarnings: sample(warnings, 10) } : {};

    if (action === "list") {
      // An unreadable or unparseable registry is NOT an empty one: the
      // library's reader returns an empty document either way, so the file's
      // condition is what decides whether this listing means anything.
      const readable = file.state === "ok" || file.state === "absent";
      const entries = readable ? sortEntries(registry.list()) : [];
      const filtered = entries.filter((entry) => {
        if (input.filterGroup !== undefined && !entry.groups.includes(input.filterGroup)) {
          return false;
        }
        if (input.filterTag !== undefined && !entry.tags.includes(input.filterTag)) return false;
        if (input.includeHidden === false && entry.hidden) return false;
        return true;
      });
      return json({
        ...base,
        status: readable ? "ok" : "unreadable",
        ...(readable
          ? {}
          : {
              reason: `${file.detail ?? file.state} — this is NOT an empty registry, and no entry could be listed`,
            }),
        count: filtered.length,
        entries: filtered.map((entry) => entryView(entry, root)),
        // Groups come out of the same document. Reporting `[]` for a file
        // that could not be read would be the same lie as `count: 0`.
        ...(readable ? { groups: registry.listGroups() } : {}),
        outsideWorkspace: filtered.filter((entry) => !isInside(root, entry.dir)).length,
        ...warned(),
      });
    }

    // Everything below writes. Two gates first, in this order: a registry
    // whose file could not be read must not be "healed" into an empty one,
    // and a disabled registry would compute a perfectly plausible answer and
    // write nothing at all.
    const blocked = mutationBlockedBy(file);
    if (!blocked.ok) return refusal(tool, blocked.code, blocked.reason, base);
    if (writesDisabled) {
      return refusal(
        tool,
        "unavailable",
        "CREWHAUS_NO_REGISTRY is set, which turns every registry write into a no-op while reads keep working. The call would have returned an entry that was never persisted.",
        base,
      );
    }

    if (action === "register") {
      if (input.dir === undefined) {
        return refusal(tool, "bad-input", "`register` needs `dir`", base);
      }
      const safe = harnessDir(tool, input.dir);
      if (!safe.ok) return refusal(tool, safe.code, safe.reason, base);
      const existing = findByDir(registry, safe.value);
      if (existing.length > 1) {
        return refusal(
          tool,
          "conflict",
          `this directory is already registered TWICE, under both of its spellings (${existing
            .map((e) => `${e.id} at ${e.dir}`)
            .join(", ")}). Remove one before registering.`,
          base,
        );
      }
      // Identity facts come from the PARSED spec, not from the directory
      // name: `upsert` defaults specName to `basename(dir)` and target to
      // "unknown", and a fleet table full of those is how a registry stops
      // being worth reading.
      const facts = readSpecFacts(tool, safe.value);
      // A spec that leads OUT of the workspace is refused on its own terms.
      // "Pass specName and target explicitly" is the remedy for a spec that
      // does not parse; it is not the remedy for a symlink, and appending it
      // would read as an offer to register the row anyway.
      if (!facts.ok && facts.code === "refused") {
        return refusal(tool, facts.code, facts.reason, base);
      }
      const specName = input.specName ?? (facts.ok ? facts.value.name : undefined);
      const target = input.target ?? (facts.ok ? facts.value.target : undefined);
      if (specName === undefined || target === undefined) {
        return refusal(
          tool,
          facts.ok ? "bad-input" : facts.code,
          facts.ok
            ? "the spec parsed but carries no name — pass specName and target explicitly"
            : `${facts.reason}. Pass specName and target explicitly to register it anyway.`,
          base,
        );
      }
      const prior = existing[0];
      // Register under the REAL path, so two spellings of one directory
      // cannot become two rows — but refresh the row that is already there
      // under its own spelling rather than adding a second.
      const dir = prior?.dir ?? safe.value.real;
      if (dryRun) {
        return json({
          ...base,
          status: "preview",
          dryRun: true,
          would: prior === undefined ? "add a new entry" : `refresh ${prior.id}`,
          dir,
          specName,
          target,
          ...(prior !== undefined ? { entry: entryView(prior, root) } : {}),
          nothingWasTouched: true,
          ...warned(),
        });
      }
      const written = attempt(() =>
        registry.upsert({
          dir,
          specName,
          target,
          origin: "manual",
          originDetail: "HarnessRegister",
        }),
      );
      if (!written.ok) {
        return refusal(
          tool,
          "unavailable",
          `the registry could not be written (${renderText(written.reason, 400)}). The write is atomic, so ${file.path} still holds exactly what it held before this call.`,
          { ...base, ...warned() },
        );
      }
      const entry = written.value;
      // Read back: `upsert` returns the entry it COMPUTED, which is not
      // proof the document on disk carries it.
      const stored = registry.get(entry.id);
      return json({
        ...base,
        status: stored === undefined ? "failed" : "applied",
        dryRun: false,
        created: prior === undefined,
        entry: entryView(stored ?? entry, root),
        persisted: stored !== undefined,
        ...warned(),
      });
    }

    // The remaining three all act on ONE existing entry. Resolve it first —
    // by id when given, else by directory — so the preview and the real call
    // select the same row, and so a relocate acts on an id rather than on
    // the path that is about to change.
    let entry: HangarHarnessEntry | undefined;
    if (input.id !== undefined) {
      entry = registry.get(input.id);
    } else if (input.from !== undefined) {
      const safe = contain(tool, input.from);
      if (!safe.ok) return refusal(tool, safe.code, safe.reason, base);
      const found = findByDir(registry, safe.value);
      if (found.length > 1) {
        return refusal(
          tool,
          "conflict",
          `two entries point at that directory (${found
            .map((e) => e.id)
            .join(", ")}) — name the one you mean with \`id\``,
          base,
        );
      }
      entry = found[0];
    } else {
      return refusal(tool, "bad-input", `\`${action}\` needs \`id\` or \`from\``, base);
    }
    if (entry === undefined) {
      return refusal(
        tool,
        "missing",
        `no registry entry for ${
          input.id !== undefined
            ? `id "${renderPath(input.id)}"`
            : `directory "${renderPath(input.from ?? "")}"`
        }`,
        base,
      );
    }
    const selectedId = entry.id;
    const selectedDir = entry.dir;
    const selected = entryView(entry, root);

    if (action === "remove") {
      if (dryRun) {
        return json({
          ...base,
          status: "preview",
          dryRun: true,
          would: `remove the registry row ${selectedId} (the directory itself is never touched)`,
          entry: selected,
          nothingWasTouched: true,
          ...warned(),
        });
      }
      // BY ID: the row that was selected, not whatever now answers to the
      // directory that was typed.
      const outcome = attempt(() => registry.remove(selectedId));
      if (!outcome.ok) {
        return refusal(
          tool,
          "unavailable",
          `the registry could not be written (${renderText(outcome.reason, 400)}). The write is atomic, so the row is still there.`,
          { ...base, entry: selected, ...warned() },
        );
      }
      const removed = outcome.value;
      const after = registry.get(selectedId);
      return json({
        ...base,
        status: removed && after === undefined ? "applied" : "failed",
        dryRun: false,
        removed,
        entry: selected,
        stillPresent: after !== undefined,
        note: "only the registry row was removed; the harness directory and its state are untouched",
        ...warned(),
      });
    }

    if (action === "relocate") {
      if (input.dir === undefined) {
        return refusal(tool, "bad-input", "`relocate` needs `dir` (the new directory)", base);
      }
      const safe = harnessDir(tool, input.dir);
      if (!safe.ok) return refusal(tool, safe.code, safe.reason, base);
      const conflicts = findByDir(registry, safe.value).filter((e) => e.id !== selectedId);
      if (conflicts.length > 0) {
        return refusal(
          tool,
          "conflict",
          `"${renderPath(input.dir)}" is already registered as ${conflicts
            .map((e) => e.id)
            .join(", ")} — relocating onto it would need that row removed first`,
          { ...base, entry: selected },
        );
      }
      const to = safe.value.real;
      if (dryRun) {
        return json({
          ...base,
          status: "preview",
          dryRun: true,
          would: `point ${selectedId} at "${to}", keeping its id, groups, tags and notes`,
          from: selectedDir,
          to,
          entry: selected,
          nothingWasTouched: true,
          ...warned(),
        });
      }
      let moved: HangarHarnessEntry | undefined;
      try {
        moved = registry.relocate(selectedId, to);
      } catch (err) {
        return refusal(tool, "conflict", err instanceof Error ? err.message : String(err), {
          ...base,
          entry: selected,
        });
      }
      // The claim this action exists to make, checked against the file: ONE
      // row, still carrying the id, now pointing at the new directory. A
      // registry keyed by path answers a relocate by adding a SECOND entry,
      // and a result built from the return value alone would never see it.
      const all = registry.list();
      const withId = all.filter((e) => e.id === selectedId);
      const atOldDir = all.filter((e) => e.dir === selectedDir && e.id !== selectedId);
      const landed = withId[0];
      return json({
        ...base,
        status:
          moved !== undefined && withId.length === 1 && landed?.dir === to ? "applied" : "failed",
        dryRun: false,
        from: selectedDir,
        to,
        idPreserved: landed?.id === selectedId,
        entriesWithId: withId.length,
        entriesLeftAtOldDir: atOldDir.length,
        entry: landed !== undefined ? entryView(landed, root) : selected,
        ...warned(),
      });
    }

    // update
    //
    // ONE list, built once: the fields named in the preview, the setters the
    // real call runs and the fields it reports as applied are the same
    // array in the same order, so a preview cannot describe a write the
    // real path does not perform.
    const groups = input.groups;
    const tags = input.tags;
    const pinned = input.pinned;
    const hidden = input.hidden;
    const notes = input.notes;
    const group = input.group;
    const setters: Array<{ readonly field: string; readonly run: () => void }> = [
      ...(groups !== undefined
        ? [{ field: "groups", run: (): void => void registry.setGroups(selectedId, groups) }]
        : []),
      ...(tags !== undefined
        ? [{ field: "tags", run: (): void => void registry.setTags(selectedId, tags) }]
        : []),
      ...(pinned !== undefined
        ? [{ field: "pinned", run: (): void => void registry.setPinned(selectedId, pinned) }]
        : []),
      ...(hidden !== undefined
        ? [{ field: "hidden", run: (): void => void registry.setHidden(selectedId, hidden) }]
        : []),
      ...(notes !== undefined
        ? [{ field: "notes", run: (): void => void registry.setNotes(selectedId, notes) }]
        : []),
      ...(group !== undefined
        ? [
            {
              field: `groupOrder[${group}]`,
              run: (): void => void registry.setGroupOrder(selectedId, group, input.order),
            },
          ]
        : []),
    ];
    const planned = setters.map((setter) => setter.field);
    if (planned.length === 0) {
      return refusal(
        tool,
        "bad-input",
        "`update` was given nothing to change (groups, tags, pinned, hidden, notes, or group+order)",
        base,
      );
    }
    if (input.order !== undefined && input.group === undefined) {
      return refusal(tool, "bad-input", "`order` needs the `group` it applies to", base);
    }
    // A membership in a group nobody DEFINED is legal and nearly invisible:
    // the row carries the name, `listGroups` does not, and the manager's
    // Library has no column to show it in. Reported rather than rejected —
    // defining groups is the manager's own verb, not this tool's.
    const definedGroups = new Set(registry.listGroups().map((group) => group.name));
    const undefinedGroups = [
      ...new Set(
        [...(groups ?? []), ...(group !== undefined ? [group] : [])].filter(
          (name) => !definedGroups.has(name),
        ),
      ),
    ].sort(compareStrings);
    const groupNote =
      undefinedGroups.length > 0
        ? {
            groupsNotDefined: undefinedGroups,
            groupsNote:
              "these names are not defined in the registry's group list, so the entry carries a membership the manager's Library will not show a group for",
          }
        : {};

    if (dryRun) {
      return json({
        ...base,
        status: "preview",
        dryRun: true,
        would: `set ${planned.join(", ")} on ${selectedId}`,
        entry: selected,
        ...groupNote,
        nothingWasTouched: true,
        ...warned(),
      });
    }
    // Each setter is its own atomic read-merge-write. A multi-field update is
    // therefore SEVERAL writes and another writer can land between them —
    // stated here rather than papered over, because the alternative is a
    // second document-level mutation path in this package, which is exactly
    // the thing the registry's own writer exists to prevent.
    //
    // It is also why a failure halfway through has to be REPORTED rather
    // than thrown: with three setters and the second one refused by the
    // filesystem, one field is on disk and two are not, and the caller is
    // the only one who can put that right.
    const appliedFields: string[] = [];
    let writeFailure: { readonly field: string; readonly reason: string } | undefined;
    for (const setter of setters) {
      const outcome = attempt(setter.run);
      if (!outcome.ok) {
        writeFailure = { field: setter.field, reason: outcome.reason };
        break;
      }
      appliedFields.push(setter.field);
    }
    const after = registry.get(selectedId);
    if (writeFailure !== undefined) {
      return json({
        ...base,
        status: "failed",
        dryRun: false,
        applied: appliedFields,
        notApplied: planned.slice(appliedFields.length),
        failedAt: writeFailure.field,
        reason: `the registry could not be written (${renderText(writeFailure.reason, 400)}). Each field is its own atomic write, so the ones listed in \`applied\` ARE on disk and the ones in \`notApplied\` are not.`,
        entry: after === undefined ? selected : entryView(after, root),
        ...groupNote,
        ...warned(),
      });
    }
    return json({
      ...base,
      status: after === undefined ? "failed" : "applied",
      dryRun: false,
      applied: appliedFields,
      writes: appliedFields.length,
      entry: after === undefined ? selected : entryView(after, root),
      ...groupNote,
      ...warned(),
    });
  },
});

// ---------------------------------------------------------------------------
// HarnessJobStatus
// ---------------------------------------------------------------------------

/**
 * The job states the ledger can hold, so a caller can filter on one.
 *
 * The constant below fails to COMPILE if `JobState` ever gains a member this
 * list does not carry — the only kind of drift guard worth having, one that
 * cannot pass vacuously.
 */
const JOB_STATES = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly JobState[];

/** Compile-time proof that `JOB_STATES` covers every `JobState`. */
export const JOB_STATES_COVER_JOBSTATE: Exclude<JobState, (typeof JOB_STATES)[number]> extends never
  ? true
  : never = true;

export const harnessJobStatus: RegisteredTool = buildTool({
  name: "HarnessJobStatus",
  description:
    "Read the manager's durable job ledger (<hangarRoot>/jobs.jsonl, from CREWHAUS_HANGAR_ROOT or <registryRoot>/hangar): what was enqueued, what ran, what it exited with, and what is still open. Read-only — the store has no cancel route. The fold is @crewhaus/harness-supervisor's own, which skips a torn trailing line while the manager is appending to it. A ledger that exists but could not be opened is reported as unreadable, never as 'no jobs': the store answers both with an empty list, and that is how an operator concludes a queue is idle while it is running. `interrupted` is a FINAL state — a manager that died mid-job reopens the row as interrupted and never re-runs it — so a job sitting there is waiting for a person, not for the queue.",
  inputSchema: z.object({
    jobId: z.string().min(1).max(200).optional().describe("a single job"),
    dir: z
      .string()
      .optional()
      .describe("only jobs for this harness directory (inside the workspace)"),
    harnessId: z.string().optional().describe("only jobs recorded with this hrn_ id"),
    kind: z.string().min(1).max(100).optional().describe("only this job kind (eval, compile, …)"),
    state: z.enum(JOB_STATES).optional().describe("only jobs in this state"),
    since: z
      .string()
      .min(1)
      .optional()
      .describe("only jobs enqueued at or after this ISO 8601 instant"),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe(`most recent N jobs (default ${DEFAULT_JOB_LIMIT})`),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const tool = "HarnessJobStatus";
    const ledger = jobLedgerPath();
    const probe = probeLedger(ledger);
    const base = {
      tool,
      ledger: probe.path,
      ledgerState: probe.state,
      ...(probe.bytes !== undefined ? { bytes: probe.bytes } : {}),
    };
    const blocked = ledgerBlockedBy(probe);
    if (!blocked.ok) return refusal(tool, blocked.code, blocked.reason, base);

    let harnessDirs: string[] | undefined;
    if (input.dir !== undefined) {
      const safe = contain(tool, input.dir);
      if (!safe.ok) return refusal(tool, safe.code, safe.reason, base);
      // Both spellings: the manager records whichever path it was handed.
      harnessDirs = spellings(safe.value);
    }
    if (input.since !== undefined && Number.isNaN(Date.parse(input.since))) {
      return refusal(
        tool,
        "bad-input",
        `"${renderPath(input.since)}" is not an ISO 8601 instant — filtering on it would have silently kept every record`,
        base,
      );
    }

    const records: JobRecord[] = createFileJobStore(ledger).read();
    const { kept, unparsedTimestamps } = filterJobs(records, {
      ...(harnessDirs !== undefined ? { harnessDirs } : {}),
      ...(input.harnessId !== undefined ? { harnessId: input.harnessId } : {}),
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.since !== undefined ? { sinceIso: input.since } : {}),
    });
    const ordered = sortJobs(kept);
    const limit = input.limit ?? DEFAULT_JOB_LIMIT;
    return json({
      ...base,
      status: "ok",
      // Three different questions: how many records the fold produced, how
      // many survived the filter, how many are shown.
      recordsInLedger: records.length,
      matched: ordered.length,
      shown: Math.min(ordered.length, limit),
      countsByState: countByState(ordered),
      ...(probe.state === "ok" && records.length === 0
        ? {
            note: "the ledger file is there but folded to NO records — every line was empty or unparseable, which is not the same as a manager that has run nothing",
          }
        : {}),
      ...(unparsedTimestamps.length > 0
        ? {
            unparsedTimestamps: sample(unparsedTimestamps, 20),
            timestampNote:
              "these records were KEPT despite an enqueuedAt that does not parse — a malformed field must not hide a job from a status listing",
          }
        : {}),
      jobs: ordered.slice(0, limit).map(jobView),
    });
  },
});

// ---------------------------------------------------------------------------
// CompileBundle
// ---------------------------------------------------------------------------

export const compileBundle: RegisteredTool = buildTool({
  name: "CompileBundle",
  operativeArgs: [{ field: "dir", kind: "path", default: "." }],
  description:
    "Compare a harness's compiled bundle against its spec with @crewhaus/harness-supervisor's spec-hash stamp — the exact comparison the manager gates a start on — and recompile it when it is stale, by running the same `crewhaus compile` (plus `bun install` in the bundle) that `daemon start --compile` runs. THREE verdicts, not two: fresh, stale, and UNDETERMINED. A bundle with no stamp and no usable mtimes, or one whose spec cannot be read or parsed, is undetermined — the supervisor treats that as 'not stale' and carries on, so a tool that reported its success as 'the bundle is current' is exactly how a fleet ends up running last month's CLI with every line green. A real run on an undetermined verdict is refused, with the command that fixes it. The compile spawns with a minimal environment (no .env chain) and, afterwards, the freshness is re-read and reported: a compile that exited 0 and left the bundle stale says so. Every file it opens is contained, including the ones the supervisor's own locators hand back — a crewhaus.yaml or a bundle directory that a symlink puts outside the workspace is refused in the preview and in the real call alike, because the recompile writes into that directory. dryRun defaults to true.",
  inputSchema: z.object({
    dir: z
      .string()
      .optional()
      .describe("the harness root — the directory holding crewhaus.yaml (default: .)"),
    target: z
      .string()
      .min(1)
      .optional()
      .describe("the shape, when the spec cannot be parsed to supply it"),
    allowExternalCli: z
      .boolean()
      .optional()
      .describe(
        "run a `crewhaus` binary that resolves outside the workspace (a globally installed CLI on PATH)",
      ),
    forwardEnv: z
      .array(z.string().min(1).max(200))
      .max(50)
      .optional()
      .describe(
        "extra environment variable NAMES to forward to the compile (values come from this process; nothing else is forwarded)",
      ),
    dryRun: dryRunField,
  }),
  destructive: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input) => {
    const tool = "CompileBundle";
    const dryRun = input.dryRun ?? true;
    const root = workspaceRoot();
    const safe = harnessDir(tool, input.dir ?? ".");
    if (!safe.ok) return refusal(tool, safe.code, safe.reason);
    const harness = safe.value.real;
    const shownDir = safe.value.rel === "" ? "." : safe.value.rel;

    const facts = readSpecFacts(tool, safe.value);
    // A spec that leads OUT of the workspace is not a spec this tool reads,
    // and it is also the file a recompile would hand to the CLI.
    if (!facts.ok && facts.code === "refused") return refusal(tool, facts.code, facts.reason);
    const target = input.target ?? (facts.ok ? facts.value.target : undefined);
    if (target === undefined) {
      // No target ⇒ no entry file ⇒ the freshness question cannot even be
      // ASKED. Reported as undetermined, never as "no bundle", never as fresh.
      return json({
        tool,
        status: "undetermined",
        harnessDir: shownDir,
        verdict: "undetermined",
        reason: facts.ok ? "the spec carries no target" : facts.reason,
        remedy:
          "fix the spec, or pass `target` explicitly to check the bundle without it. An undetermined bundle is NOT a fresh one.",
      });
    }

    // ONE GATE, before the dryRun branch, so the preview and the real call
    // refuse a spec or a bundle directory that leads out of the workspace
    // identically — and so nothing below can open one.
    const judged = freshnessOf(tool, safe.value, target);
    if (!judged.ok)
      return refusal(tool, judged.code, judged.reason, { tool, harnessDir: shownDir });
    const fresh: FreshnessView = judged.value.freshness;
    const located = judged.value.bundle;
    const cli = resolveCli(harness, root);
    // `compileOutDir` is the supervisor's own choice of `-o` and is what
    // `compileIfStale` will use; `containedBundle` has already proved that
    // name does not lead out of the workspace.
    const outDir = compileOutDir(harness, target);
    const view = {
      tool,
      harnessDir: shownDir,
      target,
      targetFrom: input.target !== undefined ? "input" : "spec",
      ...(facts.ok ? { specPath: path.relative(root, facts.value.specPath) } : {}),
      verdict: fresh.verdict,
      freshness: fresh.state,
      exact: fresh.exact,
      label: fresh.label,
      ...(fresh.compiledWith !== undefined ? { compiledWith: fresh.compiledWith } : {}),
      bundleDir: located === undefined ? null : path.relative(root, located.bundleDir),
      outDir,
      cli:
        cli === undefined
          ? { resolved: false }
          : { resolved: true, bin: cli.bin, where: cli.where, inWorkspace: cli.inWorkspace },
    };

    if (dryRun) {
      return json({
        ...view,
        status: "preview",
        dryRun: true,
        wouldRecompile: fresh.wouldRecompile,
        ...(fresh.verdict === "undetermined"
          ? {
              wouldRefuse:
                "a real run refuses an undetermined verdict: compileIfStale recompiles only on `stale`/`approximate-stale`, so it would have reported success and compiled nothing",
            }
          : {}),
        nothingWasTouched: true,
      });
    }

    if (fresh.verdict === "undetermined") {
      return refusal(
        tool,
        "refused",
        `the bundle's staleness could not be determined (${fresh.state}: ${fresh.label}), and an undetermined bundle is not a fresh one. compileIfStale recompiles only on a STALE verdict, so this call would have reported success while compiling nothing. Compile it explicitly — \`crewhaus compile <spec> -o ${outDir}\` from the harness directory — then run this again for an exact answer.`,
        view,
      );
    }
    if (fresh.verdict === "fresh") {
      return json({
        ...view,
        status: "unchanged",
        dryRun: false,
        compiled: false,
        note: fresh.exact
          ? "the bundle's spec-hash stamp matches the spec"
          : "no spec-hash stamp: this is the mtime heuristic, so `fresh` means 'nothing suggests otherwise', not 'proven identical'",
      });
    }
    if (cli === undefined) {
      return refusal(
        tool,
        "unavailable",
        "the bundle is stale and no `crewhaus` CLI resolves (harness node_modules/.bin, then PATH), so it cannot be recompiled here",
        view,
      );
    }
    const external = externalBinRefusal(cli, input.allowExternalCli === true);
    if (external !== undefined) return refusal(tool, "refused", external.reason, view);

    // NOTE ON THE WRITE. `compileIfStale` runs `crewhaus compile … -o
    // <outDir>` with the harness as its cwd and then `bun install --cwd
    // <outDir>`: two child processes writing into a name this tool resolved
    // but does not own, and a symlinked `dist` sends both of them out of the
    // workspace with nothing downstream able to take that back. The gate for
    // that is `containedBundle` ABOVE — it runs before the dryRun branch, so
    // the preview and the real call refuse identically, and it contains the
    // out dir, the entry and the manifest, which is every name either child
    // replaces. A second check here would be a strict subset of it: a guard
    // that cannot fire reads as protection and is not any.
    const { env, forwarded } = spawnEnv(input.forwardEnv ?? []);
    let outcome: Awaited<ReturnType<typeof compileIfStale>>;
    try {
      outcome = await compileIfStale({
        harnessDir: harness,
        target,
        ops: createProcessOps(),
        env,
        crewhausBin: cli.bin,
        // The operator's own timeout, when this harness declares one.
        settings: readManagerSettings(harness),
      });
    } catch (err) {
      // `spawn` can throw synchronously (an unusable cwd, an argv the OS
      // refuses). A tool that lets that escape returns a stack trace where a
      // caller expects a result, and says nothing about the bundle.
      return refusal(
        tool,
        "unavailable",
        `the compile could not be launched: ${err instanceof Error ? err.message : String(err)}`,
        { ...view, envForwarded: forwarded },
      );
    }
    // Re-read the verdict FROM DISK. The exit code says the command
    // succeeded; only the stamp says the bundle now matches the spec, and a
    // compile that wrote somewhere else exits 0 all the same. A compile that
    // replaced `dist` with a symlink out of the workspace fails the gate on
    // the way back, which is reported rather than followed.
    const judgedAfter = freshnessOf(tool, safe.value, target);
    const after: FreshnessView = judgedAfter.ok
      ? judgedAfter.value.freshness
      : {
          state: "unknown",
          verdict: "undetermined",
          exact: false,
          label: judgedAfter.reason,
          wouldRecompile: false,
        };
    if (!outcome.ok) {
      return json({
        ...view,
        status: "failed",
        dryRun: false,
        compiled: false,
        stage: outcome.refusal.stage,
        reason: outcome.refusal.message,
        ...(outcome.refusal.exitCode !== undefined ? { exitCode: outcome.refusal.exitCode } : {}),
        // A line a spawned binary printed is text this package did not write.
        output: sample(
          outcome.refusal.output.map((line) => renderText(line, 400)),
          40,
        ),
        after: { verdict: after.verdict, freshness: after.state, label: after.label },
        envForwarded: forwarded,
      });
    }
    const compiled = outcome.replan;
    return json({
      ...view,
      status: after.verdict !== "fresh" ? "incomplete" : compiled ? "applied" : "unchanged",
      dryRun: false,
      compiled,
      notes: outcome.notes,
      after: {
        verdict: after.verdict,
        freshness: after.state,
        exact: after.exact,
        label: after.label,
        ...(after.compiledWith !== undefined ? { compiledWith: after.compiledWith } : {}),
      },
      // A prediction that did not come true has TWO explanations, and they
      // are not the same news. If the bundle is fresh now and nothing was
      // compiled, somebody else compiled it between this tool's verdict and
      // `compileIfStale`'s own — a race, not a defect. Only a bundle that is
      // still not fresh means the mirrored stale-state set has drifted from
      // the library's.
      ...(compiled
        ? {}
        : after.verdict === "fresh"
          ? {
              raced:
                "this tool judged the bundle stale and compileIfStale found it fresh, so nothing was compiled — another writer compiled it between the two reads. The bundle on disk matches the spec.",
            }
          : {
              disagreement:
                "this tool predicted a recompile and compileIfStale reported none, and the bundle is still not fresh — the two stale-state sets have drifted apart",
            }),
      ...(after.verdict !== "fresh"
        ? {
            stillNotFresh:
              "the compile reported success and the bundle is STILL not fresh — check that it wrote to the directory the bundle is resolved from",
          }
        : {}),
      envForwarded: forwarded,
    });
  },
});

// ---------------------------------------------------------------------------
// CliVersionPin
// ---------------------------------------------------------------------------

type FleetRow = {
  dir: string;
  specName?: string;
  target?: string;
  verdict: string;
  /** The library's own state. Absent when the question could not be asked at
   *  all — no invented state ever stands in for one. */
  freshness?: string;
  compiledWith?: string;
  cli?: { bin: string; where: string; inWorkspace: boolean };
  note?: string;
};

type Inspected = { safe: SafePath; row: FleetRow; cli: CliResolution | undefined };

/** A semver-shaped token, wherever a CLI prints it. */
const VERSION_RE = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;

export const cliVersionPin: RegisteredTool = buildTool({
  name: "CliVersionPin",
  operativeArgs: [{ field: "dirs", kind: "path" }],
  description:
    "Show which crewhaus CLI each harness would run and which version its bundle was COMPILED WITH, and roll the fleet up by version so a harness left behind on an old CLI is visible. The harnesses come from this machine's registry unless directories are given; the compiledWith stamp is @crewhaus/harness-supervisor's, the binary is its resolver's (harness node_modules/.bin first, then PATH). This tool does NOT install, switch or pin a version — that is @crewhaus/chvm talking to the npm registry, and this package has neither the dependency nor a network call — so the result names the command instead of pretending. With probe:true it runs `<bin> --version` once per DISTINCT binary, with a timeout, and only for a binary inside the workspace unless allowExternalCli is set. A version it could not read is reported as unknown WITH the reason, never as agreeing with the others. It writes NOTHING: the registry is enumerated through @crewhaus/harness-registry's own CREWHAUS_NO_REGISTRY switch, so the missing-directory stamps a plain list() would persist are computed and reported but not written. At most 500 harnesses are inspected; past that the result carries truncated:true and every count describes that subset rather than the fleet. A spec or bundle that a symlink puts outside the workspace is reported as undetermined with the reason, never opened.",
  inputSchema: z.object({
    dirs: z
      .array(z.string())
      .max(MAX_FLEET)
      .optional()
      .describe("harness directories to inspect; omitted, the machine registry supplies them"),
    probe: z
      .boolean()
      .optional()
      .describe("run `<bin> --version` once per distinct binary (default false)"),
    allowExternalCli: z
      .boolean()
      .optional()
      .describe("allow probing a binary that resolves outside the workspace"),
    includeMissing: z
      .boolean()
      .optional()
      .describe("include registry entries whose directory has vanished (default false)"),
  }),
  // NOT read-only (0.7.1, permission-integration#7): with `probe` it runs
  // `<bin> --version` for a binary found in a harness's node_modules/.bin —
  // a program the workspace supplies — and plan mode runs every read-only
  // tool without asking. Nothing it runs is expected to change anything, so
  // it is not destructive, and auto mode still allows it.
  readOnly: false,
  scope: "external",
  ioCapability: "process",
  execute: async (input) => {
    const tool = "CliVersionPin";
    const root = workspaceRoot();
    const file = probeRegistryFile(registryFilePath());
    const skipped: Array<{ dir: string; reason: string }> = [];
    const selected: SafePath[] = [];
    let source: string;
    /** True when the cap stopped the enumeration before the registry was
     *  exhausted — so every number below describes a PART of the fleet. */
    let truncated = false;
    let registryRows: number | undefined;

    // Keyed by the REAL path: two spellings of one harness (a symlink, a
    // trailing slash, the same row twice) must not be inspected — or
    // counted in the version roll-up — twice.
    const already = new Set<string>();
    const take = (safe: SafePath): void => {
      if (already.has(safe.real)) return;
      already.add(safe.real);
      selected.push(safe);
    };

    if (input.dirs !== undefined) {
      source = "input";
      for (const rel of input.dirs) {
        const safe = harnessDir(tool, rel);
        if (!safe.ok) {
          skipped.push({ dir: renderPath(rel), reason: safe.reason });
          continue;
        }
        take(safe.value);
      }
    } else {
      source = "registry";
      if (file.state !== "ok" && file.state !== "absent") {
        return refusal(
          tool,
          "unreadable",
          `${file.path}: ${file.detail ?? file.state} — the fleet could not be enumerated. An unreadable registry is not an empty one; pass \`dirs\` to inspect harnesses directly.`,
          { tool, registryFile: file.path, registryFileState: file.state },
        );
      }
      // A READ, so the handle's writes are no-ops: this tool declares
      // `readOnly: true`, and `list()` would otherwise persist its own
      // missing-directory stamps into a machine-wide file.
      const { registry } = openRegistry("read");
      const rows = sortEntries(registry.list());
      registryRows = rows.length;
      for (const entry of rows) {
        if (selected.length >= MAX_FLEET) {
          // A cap that silently stops is a roll-up computed over part of the
          // fleet and reported as the fleet: `mixedFleet: false` for a fleet
          // whose 501st harness is the one on the old CLI. Say so.
          truncated = true;
          break;
        }
        if (entry.missingSince !== null && input.includeMissing !== true) {
          skipped.push({
            dir: renderStorePath(entry.dir),
            reason: `missing since ${renderText(entry.missingSince, 64)}`,
          });
          continue;
        }
        // A path a STORE handed back is not a path a caller contained. The
        // registry is machine-wide, so plenty of its rows legitimately point
        // outside this workspace — and this tool OPENS specs and bundles, so
        // those rows are reported and not touched.
        const safe = containExistingDir(tool, path.relative(root, entry.dir) || ".");
        if (!safe.ok) {
          skipped.push({
            dir: renderStorePath(entry.dir),
            reason:
              safe.code === "refused" ? "outside the workspace root — not inspected" : safe.reason,
          });
          continue;
        }
        take(safe.value);
      }
    }
    selected.sort((a, b) => compareStrings(a.real, b.real));

    const inspected: Inspected[] = selected.map((safe) => {
      const rel = safe.rel === "" ? "." : safe.rel;
      const cli = resolveCli(safe.real, root);
      const cliField =
        cli === undefined
          ? {}
          : { cli: { bin: cli.bin, where: cli.where, inWorkspace: cli.inWorkspace } };
      const facts = readSpecFacts(tool, safe);
      if (!facts.ok) {
        // No target, so no bundle question can be asked — which is not the
        // same as a bundle that is up to date. A spec that leads out of the
        // workspace lands here too, with its own reason.
        return {
          safe,
          cli,
          row: {
            dir: rel,
            verdict: "undetermined",
            note: facts.reason,
            ...cliField,
          },
        };
      }
      const judged = freshnessOf(tool, safe, facts.value.target);
      if (!judged.ok) {
        return {
          safe,
          cli,
          row: {
            dir: rel,
            ...(facts.value.name !== undefined ? { specName: facts.value.name } : {}),
            target: facts.value.target,
            verdict: "undetermined",
            note: judged.reason,
            ...cliField,
          },
        };
      }
      const fresh = judged.value.freshness;
      return {
        safe,
        cli,
        row: {
          dir: rel,
          ...(facts.value.name !== undefined ? { specName: facts.value.name } : {}),
          target: facts.value.target,
          verdict: fresh.verdict,
          freshness: fresh.state,
          // Already bounded and printable by `classify` — it is also the key
          // the roll-up below is grouped by.
          ...(fresh.compiledWith !== undefined ? { compiledWith: fresh.compiledWith } : {}),
          ...cliField,
        },
      };
    });

    // One probe per DISTINCT binary: a fleet of thirty harnesses sharing one
    // CLI is one spawn, not thirty.
    const probes: Record<string, Record<string, unknown>> = {};
    if (input.probe === true) {
      const seen = new Map<string, Inspected>();
      for (const item of inspected) {
        if (item.cli !== undefined && !seen.has(item.cli.bin)) seen.set(item.cli.bin, item);
      }
      for (const bin of [...seen.keys()].sort(compareStrings)) {
        const item = seen.get(bin);
        if (item?.cli === undefined) continue;
        const external = externalBinRefusal(item.cli, input.allowExternalCli === true);
        if (external !== undefined) {
          probes[bin] = { state: "not-probed", reason: external.reason };
          continue;
        }
        let outcome: Awaited<ReturnType<typeof runPrepareCommand>>;
        try {
          outcome = await runPrepareCommand({
            argv: [bin, "--version"],
            cwd: item.safe.real,
            env: spawnEnv().env,
            ops: createProcessOps(),
            timeoutMs: VERSION_PROBE_TIMEOUT_MS,
          });
        } catch (err) {
          probes[bin] = {
            state: "unknown",
            reason: `could not be launched: ${err instanceof Error ? err.message : String(err)}`,
          };
          continue;
        }
        if (outcome.timedOut) {
          probes[bin] = {
            state: "unknown",
            reason: `the probe was killed after ${VERSION_PROBE_TIMEOUT_MS} ms`,
          };
          continue;
        }
        if (outcome.exitCode !== 0) {
          // `exitCode: null` is not an exit code: the adapter resolves a
          // FAILED SPAWN that way too (a file without the execute bit, a
          // broken interpreter line), so it must not be reported as one.
          probes[bin] = {
            state: "unknown",
            reason:
              outcome.exitCode === null
                ? `it never exited normally — the spawn failed, or it was killed by ${outcome.signal ?? "a signal"}`
                : `exited ${outcome.exitCode}`,
            output: sample(
              outcome.output.map((line) => renderText(line, 400)),
              5,
            ),
          };
          continue;
        }
        // PARSE, then report the PARSED value. A line that carries no
        // version is not a version, and echoing the raw line as one is how a
        // startup banner ends up in a version table.
        const matched = VERSION_RE.exec(outcome.output.join("\n"));
        probes[bin] =
          matched === null
            ? {
                state: "unparsed",
                reason: "the output carried no semver-shaped token",
                output: sample(
                  outcome.output.map((line) => renderText(line, 400)),
                  5,
                ),
              }
            : { state: "known", version: matched[0] };
      }
    }

    const inspectedRows = inspected.map((item) => item.row);
    const byVersion = new Map<string, number>();
    for (const row of inspectedRows) {
      // The KEY is a string a bundle's own `package.json` supplied. Bounded
      // and printable before it becomes a field name in a statistic a reader
      // acts on — an unbounded one spends the whole context, and a newline
      // in it ends the line the roll-up is printed on.
      const key = row.compiledWith ?? "unstamped-or-undetermined";
      byVersion.set(key, (byVersion.get(key) ?? 0) + 1);
    }
    const stamped = [...byVersion.keys()].filter((k) => k !== "unstamped-or-undetermined");
    return json({
      tool,
      status: "ok",
      source,
      registryFile: file.path,
      registryFileState: file.state,
      count: inspectedRows.length,
      ...(registryRows !== undefined ? { registryRows } : {}),
      truncated,
      ...(truncated
        ? {
            truncatedNote: `the registry holds more than ${MAX_FLEET} harnesses; only the first ${MAX_FLEET} by directory were inspected, so every count and the mixedFleet verdict below describe THAT subset and not the fleet`,
          }
        : {}),
      harnesses: inspectedRows,
      compiledWith: Object.fromEntries(
        [...byVersion.entries()].sort((a, b) => compareStrings(a[0], b[0])),
      ),
      distinctCompiledWith: stamped.length,
      mixedFleet: stamped.length > 1,
      undetermined: inspectedRows.filter((r) => r.verdict === "undetermined").length,
      distinctCli: [...new Set(inspectedRows.map((r) => r.cli?.bin ?? "none"))].sort(
        compareStrings,
      ),
      ...(Object.keys(probes).length > 0 ? { probes } : {}),
      ...(skipped.length > 0 ? { skipped: sample(skipped, 20) } : {}),
      cannotDo: [
        {
          op: "install / use / pin a CLI version",
          reason:
            "that is @crewhaus/chvm talking to registry.npmjs.org; this package has neither the dependency nor a network call",
          instead: "chvm install <version> && chvm use <version>",
        },
      ],
    });
  },
});

// ---------------------------------------------------------------------------
// HooksManage
// ---------------------------------------------------------------------------

export const hooksManage: RegisteredTool = buildTool({
  name: "HooksManage",
  operativeArgs: [
    { field: "dir", kind: "path", default: "." },
    { field: "command", kind: "command" },
  ],
  description:
    "List, set and remove the MANAGER hooks in a harness's .crewhaus/settings.json — the postCompile and preSpawn steps @crewhaus/harness-supervisor runs between a compile and a spawn — and report what each declaration actually PARSES to. It never executes a hook. The grammar is the supervisor's: a string is ONE command with no arguments (deliberately never word-split), an array is an argv vector — so \"bun run prep.ts\" declares a command whose FILENAME contains spaces and will refuse every start with ENOENT, and that shape is refused here with the array form spelled out. A command that resolves to a path is probed for existence and the execute bit; a bare name is reported as resolved by the OS at spawn time rather than guessed at. A command that is a directory or a dangling symlink is `not-executable`/`absent` rather than executable, because access(X_OK) says yes to a directory and a hook that cannot spawn refuses every start. Writes preserve every other key in the file (the runtime's own hooks and permissions blocks live there too), are atomic, keep the file's mode, and are refused outright when the existing file does not parse. The settings file and the hook run log are contained before they are READ, so a symlinked .crewhaus/settings.json is refused — on `list` too — instead of reporting another file's hooks as this harness's. After a write the file is re-read THROUGH the supervisor's own reader and the result says whether the hook came back as the argv you asked for. dryRun defaults to true.",
  inputSchema: z.object({
    action: z.enum(["list", "set", "remove"]).describe("`list` never writes"),
    dir: z
      .string()
      .optional()
      .describe("the harness root — the directory holding .crewhaus/ (default: .)"),
    hook: z.enum(MANAGER_HOOK_NAMES).optional().describe("which hook `set`/`remove` acts on"),
    command: z
      .union([z.string().min(1).max(4000), z.array(z.string().min(1).max(4000)).min(1).max(64)])
      .optional()
      .describe("the declaration: a bare command name, or an argv array (the form with arguments)"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .optional()
      .describe("how long any hook in this harness may run before it is killed and refused"),
    allowMissingCommand: z
      .boolean()
      .optional()
      .describe("write a hook whose command does not exist or is not executable"),
    dryRun: dryRunField,
  }),
  destructive: true,
  execute: async (input) => {
    const tool = "HooksManage";
    const dryRun = input.dryRun ?? true;
    const safe = harnessDir(tool, input.dir ?? ".");
    if (!safe.ok) return refusal(tool, safe.code, safe.reason);
    const harness = safe.value.real;
    const rel = settingsRelPath();
    const abs = settingsAbsPath(harness);
    const shownDir = safe.value.rel === "" ? "." : safe.value.rel;
    const shown = path.posix.join(shownDir, rel);

    // CONTAIN THE LEAVES BEFORE READING THEM, not only before writing them.
    // `readManagerSettings` and `readHookRunLog` open these two names with
    // no boundary of their own, and `<harness>/.crewhaus/settings.json ->
    // /elsewhere/settings.json` is read straight through: another harness's
    // hooks — or any JSON on the disk — come back reported as THIS harness's
    // configuration, and a file that is not JSON comes back as a parser
    // message quoting its contents. `@crewhaus/tool-crewhaus` refuses the
    // same shape for a symlinked `crewhaus.yaml`; this is that refusal, and
    // it applies to `list` too, because reading is the escape.
    //
    // The hook-log leaf is derived from the supervisor's OWN `hookLogPath`,
    // never from a second spelling of `.crewhaus/run/hooks.json` written
    // here — a mirrored path convention is the drift this package avoids.
    const hookLogRel = path.relative(harness, hookLogPath(harness)).split(path.sep).join("/");
    for (const leaf of [rel, hookLogRel]) {
      const contained = containUnder(tool, safe.value, leaf);
      if (!contained.ok) {
        return refusal(tool, contained.code, contained.reason, {
          tool,
          harnessDir: shownDir,
          settingsFile: shown,
        });
      }
    }

    const probe = probeSettings(abs, shown);
    const settings = readManagerSettings(harness);
    const lastRuns = readHookRunLog(harness);

    const declared = MANAGER_HOOK_NAMES.map((name) => {
      const hook = settings.hooks[name];
      const run = lastRuns[name];
      return hook === undefined
        ? { name, declared: false, ...(run !== undefined ? { lastRun: run } : {}) }
        : {
            declared: true,
            ...viewHook(name, hook, harness),
            ...(run !== undefined ? { lastRun: run } : {}),
          };
    });
    const base = {
      tool,
      harnessDir: shownDir,
      settingsFile: shown,
      settingsState: probe.state,
      ...(probe.detail !== undefined ? { settingsDetail: probe.detail } : {}),
    };

    if (input.action === "list") {
      const usable = probe.state === "ok" || probe.state === "absent";
      return json({
        ...base,
        status: usable ? "ok" : "unreadable",
        ...(usable
          ? {}
          : {
              reason:
                "@crewhaus/harness-supervisor's reader answers an unusable settings file with its DEFAULTS, so what follows is the defaults — NOT what the file says",
            }),
        hooks: declared,
        timeout: timeoutView(settings.hooks.timeoutMs),
        autoCompile: settings.autoCompile,
        envFiles: settings.envFiles,
        hookRunLog: path.relative(workspaceRoot(), hookLogPath(harness)),
      });
    }

    if (input.hook === undefined) {
      return refusal(tool, "bad-input", `\`${input.action}\` needs \`hook\``, base);
    }
    const name: ManagerHookName = input.hook;
    const blocked = writeBlockedBy(probe);
    if (!blocked.ok) return refusal(tool, blocked.code, blocked.reason, base);

    // THE WRITE GATE, re-checked at the last moment before the rename. The
    // read gate above will normally have refused a settings.json that leads
    // out already; this one covers the TEMP NAME the atomic replace renames
    // FROM — which the read gate never sees — and re-validates the
    // destination after all the parsing work above, because a rename
    // replaces whatever the name points at by then.
    const tmpRel = `${rel}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const escapes = containWritePaths(tool, safe.value, [rel, tmpRel]);
    if (escapes !== undefined) return refusal(tool, escapes.code, escapes.reason, base);
    const tmpAbs = path.join(harness, ...tmpRel.split("/"));

    const doc = probe.doc ?? {};
    const manager = managerBlock(doc);
    if (!manager.ok) return refusal(tool, manager.code, manager.reason, base);

    const current = settings.hooks[name];
    let nextDoc: Record<string, unknown>;
    let intended: readonly string[] | undefined;
    let plan: Record<string, unknown>;

    if (input.action === "set") {
      if (input.command === undefined) {
        return refusal(tool, "bad-input", "`set` needs `command`", base);
      }
      // Parse with the supervisor's OWN parser, then act on the parsed argv
      // — never on the spelling. A declaration its parser drops is silently
      // NO hook at all.
      const parsed = parseDeclaration(input.command);
      if (!parsed.ok) return refusal(tool, parsed.code, parsed.reason, base);
      const warning = splitWarning(parsed.value.argv);
      if (warning !== undefined) return refusal(tool, "bad-input", warning, base);
      const resolved = viewHook(name, parsed.value, harness);
      if (
        (resolved.commandState === "absent" || resolved.commandState === "not-executable") &&
        input.allowMissingCommand !== true
      ) {
        return refusal(
          tool,
          "bad-input",
          `the command "${renderPath(resolved.command)}" is ${resolved.commandState}${
            resolved.detail === undefined ? "" : ` (${resolved.detail})`
          }. A declared hook that cannot run REFUSES every start of this harness. Pass allowMissingCommand:true if it is created later.`,
          { ...base, hook: resolved },
        );
      }
      intended = parsed.value.argv;
      // What goes into the file is the PARSED value, not the caller's
      // spelling — `parseManagerHook` trims each entry, so writing the raw
      // input would leave a declaration on disk that is not the one this
      // call verified. The FORM is kept (a string stays a string) so the
      // file still reads the way its author wrote it.
      const declaration: string | readonly string[] =
        typeof input.command === "string" ? (parsed.value.argv[0] as string) : parsed.value.argv;
      nextDoc = withHook(doc, manager.value, name, declaration, input.timeoutMs);
      plan = {
        would: current === undefined ? `declare ${name}` : `replace ${name}`,
        hook: resolved,
        ...(current !== undefined ? { replacing: viewHook(name, current, harness) } : {}),
        ...(resolved.commandState === "path-lookup"
          ? {
              unverified:
                "argv[0] is a bare name, so it is resolved on PATH by whichever process spawns the hook — this tool cannot check it from here, and does not claim to",
            }
          : {}),
      };
    } else {
      if (current === undefined && input.timeoutMs === undefined) {
        return json({
          ...base,
          status: "unchanged",
          dryRun,
          note: `${name} is not declared in this harness's settings — nothing to remove`,
          hooks: declared,
        });
      }
      nextDoc = withHook(doc, manager.value, name, undefined, input.timeoutMs);
      plan = {
        would:
          current === undefined
            ? `set the hook timeout to ${input.timeoutMs} ms (${name} is not declared)`
            : `remove ${name}`,
        ...(current !== undefined ? { removing: viewHook(name, current, harness) } : {}),
      };
    }

    if (dryRun) {
      return json({
        ...base,
        status: "preview",
        dryRun: true,
        ...plan,
        resultingManagerHooks: (nextDoc["manager"] as Record<string, unknown>)["hooks"],
        nothingWasTouched: true,
      });
    }

    const written = writeSettingsFile(tmpAbs, abs, nextDoc, probe.mode);
    if (!written.ok) {
      try {
        unlinkSync(tmpAbs);
      } catch {
        // Best-effort: the write error is what matters.
      }
      return refusal(tool, written.code, written.reason, base);
    }

    // Read it back THROUGH THE SUPERVISOR'S READER. A write that lands as
    // JSON the supervisor then drops (a shape its parser refuses, a key it
    // ignores) is a hook that does not exist, and the only way to know is to
    // ask the thing that will read it at spawn time.
    const after = readManagerSettings(harness);
    const stored = after.hooks[name];
    const matches =
      input.action === "set"
        ? stored !== undefined &&
          intended !== undefined &&
          stored.argv.length === intended.length &&
          stored.argv.every((part, index) => part === intended?.[index])
        : stored === undefined;
    return json({
      ...base,
      status: matches ? "applied" : "failed",
      dryRun: false,
      hookAction: input.action,
      hook: name,
      verified: matches,
      ...(matches
        ? {}
        : {
            reason:
              "the file was written, but re-reading it through @crewhaus/harness-supervisor did not give back what was asked for",
          }),
      now:
        stored === undefined
          ? { name, declared: false }
          : { declared: true, ...viewHook(name, stored, harness) },
      timeout: timeoutView(after.hooks.timeoutMs),
    });
  },
});
