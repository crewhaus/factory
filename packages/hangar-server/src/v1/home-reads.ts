/**
 * Home's own reads (#524, #507, #513): its status line, this period's spend of every
 * harness, and who may work on one harness. Each reads only the harnesses the caller may
 * read, filtered before anything is counted or added up, and writes nothing.
 *
 * - `home.status`: the host Home runs on and how this browser reached it, its version,
 *   whether it runs as a service, and its harnesses counted by what they are doing. A
 *   count Home cannot know is left out with a note, never shown as zero.
 * - `home.spend`: each harness's budget fold for the current period, and the totals of
 *   the priced amounts. A call nothing could price is counted as unknown, never `$0`, and
 *   the totals then say they are at least what they show.
 * - `home.harnessAccess`: the people whose grants cover one harness, in plain terms:
 *   names, roles and where each grant applies. No secret and no linked account.
 */
import { hostname } from "node:os";
import { listMembers } from "@crewhaus/access-control";
import type { HomeSpend, HomeStatus, SpendRow } from "@crewhaus/control-contract";
import { actionDecisionState, readActionDecisions } from "@crewhaus/control-records";
import { periodOf, readBudgetState } from "@crewhaus/control-records/budget";
import { slugOf } from "@crewhaus/harness-registry";
import { pendingApprovalsOf } from "../approvals";
import { declaredBudgetPeriod, readBudget } from "../budget";
import { readSpecText } from "./budget";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { displayOf } from "./harnesses";
import { harnessOf, liveDirOf, visibleHarnesses } from "./resolve";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** How this request reached Home: through a proxy, on Home's own computer, or over the network. */
export function reachedByOf(req: Request, url: URL): "loopback" | "lan" | "proxy" {
  const headers = req.headers;
  if (
    headers.get("forwarded") !== null ||
    headers.get("x-forwarded-for") !== null ||
    headers.get("x-forwarded-host") !== null
  ) {
    return "proxy";
  }
  return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.startsWith("127.") ? "loopback" : "lan";
}

/** Whether the harness's current period's limit is used up: new work waits for it to renew. */
export function waitingForBudget(dir: string, now: number): boolean | undefined {
  const text = readSpecText(dir);
  if (text === undefined) return undefined;
  const def = declaredBudgetPeriod(text);
  if (def === undefined) return false;
  const state = readBudgetState(dir);
  if (state.state === "unreadable") return undefined;
  if (state.state === "absent") return false;
  let current: string;
  try {
    current = periodOf(def, now).periodId;
  } catch {
    return undefined;
  }
  const renews = Date.parse(state.record.renewsAt);
  return state.record.periodId === current && Number.isFinite(renews) && renews > now;
}

export const homeStatus: V1Handler = async (ctx) => {
  const now = ctx.deps.now();
  const reachedBy = reachedByOf(ctx.req, ctx.url);
  const harnesses = visibleHarnesses(ctx.deps);
  let needsYou = 0;
  let needsYouKnown = true;
  let working = 0;
  let paused = 0;
  let notResponding = 0;
  let budget = 0;
  let budgetKnown = true;
  for (const entry of harnesses) {
    const dir = liveDirOf(entry);
    const display = await displayOf(ctx, entry, dir);
    if (display.state === "running" || display.state === "draining") working += 1;
    else if (display.state === "paused") paused += 1;
    else if (display.state === "crashed" || display.state === "disconnected") notResponding += 1;
    if (dir === undefined) {
      needsYouKnown = false;
      budgetKnown = false;
      continue;
    }
    const pending = pendingApprovalsOf(dir);
    if (pending === undefined) needsYouKnown = false;
    else needsYou += pending;
    const actions = readActionDecisions(dir);
    if (actions.state === "unreadable") needsYouKnown = false;
    else if (actions.state === "present") {
      needsYou += actions.rows.filter((row) => actionDecisionState(row, now) === "pending").length;
    }
    const waiting = waitingForBudget(dir, now);
    if (waiting === undefined) budgetKnown = false;
    else if (waiting) budget += 1;
  }
  const notes: { count: string; note: string }[] = [];
  if (!needsYouKnown) {
    notes.push({
      count: "needsYou",
      note: "Some harnesses keep their requests where Home cannot read them, so what needs you is not counted.",
    });
  }
  if (!budgetKnown) {
    notes.push({
      count: "waitingForBudget",
      note: "Some harnesses' spending limits cannot be read, so the harnesses waiting for budget are not counted.",
    });
  }
  const body: HomeStatus = {
    host: { name: hostname(), loopback: reachedBy === "loopback", reachedBy },
    version: ctx.deps.version,
    // Whether Home runs as a service is decided by the command that started it.
    service: { installed: "unknown" },
    counts: {
      harnesses: harnesses.length,
      ...(needsYouKnown ? { needsYou } : {}),
      working,
      paused,
      notResponding,
      ...(budgetKnown ? { waitingForBudget: budget } : {}),
    },
    ...(notes.length > 0 ? { notes } : {}),
    asOf: new Date(now).toISOString(),
  };
  return { status: 200, body };
};

export const homeSpend: V1Handler = async (ctx) => {
  const now = ctx.deps.now();
  const rows: SpendRow[] = [];
  const totals = {
    harnesses: 0,
    capUsdMicros: 0,
    spentUsdMicros: 0,
    reservedUsdMicros: 0,
    unknownCalls: 0,
  };
  let lowerBound = false;
  // Filtered before anything is added up: a harness the caller may not read is not read.
  for (const entry of visibleHarnesses(ctx.deps)) {
    const dir = liveDirOf(entry);
    const name = entry.slug ?? slugOf(entry.specName) ?? entry.id;
    if (dir === undefined) {
      lowerBound = true;
      rows.push({
        harness: entry.id,
        name,
        present: false,
        why: "spec_unreadable",
        note: "This harness's folder is missing, so its spending is unknown.",
        verb: "crewhaus harness list",
      });
      continue;
    }
    const read = readBudget(dir, readSpecText(dir), now, entry.id);
    if (!read.present) {
      if (read.why === "spec_unreadable") lowerBound = true;
      rows.push({
        harness: entry.id,
        name,
        present: false,
        why: read.why,
        note: read.note,
        verb: read.verb,
      });
      continue;
    }
    const { fold } = read;
    totals.harnesses += 1;
    totals.capUsdMicros += fold.capUsdMicros + fold.extensionsUsdMicros;
    totals.spentUsdMicros += fold.spentUsdMicros;
    totals.reservedUsdMicros += fold.reservedUsdMicros;
    totals.unknownCalls += fold.unknownCalls;
    if (fold.unknownCalls > 0 || fold.truncated) lowerBound = true;
    rows.push({
      harness: entry.id,
      name,
      present: true,
      note: read.note,
      verb: read.verb,
      periodId: fold.periodId,
      every: fold.every,
      renewsAt: fold.renewsAt,
      timezone: fold.timezone,
      capUsdMicros: fold.capUsdMicros,
      extensionsUsdMicros: fold.extensionsUsdMicros,
      spentUsdMicros: fold.spentUsdMicros,
      reservedUsdMicros: fold.reservedUsdMicros,
      unknownCalls: fold.unknownCalls,
      exhausted: fold.exhausted,
      truncated: fold.truncated,
    });
  }
  const body: HomeSpend = {
    rows,
    totals: { ...totals, ...(lowerBound ? { lowerBound: true as const } : {}) },
    asOf: new Date(now).toISOString(),
  };
  return { status: 200, body };
};

/** Where a grant applies, as a word: the whole Home, a group, or one harness. */
function scopeKind(scope: string): "home" | "group" | "harness" | undefined {
  if (scope === "home") return "home";
  if (scope.startsWith("group:")) return "group";
  if (scope.startsWith("harness:")) return "harness";
  return undefined;
}

export const homeHarnessAccess: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const read = ctx.deps.home.signIn.snapshot();
  if (read.state !== "present") {
    throw new V1Error({
      status: 503,
      code: "unavailable",
      reason: read.state === "absent" ? "access_not_set_up" : "access_unreadable",
      message:
        read.state === "absent"
          ? "Nobody else has access to this Home yet."
          : "Home's access records cannot be read. Run `crewhaus access members` on this computer to see why.",
    });
  }
  const covers = (scope: string): boolean =>
    scope === "home" ||
    scope === `harness:${entry.id}` ||
    entry.groups.some((group) => scope === `group:${group}`);
  const members = listMembers(read.snapshot, ctx.deps.now()).flatMap((member) => {
    const grants = member.grants
      .filter((grant) => grant.live && covers(grant.scope))
      .flatMap((grant) => {
        const kind = scopeKind(grant.scope);
        return kind === undefined
          ? []
          : [
              {
                role: grant.role,
                scope: kind,
                ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
              },
            ];
      });
    const all =
      member.homeOwner && grants.length === 0
        ? [{ role: "owner", scope: "home" as const }]
        : grants;
    if (all.length === 0) return [];
    return [
      {
        principal: member.id,
        ...(member.displayName !== undefined ? { name: member.displayName } : {}),
        kind: member.kind === "service" ? ("service" as const) : ("member" as const),
        grants: all,
      },
    ];
  });
  return {
    status: 200,
    body: {
      harness: entry.id,
      members,
      note: "People who can work on this harness, and what they can do here.",
    },
  };
};
