/**
 * The creation area's console modules, keyed by serve path. Empty until the
 * area adds a screen: it imports each new file `with { type: "text" }` here
 * and adds its row, and `../index.ts` already spreads this map.
 */
import type { HangarAsset } from "./asset";

export const creationAssets: Readonly<Record<string, HangarAsset>> = {};
