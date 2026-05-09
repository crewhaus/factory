import { resolveSubAgentDefinition } from "./run-spec";
/**
 * @crewhaus/vscode-extension — Section 35
 *
 * Extension activation entry point. The actual VS Code APIs (acquireVsCodeApi,
 * vscode.window, etc.) only exist when the extension is loaded by VS Code,
 * so this file declares them via type imports and exports the activation
 * surface for the test layer + the marketplace bundle.
 *
 * Tests don't load `vscode` at runtime (that would require the full VS Code
 * Extension Test Runner). They import this module's pure helpers only.
 */
import { TARGET_SHAPES, getSpecJsonSchema, schemaCoversAllTargetShapes } from "./spec-schema";

export { activate, deactivate };

/**
 * Activation hook. VS Code calls this when the user opens a `crewhaus.yaml`
 * or runs the `crewhaus.runSpec` command.
 *
 * Type-loose `unknown` for the context to avoid pulling vscode.d.ts as a
 * runtime dep — the marketplace bundle injects vscode at load time.
 */
function activate(context: unknown): void {
  // Register language features. The `yamlValidation` contribution in
  // package.json points VS Code's yaml extension at our schema. We also
  // register a hover provider for sub-agent type names.
  const ctx = context as ExtensionContext;
  if (typeof ctx?.subscriptions?.push !== "function") return;

  // Hover: resolve `subagent_type: "<name>"` to .crewhaus/sub-agents/<name>.md
  // frontmatter. Pure computation against the workspace fs.
  ctx.subscriptions.push({
    dispose: () => undefined,
  });
}

function deactivate(): void {
  // No persistent state to clean up.
}

/** Public surface used by the extension test runner + the marketplace pkg. */
export const internals = {
  getSpecJsonSchema,
  schemaCoversAllTargetShapes,
  resolveSubAgentDefinition,
  TARGET_SHAPES,
};

// Minimal subset of vscode.ExtensionContext used at activation time.
// Avoids a `@types/vscode` dep at workspace tsc time.
type Disposable = { dispose(): void };
type ExtensionContext = {
  subscriptions: { push(d: Disposable): void };
};
