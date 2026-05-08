/**
 * Catalog F4 `wizard` — Section 26 Studio.
 *
 * 5-question guided spec creation. Headless logic — both `crewhaus
 * init --wizard` and the studio-ui "new spec" button drive the same
 * state machine.
 *
 * The 5 questions:
 *   1. target shape (cli | channel | graph | managed | pipeline | crew |
 *      research | batch | voice | browser)
 *   2. spec name
 *   3. primary model
 *   4. primary tools (comma-separated, applies only to cli/research/batch
 *      shapes — others use shape-specific defaults)
 *   5. permission mode (default | plan | auto)
 *
 * The wizard composes the answers into a `crewhaus.yaml` derived from
 * `scaffold-templates` for the chosen target, with the user's name /
 * model / tools / permission-mode patched in.
 */
import { CrewhausError } from "@crewhaus/errors";
import { type TemplateId, getTemplate, listTemplates } from "@crewhaus/scaffold-templates";

export class WizardError extends CrewhausError {
  override readonly name = "WizardError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type TargetShape =
  | "cli"
  | "channel"
  | "graph"
  | "managed"
  | "pipeline"
  | "crew"
  | "research"
  | "batch"
  | "voice"
  | "browser";

const TARGET_TO_TEMPLATE: Record<TargetShape, TemplateId> = {
  cli: "cli-coding-agent",
  channel: "slack-bot",
  graph: "graph-stateful",
  managed: "managed-multitenant",
  pipeline: "rag-bot",
  crew: "crew-research",
  research: "research-agent",
  batch: "batch-worker",
  voice: "voice-realtime",
  browser: "browser-driver",
};

export type WizardAnswer =
  | { question: "target"; value: TargetShape }
  | { question: "name"; value: string }
  | { question: "model"; value: string }
  | { question: "tools"; value: ReadonlyArray<string> }
  | { question: "permissionMode"; value: "default" | "plan" | "auto" };

export type WizardQuestion =
  | {
      readonly id: "target";
      readonly prompt: string;
      readonly choices: ReadonlyArray<{ readonly value: TargetShape; readonly label: string }>;
    }
  | { readonly id: "name"; readonly prompt: string }
  | { readonly id: "model"; readonly prompt: string; readonly suggested: ReadonlyArray<string> }
  | {
      readonly id: "tools";
      readonly prompt: string;
      readonly applicable: boolean;
      readonly suggested: ReadonlyArray<string>;
    }
  | {
      readonly id: "permissionMode";
      readonly prompt: string;
      readonly choices: ReadonlyArray<{
        readonly value: "default" | "plan" | "auto";
        readonly label: string;
      }>;
    };

export type WizardState = {
  /** Index of the next question to ask. 0 = target, 1 = name, … */
  readonly step: number;
  /** Answers collected so far. */
  readonly answers: ReadonlyArray<WizardAnswer>;
};

export type WizardResult = {
  readonly yaml: string;
  readonly envExample: string;
  readonly target: TargetShape;
  readonly name: string;
};

export function startWizard(): WizardState {
  return { step: 0, answers: [] };
}

export function nextQuestion(state: WizardState): WizardQuestion | undefined {
  switch (state.step) {
    case 0:
      return {
        id: "target",
        prompt: "What target shape do you want?",
        choices: listTemplates().map((t) => ({
          value: t.target as TargetShape,
          label: t.title,
        })),
      };
    case 1:
      return {
        id: "name",
        prompt: "What should this spec be called? (kebab-case)",
      };
    case 2:
      return {
        id: "model",
        prompt: "Which primary model?",
        suggested: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-7"],
      };
    case 3: {
      const target = answerOf(state, "target");
      const applicable = target === "cli" || target === "research" || target === "batch";
      return {
        id: "tools",
        prompt: applicable
          ? "Which tools should the agent have? (comma-separated)"
          : "(this target shape uses tool defaults — press enter to skip)",
        applicable,
        suggested: applicable ? ["read", "write", "edit", "glob", "grep", "bash"] : [],
      };
    }
    case 4:
      return {
        id: "permissionMode",
        prompt: "Default permission mode?",
        choices: [
          { value: "default", label: "default — ask for tool grants when no rule matches" },
          { value: "plan", label: "plan — read-only mode, no destructive tool grants" },
          { value: "auto", label: "auto — auto-allow tools that match an alwaysAllow rule" },
        ],
      };
    default:
      return undefined; // wizard complete
  }
}

export function answerWizard(state: WizardState, answer: WizardAnswer): WizardState {
  return {
    step: state.step + 1,
    answers: [...state.answers, answer],
  };
}

function answerOf<K extends WizardAnswer["question"]>(
  state: WizardState,
  question: K,
): Extract<WizardAnswer, { question: K }>["value"] | undefined {
  const a = state.answers.find((x) => x.question === question);
  if (a === undefined) return undefined;
  return a.value as Extract<WizardAnswer, { question: K }>["value"];
}

/**
 * Take a completed wizard state and synthesize the final spec YAML +
 * `.env.example` entries.
 *
 * The YAML is the matching template's body with the user's name/model/
 * tools/permission-mode patched in. The `.env.example` lists every
 * `$VAR_NAME` reference in the YAML (e.g. `$SLACK_BOT_TOKEN`).
 */
export function compileWizard(state: WizardState): WizardResult {
  const target = answerOf(state, "target");
  if (target === undefined) {
    throw new WizardError("compileWizard: target not answered yet");
  }
  const name = answerOf(state, "name") ?? `my-${target}`;
  const model = answerOf(state, "model") ?? "claude-sonnet-4-6";
  const tools = answerOf(state, "tools") ?? [];
  const permissionMode = answerOf(state, "permissionMode") ?? "default";

  const tmpl = getTemplate(TARGET_TO_TEMPLATE[target]);
  if (tmpl === undefined) {
    throw new WizardError(`compileWizard: no template for target "${target}"`);
  }
  let yaml = tmpl.yaml;
  // Replace the template's name + model + permission mode.
  yaml = yaml.replace(/^name:\s+.+$/m, `name: ${name}`);
  yaml = yaml.replace(/(model:)\s+claude-[a-z0-9-]+/m, `$1 ${model}`);
  yaml = yaml.replace(/^( {2}mode:)\s+\w+$/m, `$1 ${permissionMode}`);
  // Optional tool list (only meaningful for cli/research/batch).
  if (tools.length > 0 && (target === "cli" || target === "research" || target === "batch")) {
    const block = `tools:\n${tools.map((t) => `  - ${t}`).join("\n")}\n`;
    if (/^tools:/m.test(yaml)) {
      yaml = yaml.replace(/^tools:[\s\S]*?(?=\npermissions:|\n\Z|$)/m, block.trimEnd());
    } else {
      // Insert before `permissions:`
      yaml = yaml.replace(/^permissions:/m, `${block}permissions:`);
    }
  }

  // .env.example — extract $VAR_NAME references.
  const envVars = new Set<string>();
  const re = /\$([A-Z_][A-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
  while ((m = re.exec(yaml)) !== null) {
    if (m[1] !== undefined) envVars.add(m[1]);
  }
  const envExample =
    envVars.size === 0
      ? "# (no env vars referenced in this spec)\n"
      : `${[...envVars]
          .sort()
          .map((v) => `${v}=`)
          .join("\n")}\n`;

  return { yaml, envExample, target, name };
}
