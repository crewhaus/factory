import { CrewhausError } from "@crewhaus/errors";

/**
 * Canary/experiment configuration error. Lives in its own module so both the
 * controller (`index.ts`) and the E50 experiment surface (`experiment.ts`)
 * can throw the SAME class without importing each other — the public export
 * remains `@crewhaus/canary-controller`'s `CanaryError`, unchanged.
 */
export class CanaryError extends CrewhausError {
  override readonly name = "CanaryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}
