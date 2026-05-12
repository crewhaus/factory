# Recipe 35 — Studio Walkthrough

End-to-end use of Studio — the local web UI for browsing specs,
running the spec wizard, visualizing graphs with live state coloring,
replaying traces, and managing community plugins.

You'd use Studio when:

- You prefer **GUI-driven** spec authoring to handwriting YAML.
- You want **visual trace timelines** instead of `jq` over JSONL.
- You're doing **interactive HITL** (graph approvals through a web UI).
- You're **demoing** to teammates and the CLI is the wrong surface.

For day-to-day development, the CLI + editor plugins are usually
faster. Studio shines for onboarding, demos, and operations.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for what
  a spec is.

## Starting Studio

```bash
bun run studio
```

Default port 4187. Override:

```bash
STUDIO_PORT=8080 bun run studio
```

Workspace defaults to `<cwd>/.crewhaus/studio-specs/` — every spec
authored in Studio lives here. Override:

```bash
STUDIO_WORKSPACE=/path/to/my/specs bun run studio
```

Open `http://localhost:4187/` in a browser. The landing page shows
the Specs tab.

## The Specs tab

Lists every spec in the workspace. Each row shows:

- Name + target shape (cli / channel / managed / ...).
- Last modified.
- Status (compiled / not compiled / outdated).
- Quick actions: **Edit**, **Run**, **Compile**, **Delete**.

Click a name to open the spec editor — a syntax-highlighted YAML
editor with the same JSON Schema validation the IDE plugins use
([Recipe 25](25-vscode-and-jetbrains.md)). Saves auto-format on Cmd+S
/ Ctrl+S.

## The Wizard

The Wizard creates a spec in 5 questions:

1. **Target shape.** cli / channel / managed / graph / pipeline / ...
2. **Name.** Display name; lowercased and slugified for the directory.
3. **Model.** Dropdown of recent models, or type-your-own.
4. **Tools.** Multi-select from the standard catalog.
5. **Permission mode.** default / plan / auto.

When the user submits, the wizard:

1. Picks the matching template from
   [`packages/scaffold-templates`](../../packages/scaffold-templates).
2. Patches it with the user's answers.
3. Writes the spec into the workspace.
4. Drops a `.env.example` listing every `$VAR_NAME` the spec references.

The user lands in the spec editor with the new spec open. Total time:
~30 seconds.

## The Run viewer

Click **Run** on a spec → Studio:

1. POSTs to `/api/runs` with the spec name.
2. Receives `{ runId }`.
3. Opens the Run viewer, which SSE-streams `/api/runs/:runId/events`.

The viewer renders events as they arrive:

- **User messages** as right-aligned bubbles.
- **Assistant messages** with markdown rendering.
- **Tool calls** as collapsed cards (click to expand args + output).
- **Errors** highlighted in red.
- **Compaction** as gray bars with token deltas.

Each span shows its duration. Click any span → drilldown panel with
the raw event JSON.

For long-running daemons (channel / managed), the Run viewer also
exposes:

- **Cancel.** `POST /api/runs/:runId/cancel` signals the AbortSignal.
- **HITL.** For graph runs paused at HITL,
  `POST /api/runs/:runId/hitl?nodeId=&decision=` pushes the decision.

The cancel + HITL endpoints make the daemon controllable from the
web UI without touching the CLI.

## Cost summary

A dashboard tile aggregates spend:

```
GET /api/cost-summary?tenant=&from=&to=
```

Backed by [`packages/cost-tracker`](../../packages/cost-tracker).
Shows per-tenant, per-model, per-tool cost over a date range. The
default view is "this month, all tenants" — drill into one tenant
for a per-call breakdown.

For multi-tenant deployments ([Recipe 11](11-managed-multitenant.md)),
the cost summary is the natural billing dashboard. For single-tenant
CLIs, it's the "how much did I spend today" view.

## Graph layouts

For `target: graph` specs, Studio renders the graph as SVG:

```
GET /api/graph-layout/:specName
```

The layout is **deterministic** (same spec → same SVG). Nodes are
placed by topological order; edges route around nodes.

When a graph runs, Studio applies `applyEvent(state, event)` to
update the SVG **live**:

- Active node: highlighted blue.
- Completed node: green check.
- HITL paused node: yellow with a "Decide" button.
- Failed node: red.

Click a node mid-run to see its current state JSON.

## Trace replay

The Trace tab opens past sessions. Pick a session id (or paste
from CLI output), and the replay engine walks the JSONL:

- **Speed control.** `raw` / 1× / 2× / 4× (see [Recipe 31](31-session-resume-and-replay.md)).
- **Step controls.** Play / pause / step-forward.
- **Search.** Find tool calls by name.

The same replay engine powers the IDE plugins' webview ([Recipe 25](25-vscode-and-jetbrains.md)) —
opening a trace from VS Code lands in this Studio panel.

## Plugins

Studio is extensible via plugins from `~/.crewhaus/plugins/`:

```
~/.crewhaus/plugins/
  my-plugin/
    package.json
    plugin.json
    index.ts
    ui.tsx
```

`plugin.json` declares the plugin's name, version, and which Studio
hooks it taps:

- `spec-editor-toolbar` — add a button to the spec editor toolbar.
- `run-viewer-sidebar` — add a panel to the run viewer.
- `dashboard-tile` — add a card to the dashboard.

`index.ts` exports the plugin's server-side logic; `ui.tsx` is the
React component.

### Sandboxing

Today's plugin sandbox is **path-only**: plugins can only read/write
under their own directory. Full content isolation (worker-based,
restricted imports) arrives in v1.3.

For untrusted plugins, the contract is "review the code before
installing" — this is a single-user system today, not a
plugins-from-strangers marketplace.

## Multi-spec dashboard

The dashboard view runs `renderMultiSpecDashboard(rows)` to show:

| Column        | Source                                                              |
| ------------- | ------------------------------------------------------------------- |
| Spec name      | spec-registry                                                       |
| Last run       | session-store mtime                                                 |
| Pass rate      | eval-runner's most recent result                                    |
| Cost (24h)     | cost-tracker aggregate                                              |
| p50 latency    | trace-event-bus rollup                                              |
| p95 latency    | trace-event-bus rollup                                              |
| Status         | red / yellow / green based on threshold deltas                       |

Useful as the "single pane of glass" for a small fleet of specs.
For larger fleets (10+ specs), grafana / OTel exporters
([Recipe 17](17-observability.md)) scale better.

## Public marketplace integration

Studio's Marketplace tab embeds the
[`MarketplaceClient`](../../packages/template-marketplace-client):

- Browse public templates.
- Search by query / target / author.
- Click **Install** → drops the template into the workspace.
- Click **Publish** (on a workspace spec) → signs + opens a PR.

See [Recipe 26](26-template-marketplace.md) for the protocol details.

## Operating tips

- **Workspace isolation.** Studio writes only under
  `<cwd>/.crewhaus/studio-specs/`. So you can run Studio against
  a project without polluting the rest of the repo.
- **Headless mode.** `STUDIO_HEADLESS=1` runs the API without the
  UI bundle. Useful when embedding Studio's APIs in another tool.
- **HTTPS.** Studio listens on HTTP by default. For remote use,
  reverse-proxy behind nginx/caddy for TLS.
- **Auth.** Studio has **no authentication** by default — assume
  the host is trusted. For shared deployments, put a basic-auth proxy
  in front or use the managed gateway ([Recipe 11](11-managed-multitenant.md)).

## Running the smokes

```bash
bun run smoke:section-35-playground
```

Validates the studio-server + studio-ui + wizard end-to-end against
a fixture workspace. Doesn't open a browser; checks the API surface
plus the SSR-rendered HTML for key UI strings.

## Things that look like Studio but aren't

| Symptom                                                          | Better tool                                       |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| You're authoring specs by typing YAML.                           | CLI + IDE plugin ([Recipe 25](25-vscode-and-jetbrains.md)). |
| You're tailing logs in production.                                | OTel + grafana ([Recipe 17](17-observability.md)). |
| You're shipping a customer-facing UI.                             | Build your own — Studio is internal tooling.       |
| You want CLI-equivalent automation.                               | `crewhaus` CLI directly.                            |

## What to read next

- **VS Code / JetBrains parity.** [Recipe 25 — VS Code and JetBrains](25-vscode-and-jetbrains.md).
- **The marketplace Studio embeds.** [Recipe 26 — Template Marketplace](26-template-marketplace.md).
- **Session resume / replay.** [Recipe 31 — Session Resume and Replay](31-session-resume-and-replay.md).

## Pointers to source

- **Server:** [`packages/studio-server`](../../packages/studio-server).
- **UI:** [`packages/studio-ui`](../../packages/studio-ui).
- **Wizard:** [`packages/wizard`](../../packages/wizard).
- **Scaffolds:** [`packages/scaffold-templates`](../../packages/scaffold-templates).
- **Trace viewer:** [`packages/trace-viewer`](../../packages/trace-viewer).
- **Graph visualizer:** [`packages/graph-visualizer`](../../packages/graph-visualizer).
- **Plugin SDK:** [`packages/plugin-sdk`](../../packages/plugin-sdk).
- **Launcher:** [`scripts/studio-launcher.ts`](../../scripts/studio-launcher.ts).
- **Module catalog reference:** §26, §31 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
