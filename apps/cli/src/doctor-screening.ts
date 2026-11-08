/**
 * `crewhaus doctor`'s line for the prompt-injection check: which tier runs.
 *
 * The built-in check (rules and structure, `@crewhaus/prompt-injection-detector`)
 * is on. The model-backed tier is not available in this version, so
 * `CREWHAUS_PI_CLASSIFIER_MODEL` has no effect, and the line says so when it is
 * set. It is informational (`warn: true` is what makes doctor print its reason)
 * and never fails doctor.
 *
 * Side-effect free: reads only the environment it is handed.
 */
import { llmClassifierEnabled } from "@crewhaus/prompt-injection-detector";

export type ScreeningStatus = {
  readonly label: string;
  readonly pass: true;
  readonly warn: true;
  readonly reason: string;
};

export function injectionCheckStatus(env: NodeJS.ProcessEnv): ScreeningStatus {
  return {
    label: "Prompt-injection check",
    pass: true,
    warn: true,
    reason: llmClassifierEnabled(env)
      ? "built-in check on; CREWHAUS_PI_CLASSIFIER_MODEL is set but has no effect in this version"
      : "built-in check on; the model-backed check is not available in this version",
  };
}
