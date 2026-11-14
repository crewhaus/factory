/**
 * The integrations area: what outside code may see of Home, granted by its owner.
 * Static data, like every area module.
 *
 * Plugins (#522): a plugin's manifest asks for panes, event families, reads,
 * origins and host tools; the owner grants some of them on some harnesses; Home
 * serves the intersection of the live grant and what the current manifest asks.
 * A grant is a `pluginGrant` object in Home's own ledger, never a spec field.
 *
 * Later integrations append their own rows to each list below, after the plugin
 * rows, and leave these alone.
 */
import { PLUGIN_OPERATIONS } from "../operations/plugins.js";
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

/**
 * A plugin's name: the manifest name grammar (plugin-sdk's
 * `PLUGIN_NAME_PATTERN`, copied: this package has no dependencies; a test in
 * apps/cli holds the two equal).
 */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

/** Event families a plugin may be granted (plugin-sdk's `PLUGIN_INTEGRATION_EVENT_FAMILIES`). */
export const PLUGIN_EVENT_FAMILIES = deepFreeze([
  "run",
  "decision",
  "deployment",
  "harness",
] as const);

export type PluginEventFamily = (typeof PLUGIN_EVENT_FAMILIES)[number];

/** What a plugin may be granted to read (plugin-sdk's `PLUGIN_INTEGRATION_READS`). */
export const PLUGIN_READS = deepFreeze([
  "run.lifecycle",
  "run.trace",
  "decisions",
  "costs",
] as const);

export type PluginRead = (typeof PLUGIN_READS)[number];

/** A plugin's standing with the owner, as a review reads it. Never stored: computed at read time. */
export const PLUGIN_REVIEW_STATES = deepFreeze([
  "waiting",
  "allowed",
  "asks-for-more",
  "revoked",
] as const);

export type PluginReviewState = (typeof PLUGIN_REVIEW_STATES)[number];

/** The most entries one granted list holds. */
export const PLUGIN_GRANT_LIST_MAX = 64;

/** What a plugin asks for, or what a grant allows, field by field. */
export type PluginGrantSet = {
  readonly harnesses: readonly string[] | "all";
  readonly panes: readonly string[];
  readonly events: readonly string[];
  readonly reads: readonly string[];
  readonly net: readonly string[];
  readonly tools: readonly string[];
};

export type PluginGrantRequest = {
  readonly harnesses: readonly string[] | "all";
  readonly panes: readonly string[];
  readonly events: readonly PluginEventFamily[];
  readonly reads: readonly PluginRead[];
  readonly net: readonly string[];
  readonly tools: readonly string[];
  /** The live grant's generation the caller read. Absent: there is no live grant. */
  readonly expect?: number;
};

export type PluginReview = {
  readonly plugin: string;
  readonly version: string;
  readonly entrypointDigest: string | null;
  readonly signed: boolean;
  /** The crewhaus versions the plugin says it runs on. */
  readonly crewhausRange: string | null;
  readonly state: PluginReviewState;
  /** No grant yet, and a manifest with no integration section. */
  readonly legacy: boolean;
  readonly asks: PluginGrantSet;
  readonly granted: PluginGrantSet | null;
  readonly served: PluginGrantSet;
  /** The live grant's generation, or null when there is none. */
  readonly gen: number | null;
  /** The environment variables the plugin says it reads. Names only. */
  readonly envNames: readonly string[];
  readonly verb: string;
};

const ULID = "ulid";

export const INTEGRATIONS_MODULE = {
  area: "integrations",
  operations: [
    // Plugins (#522).
    ...PLUGIN_OPERATIONS,
  ],
  grammars: [
    // A plugin grant.
    { prefix: "pgt", grammar: ULID },
  ],
  refKinds: [],
  eventFamilies: [
    // Declared for the event stream; nothing emits them yet.
    {
      family: "plugin",
      types: [
        { type: "plugin.installed", sensitivity: "internal" },
        { type: "plugin.granted", sensitivity: "internal" },
        { type: "plugin.revoked", sensitivity: "internal" },
        { type: "plugin.asks-for-more", sensitivity: "internal" },
      ],
    },
  ],
  machines: {
    // One grant's lifecycle. A grant after a revoke is a new object: the revoked
    // one stays as history.
    pluginGrant: {
      states: ["granted", "revoked"],
      entry: ["granted"],
      terminal: ["revoked"],
      transitions: { granted: ["granted", "revoked"], revoked: [] },
      recoveryOwner: { granted: "operator", revoked: "none" },
    },
  },
  commandKinds: [
    {
      id: "plugins.grant",
      permission: "home.settings.manage",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "plugins.revoke",
      permission: "home.settings.manage",
      idempotent: true,
      effect: "local",
      cliTwin: { argv: ["plugins", "revoke", "{plugin}"] },
    },
  ],
  permissions: [],
} as const satisfies AreaModule;
