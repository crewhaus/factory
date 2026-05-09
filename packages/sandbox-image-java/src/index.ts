import { type SandboxImageEntry, registerSandboxImage } from "@crewhaus/sandbox-image-registry";

/**
 * Catalog R8 `sandbox-image-java` — Section 36 polyglot Java sandbox image.
 *
 * Java 11+ supports running .java source files directly via `java <File>.java`,
 * so snippet mode skips the explicit javac step. Default entrypoint is
 * `["java"]`; tool-code-execution callers extend with the source file path.
 *
 * Cold-start budget: ≤2s for the compiled-language warm pool. The JVM's
 * `java -version` boot is ~250ms on warm hosts and stays well under
 * budget; full compile+run round-trips can take longer (1-3s) and
 * should be invoked with a per-call timeoutMs override.
 *
 * Layer R8.
 */

export const JAVA_IMAGE_ID = "java";
export const JAVA_IMAGE_REF = "eclipse-temurin:21-alpine";
export const JAVA_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["java"];
export const JAVA_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["java", "-version"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const JAVA_COLD_START_BUDGET_MS = 2_000;

export function registerJavaSandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: JAVA_IMAGE_ID,
    image: JAVA_IMAGE_REF,
    defaultEntrypoint: JAVA_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: JAVA_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: JAVA_COLD_START_BUDGET_MS,
    },
    description:
      "JDK 21 (Eclipse Temurin alpine) — snippet mode via `java <File>.java` (Java 11+); compiled-class mode for mounted projects.",
  });
}
