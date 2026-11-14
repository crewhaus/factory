/**
 * Plugin grants through the API (#522): one plugin's review, the owner's grant and its
 * revoke. A review folds the grants ledger and the manifests and writes nothing; a grant
 * or a revoke is a workspace command, refused before its receipt when the request names
 * something the plugin does not ask for, a harness Home does not know, or a generation
 * that is not the live grant's.
 */
import type { PluginGrantSet } from "@crewhaus/control-contract";
import { outcomeOf } from "@crewhaus/control-service";
import {
  type GrantOutcome,
  type PluginGrantInput,
  type PluginGrants,
  expectHolds,
  grantPlugin,
  grantProblem,
  liveGrantOf,
  pluginReviewOf,
  readPluginGrants,
  reviewVerbOf,
  revokePlugin,
  standingFrom,
} from "../plugin-grants";
import { type PluginRow, readPluginInventory } from "../plugins";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { acceptedAnswer, submitCommand } from "./submit";

function grantsOf(ctx: V1Context): PluginGrants {
  const read = readPluginGrants(ctx.deps.hangarRoot);
  if (!read.ok) {
    throw new V1Error({
      status: 503,
      code: "unavailable",
      reason: "grants_unreadable",
      message: `Plugin grants cannot be read: ${read.reason}`,
    });
  }
  return read.grants;
}

/** The plugin the path names, with its standing, or a 404 that names the install verb. */
function pluginOf(ctx: V1Context, grants: PluginGrants): PluginRow {
  const name = String(ctx.params["plugin"]);
  const row = readPluginInventory(ctx.deps.pluginsDir, standingFrom(grants)).plugins.find(
    (p) => p.name === name,
  );
  if (row === undefined) {
    throw new V1Error({
      status: 404,
      code: "not_found",
      reason: "plugin_unknown",
      message: `No plugin "${name}" is installed.`,
      verb: `crewhaus plugins install ${name}`,
    });
  }
  return row;
}

function harnessesOf(ctx: V1Context) {
  return ctx.deps.registry.list().map((entry) => ({ id: entry.id, dir: entry.dir }));
}

function currentOf(grants: PluginGrants, plugin: string) {
  const live = liveGrantOf(grants, plugin);
  return live === undefined
    ? { gen: null, granted: null }
    : {
        gen: live.gen,
        granted: {
          harnesses: live.row.harnesses,
          panes: live.row.panes,
          events: live.row.events,
          reads: live.row.reads,
          net: live.row.net,
          tools: live.row.tools,
        } satisfies PluginGrantSet,
      };
}

function staleError(
  plugin: string,
  current: { readonly gen: number | null },
  details?: Record<string, unknown>,
): V1Error {
  return new V1Error({
    status: 412,
    code: "precondition_failed",
    reason: "stale_grant",
    message:
      current.gen === null
        ? `"${plugin}" has no live grant now: read its review again and send no expect.`
        : `"${plugin}"'s grant is at generation ${current.gen} now: read its review again.`,
    current,
    verb: reviewVerbOf(plugin),
    ...(details !== undefined ? { details } : {}),
  });
}

const review: V1Handler = async (ctx) => {
  const grants = grantsOf(ctx);
  const row = pluginOf(ctx, grants);
  return {
    status: 200,
    body: pluginReviewOf(row, grants.get(row.name), harnessesOf(ctx), (id) =>
      ctx.access.canRead(id),
    ),
  };
};

/** How a grant or revoke ended, as its receipt records it. */
function settleOf(outcome: GrantOutcome) {
  if (outcome.ok) return { state: "succeeded" as const };
  if (outcome.code === "io") return { state: "failed" as const, outcome: outcomeOf("unavailable") };
  return {
    state: "rejected" as const,
    outcome: outcomeOf(outcome.code === "stale" ? "precondition_failed" : "conflict"),
  };
}

function noLiveGrant(plugin: string, details?: Record<string, unknown>): V1Error {
  return new V1Error({
    status: 409,
    code: "conflict",
    reason: "no_live_grant",
    message: `"${plugin}" has no live grant to remove.`,
    verb: reviewVerbOf(plugin),
    ...(details !== undefined ? { details } : {}),
  });
}

/** A failed outcome after its receipt, in the API's words, the receipt riding along. */
function refusalAfter(
  plugin: string,
  outcome: GrantOutcome,
  receipt: unknown,
): V1Error | undefined {
  if (outcome.ok) return undefined;
  const details = { receipt };
  if (outcome.code === "stale") return staleError(plugin, { gen: outcome.gen }, details);
  if (outcome.code === "no-live-grant") return noLiveGrant(plugin, details);
  return new V1Error({
    status: 503,
    code: "unavailable",
    reason: "grant_write",
    message: outcome.reason,
    details,
  });
}

const grant: V1Handler = async (ctx) => {
  const grants = grantsOf(ctx);
  const row = pluginOf(ctx, grants);
  const input = ctx.body as unknown as PluginGrantInput;
  const known = new Set(harnessesOf(ctx).map((h) => h.id));
  const problem = grantProblem(row, input, known);
  if (problem !== undefined) {
    throw new V1Error({ status: 400, code: "invalid", reason: "not_asked", message: problem });
  }
  if (!expectHolds(liveGrantOf(grants, row.name), input.expect)) {
    throw staleError(row.name, currentOf(grants, row.name));
  }
  const submitted = await submitCommand<GrantOutcome>(ctx, {
    ledger: "workspace",
    effect: async (receipt) => {
      const outcome = await grantPlugin(ctx.deps.hangarRoot, {
        row,
        grant: input,
        by: receipt.actor,
        cmd: receipt.id,
        now: ctx.deps.now,
      });
      return { settle: settleOf(outcome), value: outcome };
    },
  });
  const outcome = submitted.value;
  const refused =
    outcome === undefined ? undefined : refusalAfter(row.name, outcome, submitted.receipt);
  if (refused !== undefined) throw refused;
  return acceptedAnswer(
    submitted,
    outcome?.ok === true ? { grant: { id: outcome.id, gen: outcome.gen } } : {},
  );
};

const revoke: V1Handler = async (ctx) => {
  const grants = grantsOf(ctx);
  const row = pluginOf(ctx, grants);
  if (liveGrantOf(grants, row.name) === undefined) throw noLiveGrant(row.name);
  const submitted = await submitCommand<GrantOutcome>(ctx, {
    ledger: "workspace",
    effect: async (receipt) => {
      const outcome = await revokePlugin(ctx.deps.hangarRoot, {
        plugin: row.name,
        by: receipt.actor,
        cmd: receipt.id,
        now: ctx.deps.now,
      });
      return { settle: settleOf(outcome), value: outcome };
    },
  });
  const outcome = submitted.value;
  const refused =
    outcome === undefined ? undefined : refusalAfter(row.name, outcome, submitted.receipt);
  if (refused !== undefined) throw refused;
  return acceptedAnswer(submitted);
};

export const PLUGIN_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "plugins.review": review,
  "plugins.grant": grant,
  "plugins.revoke": revoke,
};
