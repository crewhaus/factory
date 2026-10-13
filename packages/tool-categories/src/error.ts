import { CrewhausError } from "@crewhaus/errors";

/**
 * A builtin-tool refusal: an unknown name, a builtin this shape cannot run, or
 * a `tool_config` the boot registrations cannot apply.
 */
export class BuiltinToolError extends CrewhausError {
  override readonly name = "BuiltinToolError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}
