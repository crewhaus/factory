/**
 * The orchestration: what setup does, in what order, and what it writes.
 *
 * ORDER IS LOAD-BEARING.
 *
 *   1. Cloudflare, because the Slack app's Request URLs are `https://<the
 *      hostname we are about to create>/slack/events`. Creating the app first
 *      would point it at a name that does not resolve.
 *   2. Thredz, because it is independent of both and cheap to fail early on —
 *      a plan-capped account should stop the run before a Slack app exists.
 *   3. Slack last, and only Slack needs the stand-in responder: the app's
 *      Request URL has to answer a `url_verification` challenge, and the real
 *      daemon cannot boot until it has the signing secret this step returns.
 *      See `responder.ts` for why that deadlock is real and how it dissolves.
 *
 * WHAT GETS PERSISTED, AND WHEN. Slack returns the signing secret exactly
 * once, in the `apps.manifest.create` response — there is no API to read it
 * back. So the credentials are written to `.env` IMMEDIATELY on receipt,
 * before the OAuth install that follows can fail. A crashed run then leaves a
 * recoverable app rather than an orphan with an unretrievable secret, and a
 * re-run finds the app id already recorded and updates in place instead of
 * minting a duplicate.
 *
 * WHAT SETUP NEVER DOES. It does not install or restart the cloudflared
 * connector — that is `sudo cloudflared service install`, and a provisioning
 * tool that shells out to sudo is a different security posture than one that
 * prints a command. It does not write a provisioning credential into the
 * harness; the Cloudflare token, the Slack config token and the Thredz key
 * are read, used, and dropped.
 */
import {
  type CloudflareAuth,
  type CloudflareDeps,
  type IngressRule,
  connectorInstallHint,
  ensureTunnel,
  findZone,
  getTunnelConfiguration,
  getTunnelToken,
  localOrigin,
  mergeIngress,
  needsConnector,
  putTunnelConfiguration,
  upsertDnsCname,
  verifyToken,
} from "./cloudflare";
import { readEnvFile, upsertEnvVar } from "./env-file";
import {
  type SlackAuth,
  type SlackDeps,
  buildAuthorizeUrl,
  buildManifest,
  createApp,
  exchangeOauthCode,
  updateApp,
  validateManifest,
} from "./slack";
import { previewThredzSpace, setThredzSpace } from "./spec-edit";
import { SLACK_ACTIONS_PATH, SLACK_EVENTS_PATH, type SetupTarget, slotEnvName } from "./target";
import { type SpaceType, type ThredzAuth, type ThredzDeps, ensureSpace, verifyKey } from "./thredz";
import {
  type AppliedChange,
  PROVISIONING_CREDENTIALS,
  type PlannedChange,
  type ServiceId,
  ServiceSetupError,
} from "./types";

/**
 * Scopes and events the Slack app needs.
 *
 * These are DERIVED from what `@crewhaus/channel-adapter-slack` actually
 * calls and parses, not from a generic bot template — the same derivation
 * `crewhaus channel provision` performs, kept in lockstep here so an app this
 * command creates and an app that command describes are the same app.
 */
export function slackScopes(channelReactions: boolean): readonly string[] {
  const scopes = [
    "app_mentions:read",
    "channels:history",
    "groups:history",
    "im:history",
    "mpim:history",
    "chat:write",
    "reactions:write",
  ];
  // reactions:read is requested exactly when the spec turns 👍/👎 ratings on,
  // because only then does the generated gateway dispatch reaction_added.
  return channelReactions ? [...scopes, "reactions:read"] : scopes;
}

/** Event subscriptions matching {@link slackScopes}. */
export function slackBotEvents(channelReactions: boolean): readonly string[] {
  const events = [
    "app_mention",
    "message.channels",
    "message.groups",
    "message.im",
    "message.mpim",
  ];
  return channelReactions ? [...events, "reaction_added"] : events;
}

/** Everything the operator can steer. */
export type SetupOptions = {
  /** Which services to touch. Defaults to every one the spec configures. */
  readonly services?: readonly ServiceId[];
  /** The Cloudflare zone (`example.com`) the hostname lives under. */
  readonly zone?: string;
  /** Named tunnel to find-or-create. Defaults to `crewhaus`. */
  readonly tunnelName?: string;
  /** Full public hostname. Defaults to `<spec name label>.<zone>`. */
  readonly hostname?: string;
  /** Origin host written into the ingress rule. */
  readonly originHost?: string;
  /** Wiki space type. `individual` keeps a harness's memory private to its key. */
  readonly spaceType?: SpaceType;
  /** Wiki space slug. Defaults to `thredz.space`, else the spec name. */
  readonly spaceSlug?: string;
  /** An existing Slack app to UPDATE instead of creating a new one. */
  readonly slackAppId?: string;
  /** Skip the browser OAuth round-trip; the operator pastes the bot token. */
  readonly manualInstall?: boolean;
  /** `.env` to write. Defaults to `<harness dir>/.env`. */
  readonly envFile?: string;
  /** How long to wait for the browser install callback. */
  readonly installTimeoutMs?: number;
};

/** The provisioning credentials, resolved. */
export type SetupCredentials = {
  readonly cloudflareApiToken?: string;
  readonly slackConfigToken?: string;
  readonly thredzApiKey?: string;
};

/** Terminal seams, injected so the package prints nothing on its own. */
export type SetupIo = {
  /** A progress line — the `✓ label` / `~ label: reason` lane. */
  info(line: string): void;
  warn(line: string): void;
  /** Ask the operator for a value. Absent ⇒ non-interactive. */
  prompt?(question: string, opts: { readonly secret: boolean }): Promise<string | undefined>;
  /** Open a URL. Absent ⇒ setup prints it instead. */
  openUrl?(url: string): Promise<void>;
};

/** Injected network seams, one per provider. */
export type SetupDeps = {
  readonly cloudflare?: CloudflareDeps;
  readonly slack?: SlackDeps;
  readonly thredz?: ThredzDeps;
  /** Starts the stand-in listener. Injected so tests never bind a port. */
  readonly startResponder?: typeof import("./responder").startResponder;
  readonly portInUse?: typeof import("./responder").portInUse;
};

export type SetupContext = {
  readonly target: SetupTarget;
  readonly options: SetupOptions;
  readonly credentials: SetupCredentials;
  readonly io: SetupIo;
  readonly deps?: SetupDeps;
};

/** Which services this run will touch, given the spec and the flags. */
export function selectedServices(target: SetupTarget, options: SetupOptions): readonly ServiceId[] {
  const available: ServiceId[] = [];
  // Cloudflare is available whenever a zone is known: a tunnel fronts the
  // daemon's events port, which every channel harness has.
  if (target.slack !== undefined || options.zone !== undefined) available.push("cloudflare");
  if (target.slack !== undefined) available.push("slack");
  if (target.thredz !== undefined) available.push("thredz");
  const requested = options.services;
  return requested === undefined ? available : available.filter((s) => requested.includes(s));
}

/**
 * Resolve the provisioning credentials: explicit values win, then the
 * process env, then the harness `.env`, then a prompt. Returns the values
 * plus the names of anything still missing, so a non-interactive run can fail
 * with the full list rather than one at a time.
 */
export async function resolveCredentials(
  services: readonly ServiceId[],
  env: Readonly<Record<string, string | undefined>>,
  envFilePath: string,
  io: SetupIo,
  provided: SetupCredentials = {},
): Promise<{ credentials: SetupCredentials; missing: readonly string[] }> {
  const fileValues = readEnvFile(envFilePath).values;
  const out: Record<string, string> = {};
  const missing: string[] = [];

  for (const cred of PROVISIONING_CREDENTIALS) {
    if (!services.includes(cred.service)) continue;
    if (cred.optional) continue;
    const explicit = (provided as Record<string, string | undefined>)[cred.id];
    const found = explicit ?? env[cred.envName] ?? fileValues[cred.envName];
    if (found !== undefined && found !== "") {
      out[cred.id] = found;
      continue;
    }
    const answer = await io.prompt?.(cred.prompt, { secret: true });
    if (answer !== undefined && answer !== "") {
      out[cred.id] = answer;
      continue;
    }
    missing.push(cred.envName);
  }
  return { credentials: out as SetupCredentials, missing };
}

/** The env variable names setup writes for the Slack half of a target. */
export function slackEnvNames(botTokenVar: string): {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
} {
  // `SECRETARY_SLACK_BOT_TOKEN` → `SECRETARY_SLACK`; `SLACK_BOT_TOKEN` → `SLACK`.
  // The prefix comes from the spec's own variable name, so a fleet's role
  // prefixes are honoured without this package knowing the convention exists.
  const prefix = botTokenVar.replace(/_BOT_TOKEN$/, "") || "SLACK";
  return {
    appId: `${prefix}_APP_ID`,
    clientId: `${prefix}_CLIENT_ID`,
    clientSecret: `${prefix}_CLIENT_SECRET`,
  };
}

/** The default public hostname label for a target. */
export function defaultHostname(target: SetupTarget, options: SetupOptions): string | undefined {
  if (options.hostname !== undefined) return options.hostname;
  if (options.zone === undefined) return undefined;
  const label = target.name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return label === "" ? undefined : `${label}.${options.zone}`;
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

/** Everything the Cloudflare step produced, for the steps that follow. */
export type CloudflareOutcome = {
  readonly changes: readonly AppliedChange[];
  readonly hostname: string;
  readonly tunnelId: string;
  /** Only when the tunnel was created in this run — the operator must run it. */
  readonly connectorHint: readonly string[] | undefined;
};

/**
 * Find-or-create the tunnel, merge this harness's hostname into its ingress,
 * and point DNS at it.
 *
 * The ingress write is a read-merge-write because Cloudflare's
 * `PUT …/configurations` REPLACES the whole config — a naive PUT on a tunnel
 * that already fronts eight other harnesses would delete them. `mergeIngress`
 * also guarantees the catch-all stays last, which the API does NOT validate:
 * a missing catch-all returns `success: true`, bumps the version, and is then
 * silently rejected by the connector, which keeps serving the old config.
 */
export async function applyCloudflare(ctx: SetupContext): Promise<CloudflareOutcome> {
  const { target, options, io } = ctx;
  const apiToken = ctx.credentials.cloudflareApiToken;
  if (apiToken === undefined) {
    throw new ServiceSetupError("cloudflare", "no Cloudflare API token", {
      fix: "export CLOUDFLARE_API_TOKEN, or put it in the harness .env",
    });
  }
  const zone = options.zone;
  const hostname = defaultHostname(target, options);
  if (zone === undefined || hostname === undefined) {
    throw new ServiceSetupError("cloudflare", "no zone to put the hostname under", {
      fix: "pass --zone example.com (and optionally --hostname sub.example.com)",
    });
  }

  const auth: CloudflareAuth = { apiToken };
  const deps = ctx.deps?.cloudflare;
  const changes: AppliedChange[] = [];

  await verifyToken(auth, deps);
  io.info("Cloudflare token verified");

  const { zoneId, accountId } = await findZone(auth, zone, deps);
  const tunnelName = options.tunnelName ?? "crewhaus";
  const { tunnel, created } = await ensureTunnel(auth, accountId, tunnelName, deps);
  changes.push({
    service: "cloudflare",
    summary: `tunnel "${tunnelName}"`,
    outcome: created ? "created" : "unchanged",
    detail: [`id ${tunnel.id}`],
  });

  const origin = localOrigin(target.eventsPort, options.originHost);
  const config = await getTunnelConfiguration(auth, accountId, tunnel.id, deps);
  const desired: IngressRule[] = [{ hostname, service: origin }];
  const merged = mergeIngress(config.ingress, desired);
  const already = sameIngress(config.ingress, merged);
  if (!already) {
    // `config.raw` carries everything this module does not model —
    // `warp-routing`, the tunnel-level `originRequest` — through a PUT that
    // replaces the whole configuration.
    await putTunnelConfiguration(auth, accountId, tunnel.id, merged, deps, config.raw);
  }
  changes.push({
    service: "cloudflare",
    summary: `public hostname ${hostname} → ${origin}`,
    outcome: already ? "unchanged" : "updated",
    detail: [`${merged.length - 1} hostname rule(s) on the tunnel, catch-all last`],
  });

  const dns = await upsertDnsCname(auth, zoneId, hostname, tunnel.id, deps);
  changes.push({
    service: "cloudflare",
    summary: `DNS CNAME ${hostname} → ${tunnel.id}.cfargotunnel.com`,
    outcome:
      dns.action === "created" ? "created" : dns.action === "updated" ? "updated" : "unchanged",
  });

  // Offer the connector command whenever no connector is attached — not just
  // on the run that created the tunnel. A run that creates the tunnel and
  // then fails at DNS would otherwise lose the command permanently, leaving a
  // hostname that resolves and 502s with nothing to explain it. `created` is
  // kept as an independent trigger because a tunnel minted seconds ago has no
  // connector no matter what status the create response echoes back.
  let connectorHint: readonly string[] | undefined;
  if (created || needsConnector(tunnel)) {
    const token = await getTunnelToken(auth, accountId, tunnel.id, deps);
    connectorHint = connectorInstallHint(token);
  }

  return { changes, hostname, tunnelId: tunnel.id, connectorHint };
}

/** Structural equality for an ingress list — order and fields both matter. */
function sameIngress(a: readonly IngressRule[], b: readonly IngressRule[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((rule, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      rule.hostname === other.hostname &&
      rule.service === other.service &&
      rule.path === other.path
    );
  });
}

// ---------------------------------------------------------------------------
// Thredz
// ---------------------------------------------------------------------------

export type ThredzOutcome = {
  readonly changes: readonly AppliedChange[];
  readonly slug: string;
};

/**
 * Find-or-create the wiki space and record its slug in the spec.
 *
 * The slug goes into `crewhaus.yaml`, not `.env`, because the compiler bakes
 * `thredz.space` in as a literal — it becomes the MCP child's
 * `THREDZ_DEFAULT_SPACE`, and an env ref would not survive lowering.
 */
export async function applyThredz(ctx: SetupContext): Promise<ThredzOutcome> {
  const { target, options, io } = ctx;
  const thredz = target.thredz;
  if (thredz === undefined) {
    throw new ServiceSetupError("thredz", "the spec has no thredz: block", {
      fix: "add a thredz: block, or re-run with --services to skip the wiki step",
    });
  }
  const apiKey = ctx.credentials.thredzApiKey;
  if (apiKey === undefined) {
    throw new ServiceSetupError("thredz", "no Thredz API key", {
      fix: "export THREDZ_API_KEY, or put it in the harness .env",
    });
  }

  const auth: ThredzAuth = { apiKey };
  const deps = ctx.deps?.thredz;

  // PRE-FLIGHT THE SPEC EDIT, BEFORE CREATING ANYTHING.
  //
  // `setThredzSpace` refuses a spec whose `thredz:` block cannot hold a slug
  // — the `thredz: true` / `thredz: $KEY` shorthands, and a block with an
  // inlined literal key. Discovering that AFTER `ensureSpace` would leave a
  // space created in the operator's account that the harness can never be
  // pointed at, and on an individual key that is not recoverable: a key owns
  // at most one individual space, ever. Check first, create second.
  assertSpecCanHoldSpace(target.specPath);

  await verifyKey(auth, deps);
  io.info("Thredz key verified");

  // `individual` is the default because a harness's memory is private by
  // spec default (`thredz.visibility: private`), and an individual space is
  // readable only by the key that owns it. A spec that opts into `shared`
  // visibility gets a shared space unless the operator says otherwise.
  const type: SpaceType =
    options.spaceType ?? (thredz.visibility === "shared" ? "shared" : "individual");
  const slug = options.spaceSlug ?? thredz.space;

  const { space, created } = await ensureSpace(
    auth,
    { name: target.name, ...(slug === undefined ? {} : { slug }), type },
    deps,
  );

  const changes: AppliedChange[] = [
    {
      service: "thredz",
      summary: `${type} wiki space "${space.slug}"`,
      outcome: created ? "created" : "unchanged",
      detail: [`id ${space.id}`, `${space.articleCount} article(s)`],
    },
  ];

  const edit = setThredzSpace(target.specPath, space.slug);
  changes.push({
    service: "thredz",
    summary: `${edit.file}: thredz.space = "${space.slug}"`,
    outcome: edit.outcome === "set" ? "updated" : "unchanged",
  });

  return { changes, slug: space.slug };
}

/**
 * Throw if the spec could not accept a `thredz.space` value, using the exact
 * refusal the later write would raise.
 *
 * It probes with the sentinel below rather than the real slug because the
 * real slug is not known until the space exists — and the refusals are all
 * about the SHAPE of the `thredz:` block, never about the value.
 */
function assertSpecCanHoldSpace(specPath: string): void {
  const preview = previewThredzSpace(specPath, SPACE_PROBE_SLUG);
  if (preview.startsWith("cannot set thredz.space")) {
    // Re-raise through the real writer so the message and its `fix:` are the
    // ones the operator would otherwise have seen, with nothing invented here.
    setThredzSpace(specPath, SPACE_PROBE_SLUG);
  }
}

/** A slug no space will have, used only to shape-check the spec. */
const SPACE_PROBE_SLUG = "\u0000probe";

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export type SlackOutcome = {
  readonly changes: readonly AppliedChange[];
  /** Printed when the operator still has to finish the install by hand. */
  readonly followUp: readonly string[];
};

/**
 * Create (or update) the Slack app, persist its credentials, and install it.
 *
 * The stand-in responder is started ONLY when nothing already holds the
 * events port. A port in use is the good case — the harness daemon is running
 * and answers Slack's challenge itself.
 */
export async function applySlack(
  ctx: SetupContext,
  hostname: string,
  envFile: string,
): Promise<SlackOutcome> {
  const { target, options, io } = ctx;
  const slack = target.slack;
  if (slack === undefined) {
    throw new ServiceSetupError("slack", "the spec configures no Slack channel", {
      fix: "add channels.slack.botToken / signingSecret, or skip with --services",
    });
  }
  const configToken = ctx.credentials.slackConfigToken;
  if (configToken === undefined) {
    throw new ServiceSetupError("slack", "no Slack app-configuration token", {
      fix: "generate one at api.slack.com/apps → Your App Configuration Tokens",
    });
  }

  const botTokenVar = slotEnvName(slack.botToken);
  const signingSecretVar = slotEnvName(slack.signingSecret);
  if (botTokenVar === undefined || signingSecretVar === undefined) {
    throw new ServiceSetupError(
      "slack",
      "the spec does not name env variables for the Slack credentials",
      {
        fix:
          "write channels.slack.botToken and .signingSecret as $UPPER_SNAKE refs " +
          "(e.g. $SLACK_BOT_TOKEN) so setup knows where to put the values",
      },
    );
  }

  const auth: SlackAuth = { configToken };
  const deps = ctx.deps?.slack;
  const changes: AppliedChange[] = [];
  const followUp: string[] = [];

  const eventsUrl = `https://${hostname}${SLACK_EVENTS_PATH}`;
  const actionsUrl = `https://${hostname}${SLACK_ACTIONS_PATH}`;
  const callbackPath = "/crewhaus/oauth/callback";
  const redirectUri = `https://${hostname}${callbackPath}`;
  const scopes = slackScopes(slack.channelReactions);

  const manifest = buildManifest({
    name: target.name,
    scopes,
    botEvents: slackBotEvents(slack.channelReactions),
    eventsUrl,
    actionsUrl,
    redirectUrls: options.manualInstall === true ? undefined : [redirectUri],
  });
  // Which app this run targets has to be settled BEFORE validating, not after:
  // `apps.manifest.validate` takes an optional app_id and validates against
  // that app's current configuration when given one. Resolving it later would
  // mean a re-run — the update path, driven by the app id recorded in `.env`
  // — validated its manifest with no app context, and then applied it with
  // full context. The cheap check would not be checking the same thing as the
  // expensive one.
  const existingAppId =
    options.slackAppId ?? readEnvFile(envFile).values[slackEnvNames(botTokenVar).appId];
  const targetAppId =
    existingAppId !== undefined && existingAppId !== "" ? existingAppId : undefined;

  await validateManifest(auth, manifest, deps, targetAppId);
  io.info("Slack manifest validated");

  // Stand in for the daemon so the Request URL answers, unless something
  // already holds the port (i.e. the daemon is up and will answer itself).
  const portCheck = ctx.deps?.portInUse;
  const start = ctx.deps?.startResponder;
  const daemonUp = portCheck === undefined ? false : await portCheck(target.eventsPort);
  const responder =
    daemonUp || start === undefined
      ? undefined
      : await start({
          port: target.eventsPort,
          eventsPath: SLACK_EVENTS_PATH,
          callbackPath,
          expectedState: STATE_TOKEN,
        });
  if (responder !== undefined) {
    io.info(`stand-in listener on :${target.eventsPort} (answers Slack's URL verification)`);
  } else if (daemonUp) {
    io.info(`port ${target.eventsPort} already serving — the daemon will answer verification`);
  }

  const names = slackEnvNames(botTokenVar);

  try {
    // ── The app: update the one we already made, or make it ──────────────
    //
    // Both branches converge, deliberately. An earlier version returned
    // straight after `updateApp`, which meant a run that created the app and
    // then failed during install could NEVER finish: the app id was now in
    // `.env`, so every re-run took the update path, reported success, and
    // exited 0 while the bot token was still missing and the daemon still
    // refused to boot. The install step below is the part that has to be
    // reachable on a second run — that is the whole point of recording the
    // app id.
    let appId: string;
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    let installUrl: string;
    let scopesChanged = false;

    if (targetAppId !== undefined) {
      const { permissionsUpdated } = await updateApp(auth, targetAppId, manifest, deps);
      scopesChanged = permissionsUpdated;
      changes.push({
        service: "slack",
        summary: `Slack app ${targetAppId} updated from manifest`,
        outcome: "updated",
      });
      appId = targetAppId;
      installUrl = `https://api.slack.com/apps/${targetAppId}/install-on-team`;
      // The OAuth pair was persisted when the app was created; an app adopted
      // via --app-id may not have one, which only costs us the automated
      // install, not the run.
      const stored = readEnvFile(envFile).values;
      clientId = stored[names.clientId];
      clientSecret = stored[names.clientSecret];
    } else {
      const app = await createApp(auth, manifest, deps);
      // PERSIST FIRST. The signing secret is returned only here; nothing can
      // read it back. Everything after this point is allowed to fail.
      upsertEnvVar(envFile, signingSecretVar, app.signingSecret);
      upsertEnvVar(envFile, names.appId, app.appId);
      upsertEnvVar(envFile, names.clientId, app.clientId);
      upsertEnvVar(envFile, names.clientSecret, app.clientSecret);
      changes.push({
        service: "slack",
        summary: `Slack app "${target.name}" created (${app.appId})`,
        outcome: "created",
        detail: [`signing secret → $${signingSecretVar}`, `app id → $${names.appId}`],
      });
      appId = app.appId;
      clientId = app.clientId;
      clientSecret = app.clientSecret;
      installUrl = app.oauthAuthorizeUrl;
    }

    // ── The install ──────────────────────────────────────────────────────
    //
    // Skip it only when a bot token is already on file AND the scopes did not
    // change. A stale token missing a newly-added scope fails at the first
    // call that needs it, which is a far worse failure than re-installing.
    const installedToken = readEnvFile(envFile).values[botTokenVar];
    if (installedToken !== undefined && installedToken !== "" && !scopesChanged) {
      changes.push({
        service: "slack",
        summary: `already installed — $${botTokenVar} is set`,
        outcome: "unchanged",
      });
      return { changes, followUp };
    }
    if (scopesChanged && installedToken !== undefined && installedToken !== "") {
      io.warn("scopes changed — the existing bot token must be replaced by re-installing");
    }

    // Written as a single narrowing condition rather than a boolean flag so
    // the compiler can see that clientId/clientSecret are defined below.
    if (
      options.manualInstall === true ||
      responder === undefined ||
      clientId === undefined ||
      clientSecret === undefined
    ) {
      followUp.push(
        scopesChanged
          ? `Scopes changed — re-install the app, then replace $${botTokenVar}:  ${installUrl}`
          : `Install the app, then put the Bot User OAuth Token in $${botTokenVar}:  ${installUrl}`,
      );
      return { changes, followUp };
    }

    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      scopes,
      redirectUri,
      state: STATE_TOKEN,
    });
    // ALWAYS print the URL, then try to open it. An opener that silently
    // fails — no browser on a headless box, a sandboxed launcher — would
    // otherwise leave the operator staring at "approve the scopes" with
    // nothing to click, and the run then times out for no visible reason.
    io.info("approve the scopes to finish installing:");
    io.info(authorizeUrl);
    if (ctx.io.openUrl !== undefined) await ctx.io.openUrl(authorizeUrl);

    const code = await responder.waitForCode(options.installTimeoutMs ?? 300_000);
    const installed = await exchangeOauthCode({ clientId, clientSecret, code, redirectUri }, deps);
    upsertEnvVar(envFile, botTokenVar, installed.botToken);
    changes.push({
      service: "slack",
      summary: `installed to ${installed.teamName}`,
      outcome: "created",
      detail: [`bot token → $${botTokenVar}`, `scopes: ${installed.scopes.join(", ")}`],
    });
    if (!responder.sawChallenge()) {
      followUp.push(
        `Slack has not yet verified the Request URL. Start the daemon, then click Retry on https://api.slack.com/apps/${appId}/event-subscriptions`,
      );
    }
    return { changes, followUp };
  } finally {
    await responder?.stop();
  }
}

/**
 * The `state` value tying an authorize URL to its callback. It is a constant
 * rather than a random value on purpose: this package must stay deterministic
 * for tests, and the parameter's job here is only to reject a redirect that
 * did not come from the URL setup just opened — the listener is loopback-only
 * and lives for one exchange.
 */
const STATE_TOKEN = "crewhaus-services-setup";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a plan or a result in the repo's `✓` / `~` / `✗` lane. */
export function renderChanges(changes: readonly AppliedChange[]): readonly string[] {
  return changes.flatMap((c) => {
    const mark = c.outcome === "failed" ? "✗" : c.outcome === "unchanged" ? "~" : "✓";
    const suffix =
      c.outcome === "failed"
        ? `: ${c.error ?? "failed"}`
        : c.outcome === "unchanged"
          ? " (already set)"
          : "";
    return [`${mark} ${c.summary}${suffix}`, ...(c.detail ?? []).map((d) => `    ${d}`)];
  });
}

/** Render a dry-run plan. */
export function renderPlan(planned: readonly PlannedChange[]): readonly string[] {
  return planned.flatMap((p) => [
    `${p.satisfied ? "~" : "→"} ${p.summary}${p.satisfied ? " (already set)" : ""}`,
    ...(p.detail ?? []).map((d) => `    ${d}`),
  ]);
}
