/**
 * One verb the command menu can propose for a harness: the route the
 * console calls after the operator confirms, the command that does the same
 * in a terminal, and how the proposal reads. An area adds its verbs as a
 * provider file beside `daemon.ts` and one line in `index.ts`.
 */
export type MenuActionProvider = {
  /** The first word of a query that proposes it (`start polymarket`). */
  readonly verb: string;
  /** The `routes.js` map entry the console calls after the confirm. */
  readonly route: string;
  /** The exact command that does the same thing in a terminal. */
  readonly cli: (dir: string) => string;
  readonly label: (name: string) => string;
};
