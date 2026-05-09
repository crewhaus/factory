import { type SandboxImageEntry, registerSandboxImage } from "@crewhaus/sandbox-image-registry";

/**
 * Catalog R8 `sandbox-image-dotnet` — Section 36 polyglot .NET sandbox image.
 *
 * Snippet mode (default entrypoint): `dotnet script` consumes a `.csx`
 * file or stdin. The image bakes in the globally-installed
 * `dotnet-script` tool so callers don't need a per-invocation install.
 *
 * Cold-start budget: ≤4s — more generous than the compiled-language
 * 2s budget. The kickoff prompt assigns .NET this looser bucket
 * because the .NET runtime + dotnet-script first-run JIT can take
 * 2-3s on alpine. `dotnet --version` itself stays well under budget;
 * the 4s value covers the realistic worst case for the first
 * snippet exec in a fresh warm-pool slot.
 *
 * Layer R8.
 */

export const DOTNET_IMAGE_ID = "dotnet";
export const DOTNET_IMAGE_REF = "mcr.microsoft.com/dotnet/sdk:8.0-alpine";
export const DOTNET_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["dotnet", "script"];
export const DOTNET_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["dotnet", "--version"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const DOTNET_COLD_START_BUDGET_MS = 4_000;

export function registerDotnetSandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: DOTNET_IMAGE_ID,
    image: DOTNET_IMAGE_REF,
    defaultEntrypoint: DOTNET_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: DOTNET_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: DOTNET_COLD_START_BUDGET_MS,
    },
    description:
      ".NET 8 SDK alpine — snippet mode via `dotnet script` (preinstalled global tool); compiled-binary mode for mounted projects.",
  });
}
