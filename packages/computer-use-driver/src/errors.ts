import { CrewhausError } from "@crewhaus/errors";

export class ComputerUseDriverError extends CrewhausError {
  override readonly name = "ComputerUseDriverError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}
