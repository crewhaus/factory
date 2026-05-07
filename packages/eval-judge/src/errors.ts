import { RuntimeError } from "@crewhaus/errors";

export class JudgeError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(`eval-judge: ${message}`, cause);
  }
}
