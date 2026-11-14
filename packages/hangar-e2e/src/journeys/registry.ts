/** Every journey. A guard fails if a `*.journey.ts` on disk is not listed here. */
import { a11yFloor } from "./a11y-floor.journey";
import { a11ySelfTest } from "./a11y-self-test.journey";
import { axeGate } from "./axe-gate.journey";
import { axeStates } from "./axe-states.journey";
import { benchDryRun } from "./bench-dry-run.journey";
import { cliBoot } from "./cli-boot.journey";
import { crawl } from "./crawl.journey";
import type { Journey } from "./journey";
import { keyboardTour } from "./keyboard-tour.journey";
import { legacyRedirects } from "./legacy-redirects.journey";
import { navigation } from "./navigation.journey";
import { pluginGrant } from "./plugin-grant.journey";
import { pluginPane } from "./plugin-pane.journey";
import { runThenConsole } from "./run-then-console.journey";
import { sessionSelfTest } from "./session-self-test.journey";
import { signIn } from "./sign-in.journey";
import { specConflict } from "./spec-conflict.journey";
import { thredzProxy } from "./thredz-proxy.journey";
import { untrustedMarkup } from "./untrusted-markup.journey";

export const JOURNEYS: readonly Journey[] = [
  sessionSelfTest,
  signIn,
  pluginPane,
  pluginGrant,
  crawl,
  legacyRedirects,
  navigation,
  untrustedMarkup,
  thredzProxy,
  benchDryRun,
  a11ySelfTest,
  a11yFloor,
  axeGate,
  axeStates,
  keyboardTour,
  specConflict,
  cliBoot,
  runThenConsole,
];
