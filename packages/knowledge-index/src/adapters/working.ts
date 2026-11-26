/**
 * Working memory: focus, plans, goals and requirements, for the spec, for each conversation
 * and for each customer, and what was cleared into the trash and can still be put back.
 */
import { createHash } from "node:crypto";
import {
  type ContinuityStore,
  TRASH_PURGE_AFTER_MS,
  createContinuityStore,
  listTrash,
  parseTrashTimestamp,
} from "@crewhaus/continuity-store";
import { SESSION_ID_RE } from "@crewhaus/control-contract";
import type { KnowledgeItem } from "@crewhaus/control-contract/knowledge";
import type { HarnessRead } from "../context";
import { relOf } from "../context";
import { type FoldedItem, can, cannot, folded, shellArg } from "../model";
import {
  type KnowledgeAdapter,
  isSpecName,
  isoField,
  pick,
  sessionEvidence,
  storePlaces,
} from "./types";

type Scope = {
  /** Where the store's `.crewhaus`-like directory is: the harness's own, or a customer's. */
  readonly base: string;
  readonly rel: string;
  readonly spec: string;
  readonly partition: string | undefined;
  readonly session: string | undefined;
  readonly tenant: boolean;
  readonly store: ContinuityStore;
};

/** Every place working memory is kept. */
function scopes(read: HarnessRead): Scope[] {
  const out: Scope[] = [];
  for (const place of storePlaces(read, "state")) {
    const { root } = place;
    const sessions = read.directory(relOf(root.base, "sessions"), "plans");
    const at = (session: string | undefined): Scope => ({
      base: root.base,
      rel: session === undefined ? place.rel : relOf(place.rel, "sessions", session),
      spec: place.spec,
      partition: root.partition ?? (session !== undefined ? `s.${session}` : undefined),
      session,
      tenant: root.partition !== undefined,
      store: createContinuityStore({
        specName: place.name,
        rootDir: place.rootDir,
        ...(sessions !== undefined ? { sessionRootDir: sessions } : {}),
        ...(session !== undefined ? { scope: { kind: "session", sessionId: session } } : {}),
      }),
    });
    out.push(at(undefined));
    // A customer's conversations share the customer's partition: the id has one place to
    // say where, and the customer is the stronger fence.
    if (root.partition !== undefined) continue;
    for (const name of read.names(relOf(place.rel, "sessions"), "dirs", "plans")) {
      if (SESSION_ID_RE.test(name)) out.push(at(name));
    }
  }
  return out;
}

const CUSTOMER = "Customer memory is changed by the deployment that serves the customer.";

function clearing(scope: Scope, what: string): KnowledgeItem["operations"] {
  if (scope.tenant) return [cannot("clear", CUSTOMER)];
  if (scope.spec === "-") {
    return [
      cannot("clear", "This is kept the older way; the harness moves it when it next writes."),
    ];
  }
  const session = scope.session !== undefined ? ` --session ${scope.session}` : "";
  return [
    can("clear", `crewhaus state clear --scope ${what}${session} --spec ${shellArg(scope.spec)}`),
  ];
}

async function readOrNote<T>(
  read: HarnessRead,
  store: string,
  fn: () => Promise<T>,
  none: T,
): Promise<T> {
  try {
    return await fn();
  } catch {
    read.note("unreadable", store, "A file here could not be read, so it is left out.");
    return none;
  }
}

async function foldScope(read: HarnessRead, scope: Scope): Promise<FoldedItem[]> {
  const out: FoldedItem[] = [];
  const common = {
    spec: scope.spec,
    ...(scope.partition !== undefined ? { partition: scope.partition } : {}),
  };
  const record = (store: "focus" | "plan" | "goal", localId: string) =>
    scope.spec === "-"
      ? {}
      : {
          record: {
            store,
            backend: "local" as const,
            spec: scope.spec,
            partition: scope.partition ?? "-",
            localId,
          },
        };
  const author = {
    author: {
      kind: "agent" as const,
      ...(scope.session !== undefined ? { session: scope.session } : {}),
    },
  };
  const add = (item: FoldedItem | undefined): void => {
    if (item !== undefined) out.push(item);
  };
  const focus = await readOrNote(read, "focus", () => scope.store.readFocus(), null);
  if (focus !== null && focus.body !== "") {
    add(
      folded(read, {
        ...common,
        ...author,
        ...record("focus", "focus"),
        store: "focus",
        localId: "focus",
        title: "Focus",
        body: focus.body,
        ...isoField("updatedAt", read.modifiedAt(relOf(scope.rel, "focus.md"))?.getTime()),
        operations: clearing(scope, "focus"),
      }),
    );
  }
  for (const req of focus?.requirements ?? []) {
    add(
      folded(read, {
        ...common,
        store: "requirements",
        localId: req.id,
        title: req.text,
        titleIsText: true,
        body: req.text,
        status: req.status,
        author: { kind: "extractor", session: req.source.sessionId },
        origin: { kind: "conversation", session: req.source.sessionId },
        evidence: sessionEvidence(read, scope.base, req.source.sessionId),
        operations: clearing(scope, "focus"),
      }),
    );
  }
  for (const plan of await readOrNote(read, "plans", () => scope.store.listPlans(), [])) {
    const proofs = plan.steps.flatMap((step) => step.proofs);
    const proven = plan.steps.filter((step) => step.status === "proven").length;
    add(
      folded(read, {
        ...common,
        ...author,
        ...record("plan", plan.id),
        store: "plans",
        localId: plan.id,
        title: plan.title,
        body: plan.steps.map((step) => `${step.index}. [${step.status}] ${step.text}`).join("\n"),
        status: `${proven} of ${plan.steps.length} proven`,
        ...isoField("createdAt", plan.createdAt),
        ...isoField("updatedAt", plan.updatedAt),
        evidence: proofs.length > 0 ? { status: "frozen" } : { status: "not-recorded" },
        operations: clearing(scope, "plans"),
      }),
    );
  }
  for (const goal of await readOrNote(read, "goals", () => scope.store.listGoals(), [])) {
    add(
      folded(read, {
        ...common,
        ...author,
        ...record("goal", goal.id),
        store: "goals",
        localId: goal.id,
        title: goal.title,
        status: goal.status,
        ...isoField("createdAt", goal.createdAt),
        ...isoField("updatedAt", goal.updatedAt),
        evidence:
          (goal.proofs?.length ?? 0) > 0 ? { status: "frozen" } : { status: "not-recorded" },
        operations: clearing(scope, "goals"),
      }),
    );
  }
  return out;
}

/** What one trashed file was: a focus, a plan or a list of goals, of one scope. */
function trashedKind(file: string):
  | {
      readonly store: "focus" | "plans" | "goals";
      readonly spec: string;
      readonly partition?: string;
      readonly localId?: string;
    }
  | undefined {
  const parts = file.split(/[/\\]/);
  if (parts[0] !== "state" || parts[1] === undefined || !isSpecName(parts[1])) return undefined;
  const spec = parts[1];
  const session = parts[2] === "sessions" ? parts[3] : undefined;
  if (session !== undefined && !SESSION_ID_RE.test(session)) return undefined;
  const rest = session === undefined ? parts.slice(2) : parts.slice(4);
  const partition = session !== undefined ? { partition: `s.${session}` } : {};
  if (rest.length === 1 && rest[0] === "focus.md") {
    return { store: "focus", spec, ...partition, localId: "focus" };
  }
  if (rest.length === 1 && rest[0] === "goals.yaml") return { store: "goals", spec, ...partition };
  const plan =
    rest.length === 2 && rest[0] === "plans" ? /^(plan-\d{4})-/.exec(rest[1] ?? "") : null;
  return plan?.[1] !== undefined
    ? { store: "plans", spec, ...partition, localId: plan[1] }
    : undefined;
}

/** What was cleared and can still be put back, one item per thing cleared. */
async function foldTrash(read: HarnessRead): Promise<FoldedItem[]> {
  if (read.directory(".crewhaus", "trash") === undefined) return [];
  if (read.directory(relOf(".crewhaus", "trash"), "trash") === undefined) return [];
  const out: FoldedItem[] = [];
  const snapshots = await readOrNote(
    read,
    "trash",
    () => listTrash(read.directory(".crewhaus", "trash") as string),
    [],
  );
  for (const snapshot of snapshots) {
    const at = parseTrashTimestamp(snapshot.ts);
    // One id per thing and snapshot: the id names what it was, its version which snapshot.
    const version = createHash("sha256").update(snapshot.ts).digest("hex").slice(0, 12);
    for (const file of snapshot.files) {
      const kind = trashedKind(file);
      if (kind === undefined) continue;
      const item = folded(read, {
        store: kind.store,
        spec: kind.spec,
        ...(kind.partition !== undefined ? { partition: kind.partition } : {}),
        localId: kind.localId ?? "goal-0000",
        idVersion: version,
        title:
          kind.store === "goals"
            ? "Cleared goals"
            : kind.store === "focus"
              ? "Cleared focus"
              : `Cleared plan ${kind.localId}`,
        lifecycle: "deleted-restorable",
        ...(at !== null
          ? {
              updatedAt: new Date(at).toISOString(),
              expiresAt: new Date(at + TRASH_PURGE_AFTER_MS).toISOString(),
            }
          : {}),
        author: { kind: "unknown" },
        operations: [can("restore", `crewhaus state restore --trash ${snapshot.ts}`)],
      });
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

/** How many of a customer's conversations keep working memory of their own. */
function customerConversations(read: HarnessRead): number {
  let count = 0;
  for (const place of storePlaces(read, "state")) {
    if (place.root.partition === undefined) continue;
    count += read
      .names(relOf(place.rel, "sessions"), "dirs", "plans")
      .filter((name) => SESSION_ID_RE.test(name)).length;
  }
  return count;
}

export const workingAdapter: KnowledgeAdapter = {
  name: "working",
  stores: ["focus", "plans", "goals", "requirements"],
  async list(read) {
    const out: FoldedItem[] = [];
    for (const scope of scopes(read)) {
      for (const item of await foldScope(read, scope)) out.push(item);
    }
    for (const item of await foldTrash(read)) out.push(item);
    for (let i = customerConversations(read); i > 0; i -= 1) {
      read.note(
        "not-listed",
        "plans",
        "A customer's conversation keeps working memory of its own, which isn't listed here.",
      );
    }
    return out;
  },
  marks(read) {
    const out: Record<string, string> = {};
    const mark = (rel: string): void => {
      out[rel] = read.sourceMark(rel);
    };
    for (const scope of scopes(read)) {
      // Each write is a rename into the scope's directory or its plans.
      mark(scope.rel);
      mark(relOf(scope.rel, "plans"));
      mark(relOf(scope.rel, "sessions"));
    }
    mark(relOf(".crewhaus", "state"));
    mark(relOf(".crewhaus", "trash"));
    return out;
  },
  async current(read, ids) {
    const out: FoldedItem[] = [];
    const inTrash = ids.some((id) => id.version !== undefined);
    for (const scope of scopes(read)) {
      const mine = ids.filter(
        (id) =>
          id.version === undefined &&
          id.spec === scope.spec &&
          (id.partition ?? "-") === (scope.partition ?? "-"),
      );
      if (mine.length === 0) continue;
      const wanted = new Set(mine.map((id) => `${id.store}\0${id.localId}`));
      for (const item of await foldScope(read, scope)) {
        if (wanted.has(`${item.item.ref.store}\0${item.item.ref.localId}`)) out.push(item);
      }
    }
    if (inTrash) out.push(...(await pick({ list: foldTrash }, read, ids)));
    return out;
  },
};
