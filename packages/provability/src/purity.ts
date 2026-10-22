/**
 * Which tools the `checked` rung may re-run (design §6.3, §10).
 *
 * Replay re-executes a tool with the input the log recorded and compares
 * output digests, so it must only ever run a tool that cannot reach a
 * network, a process or a filesystem write: the safety flags every
 * registered tool declares already say which those are. One definition,
 * here, so the gate's composition root and the preflight tool agree.
 */
import type { RegisteredTool } from "@crewhaus/tool-catalog";

/**
 * Pure: read-only, safe to run concurrently, not destructive, no sandbox,
 * internal scope and no declared network or process capability. `Bash`,
 * `Python`, every fetch and every write fail at least one of these, so none
 * is ever replayed — a spec that lists one on `execution.allow` opts into
 * "it ran" without "it reproduces", and the binding says `replayed: false`.
 */
export function isPureTool(
  tool: Pick<
    RegisteredTool,
    "readOnly" | "concurrencySafe" | "destructive" | "requiresSandbox" | "scope" | "ioCapability"
  >,
): boolean {
  return (
    tool.readOnly &&
    tool.concurrencySafe &&
    !tool.destructive &&
    !tool.requiresSandbox &&
    tool.scope === "internal" &&
    tool.ioCapability === undefined
  );
}
