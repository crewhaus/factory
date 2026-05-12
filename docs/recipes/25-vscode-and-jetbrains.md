# Recipe 25 — VS Code and JetBrains

Author specs in your editor with autocomplete + lint, run an agent
without leaving the editor, hover over a sub-agent reference to see
its frontmatter, and open a trace timeline as a Studio webview.

You'd reach for the editor plugins when:

- You're authoring specs as a **daily activity** — autocomplete
  shaves real time off iteration.
- You want **inline trace navigation** — click a tool call in the
  JSONL log and jump to its line.
- Your team has a strong **IDE convention** (everyone on JetBrains;
  everyone on VS Code) and CLI-first onboarding is friction.

For one-off spec authoring, a YAML linter pointed at the bundled
schema is enough.

## Prerequisites

- VS Code, or any JetBrains IDE that supports the YAML plugin
  (IntelliJ, WebStorm, PyCharm, GoLand, Rider, etc.).

## The shared JSON Schema

Both plugins consume the same JSON Schema (Draft-07) at
[`packages/vscode-extension/schemas/spec.json`](../../packages/vscode-extension/schemas/spec.json).
The schema covers all 12 target shapes via a `discriminator: target`
union.

This is the source of truth for editor validation — when the spec
schema in [`packages/spec`](../../packages/spec) gains a field, the
JSON Schema must be regenerated. The drift test:

```bash
bun test packages/vscode-extension
```

runs `schemaCoversAllTargetShapes()` and fails if a new target shape
landed in `packages/spec` without a corresponding union member in
the JSON Schema.

## VS Code

[`packages/vscode-extension`](../../packages/vscode-extension)
registers:

| Surface              | Behavior                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| Language id          | `crewhaus-spec` for `crewhaus.yaml` files.                              |
| Commands             | `crewhaus.runSpec`, `crewhaus.openTrace`, `crewhaus.compileSpec`.        |
| Settings             | `crewhaus.cliPath`, `crewhaus.studioUrl`, `crewhaus.runCommandPrefix`.   |
| Hover cards          | Sub-agent references render the sub-agent's frontmatter on hover.        |
| Webview              | "Open trace" opens a Studio panel in a side webview.                    |

### Installing (dev mode)

```bash
cd packages/vscode-extension
bun install
bun run build
# Press F5 in VS Code → "Extension Development Host" window opens with the extension loaded.
```

For team distribution:

```bash
cd packages/vscode-extension
bunx vsce package        # produces crewhaus-spec-<version>.vsix
```

Drop the `.vsix` into a private extension gallery, or publish to the
marketplace (see "Marketplace publishing" below).

### Running a spec from the editor

Right-click on `crewhaus.yaml` → **CrewHaus: Run Spec**.

The command:

1. Reads `crewhaus.cliPath` (default: `crewhaus`).
2. Runs `<cliPath> compile <spec> && <cliPath> run <spec>`.
3. Streams stdout/stderr into a "CrewHaus" output channel.

Tracing flag:

- `crewhaus.runCommandPrefix: "CREWHAUS_TRACE=pretty"` (default empty).

### Sub-agent hover cards

Hovering over a sub-agent name in `agent.sub_agents:` or `tools.task:`
resolves the file:

```
.crewhaus/sub-agents/<name>.md
```

`resolveSubAgentDefinition(name)` parses the frontmatter:

```markdown
---
name: code-reviewer
description: Review a PR for correctness, security, and style.
tools: [read, grep, bash]
---

Code-review procedure body...
```

The hover renders `name` + `description` + tool list. The body is
not shown (too long for a hover) — use **Go to Definition** to jump
to the file.

**Path traversal:** `resolveSubAgentDefinition` rejects names
containing `/`, `..`, or null bytes — same as the runtime resolver.

## JetBrains

[`packages/jetbrains-plugin`](../../packages/jetbrains-plugin) plugs
into the JetBrains YAML plugin's JSON Schema integration:

| Surface                 | Behavior                                                              |
| ----------------------- | --------------------------------------------------------------------- |
| Schema provider          | `CrewhausSpecSchemaProviderFactory` registers `spec.json` for `*/crewhaus.yaml`. |
| Run configurations       | `RunSpec`, `RunEval`, `RunCanary` (three types).                       |
| Tool window              | `CrewHaus Spec Registry` browses `.crewhaus/specs/`.                   |
| Action: Run Spec         | Right-click → CrewHaus → Run Spec.                                     |
| Action: Open Trace       | Right-click on a `sess_*.jsonl` → CrewHaus → Open Trace.               |

### Installing (dev mode)

```bash
cd packages/jetbrains-plugin
# Requires JBR_BIN pointing at a JetBrains Runtime install:
JBR_BIN=/path/to/jbr ./gradlew runIde
```

An IDE window opens with the plugin loaded.

### Building a distributable

```bash
cd packages/jetbrains-plugin
JBR_BIN=/path/to/jbr ./gradlew buildPlugin
# → build/distributions/crewhaus-jetbrains-<version>.zip
```

The Gradle build is **gated on `JBR_BIN`** so unit-level CI (which
doesn't carry JetBrains Runtime) stays green; only the
`smoke:section-35-jetbrains` job runs the full build.

## Run configurations (JetBrains)

Three configuration types:

| Type         | Runs                                            | Parameters                                  |
| ------------ | ----------------------------------------------- | ------------------------------------------- |
| `RunSpec`    | `crewhaus compile <spec> && crewhaus run <spec>` | Spec path, env vars                          |
| `RunEval`    | `crewhaus eval <spec> --dataset <name>`          | Spec path, dataset name, concurrency        |
| `RunCanary`  | `crewhaus canary auto-rollout <name> --steps ...` | Spec name, weight steps, gate thresholds |

Each is template-able and persists into the project's
`.idea/runConfigurations/*.xml`.

## Trace timeline webview

Both plugins open trace JSONL in a **webview** that points at Studio
([Recipe 35](35-studio-walkthrough.md)):

```
<studioUrl>/trace?session=<sessionId>
```

Default `crewhaus.studioUrl: "http://localhost:7325"`. If you run
Studio remote (cluster-hosted Studio), set this to the public URL.

Webview vs external browser: the webview embeds Studio's React UI
**inside** the IDE pane, so the timeline opens next to the spec it
came from. Click → external browser → same URL works too.

## Marketplace publishing

Both plugins ship to public marketplaces:

| Marketplace                  | Push command                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| VS Code Marketplace          | `vsce publish --pat $VSCE_PAT`                                            |
| Open VSX (open-source)       | `ovsx publish *.vsix --pat $OVSX_PAT`                                     |
| JetBrains Marketplace        | `./gradlew publishPlugin -Pcrewhaus.jetbrains.token=$JETBRAINS_TOKEN`     |

**Tokens are read from env** — no credentials are checked in. CI sets
them from GitHub Actions secrets / GitLab CI variables.

## Smoke tests

```bash
bun run smoke:section-35-vscode       # type-checks the extension, packages a .vsix
bun run smoke:section-35-jetbrains    # type-checks the plugin (no JBR_BIN required)
bun run smoke:section-35-playground   # smokes Studio against a synthetic spec
```

For a live JetBrains build (requires JBR_BIN):

```bash
bun run play:jetbrains
```

This is intentionally separate from the unit smokes so the unit tier
stays fast.

## Configuration cheatsheet

VS Code `settings.json` (workspace or user):

```json
{
  "crewhaus.cliPath": "/usr/local/bin/crewhaus",
  "crewhaus.studioUrl": "http://localhost:7325",
  "crewhaus.runCommandPrefix": "CREWHAUS_TRACE=pretty",
  "yaml.schemas": {
    "./packages/vscode-extension/schemas/spec.json": ["**/crewhaus.yaml"]
  }
}
```

JetBrains: settings live under **Languages & Frameworks → CrewHaus**
in the IDE preferences. The plugin auto-registers the schema; the
"yaml.schemas" mapping isn't needed.

## What to read next

- **Browser-based authoring.** [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md)
  — Studio embeds the same trace viewer the IDE plugins call out to.
- **Marketplace of specs the editor can install.** [Recipe 26 — Template Marketplace](26-template-marketplace.md).
- **Building agents in the editor.** [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Pointers to source

- **VS Code extension:** [`packages/vscode-extension`](../../packages/vscode-extension).
- **JetBrains plugin:** [`packages/jetbrains-plugin`](../../packages/jetbrains-plugin).
- **Shared schema:** [`packages/vscode-extension/schemas/spec.json`](../../packages/vscode-extension/schemas/spec.json).
- **Module catalog reference:** §35 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
