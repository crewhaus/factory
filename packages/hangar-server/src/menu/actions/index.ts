/**
 * Every verb the command menu can propose, one provider per line. An area
 * adds its own provider file beside these and one line here; the menu's
 * matching and its command-line twins read only this list.
 */
import { DAEMON_ACTIONS } from "./daemon";
import type { MenuActionProvider } from "./types";

export type { MenuActionProvider } from "./types";

export const MENU_ACTION_PROVIDERS: readonly MenuActionProvider[] = [...DAEMON_ACTIONS];
