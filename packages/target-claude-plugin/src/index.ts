/**
 * Track H (§59) — `target-claude-plugin`. Emits an Anthropic-compatible
 * Claude Code plugin directory from any CrewHaus IR variant.
 *
 * Source: claude-plugins-official (Anthropic's reference repo at
 * github.com/anthropics/claude-code-plugins). Anthropic's reference
 * plugin format is intentionally minimal:
 *
 *   plugin-name/
 *   ├── .claude-plugin/
 *   │   └── plugin.json       # required: name, description, author
 *   ├── .mcp.json             # optional, MCP server config
 *   ├── skills/<name>/SKILL.md
 *   ├── agents/<name>.md      # optional sub-agent definitions
 *   ├── commands/<name>.md    # optional legacy slash entries
 *   └── README.md             # documentation
 *
 * The emitter is shape-aware:
 *
 *   - `cli` / `channel` / `managed` / `pipeline` / `research` / `batch` /
 *     `voice` / `browser` / `eval` / `onchain` / `onchain-game` →
 *     produce a single SKILL.md derived from agent.instructions, plus
 *     sub-agent .md files for each declared sub-agent.
 *   - `workflow` → one SKILL.md per step.
 *   - `graph` → one SKILL.md per node, plus a top-level SKILL.md naming
 *     the entry node.
 *   - `crew` → one agent .md per role; the entry role becomes the
 *     primary SKILL.md.
 *
 * On top of that PROJECTION, `opts.assets` carries the harness's
 * AUTHORED surface — the `.crewhaus/skills/**` and `.crewhaus/commands/*.md`
 * files the user hand-wrote — through verbatim, so an exported plugin is
 * not a strictly smaller agent than the harness it came from. The caller
 * reads them (this package still does no I/O) and they override a
 * synthesized file at the same path.
 *
 * This is a strict-emission package: no I/O, returns a `Bundle` of
 * files for the caller (the CLI) to write to disk. Pure functions.
 *
 * See Track H of the §55–§59 batch in factory/CHANGELOG.md.
 */
import { CrewhausError } from "@crewhaus/errors";
import {
  type IrChannelV0,
  type IrCrewV0,
  type IrEvalV0,
  type IrGraphV0,
  type IrManagedV0,
  type IrMcpServers,
  type IrNode,
  type IrPipelineV0,
  type IrResearchV0,
  type IrSecretRef,
  type IrV0,
  type IrWorkflowV0,
  renderBundleReadme,
} from "@crewhaus/ir";

export class TargetClaudePluginError extends CrewhausError {
  override readonly name = "TargetClaudePluginError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

export type PluginFile = {
  readonly path: string;
  readonly content: string;
};

export type PluginBundle = {
  readonly files: ReadonlyArray<PluginFile>;
};

export type EmitClaudePluginOptions = {
  /** Plugin author (required by Anthropic's minimal schema). */
  readonly author: {
    readonly name: string;
    readonly email?: string;
  };
  /**
   * Optional human-readable description; defaults to the IR's name + target.
   * Anthropic recommends 1-2 sentences describing trigger conditions.
   */
  readonly description?: string;
  /**
   * Item 14 — the harness's AUTHORED assets, already read from the
   * `.crewhaus/` workspace by the caller (this package does no I/O) and
   * addressed at their plugin-relative destination: `skills/<name>/SKILL.md`
   * (plus anything else under the skill dir) and `commands/<name>.md`.
   *
   * Without these, an export of a spec whose harness ships hand-written
   * skills + slash commands emitted only the ONE skill synthesized from
   * `agent.instructions` and no `commands/` dir at all — the plugin was a
   * strictly smaller agent than the harness it came from.
   *
   * Merged AFTER the synthesized files and overriding them on a path
   * collision: a hand-authored `skills/<ir.name>/SKILL.md` is the author's
   * explicit intent and beats the projection of `agent.instructions`.
   */
  readonly assets?: ReadonlyArray<PluginFile>;
};

/**
 * Main entry. Returns a `PluginBundle` of files; the caller writes
 * them to disk under the chosen plugin directory.
 */
export function emitClaudePlugin(ir: IrNode, opts: EmitClaudePluginOptions): PluginBundle {
  const description = opts.description ?? defaultDescription(ir);
  const pluginJson = renderPluginJson(ir.name, description, opts.author);
  const files: PluginFile[] = [{ path: ".claude-plugin/plugin.json", content: pluginJson }];

  // MCP servers — only emitted for variants that carry them in IR.
  const mcp = renderMcpJson(ir);
  if (mcp !== undefined) {
    files.push({ path: ".mcp.json", content: mcp });
  }

  // Per-variant skill + agent emission.
  switch (ir.target) {
    case "cli":
      files.push(...emitCliShape(ir as IrV0));
      break;
    case "workflow":
      files.push(...emitWorkflowShape(ir as IrWorkflowV0));
      break;
    case "channel":
      files.push(...emitChannelShape(ir as IrChannelV0));
      break;
    case "graph":
      files.push(...emitGraphShape(ir as IrGraphV0));
      break;
    case "crew":
      files.push(...emitCrewShape(ir as IrCrewV0));
      break;
    case "managed":
      files.push(...emitGenericAgentShape(ir as IrManagedV0, ir.target));
      break;
    case "pipeline":
      files.push(...emitGenericAgentShape(ir as IrPipelineV0, ir.target));
      break;
    case "research":
      files.push(...emitGenericAgentShape(ir as IrResearchV0, ir.target));
      break;
    case "eval":
      files.push(...emitEvalShape(ir as IrEvalV0));
      break;
    case "batch":
    case "voice":
    case "browser":
    case "onchain":
    case "onchain-game":
      files.push(...emitGenericAgentShape(ir, ir.target));
      break;
    default:
      throw new TargetClaudePluginError(
        `unsupported IR target for claude-plugin emission: ${(ir as { target: string }).target}`,
      );
  }
  // Rendered after the switch so an unsupported target fails with the
  // typed TargetClaudePluginError above, not a renderer error over a
  // malformed variant; inserted at index 1 to keep the historical
  // plugin.json → README.md → … file order.
  const assets = opts.assets ?? [];
  files.splice(1, 0, { path: "README.md", content: renderReadme(ir, description, assets) });
  return { files: mergeAssets(files, assets) };
}

/**
 * Append the caller-supplied authored assets to the synthesized files,
 * deduping by path: an asset that collides with a synthesized file REPLACES
 * it in place (author beats projection) instead of appending a second entry
 * for the same path — the CLI writes the bundle file-by-file and reports
 * `files.length`, so a duplicate path would silently inflate that count.
 */
function mergeAssets(
  files: ReadonlyArray<PluginFile>,
  assets: ReadonlyArray<PluginFile>,
): PluginFile[] {
  const merged: PluginFile[] = [];
  const indexByPath = new Map<string, number>();
  for (const file of [...files, ...assets]) {
    const at = indexByPath.get(file.path);
    if (at === undefined) {
      indexByPath.set(file.path, merged.length);
      merged.push(file);
    } else {
      merged[at] = file;
    }
  }
  return merged;
}

/**
 * The `Authored assets` README section — names the skills and slash commands
 * carried verbatim out of the harness's `.crewhaus/` workspace, so a reader of
 * the emitted plugin can tell hand-written surface from the projection of
 * `agent.instructions`. Returns `undefined` when nothing was carried.
 */
function renderAssetsSection(
  assets: ReadonlyArray<PluginFile>,
): { readonly heading: string; readonly body: string } | undefined {
  if (assets.length === 0) return undefined;
  const skills = new Set<string>();
  const commands = new Set<string>();
  for (const asset of assets) {
    const skill = asset.path.match(/^skills\/([^/]+)\//);
    if (skill?.[1] !== undefined) {
      skills.add(skill[1]);
      continue;
    }
    const command = asset.path.match(/^commands\/([^/]+)\.md$/);
    if (command?.[1] !== undefined) commands.add(command[1]);
  }
  const lines = ["Carried verbatim from the harness's `.crewhaus/` workspace:", ""];
  if (skills.size > 0) {
    lines.push(`- Skills: ${[...skills].map((s) => `\`${s}\``).join(", ")}`);
  }
  if (commands.size > 0) {
    lines.push(`- Commands: ${[...commands].map((c) => `\`/${c}\``).join(", ")}`);
  }
  return { heading: "Authored assets", body: lines.join("\n") };
}

function defaultDescription(ir: IrNode): string {
  return `${ir.name} — CrewHaus ${ir.target} agent compiled to Claude Code plugin format.`;
}

function renderPluginJson(
  name: string,
  description: string,
  author: EmitClaudePluginOptions["author"],
): string {
  const obj = {
    name,
    description,
    author: {
      name: author.name,
      ...(author.email !== undefined ? { email: author.email } : {}),
    },
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * Item 42 — the plugin README is now rendered by the shared
 * `renderBundleReadme` in `@crewhaus/ir` (tool table, MCP servers, env
 * vars, literal-secret redaction), with the plugin-specific Origin +
 * Install sections layered on via options. The `.crewhaus/` workspace
 * note is suppressed — a Claude Code plugin has no CrewHaus runtime
 * workspace.
 */
function renderReadme(
  ir: IrNode,
  description: string,
  assets: ReadonlyArray<PluginFile> = [],
): string {
  const assetsSection = renderAssetsSection(assets);
  return renderBundleReadme(ir, {
    description,
    usage: {
      heading: "Install",
      body: "Drop this directory under `~/.claude/plugins/` or your project's `.claude/plugins/`.",
    },
    includeWorkspaceNote: false,
    extraSections: [
      ...(assetsSection !== undefined ? [assetsSection] : []),
      {
        heading: "Origin",
        body: [
          `Generated by CrewHaus \`target-claude-plugin\` from a \`target: ${ir.target}\` spec.`,
          "Format reference: [claude-plugins-official](https://github.com/anthropics/claude-code-plugins).",
        ].join("\n"),
      },
    ],
  });
}

function renderMcpJson(ir: IrNode): string | undefined {
  // Only emit when the IR variant has mcp_servers and it's non-empty.
  const v = ir as { mcp_servers?: IrMcpServers };
  if (v.mcp_servers === undefined) return undefined;
  const entries = Object.entries(v.mcp_servers);
  if (entries.length === 0) return undefined;
  // 0.3.0 — env/header values are IrSecretRef objects. Claude Code's
  // .mcp.json expands `${VAR}` from the environment at load time, so an
  // env ref renders as `${VAR}` (the secret stays out of the artifact and
  // Claude Code resolves it on the user's machine); literals render as
  // their plain string.
  const rendered: Record<string, unknown> = {};
  for (const [name, cfg] of entries) {
    rendered[name] =
      cfg.transport === "stdio"
        ? { ...cfg, ...(cfg.env !== undefined ? { env: renderSecretMap(cfg.env) } : {}) }
        : {
            ...cfg,
            ...(cfg.headers !== undefined ? { headers: renderSecretMap(cfg.headers) } : {}),
          };
  }
  return `${JSON.stringify(rendered, null, 2)}\n`;
}

function renderSecretMap(map: Readonly<Record<string, IrSecretRef>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(map)) {
    out[key] = ref.kind === "env" ? `\${${ref.name}}` : ref.value;
  }
  return out;
}

/**
 * Render a SKILL.md frontmatter block. Anthropic's minimal schema:
 * `name` + `description` required. Optional `argument-hint` makes
 * the skill user-invokable as a slash command.
 */
function renderSkill(opts: {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly argumentHint?: string;
}): string {
  const frontmatter: string[] = ["---", `name: ${opts.name}`, `description: ${opts.description}`];
  if (opts.argumentHint !== undefined) {
    frontmatter.push(`argument-hint: ${opts.argumentHint}`);
  }
  frontmatter.push("---");
  return `${frontmatter.join("\n")}\n\n${opts.body}\n`;
}

function emitCliShape(ir: IrV0): PluginFile[] {
  const files: PluginFile[] = [
    {
      path: `skills/${ir.name}/SKILL.md`,
      content: renderSkill({
        name: ir.name,
        description: firstSentence(ir.agent.instructions) || defaultDescription(ir),
        body: ir.agent.instructions,
      }),
    },
  ];
  for (const sa of ir.subAgents ?? []) {
    files.push({
      path: `agents/${sa.name}.md`,
      content: renderAgent(sa.name, sa.description, sa.instructions),
    });
  }
  return files;
}

function emitWorkflowShape(ir: IrWorkflowV0): PluginFile[] {
  const files: PluginFile[] = [];
  for (const step of ir.steps) {
    files.push({
      path: `skills/${ir.name}-${step.name}/SKILL.md`,
      content: renderSkill({
        name: `${ir.name}-${step.name}`,
        description: `Step ${step.name} of workflow ${ir.name}`,
        body: step.instructions,
      }),
    });
  }
  return files;
}

function emitChannelShape(ir: IrChannelV0): PluginFile[] {
  const files = emitCliShape({
    ...(ir as unknown as IrV0),
    target: "cli",
  } as IrV0);
  // Channel daemons aren't natively claude-plugin-shaped; we emit the
  // skill content but flag the channel context in the README.
  files.push({
    path: "CLAUDE_PLUGIN_NOTES.md",
    content: [
      "# Channel daemon notes",
      "",
      "This plugin was emitted from a `target: channel` spec. The channel " +
        "daemon (Slack/Telegram/Discord/etc.) lifecycle is NOT part of the " +
        "Claude Code plugin runtime — re-deploy the channel separately and " +
        "use this plugin's skills inside Claude Code for design-time work.",
      "",
    ].join("\n"),
  });
  return files;
}

function emitGraphShape(ir: IrGraphV0): PluginFile[] {
  const files: PluginFile[] = [
    {
      path: `skills/${ir.name}/SKILL.md`,
      content: renderSkill({
        name: ir.name,
        description: `Stateful graph; entry node = "${ir.entry}".`,
        body: `Graph nodes: ${ir.nodes.map((n) => n.name).join(", ")}\nEdges: ${ir.edges
          .map((e) => `${e.from}→${e.to}`)
          .join(", ")}`,
      }),
    },
  ];
  for (const node of ir.nodes) {
    files.push({
      path: `skills/${ir.name}-${node.name}/SKILL.md`,
      content: renderSkill({
        name: `${ir.name}-${node.name}`,
        description: `Graph node "${node.name}" (entry=${node.name === ir.entry})`,
        body: node.instructions,
      }),
    });
  }
  return files;
}

function emitCrewShape(ir: IrCrewV0): PluginFile[] {
  const files: PluginFile[] = [];
  for (const role of ir.roles) {
    if (role.name === ir.entry) {
      files.push({
        path: `skills/${ir.name}/SKILL.md`,
        content: renderSkill({
          name: ir.name,
          description: `Entry role "${role.name}" of crew ${ir.name}`,
          body: role.instructions,
        }),
      });
    }
    files.push({
      path: `agents/${role.name}.md`,
      content: renderAgent(role.name, `Role: ${role.name}`, role.instructions),
    });
  }
  return files;
}

function emitEvalShape(ir: IrEvalV0): PluginFile[] {
  return [
    {
      path: `skills/${ir.name}/SKILL.md`,
      content: renderSkill({
        name: ir.name,
        description: `Eval harness over dataset ${ir.dataset.name} (${ir.dataset.split})`,
        body: ir.agent.instructions,
      }),
    },
  ];
}

function emitGenericAgentShape(
  ir: { name: string; target: string; agent: { instructions: string } },
  target: string,
): PluginFile[] {
  return [
    {
      path: `skills/${ir.name}/SKILL.md`,
      content: renderSkill({
        name: ir.name,
        description: `${target} agent — see body for instructions.`,
        body: ir.agent.instructions,
      }),
    },
  ];
}

function renderAgent(name: string, description: string, instructions: string): string {
  return ["---", `name: ${name}`, `description: ${description}`, "---", "", instructions, ""].join(
    "\n",
  );
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.\n]+[.!?]/);
  return m !== null ? m[0] : (text.split("\n")[0] ?? "");
}
