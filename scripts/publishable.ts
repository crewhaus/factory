/**
 * The one rule for which workspace package names the release stamps and publishes.
 *
 * A name publishes when it is the bare `crewhaus` CLI or sits under the `@crewhaus/`
 * scope. Nothing else does: not `crewhaus-client`, not `@crewhaus-labs/x`, not
 * `@crewhaus-examples/x`. release-prep stamps exactly these names, publish-workspace
 * publishes exactly these (once release-prep has taken `private` off them), and the
 * trusted-publisher script configures exactly what is published, so the three can no
 * longer disagree about a name.
 *
 * Imports nothing on purpose: scripts/release-version.ts reads it in the release
 * workflow before `bun install` has run.
 */

const SCOPE = "@crewhaus/";

/** The bare `crewhaus` CLI, or a name under the `@crewhaus/` scope. */
export function isPublishableName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    (name === "crewhaus" || (name.startsWith(SCOPE) && name.length > SCOPE.length))
  );
}

/**
 * A manifest that ships as it stands: a publishable name, not marked `private`.
 * release-prep decides by name alone (it removes `private` from every publishable
 * name), so on a stamped tree this and {@link isPublishableName} agree.
 */
export function isPublishableManifest<
  T extends { readonly name?: unknown; readonly private?: unknown },
>(pkg: T): pkg is T & { readonly name: string } {
  return pkg.private !== true && isPublishableName(pkg.name);
}
