# Recipe 25 — VS Code and JetBrains

> **Status:** stub.

## What you'll learn

Author specs in your editor with autocomplete + lint, run an agent
without leaving the editor, hover over a sub-agent reference to see
its frontmatter, and open a trace timeline as a Studio webview.

## Prerequisites

- VS Code, or any JetBrains IDE that supports the YAML plugin (IntelliJ, WebStorm, PyCharm, …).

## Roadmap

1. The shared JSON Schema (Draft-07) at `packages/vscode-extension/schemas/spec.json` — covers all 12 target shapes via discriminated union.
2. The drift test: `schemaCoversAllTargetShapes()` catches a new target shape that didn't update the extension's schema.
3. VS Code: registers `crewhaus-spec` language for `crewhaus.yaml`, `crewhaus.runSpec` + `crewhaus.openTrace` commands, settings (`crewhaus.cliPath`, `crewhaus.studioUrl`).
4. Sub-agent hover-cards: `resolveSubAgentDefinition(...)` parses `.crewhaus/sub-agents/<name>.md` frontmatter; sanitizes the name to block path traversal.
5. JetBrains: `CrewhausSpecSchemaProviderFactory` plugs the same schema into the JetBrains YAML plugin's JSON Schema integration; three configuration types (`RunSpec` / `RunEval` / `RunCanary`); `CrewHaus Spec Registry` tool window.
6. Build pipeline: VS Code `vsce package`; JetBrains `gradle buildPlugin` (gated on `JBR_BIN` so the workspace test layer stays green without JetBrains Runtime).
7. Marketplace publishing — env-sourced tokens, no checked-in credentials.

## Run it now

```bash
bun run smoke:section-35-vscode
bun run smoke:section-35-jetbrains
# Live JetBrains build (requires JBR_BIN):
bun run play:jetbrains
```

## Pointers to existing material

- **Modules:** [`packages/vscode-extension`](../../packages/vscode-extension), [`packages/jetbrains-plugin`](../../packages/jetbrains-plugin).
- **Catalog:** §35.

## Where to go next

- For the browser-based playground → [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md) (Studio embeds the same trace viewer the IDE plugins call out to).
- For the template marketplace your IDE plugin can browse → [Recipe 26 — Template Marketplace](26-template-marketplace.md).
