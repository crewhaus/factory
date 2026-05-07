import { RuntimeError } from "@crewhaus/errors";

export class DatasetLoadError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(`eval-dataset: ${message}`, cause);
  }
}
