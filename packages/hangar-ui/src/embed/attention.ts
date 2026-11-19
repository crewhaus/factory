/**
 * The attention area's console modules, keyed by serve path. Each is imported
 * `with { type: "text" }` here, and `../index.ts` already spreads this map.
 */
import attentionViewJs from "../../assets/js/views/attention.js" with { type: "text" };
import { type HangarAsset, asset } from "./asset";

export const attentionAssets: Readonly<Record<string, HangarAsset>> = {
  "/assets/js/views/attention.js": asset(attentionViewJs, "/assets/js/views/attention.js"),
};
