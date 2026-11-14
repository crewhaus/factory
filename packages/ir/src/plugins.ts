/**
 * A `plugins:` entry in object form (#522): the plugin, and the host tools its
 * tools may drive. The loader grants only the tools in both `tools` and the
 * plugin manifest's `permissions.tools`. `tools` is sorted and de-duplicated.
 */
export type IrPluginGrant = { readonly name: string; readonly tools: readonly string[] };

/**
 * One `plugins:` entry: a plugin name (its tools may drive every host tool its
 * manifest asks for) or an {@link IrPluginGrant}.
 */
export type IrPluginEntry = string | IrPluginGrant;
