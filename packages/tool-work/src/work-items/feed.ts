/**
 * The Work view's feed, folded directly from the harness's records on every read
 * (`freshness: "direct-fold"`): what needs a person, what is running, what is up next, what
 * the harness proposes (grouped by basis), what runs on a schedule, what was delivered,
 * the continuity goals and active plan, and the tasks of the harness's Thredz workspace.
 *
 * Every section answers its rows or why it has none, with what fills it. A source that
 * cannot answer says so (`unreachable`) and shows nothing rather than old data. Nothing is
 * written: the run ledger is folded without a lock, the continuity store's goals and plans
 * are read without one, and at most one call reaches Thredz.
 */
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import type {
  WorkBasis,
  WorkFeed,
  WorkFeedEmpty,
  WorkFeedEntry,
  WorkFeedSection,
  WorkItemView,
  WorkRankDimension,
} from "@crewhaus/control-contract";
import { foldStates, runsLedger } from "@crewhaus/control-records";
import type { FoldedWorkItem } from "./fold";
import { openWorkStore } from "./store";
import { itemViews, viewContext } from "./view";

/** What one call for a Thredz workspace's tasks answers. */
export type ThredzTasksAnswer =
  | {
      readonly state: "ok";
      readonly tasks: readonly {
        readonly id: string;
        readonly title: string;
        readonly status?: string;
      }[];
    }
  | { readonly state: "unsupported"; readonly remedy?: string }
  | { readonly state: "unreachable"; readonly remedy: string };

/** One call for the tasks of the harness's Thredz workspace. */
export type ThredzTasksPort = () => Promise<ThredzTasksAnswer>;

/** A command a head is running for the harness: a job, by its receipt. */
export type WorkJob = { readonly id: string; readonly kind: string; readonly state: string };

export type WorkFeedOptions = {
  readonly now: () => number;
  /** The harness's spec name, for its continuity goals and plan; absent, none are read. */
  readonly specName?: string;
  /** Whether the spec lists any of the Work tools. */
  readonly tools: boolean;
  /** Whether the spec declares scheduled work. */
  readonly schedules?: boolean;
  /** Whether the caller may read content: goals, plans and Thredz tasks are content. */
  readonly content: boolean;
  readonly weights?: Readonly<Partial<Record<WorkRankDimension, number>>>;
  /** The Thredz workspace's tasks; absent when the harness declares no `thredz:`. */
  readonly thredz?: ThredzTasksPort;
  /** Jobs the head is running for the harness. */
  readonly jobs?: () => readonly WorkJob[];
};

/** At most this many rows per section. */
export const FEED_SECTION_MAX = 100;

/** The words each run trigger is grouped under, when the run serves no item. */
export const TRIGGER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  channel: "Conversations",
  schedule: "Scheduled checks",
  heartbeat: "Scheduled checks",
  api: "Requests from the app",
  managed: "Requests from the app",
  cli: "Runs from the command line",
  queue: "Queued jobs",
  resume: "Resumed runs",
  "approval-resume": "Resumed runs",
  retry: "Retries",
});

/** Runs that test the harness: never shown as its work. */
const HIDDEN_TRIGGERS: ReadonlySet<string> = new Set(["eval", "rehearsal"]);

const ADD_VERB = "crewhaus work add --title <title>";

function empty(reason: WorkFeedEmpty["reason"], remedy: string, verb: string | null = null) {
  return { empty: { reason, remedy, verb } } satisfies WorkFeedSection;
}

function section(
  items: readonly WorkFeedEntry[],
  whenEmpty: WorkFeedSection,
  extra: Partial<WorkFeedSection> = {},
): WorkFeedSection {
  if (items.length === 0) return whenEmpty;
  return {
    items: items.slice(0, FEED_SECTION_MAX),
    ...(items.length > FEED_SECTION_MAX ? { truncated: true } : {}),
    ...extra,
  };
}

function itemEntry(view: WorkItemView): WorkFeedEntry {
  return {
    kind: "item",
    id: view.id,
    label: view.title,
    status: view.status,
    statusWord: view.statusWord,
    item: view,
  };
}

function byPosition(a: WorkItemView, b: WorkItemView): number {
  return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
}

const LADDER_WORDS: Readonly<Record<string, string>> = {
  open: "Not started",
  in_progress: "In progress",
  claimed: "Done, not checked",
  proven: "Done and checked",
};

async function goalsSection(harnessDir: string, opts: WorkFeedOptions): Promise<WorkFeedSection> {
  if (!opts.content) {
    return empty(
      "no-access",
      "You can see this harness but not its work details. Ask an owner for access.",
    );
  }
  if (opts.specName === undefined) return empty("no-data", "No goals yet.");
  try {
    const store = createContinuityStore({
      specName: opts.specName,
      rootDir: join(harnessDir, ".crewhaus", "state"),
    });
    const [goals, plan] = await Promise.all([store.listGoals(), store.getActivePlan()]);
    const entries: WorkFeedEntry[] = goals.map((goal) => ({
      kind: "goal",
      id: goal.id,
      label: goal.title,
      status: goal.status,
      statusWord: LADDER_WORDS[goal.status] ?? goal.status,
      ...(goal.target !== undefined || goal.current !== undefined
        ? {
            progress: {
              ...(goal.current !== undefined ? { current: goal.current } : {}),
              ...(goal.target !== undefined ? { target: goal.target } : {}),
              ...(goal.unit !== undefined ? { unit: goal.unit } : {}),
            },
          }
        : {}),
    }));
    if (plan !== null) {
      entries.push({
        kind: "plan",
        id: plan.id,
        label: plan.title,
        statusWord: "Active plan",
        steps: plan.steps.map((step) => ({
          title: step.text,
          status: LADDER_WORDS[step.status] ?? step.status,
        })),
      });
    }
    return section(entries, empty("no-data", "No goals yet. The harness sets them as it works."));
  } catch {
    return empty("unreachable", "The harness's goals could not be read.");
  }
}

async function thredzSection(opts: WorkFeedOptions): Promise<WorkFeedSection> {
  if (opts.thredz === undefined) {
    return empty("unsupported", "Connect Thredz to see its tasks here.", "crewhaus services setup");
  }
  if (!opts.content) {
    return empty(
      "no-access",
      "You can see this harness but not its work details. Ask an owner for access.",
    );
  }
  let answer: ThredzTasksAnswer;
  try {
    answer = await opts.thredz();
  } catch {
    answer = {
      state: "unreachable",
      remedy: "Couldn't reach Thredz. Nothing is shown rather than old data.",
    };
  }
  if (answer.state === "unsupported") {
    return empty(
      "unsupported",
      answer.remedy ?? "Connect Thredz to see its tasks here.",
      "crewhaus services setup",
    );
  }
  if (answer.state === "unreachable") return empty("unreachable", answer.remedy);
  return section(
    answer.tasks.map((task) => ({
      kind: "task",
      id: task.id,
      label: task.title,
      ...(task.status !== undefined ? { status: task.status, statusWord: task.status } : {}),
    })),
    empty("no-data", "Thredz has no open tasks for this harness."),
  );
}

/** The run rows working now that serve no item, grouped by what started them. */
function runsWithoutItems(harnessDir: string, linked: ReadonlySet<string>): WorkFeedEntry[] {
  const fold = foldStates(runsLedger(harnessDir));
  if (!fold.ok) return [];
  const groups = new Map<string, string[]>();
  for (const [id, object] of fold.objects) {
    if (object.state !== "preparing" && object.state !== "running") continue;
    if (linked.has(id) || typeof object.record["workItem"] === "string") continue;
    const trigger = object.record["trigger"] as { readonly kind?: unknown } | undefined;
    const kind = typeof trigger?.kind === "string" ? trigger.kind : "unknown";
    if (HIDDEN_TRIGGERS.has(kind)) continue;
    groups.set(kind, [...(groups.get(kind) ?? []), id]);
  }
  return [...groups.entries()].map(([kind, runs]) => ({
    kind: "runs",
    id: `trigger:${kind}`,
    label: TRIGGER_WORDS[kind] ?? "Other runs",
    trigger: kind,
    count: runs.length,
    runs,
    statusWord: "Working",
  }));
}

const NEEDS_YOU: ReadonlySet<string> = new Set(["proposed", "waiting-approval", "needs-input"]);
const WORKING: ReadonlySet<string> = new Set(["working"]);

/** The Work feed of the harness at `harnessDir`. Writes nothing. */
export async function workFeed(harnessDir: string, opts: WorkFeedOptions): Promise<WorkFeed> {
  const store = openWorkStore(harnessDir, { now: opts.now });
  const fold = store.fold();
  const folded: readonly FoldedWorkItem[] = "items" in fold ? [...fold.items.values()] : [];
  const ctx =
    "items" in fold
      ? viewContext(harnessDir, fold, opts.weights)
      : { runStates: new Map<string, string>(), harness: {}, corrections: [] };
  const views = itemViews(store, folded, ctx);
  const linked = new Set(folded.flatMap((item) => item.runs));

  const needsYou = views
    .filter((v) => v.state === "proposed" || (v.state !== "closed" && NEEDS_YOU.has(v.status)))
    .sort(byPosition)
    .map(itemEntry);
  const working: WorkFeedEntry[] = [
    ...views.filter((v) => v.state === "open" && WORKING.has(v.status)).map(itemEntry),
    ...runsWithoutItems(harnessDir, linked),
    ...(opts.jobs?.() ?? []).map((job) => ({
      kind: "job" as const,
      id: job.id,
      label: job.kind,
      status: job.state,
      statusWord: job.state === "running" ? "Working" : "Queued",
    })),
  ];
  const upNext = views
    .filter((v) => v.state === "open" && !NEEDS_YOU.has(v.status) && !WORKING.has(v.status))
    .sort(byPosition)
    .map(itemEntry);
  const proposedViews = views.filter((v) => v.state === "proposed").sort(byPosition);
  const groups = (
    ["compatibility-security", "user-pain", "speculative"] as const satisfies readonly WorkBasis[]
  )
    .map((basis) => ({
      basis,
      items: proposedViews.filter((v) => v.basis === basis).map((v) => v.id),
    }))
    .filter((group) => group.items.length > 0);
  const deliveredItems = folded
    .filter((item) => item.history.some((line) => line.event === "delivered"))
    .map((item) => views.find((v) => v.id === item.id) as WorkItemView)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(itemEntry);

  const nothingYet = folded.length === 0;
  const noList = empty(
    "unsupported",
    "This harness doesn't keep a work list. Turn on the Work tools in Setup.",
  );
  const [goals, fromThredz] = await Promise.all([
    goalsSection(harnessDir, opts),
    thredzSection(opts),
  ]);
  return {
    freshness: "direct-fold",
    at: new Date(opts.now()).toISOString(),
    sections: {
      needsYou: section(needsYou, empty("no-data", "Nothing needs you right now.")),
      workingNow: section(working, empty("no-data", "Nothing is running right now.")),
      upNext: section(
        upNext,
        nothingYet
          ? empty(
              "no-data",
              "Nothing to do yet. Add work, or let the harness propose some.",
              ADD_VERB,
            )
          : empty("no-data", "Nothing is up next.", ADD_VERB),
      ),
      proposed: section(
        proposedViews.map(itemEntry),
        opts.tools ? empty("no-data", "No proposals right now.") : noList,
        { groups },
      ),
      scheduled:
        opts.schedules === true
          ? {
              items: [
                {
                  kind: "schedule",
                  id: "schedule",
                  label: "Scheduled work",
                  statusWord: "See the schedule",
                },
              ],
            }
          : empty("no-data", "No scheduled work."),
      delivered: section(deliveredItems, empty("no-data", "Nothing delivered yet.")),
      goals,
      fromThredz,
    },
    anomalies: "items" in fold ? fold.anomalies : 0,
    tools: opts.tools,
    ...(opts.content ? {} : { hidden: ["content" as const] }),
  };
}
