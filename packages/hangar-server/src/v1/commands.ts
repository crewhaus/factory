import { isOwnerCaller } from "../access";
/**
 * Command receipts through the API: one receipt, wherever it is kept, and a harness's
 * receipts, newest first, a page at a time over its command ledger. A receipt in Home's
 * own ledger is shown to its own actor and to the owner.
 */
import type { V1Handler } from "./context";
import { V1Error } from "./errors";
import { emptyOf, nextCursor, pagingOf, snapshotCursor } from "./lists";
import { commandLedgerOf, harnessOf, liveDirOf } from "./resolve";

const get: V1Handler = async (ctx) => {
  const id = String(ctx.params["cmd"]);
  const found = commandLedgerOf(ctx.deps, id, ctx.query["harness"]);
  const missing = new V1Error({
    status: 404,
    code: "not_found",
    reason: "command_unknown",
    message: "No command has that id here.",
  });
  if (found === undefined) throw missing;
  if (found.harness === undefined) {
    const caller = ctx.access.caller;
    const own = found.receipt.actor === caller.principal;
    if (!own && !isOwnerCaller(caller, ctx.deps.home.signIn.snapshot())) throw missing;
  }
  return { status: 200, body: found.receipt };
};

const list: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  const paging = pagingOf(ctx.query, "commands");
  if (dir === undefined) {
    return {
      status: 200,
      body: {
        items: [],
        snapshotAt: snapshotCursor("commands", []),
        empty: { reason: "unreachable", remedy: "The harness folder is missing." },
      },
    };
  }
  const page = ctx.deps.control.commands.list(
    { harness: dir },
    { limit: paging.limit, ...(paging.before !== undefined ? { before: paging.before } : {}) },
  );
  return {
    status: 200,
    body: {
      items: page.items,
      ...(page.next !== undefined ? { next: nextCursor("commands", page.next) } : {}),
      snapshotAt: snapshotCursor("commands", page.snapshotAt),
      ...(page.gaps.length > 0
        ? {
            truncated: {
              reason: "unreadable_lines",
              verb: `crewhaus commands list --harness ${entry.id}`,
            },
          }
        : {}),
      ...emptyOf(page.items, "no-data", "Nothing has been asked of this harness yet."),
    },
    scrubDir: dir,
  };
};

export const COMMAND_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "commands.get": get,
  "commands.list": list,
};
