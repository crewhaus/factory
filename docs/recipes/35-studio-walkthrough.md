# Recipe 35 — Studio Walkthrough

> **Status:** stub.

## What you'll learn

End-to-end use of Studio — the local web UI for browsing specs,
running the wizard, visualizing graphs with live state coloring,
replaying traces, and managing community plugins.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. Starting Studio: `bun run studio` (default port 4187, override via `STUDIO_PORT`). Workspace defaults to `<cwd>/.crewhaus/studio-specs`.
2. The Specs tab — list / view / create / edit specs in the workspace.
3. The Wizard — 5 questions (target → name → model → tools → permission mode), patches the matching scaffold-template with your answers, drops a `.env.example` listing every `$VAR_NAME`.
4. The Run viewer — POST `/api/runs` returns a runId; SSE-stream `/api/runs/:runId/events` for live trace events; click any span for drilldown.
5. Cancel and HITL — `POST /api/runs/:runId/cancel` signals the AbortSignal; `POST /api/runs/:runId/hitl?nodeId=&decision=` pushes a graph HITL decision.
6. Cost summary — `GET /api/cost-summary?tenant=&from=&to=` against the cost-tracker aggregator.
7. Graph layouts — `GET /api/graph-layout/:specName` returns a deterministic SVG layout. Live coloring via `applyEvent(state, event)`.
8. Plugins — sandboxed third-party plugins from `~/.crewhaus/plugins/`. Path-only sandboxing today; full content isolation arrives in v1.3.
9. Multi-spec dashboard — `renderMultiSpecDashboard(rows)` shows per-spec cost, pass-rate, p50/p95 latency.

## Run it now

```bash
bun run studio
# Then open http://localhost:4187/ in a browser.
```

## Pointers to existing material

- **Modules:** [`packages/studio-server`](../../packages/studio-server), [`packages/studio-ui`](../../packages/studio-ui), [`packages/wizard`](../../packages/wizard), [`packages/scaffold-templates`](../../packages/scaffold-templates), [`packages/trace-viewer`](../../packages/trace-viewer), [`packages/graph-visualizer`](../../packages/graph-visualizer), [`packages/plugin-sdk`](../../packages/plugin-sdk).
- **Launcher:** [`scripts/studio-launcher.ts`](../../scripts/studio-launcher.ts).
- **Catalog:** §26, §31.

## Where to go next

- For VS Code / JetBrains parity → [Recipe 25 — VS Code and JetBrains](25-vscode-and-jetbrains.md).
- For the public template marketplace Studio surfaces → [Recipe 26 — Template Marketplace](26-template-marketplace.md).
