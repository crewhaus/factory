/**
 * Setup: what this harness is told to do, what it uses, its limits, where it
 * runs, and its stored files. Rows as in `overview.js`; `group` heads the
 * list a row is drawn in, in the order the groups first appear.
 */

import { stack } from "./stack.js";

export const SETUP = Object.freeze({
  id: "setup",
  label: "Setup",
  describe: "What it is told to do, what it uses, its limits and where it runs.",
  index: null,
  // biome-ignore format: one row per line, so an area appends its row without touching the shell
  views: Object.freeze([
    { id: "spec", label: "Spec", group: "What it does", describe: "Its settings file, with every change and earlier version.", load: () => Promise.all([import("../views/spec.js"), import("../views/spec-edit.js")]), render: async ([spec, edit], root, ctx) => { await spec.renderSpec(root, ctx); await edit.renderSpecEdit(stack(root), ctx); } },
    { id: "tools", label: "Tools", group: "What it uses", describe: "Its tools, the MCP servers it connects to, and the dev server.", load: () => import("../views/runtime.js"), render: (m, root, ctx) => m.renderRuntime(root, ctx), rest: true },
    { id: "models", label: "Models", group: "What it uses", describe: "Which models it uses, and how it picks between them.", load: () => import("../views/models.js"), render: (m, root, ctx) => m.renderModels(root, ctx), rest: true },
    { id: "channels", label: "Channels", group: "What it uses", describe: "Where people reach it, such as a chat workspace.", load: () => import("../views/channels.js"), render: (m, root, ctx) => m.renderChannels(root, ctx), rest: true, gate: { shapes: ["channel"], why: "a channels: block (with its routing and gateway) is only valid in a channel spec" } },
    { id: "credentials", label: "Credentials", group: "What it uses", describe: "The keys and accounts it needs. Values are never shown.", load: () => import("../views/creds.js"), render: (m, root, ctx) => m.renderCreds(root, ctx), rest: true },
    { id: "plugins", label: "Plugins", group: "What it uses", describe: "Panels that installed plugins add for it.", load: () => import("../views/panes.js"), render: (m, root, ctx) => m.renderPanes(root, ctx) },
    { id: "security", label: "Security", group: "Limits", describe: "What it may do on its own, and the checks that guard it.", load: () => import("../views/security.js"), render: (m, root, ctx) => m.renderSecurity(root, ctx), rest: true },
    { id: "budget", label: "Budget", group: "Limits", describe: "What it has spent, by model and by day.", load: () => import("../views/costs.js"), render: (m, root, ctx) => m.renderCosts(root, ctx) },
    { id: "deployment", label: "Deployment", group: "Where it runs", describe: "Where it is deployed, and whether that is healthy.", load: () => import("../views/deploy.js"), render: (m, root, ctx) => m.renderDeploy(root, ctx) },
    { id: "files", label: "Files", group: "Advanced", describe: "Its stored records, read straight from disk.", load: () => import("../views/inspect.js"), render: (m, root, ctx) => m.renderInspect(root, ctx), rest: true },
  ]),
});
