/**
 * What a harness knows besides facts, articles and working memory: session summaries, lessons,
 * suggestions, datasets and indexed documents. Each reads one file or directory.
 */
import { createHash } from "node:crypto";
import { SESSION_ID_RE } from "@crewhaus/control-contract";
import {
  DatasetRegistryError,
  assertDatasetName,
  compareVersions,
} from "@crewhaus/dataset-registry";
import { SESSIONS_INDEX_DIRNAME } from "@crewhaus/session-store";
import type { HarnessRead } from "../context";
import { relOf } from "../context";
import { type FoldedItem, can, cannot, folded, shellArg } from "../model";
import {
  type KnowledgeAdapter,
  type StoreRoot,
  isSpecName,
  isoField,
  isoOf,
  pick,
  sessionEvidence,
  storeRoots,
} from "./types";

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

// ---------------------------------------------------------------------------
// Session summaries
// ---------------------------------------------------------------------------

/** Where one store root keeps its session summaries. */
const summariesRel = (root: StoreRoot): string => relOf(root.base, SESSIONS_INDEX_DIRNAME);

/** Session summaries: the harness's own, and each customer's in its own partition. */
export const sessionsAdapter: KnowledgeAdapter = {
  name: "sessions",
  stores: ["sessions"],
  async list(read) {
    const out: FoldedItem[] = [];
    for (const root of storeRoots(read)) {
      const dir = summariesRel(root);
      for (const name of read.names(dir, "files", "sessions")) {
        const id = name.slice(0, -".json".length);
        if (!name.endsWith(".json") || !SESSION_ID_RE.test(id)) continue;
        const summary = read.json(relOf(dir, name), "sessions");
        if (summary === undefined) continue;
        const at = isoOf(summary["summarizedAt"]);
        const outcome = str(summary["outcome"]) ?? "";
        const item = folded(read, {
          store: "sessions",
          spec: "-",
          ...(root.partition !== undefined ? { partition: root.partition } : {}),
          localId: id,
          title: at !== undefined ? `Conversation of ${at.slice(0, 10)}` : "Conversation",
          body: [outcome, ...strings(summary["keyFacts"])].filter((t) => t !== "").join("\n"),
          ...(at !== undefined ? { createdAt: at, updatedAt: at } : {}),
          author: { kind: "extractor", session: id },
          origin: { kind: "conversation", session: id },
          evidence: sessionEvidence(read, root.base, id),
          // A customer's runs record no use of what they know.
          ...(root.partition === undefined
            ? { record: { store: "session", backend: "local", localId: id } as const }
            : {}),
          operations: [],
        });
        if (item !== undefined) out.push(item);
      }
    }
    return out;
  },
  marks: (read) =>
    Object.fromEntries(
      storeRoots(read).map((root) => [summariesRel(root), read.sourceMark(summariesRel(root))]),
    ),
  current: (read, ids) => pick(sessionsAdapter, read, ids),
};

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

const LESSONS_FILE = "LESSONS.md";
const LESSONS_MARKER = "<!-- crewhaus:lessons -->";
const LESSONS_DIR = relOf(".crewhaus", "lessons");
const LESSON_ID_RE = /^l[0-9a-f]{16}$/;

/** One lesson as `crewhaus lessons update` writes it. */
export type ParsedLesson = {
  readonly id: string;
  readonly text: string;
  readonly kind: "correction" | "failure-fix";
};

/** A lesson's id: `l` and the first 16 hex of the sha256 of its normalized text. */
export function lessonIdOf(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return `l${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

/** The lessons under LESSONS.md's marker; a file without the marker is a person's own. */
export function parseLessons(content: string): ParsedLesson[] {
  const at = content.indexOf(LESSONS_MARKER);
  if (at === -1) return [];
  const out: ParsedLesson[] = [];
  let kind: ParsedLesson["kind"] = "correction";
  for (const raw of content.slice(at + LESSONS_MARKER.length).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## Known failure")) kind = "failure-fix";
    else if (line.startsWith("## Corrections")) kind = "correction";
    else if (line.startsWith("- ")) {
      const text = line.slice(2).trim();
      if (text !== "") out.push({ id: lessonIdOf(text), text, kind });
    }
  }
  return out;
}

export const lessonsAdapter: KnowledgeAdapter = {
  name: "lessons",
  stores: ["lessons"],
  async list(read) {
    const mined = new Map<string, { sessions: string[]; at: string | undefined }>();
    for (const record of read.records(relOf(LESSONS_DIR, "provenance.jsonl"), "lessons")) {
      const id = str(record["lesson"]);
      if (id === undefined || !LESSON_ID_RE.test(id)) continue;
      mined.set(id, {
        sessions: strings(record["sessions"]).filter((s) => SESSION_ID_RE.test(s)),
        at: isoOf(record["at"]),
      });
    }
    const out: FoldedItem[] = [];
    const seen = new Set<string>();
    for (const lesson of parseLessons(read.text(LESSONS_FILE, "lessons") ?? "")) {
      if (seen.has(lesson.id)) continue;
      seen.add(lesson.id);
      const from = mined.get(lesson.id);
      const session = from?.sessions[0];
      const item = folded(read, {
        store: "lessons",
        spec: "-",
        localId: lesson.id,
        title: lesson.text,
        titleIsText: true,
        body: lesson.text,
        status: "active",
        ...(from?.at !== undefined ? { createdAt: from.at } : {}),
        author: { kind: "extractor", ...(session !== undefined ? { session } : {}) },
        origin: {
          kind: lesson.kind === "correction" ? "feedback" : "tool-result",
          ...(session !== undefined ? { session } : {}),
        },
        evidence: sessionEvidence(read, ".crewhaus", session),
        operations: [can("retire", `crewhaus lessons retire ${lesson.id}`)],
      });
      if (item !== undefined) out.push(item);
    }
    for (const record of read.records(relOf(LESSONS_DIR, "retired.jsonl"), "lessons")) {
      const id = str(record["lesson"]);
      if (id === undefined || !LESSON_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      const at = isoOf(record["at"]);
      const item = folded(read, {
        store: "lessons",
        spec: "-",
        localId: id,
        title: "Retired lesson",
        lifecycle: "retired",
        status: "retired",
        ...(at !== undefined ? { updatedAt: at } : {}),
        author: { kind: "extractor" },
        origin: { kind: "feedback" },
        operations: [cannot("retire", "This lesson is retired already.")],
      });
      if (item !== undefined) out.push(item);
    }
    return out;
  },
  marks: (read) =>
    Object.fromEntries(
      [
        LESSONS_FILE,
        relOf(LESSONS_DIR, "provenance.jsonl"),
        relOf(LESSONS_DIR, "retired.jsonl"),
      ].map((rel) => [rel, read.sourceMark(rel)]),
    ),
  current: (read, ids) => pick(lessonsAdapter, read, ids),
};

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

const DRAFTS_REL = relOf(".crewhaus", "watchme", "synthesized");
/** Where one store root keeps its consolidation reports. */
const dreamRel = (root: StoreRoot): string => relOf(root.base, "dream");
const PROMOTION_RE = /^promotion candidate: .*\((mem_[0-9a-f]{16})\)$/s;

/** The newest consolidation report a dream kept for one spec: its promotion findings. */
export function promotionFindings(
  read: HarnessRead,
  root: StoreRoot,
  spec: string,
): { readonly at: string | undefined; readonly text: string; readonly fact: string }[] {
  const file = read.json(relOf(dreamRel(root), spec, "idempotency.json"), "suggestions");
  const records = Object.values((file?.["records"] as Record<string, unknown> | undefined) ?? {});
  const newest = records
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .sort((a, b) => (String(a["completedAt"]) < String(b["completedAt"]) ? 1 : -1))[0];
  const report = newest?.["result"] as { phase1?: { findings?: unknown } } | undefined;
  return strings(report?.phase1?.findings).flatMap((text) => {
    const fact = PROMOTION_RE.exec(text)?.[1];
    return fact === undefined ? [] : [{ at: isoOf(newest?.["completedAt"]), text, fact }];
  });
}

/**
 * Proposals, never beliefs: specs `crewhaus watchme synthesize` drafted, and facts a
 * consolidation found worth writing up. A finding about a fact marked personal is left out.
 */
export function suggestionsAdapter(
  personal: (read: HarnessRead, root: StoreRoot, spec: string) => Promise<ReadonlySet<string>>,
): KnowledgeAdapter {
  const adapter: KnowledgeAdapter = {
    name: "suggestions",
    stores: ["suggestions"],
    async list(read) {
      const out: FoldedItem[] = [];
      for (const name of read.names(DRAFTS_REL, "files", "suggestions")) {
        if (!name.endsWith(".yaml")) continue;
        const stem = name.slice(0, -".yaml".length);
        const at = read.modifiedAt(relOf(DRAFTS_REL, name))?.toISOString();
        const item = folded(read, {
          store: "suggestions",
          spec: "-",
          localId: `w.${stem}`,
          title: `Drafted spec: ${stem}`,
          status: "proposal",
          ...(at !== undefined ? { createdAt: at, updatedAt: at } : {}),
          author: { kind: "extractor", via: "watchme" },
          origin: { kind: "conversation" },
          operations: [
            cannot("adopt", "Read the draft, then compile it yourself when you want it."),
          ],
        });
        if (item !== undefined) out.push(item);
      }
      for (const root of storeRoots(read)) {
        for (const spec of read.names(dreamRel(root), "dirs", "suggestions")) {
          if (!isSpecName(spec)) continue;
          const findings = promotionFindings(read, root, spec);
          if (findings.length === 0) continue;
          const marked = await personal(read, root, spec);
          for (const finding of findings) {
            if (marked.has(finding.fact)) continue;
            const digest = createHash("sha256").update(finding.text).digest("hex").slice(0, 16);
            const item = folded(read, {
              store: "suggestions",
              spec,
              ...(root.partition !== undefined ? { partition: root.partition } : {}),
              localId: `d.${digest}`,
              title: finding.text,
              titleIsText: true,
              body: finding.text,
              status: "proposal",
              ...(finding.at !== undefined ? { createdAt: finding.at } : {}),
              author: { kind: "extractor", via: "dream" },
              origin: { kind: "conversation" },
              operations: [cannot("adopt", "Write it up as an article when you agree with it.")],
            });
            if (item !== undefined) out.push(item);
          }
        }
      }
      return out;
    },
    marks(read) {
      const out: Record<string, string> = { [DRAFTS_REL]: read.sourceMark(DRAFTS_REL) };
      for (const root of storeRoots(read)) {
        for (const spec of read.names(dreamRel(root), "dirs", "suggestions")) {
          const rel = relOf(dreamRel(root), spec, "idempotency.json");
          out[rel] = read.sourceMark(rel);
        }
      }
      return out;
    },
    current: (read, ids) => pick(adapter, read, ids),
  };
  return adapter;
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

const DATASETS_REL = relOf(".crewhaus", "datasets");
/** Held-out use lines live beside the records; they are not versions. */
const USES_SUFFIX = ".uses.jsonl";

function isDatasetName(name: string): boolean {
  if (name.startsWith("_")) return false;
  try {
    assertDatasetName(name);
    return true;
  } catch (err) {
    if (err instanceof DatasetRegistryError) return false;
    throw err;
  }
}

/** Datasets by name, version and size. No sample is read into an item or an index. */
export const datasetsAdapter: KnowledgeAdapter = {
  name: "datasets",
  stores: ["datasets"],
  async list(read) {
    const out: FoldedItem[] = [];
    for (const name of read.names(DATASETS_REL, "dirs", "datasets")) {
      if (!isDatasetName(name)) continue;
      const versions = read
        .names(relOf(DATASETS_REL, name), "files", "datasets")
        .filter((file) => file.endsWith(".json") && !file.endsWith(USES_SUFFIX))
        .map((file) => file.slice(0, -".json".length))
        .sort(compareVersions);
      const newest = versions[versions.length - 1];
      if (newest === undefined) continue;
      const record = read.json(relOf(DATASETS_REL, name, `${newest}.json`), "datasets");
      const splits = (record?.["splits"] as Record<string, unknown> | undefined) ?? {};
      const sizes = Object.entries(splits)
        .filter(([, samples]) => Array.isArray(samples))
        .map(([split, samples]) => `${split}: ${(samples as unknown[]).length}`)
        .sort();
      const at = isoOf(record?.["createdAt"]);
      const item = folded(read, {
        store: "datasets",
        spec: "-",
        localId: name,
        title: name,
        ...(sizes.length > 0 ? { body: sizes.join(", ") } : {}),
        status: newest,
        versions: versions.length,
        ...(at !== undefined ? { createdAt: at, updatedAt: at } : {}),
        author: { kind: "unknown" },
        origin: { kind: "unknown" },
        operations: [can("verify", `crewhaus datasets verify ${shellArg(name)}`)],
      });
      if (item !== undefined) out.push(item);
    }
    return out;
  },
  marks(read) {
    const out: Record<string, string> = { [DATASETS_REL]: read.sourceMark(DATASETS_REL) };
    for (const name of read.names(DATASETS_REL, "dirs", "datasets")) {
      const rel = relOf(DATASETS_REL, name);
      out[rel] = read.sourceMark(rel);
    }
    return out;
  },
  current: (read, ids) => pick(datasetsAdapter, read, ids),
};

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const CORPUS_REL = relOf(".crewhaus", "run", "knowledge", "corpus.json");

/** Documents the last boot indexed, by label and fingerprint: never their text. */
export const documentsAdapter: KnowledgeAdapter = {
  name: "documents",
  stores: ["documents"],
  async list(read) {
    const corpus = read.json(CORPUS_REL, "documents");
    if (corpus === undefined) return [];
    const at = isoOf(corpus["at"]);
    const out: FoldedItem[] = [];
    const seen = new Set<string>();
    for (const source of Array.isArray(corpus["sources"]) ? corpus["sources"] : []) {
      if (typeof source !== "object" || source === null) continue;
      const row = source as Record<string, unknown>;
      const label = str(row["label"]) ?? "document";
      if (row["status"] === "failed") {
        read.note("document-source-failed", "documents", "A document source could not be read.");
      }
      for (const doc of Array.isArray(row["docs"]) ? row["docs"] : []) {
        if (typeof doc !== "object" || doc === null) continue;
        const { source: localId, parts, contentHash16 } = doc as Record<string, unknown>;
        if (typeof localId !== "string" || seen.has(localId)) continue;
        seen.add(localId);
        const item = folded(read, {
          store: "documents",
          spec: "-",
          localId,
          title: label,
          status: "indexed",
          ...(typeof contentHash16 === "string" ? { version: contentHash16 } : {}),
          ...(typeof parts === "number" ? { versions: 1, body: `${parts} parts` } : {}),
          ...(at !== undefined ? { createdAt: at, updatedAt: at } : {}),
          author: { kind: "operator" },
          origin: { kind: "document", sources: [label] },
          record: { store: "document", backend: "local", localId },
          operations: [
            cannot("remove", "Change the spec's knowledge sources, then start it again."),
          ],
        });
        if (item !== undefined) out.push(item);
      }
    }
    return out;
  },
  marks: (read) => ({ [CORPUS_REL]: read.sourceMark(CORPUS_REL) }),
  current: (read, ids) => pick(documentsAdapter, read, ids),
};

// ---------------------------------------------------------------------------
// Thredz
// ---------------------------------------------------------------------------

/** Where a Thredz row is kept: the crew's identity or a role's, and its space. */
function thredzPartition(row: { readonly role?: string; readonly space?: string }): string {
  const space = row.space !== undefined ? `.${row.space}` : "";
  return row.role !== undefined ? `r.${row.role}${space}` : `c${space}`;
}

/** Thredz articles, records and tasks by name, through a client the caller supplies. */
export const thredzAdapter: KnowledgeAdapter = {
  name: "thredz",
  stores: ["records", "tasks"],
  async list(read) {
    if (read.thredz === undefined) return [];
    let rows: Awaited<ReturnType<NonNullable<HarnessRead["thredz"]>["list"]>>;
    try {
      rows = await read.thredz.list();
    } catch {
      read.note("unreadable", "thredz", "Thredz could not be reached.");
      return [];
    }
    const out: FoldedItem[] = [];
    for (const [store, list] of [
      ["wiki", rows.wiki ?? []],
      ["records", rows.records ?? []],
      ["tasks", rows.tasks ?? []],
    ] as const) {
      for (const row of list) {
        const item = folded(read, {
          store,
          backend: "thredz",
          spec: "-",
          partition: thredzPartition(row),
          localId: row.id,
          title: row.title,
          ...(row.status !== undefined ? { status: row.status } : {}),
          ...(row.version !== undefined ? { version: row.version } : {}),
          ...isoField("updatedAt", row.updatedAt),
          author: { kind: "upstream" },
          origin: { kind: "thredz" },
          tags: row.tags ?? [],
          ...(store === "wiki"
            ? { record: { store: "wiki", backend: "thredz", localId: row.id } as const }
            : {}),
          operations: [cannot("edit", "This is kept in Thredz. Edit it there.")],
        });
        if (item !== undefined) out.push(item);
      }
    }
    return out;
  },
  marks: () => ({}),
  current: (read, ids) => pick(thredzAdapter, read, ids),
};
