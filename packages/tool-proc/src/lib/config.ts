/**
 * `tool_config.proc` — what an operator configures for this package.
 *
 * One key today, `env_reveal`: the environment variables whose VALUES
 * EnvInspect may show. Before 0.7.1 the tool showed any value the CALL named
 * in `reveal`, so a model (or the text steering it) could read
 * ANTHROPIC_API_KEY into its own context from a read-only tool that plan and
 * auto mode run unasked (C052: docs-claims#6, flag-truth-4#1, security-8#3).
 * Now the list comes from the operator, never from the call, and a name that
 * looks like a credential is never shown even when listed
 * (`@crewhaus/tool-safety/env`'s checkEnvReveal).
 *
 * The block reaches the package through the builtin table's boot registrar
 * (`registerProcConfig`), which every emitter, `crewhaus run` and `crewhaus
 * eval` call; a model pool candidate's own block replaces it for that
 * candidate's calls (`ToolExecuteContext.toolConfig`).
 */
import { credentialShapeOf, isEnvName } from "@crewhaus/tool-safety/env";

/** The spec key a refusal names. */
export const ENV_REVEAL_KEY = "tool_config.proc.env_reveal";

let envReveal: readonly string[] = [];

/** Parse a `tool_config.proc` block; throws with a sentence naming the key. */
export function parseProcConfig(config: unknown): readonly string[] {
  if (config === undefined || config === null) return [];
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("tool_config.proc must be a mapping (for example `env_reveal: [NODE_ENV]`)");
  }
  const block = config as Record<string, unknown>;
  const snake = block["env_reveal"];
  const camel = block["envReveal"];
  if (snake !== undefined && camel !== undefined) {
    throw new Error("tool_config.proc sets both env_reveal and envReveal; keep one");
  }
  const list = snake ?? camel;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((n) => typeof n !== "string")) {
    throw new Error(`${ENV_REVEAL_KEY} must be a list of environment variable names`);
  }
  const names = list as string[];
  for (const name of names) {
    if (!isEnvName(name)) {
      throw new Error(
        `${ENV_REVEAL_KEY} lists ${JSON.stringify(String(name).slice(0, 64))}, which is not an environment variable name`,
      );
    }
    const shape = credentialShapeOf(name);
    if (shape !== undefined) {
      throw new Error(
        `${ENV_REVEAL_KEY} lists ${name}, whose name looks like a credential (${shape}); EnvInspect never shows such a value, so remove it`,
      );
    }
  }
  return Object.freeze([...new Set(names)].sort());
}

/** The boot registrar: `tool_config.proc` (or `tool_config.envInspect`). */
export function registerProcConfig(config: unknown): void {
  envReveal = parseProcConfig(config);
}

/**
 * The reveal list ONE call runs under: the serving candidate's block when it
 * declares one (replacing the boot registration, as every package's
 * per-call override does), else the boot registration. A candidate block
 * that does not parse reveals nothing rather than falling back.
 */
export function revealAllowFor(override: unknown): readonly string[] {
  if (override === undefined) return envReveal;
  try {
    return parseProcConfig(override);
  } catch {
    return [];
  }
}

/** Test-only: back to the default, which reveals nothing. */
export function _resetProcConfig(): void {
  envReveal = [];
}
