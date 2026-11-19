/**
 * The runtime area's console modules, keyed by serve path. Each is imported
 * `with { type: "text" }` here, and `../index.ts` already spreads this map.
 */
import budgetViewJs from "../../assets/js/views/budget.js" with { type: "text" };
import { type HangarAsset, asset } from "./asset";

export const runtimeAssets: Readonly<Record<string, HangarAsset>> = {
  "/assets/js/views/budget.js": asset(budgetViewJs, "/assets/js/views/budget.js"),
};
