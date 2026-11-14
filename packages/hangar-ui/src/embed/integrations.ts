/**
 * The integrations area's console modules, keyed by serve path. Each new file is
 * imported `with { type: "text" }` here and gets its row; `../index.ts` already
 * spreads this map.
 */
import pluginsViewJs from "../../assets/js/views/plugins.js" with { type: "text" };
import { type HangarAsset, asset } from "./asset";

export const integrationsAssets: Readonly<Record<string, HangarAsset>> = {
  "/assets/js/views/plugins.js": asset(pluginsViewJs, "plugins.js"),
};
