/**
 * Work: what this harness has done and is doing. Rows as in `overview.js`.
 * `capture` names the typed fields the trailing segments fill, in order, and
 * `deep` puts the captured form in the route templates the gate sweeps.
 */

export const WORK = Object.freeze({
  id: "work",
  label: "Work",
  describe: "What this harness has done, what it is doing, and when it runs next.",
  index: null,
  // biome-ignore format: one row per line, so an area appends its row without touching the shell
  views: Object.freeze([
    { id: "runs", label: "Runs", describe: "Every run it has made, and a live view of one.", load: () => import("../views/runs.js"), render: (m, root, ctx) => m.renderRuns(root, ctx), capture: ["runId"], deep: true },
    { id: "schedule", label: "Schedule", describe: "Work it starts on its own, and when that runs next.", load: () => import("../views/schedulers.js"), render: (m, root, ctx) => m.renderSchedulers(root, ctx), gate: { shapes: ["cli", "channel", "managed", "crew", "research", "batch", "voice"], why: "no lane can arm here — this target's schema admits no heartbeat:, schedule: or memory.dream: block, and its bundle runs no janitor" } },
    { id: "sessions", label: "Sessions", describe: "Conversations it has had, each with its full transcript.", load: () => import("../views/sessions.js"), render: (m, root, ctx) => m.renderSessions(root, ctx), capture: ["sessionId"], deep: true },
  ]),
});
