import { RuntimeError } from "@crewhaus/errors";

export class RunnerError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(`eval-runner: ${message}`, cause);
  }
}
