/**
 * The integrations area's slot: the operations it serves. Each integration adds its own
 * spread line below and leaves the others alone.
 */
import type { HomeAreaRuntime } from "./areas";
import { PLUGIN_HANDLERS } from "./plugins";

export const HOME_INTEGRATIONS: HomeAreaRuntime = {
  area: "integrations",
  handlers: {
    ...PLUGIN_HANDLERS,
  },
};
