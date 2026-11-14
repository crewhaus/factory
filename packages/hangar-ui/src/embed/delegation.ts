/**
 * The delegation area's console modules, keyed by serve path. Each is imported
 * `with { type: "text" }` here, and `../index.ts` already spreads this map.
 */
import delegationsViewJs from "../../assets/js/views/delegations.js" with { type: "text" };
import { type HangarAsset, asset } from "./asset";

export const delegationAssets: Readonly<Record<string, HangarAsset>> = {
  "/assets/js/views/delegations.js": asset(delegationsViewJs, "/assets/js/views/delegations.js"),
};
