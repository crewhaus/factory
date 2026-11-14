/**
 * Deployments through the API: the builds a harness has, one build, and activating one.
 * A prepared build recorded by a compile in a directory Home had not registered yet names
 * no harness; the list fills it from the harness the request names, so every row says
 * whose it is. A build with no spec hash or compiler stamp is served without one: a
 * guessed value would be wrong.
 */
import { deploymentsLedger } from "@crewhaus/control-records";
import {
  AREA_RUNTIMES,
  activateDeployment,
  activationGates,
  isServiceActor,
  outcomeOf,
  pageObjects,
} from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import type { V1Handler } from "./context";
import { V1Error } from "./errors";
import { emptyOf, nextCursor, pagingOf, snapshotCursor } from "./lists";
import { harnessOf, liveDirOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

/** A deployment row as served: the ledger's own fields left out, and its harness named. */
export function servedDeployment(
  record: Readonly<Record<string, unknown>>,
  entry: HangarHarnessEntry,
): Record<string, unknown> {
  const { claim: _claim, gen: _gen, ...row } = record as Record<string, unknown>;
  return typeof row["harness"] === "string" ? row : { ...row, harness: entry.id };
}

const list: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  const paging = pagingOf(ctx.query, "deployments");
  if (dir === undefined) {
    return {
      status: 200,
      body: {
        items: [],
        snapshotAt: snapshotCursor("deployments", []),
        empty: { reason: "unreachable", remedy: "The harness folder is missing." },
      },
    };
  }
  const page = pageObjects(deploymentsLedger(dir), {
    limit: paging.limit,
    ...(paging.before !== undefined ? { before: paging.before } : {}),
    entry: ["prepared"],
    view: (record) => servedDeployment(record, entry),
  });
  return {
    status: 200,
    body: {
      items: page.items,
      ...(page.next !== undefined ? { next: nextCursor("deployments", page.next) } : {}),
      snapshotAt: snapshotCursor("deployments", page.snapshotAt),
      ...(page.gaps.length > 0
        ? {
            truncated: {
              reason: "unreadable_lines",
              verb: `crewhaus deploy list --harness ${entry.id}`,
            },
          }
        : {}),
      ...emptyOf(
        page.items,
        "no-data",
        "Compile the harness to record a build: `crewhaus compile`.",
      ),
    },
    scrubDir: dir,
  };
};

const get: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const dep = ctx.params["dep"];
  const page = pageObjects(deploymentsLedger(dir), {
    limit: 500,
    entry: ["prepared"],
    view: (record) => servedDeployment(record, entry),
  });
  const found = page.items.find((row) => row["id"] === dep);
  if (found === undefined) {
    throw new V1Error({
      status: 404,
      code: "not_found",
      reason: "deployment_unknown",
      message: "This harness has no build by that id.",
      verb: `crewhaus deploy list --harness ${entry.id}`,
    });
  }
  return { status: 200, body: found, scrubDir: dir };
};

const activate: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const dep = String(ctx.body["deployment"]);
  if (ctx.actor !== undefined && isServiceActor(ctx.deps.hangarRoot, ctx.actor)) {
    throw new V1Error({
      status: 403,
      code: "forbidden",
      reason: "human_only",
      message: "Activating a build is a person's act; a service cannot do it.",
    });
  }
  const submitted = await submitCommand<{ readonly status: number; readonly body: unknown }>(ctx, {
    target: `${entry.id}/deployment/${dep}`,
    ledger: { harness: dir },
    effect: async (receipt) => {
      const answer = await activateDeployment({
        harnessDir: dir,
        dep,
        actor: receipt.actor,
        actorIsService: isServiceActor(ctx.deps.hangarRoot, receipt.actor),
        cmd: receipt.id,
        gates: activationGates(AREA_RUNTIMES),
        registryId: entry.id,
        now: ctx.deps.now,
      });
      if (answer.ok) {
        return {
          settle: { state: "succeeded" },
          value: { status: 200, body: { deployment: servedDeployment(answer.record, entry) } },
        };
      }
      return {
        settle: { state: "rejected", outcome: outcomeOf(answer.code as never) },
        value: {
          status: answer.code === "not_found" ? 404 : answer.code === "unavailable" ? 503 : 409,
          body: {
            code: answer.code,
            message: answer.message,
            ...(answer.current !== undefined ? { current: answer.current } : {}),
            ...(answer.verb !== undefined ? { verb: answer.verb } : {}),
          },
        },
      };
    },
  });
  const value = submitted.value;
  if (value !== undefined && value.status !== 200) {
    const body = value.body as { code: string; message: string; current?: unknown; verb?: string };
    throw new V1Error({
      status: value.status,
      code: body.code,
      reason: body.code,
      message: body.message,
      ...(body.current !== undefined ? { current: body.current } : {}),
      ...(body.verb !== undefined ? { verb: body.verb } : {}),
      details: { receipt: submitted.receipt },
    });
  }
  return acceptedAnswer(
    submitted,
    value !== undefined ? (value.body as Record<string, unknown>) : {},
    dir,
  );
};

export const DEPLOYMENT_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "deployments.list": list,
  "deployments.get": get,
  "deployments.activate": activate,
};
