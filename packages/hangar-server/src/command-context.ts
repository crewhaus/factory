/**
 * The command a receipted request runs for, held for the length of the request: the jobs it
 * queues carry its id, who submitted it and the permissions the request needed. A leaf
 * module, so a handler module can note a permission without importing the router.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type CommandContext = {
  readonly commandId: string;
  readonly by: string;
  /** Jobs this request queued. */
  jobs: number;
  /** The permissions this request needed beyond its route's, in the order first asked. */
  readonly needs: string[];
};

export const commandContext = new AsyncLocalStorage<CommandContext>();

/**
 * The command the current request runs for, for a job it queues: `{commandId, by}`, plus
 * `needs` when the request needed permissions beyond its route's, or nothing outside a
 * receipted request. Spread into the queue's submit, so the job starts only while every one
 * of them still holds.
 */
export function commandFields(): {
  readonly commandId?: string;
  readonly by?: string;
  readonly needs?: readonly string[];
} {
  const context = commandContext.getStore();
  if (context === undefined) return {};
  context.jobs += 1;
  return {
    commandId: context.commandId,
    by: context.by,
    ...(context.needs.length > 0 ? { needs: [...context.needs] } : {}),
  };
}

/**
 * Note a permission the current request needed, on its own target, beyond its route's: a
 * job it queues afterwards is checked for it again before it starts. Nothing outside a
 * receipted request.
 */
export function noteNeed(permission: string): void {
  const context = commandContext.getStore();
  if (context !== undefined && !context.needs.includes(permission)) context.needs.push(permission);
}

/** The command the current request runs for, read only (it queues nothing). */
export function currentCommand(): { readonly commandId: string; readonly by: string } | undefined {
  const context = commandContext.getStore();
  return context === undefined ? undefined : { commandId: context.commandId, by: context.by };
}
