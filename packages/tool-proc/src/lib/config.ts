/**
 * `tool_config.proc` — what an operator configures for this package.
 *
 * `wait_for_port_hosts` (C144): the hosts WaitForPort may probe besides
 * loopback — a compose service (`db`), a LAN address. With none listed it
 * probes loopback only; see ./addr.
 *
 * `env_reveal`: the environment variables whose VALUES
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
/** The spec key WaitForPort's refusal names. */
export const PORT_HOSTS_KEY = "tool_config.proc.wait_for_port_hosts";

let envReveal: readonly string[] = [];
let portHosts: readonly string[] = [];

/** A host WaitForPort may be named: the tool's own hostname shape. */
const HOST_SHAPE = /^[A-Za-z0-9._:-]{1,255}$/;

/**
 * Parse `wait_for_port_hosts` (or `waitForPortHosts`): host names or IP
 * literals, compared case-insensitively. Throws with a sentence naming the key.
 */
export function parsePortHosts(config: unknown): readonly string[] {
  if (config === undefined || config === null) return [];
  if (typeof config !== "object" || Array.isArray(config)) return [];
  const block = config as Record<string, unknown>;
  const snake = block["wait_for_port_hosts"];
  const camel = block["waitForPortHosts"];
  if (snake !== undefined && camel !== undefined) {
    throw new Error(
      "tool_config.proc sets both wait_for_port_hosts and waitForPortHosts; keep one",
    );
  }
  const list = snake ?? camel;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((h) => typeof h !== "string" || !HOST_SHAPE.test(h))) {
    throw new Error(
      `${PORT_HOSTS_KEY} must be a list of host names or IP addresses (for example [db, 10.0.0.5])`,
    );
  }
  return Object.freeze([...new Set((list as string[]).map((h) => h.toLowerCase()))].sort());
}

/** Parse a `tool_config.proc` block's `env_reveal`; throws with a sentence naming the key. */
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

/**
 * The boot registrar: `tool_config.proc`. A block under the own key of a
 * tool that reads it — `tool_config.envInspect` or `tool_config.waitForPort`
 * — reaches it too, when that tool is listed (the builtin table's boot rule;
 * no other tool-proc tool names this registrar). Both keys are parsed before either is stored,
 * so a block with one bad key changes nothing.
 */
export function registerProcConfig(config: unknown): void {
  const reveal = parseProcConfig(config);
  const hosts = parsePortHosts(config);
  envReveal = reveal;
  portHosts = hosts;
}

/**
 * The extra hosts ONE WaitForPort call may probe: the serving candidate's
 * block when it declares one, else the boot registration. A candidate block
 * that does not parse allows nothing beyond loopback.
 */
export function portHostsFor(override: unknown): readonly string[] {
  if (override === undefined) return portHosts;
  try {
    return parsePortHosts(override);
  } catch {
    return [];
  }
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

/** Test-only: back to the default, which reveals nothing and probes loopback only. */
export function _resetProcConfig(): void {
  envReveal = [];
  portHosts = [];
}
