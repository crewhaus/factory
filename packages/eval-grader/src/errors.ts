import { RuntimeError } from "@crewhaus/errors";

export class GraderError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(`eval-grader: ${message}`, cause);
  }
}
