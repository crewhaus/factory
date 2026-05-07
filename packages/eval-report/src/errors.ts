import { RuntimeError } from "@crewhaus/errors";

export class ReportError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(`eval-report: ${message}`, cause);
  }
}
