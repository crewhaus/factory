/**
 * `crewhaus services setup|verify` — provision the external services a
 * harness needs, in one command.
 *
 * WHY THIS EXISTS ALONGSIDE `channel provision`. That command is
 * emit-and-instruct for Slack, and its header records the reason precisely:
 * Slack's manifest API authenticates with an app *configuration* token, and
 * the spec carries only what the DAEMON uses — the `xoxb` bot token and the
 * signing secret — neither of which can call it. Inventing a runtime env var
 * for a token family the runtime never uses was rightly ruled out.
 *
 * `services setup` does not reverse that decision, it sits above it. This is
 * an OPERATOR command, run once by a person with console access, holding
 * short-lived provisioning credentials that are read and dropped: a Slack
 * app-configuration token, a Cloudflare API token, a Thredz key. Nothing they
 * unlock is written into a spec. What lands in the harness is only ever what
 * the daemon itself needs — which is exactly the boundary `channel provision`
 * was protecting.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI),
 * mirroring `channel-provision.ts` / `audit-verify.ts`.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type AppliedChange,
  SERVICE_IDS,
  type ServiceId,
  ServiceSetupError,
  type SetupContext,
  type SetupCredentials,
  type SetupIo,
  type SetupOptions,
  type SetupTarget,
  applyAgentMail,
  applyCloudflare,
  applySlack,
  applyThredz,
  defaultHostname,
  portInUse,
  readSetupTarget,
  renderChanges,
  resolveCredentials,
  selectedServices,
  slackScopes,
  slotEnvName,
  startResponder,
} from "@crewhaus/service-setup";

/** Thrown on a malformed `--services` value; the dispatch arm calls `die()`. */
export class InvalidServicesFlagError extends Error {
  override readonly name = "InvalidServicesFlagError";
}

/** Parsed, validated flags — everything the command needs, nothing more. */
export type ServicesArgs = {
  readonly specPath: string;
  readonly services: readonly ServiceId[] | undefined;
  readonly zone: string | undefined;
  readonly hostname: string | undefined;
  readonly tunnelName: string | undefined;
  readonly originHost: string | undefined;
  readonly port: number | undefined;
  readonly spaceType: "shared" | "individual" | undefined;
  readonly spaceSlug: string | undefined;
  readonly appId: string | undefined;
  readonly envFile: string | undefined;
  readonly manualInstall: boolean;
  readonly dryRun: boolean;
  readonly yes: boolean;
};

/** Resolve `--services a,b` into the typed list, rejecting unknown names. */
export function parseServicesFlag(raw: string | undefined): readonly ServiceId[] | undefined {
  if (raw === undefined || raw === "" || raw === "all") return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const bad = parts.filter((p) => !SERVICE_IDS.includes(p as ServiceId));
  if (bad.length > 0) {
    throw new InvalidServicesFlagError(
      `unknown service ${bad.map((b) => `"${b}"`).join(", ")} — valid values are ${SERVICE_IDS.join(", ")}, or "all"`,
    );
  }
  return parts as readonly ServiceId[];
}

/** `--port`, validated as a TCP port. */
export function parsePortFlag(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidServicesFlagError(`--port must be an integer in 1–65535 (got "${raw}")`);
  }
  return port;
}

/** `--space-type`, validated against the two Thredz space types. */
export function parseSpaceTypeFlag(raw: string | undefined): "shared" | "individual" | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw !== "shared" && raw !== "individual") {
    throw new InvalidServicesFlagError(
      `--space-type must be "shared" or "individual" (got "${raw}")`,
    );
  }
  return raw;
}

/**
 * The `.env` setup writes: `--env-file`, else the file beside the spec.
 *
 * A harness whose `.env` is a symlink to a shared fleet file is written
 * THROUGH the link, which is what a fleet wants — one file, every role's
 * variables — and matches how each harness's launcher sources it.
 */
export function resolveEnvFile(target: SetupTarget, override: string | undefined): string {
  return override === undefined ? join(target.harnessDir, ".env") : resolve(override);
}

/**
 * Name the env file for the plan, resolving a symlink to what it points at.
 *
 * A fleet commonly gives each harness a `.env` symlinked to one shared file
 * so every launcher sources the same variables. Writing goes THROUGH the link,
 * which is what you want — but a plan that says only `./secretary/.env` hides
 * that this run is about to edit a file every other harness reads. Say both.
 */
export function describeEnvTarget(envFile: string): string {
  try {
    // Test the FILE, not its resolved path. Comparing against `realpathSync`
    // alone would fire on any path with a symlinked ancestor — on macOS that
    // is every temp path, since `/var` links to `/private/var` — and turn a
    // useful signal into constant noise.
    if (!lstatSync(envFile).isSymbolicLink()) return envFile;
    return `${envFile} → ${realpathSync(envFile)}`;
  } catch {
    // Not yet created — there is nothing to resolve, and setup will make it.
    return envFile;
  }
}

/**
 * Render the plan the operator is about to approve.
 *
 * Everything that reaches this function is a name, a hostname, a port or a
 * variable NAME — never a credential value. The provisioning tokens are shown
 * only as the env variable they came from.
 */
export function describePlan(target: SetupTarget, opts: SetupOptions, envFile: string): string[] {
  const services = selectedServices(target, opts);
  const lines: string[] = [
    `harness   ${target.name}  (${basename(target.specPath)}, ${target.shape ?? "unknown"} target)`,
    `events    :${target.eventsPort}${target.gatewayPort === undefined ? "" : `   control UI :${target.gatewayPort} (not tunnelled)`}`,
    `writes    ${describeEnvTarget(envFile)}`,
    "",
  ];
  const hostname = defaultHostname(target, opts);

  if (services.includes("cloudflare")) {
    lines.push("Cloudflare");
    lines.push(`  → find-or-create tunnel "${opts.tunnelName ?? "crewhaus"}"`);
    lines.push(
      `  → public hostname ${hostname ?? "(needs --zone)"} → http://${opts.originHost ?? "localhost"}:${target.eventsPort}`,
    );
    lines.push(
      `  → DNS CNAME ${hostname ?? "(needs --zone)"} → <tunnel>.cfargotunnel.com (proxied)`,
    );
  }
  if (services.includes("thredz") && target.thredz !== undefined) {
    const type =
      opts.spaceType ?? (target.thredz.visibility === "shared" ? "shared" : "individual");
    lines.push("Thredz");
    lines.push(
      `  → find-or-create ${type} wiki space "${opts.spaceSlug ?? target.thredz.space ?? target.name}"`,
    );
    lines.push(`  → set thredz.space in ${basename(target.specPath)}`);
  }
  if (services.includes("agentmail") && target.agentmail !== undefined) {
    const inboxVar = slotEnvName(target.agentmail.inboxId);
    lines.push("AgentMail");
    lines.push(
      `  → find-or-create inbox for "${target.name}"${opts.mailDomain === undefined ? "" : ` on ${opts.mailDomain}`}`,
    );
    lines.push(`  → inbox id → $${inboxVar ?? "(needs --inbox-var)"}`);
    lines.push(
      opts.scopedKeyVar === undefined
        ? "  → the org key is NOT written to the harness (pass --scoped-key VAR for an inbox-scoped one)"
        : `  → mint an inbox-scoped key → $${opts.scopedKeyVar}`,
    );
    if (target.agentmail.matchedByNameOnly) {
      // The match rested on a variable name with no AgentMail credential
      // beside it. Another provider's MCP child could carry the same name, so
      // say so before anything is created rather than after.
      lines.push(
        `  ~ matched on the name "${target.agentmail.specInboxVar ?? "?"}" alone — no AgentMail`,
        "    credential is declared in that env block. Skip with --services if this",
        "    harness uses a different mail provider.",
      );
    }
  }
  if (services.includes("slack") && target.slack !== undefined) {
    const scopes = slackScopes(target.slack.channelReactions);
    lines.push("Slack");
    lines.push(`  → create app "${target.name}" from a manifest (${scopes.length} bot scopes)`);
    lines.push(`  → events   https://${hostname ?? "<host>"}/slack/events`);
    lines.push(`  → actions  https://${hostname ?? "<host>"}/slack/actions`);
    lines.push(
      opts.manualInstall === true
        ? "  → print the install URL; you paste the bot token"
        : "  → open the install page, capture the bot token through the tunnel",
    );
  }
  return lines;
}

/** Everything a run produced, for the caller to render and exit on. */
export type ServicesRunResult = {
  readonly changes: readonly AppliedChange[];
  readonly followUp: readonly string[];
  readonly failed: boolean;
};

/**
 * Run the steps, in the order `plan.ts` documents: Cloudflare (the hostname
 * the Slack URLs point at), Thredz (independent, and the cheapest thing to
 * fail early on), Slack last (the only step that needs the hostname live).
 *
 * A step that throws stops the run. Partial progress is REPORTED rather than
 * rolled back: every step is idempotent, so the fix is to correct the cause
 * and re-run, and unwinding a half-made Slack app would throw away a signing
 * secret that cannot be re-read.
 */
export async function runServicesSetup(
  ctx: SetupContext,
  envFile: string,
): Promise<ServicesRunResult> {
  const services = selectedServices(ctx.target, ctx.options);
  const changes: AppliedChange[] = [];
  const followUp: string[] = [];
  let hostname = defaultHostname(ctx.target, ctx.options);

  try {
    if (services.includes("cloudflare")) {
      const cf = await applyCloudflare(ctx);
      changes.push(...cf.changes);
      hostname = cf.hostname;
      if (cf.connectorHint !== undefined) followUp.push(...cf.connectorHint);
    }
    if (services.includes("thredz")) {
      const th = await applyThredz(ctx);
      changes.push(...th.changes);
    }
    // AgentMail sits with Thredz rather than with Slack: it needs no public
    // hostname, so it belongs in the cheap-to-fail-early group ahead of the
    // one step that creates something unrecoverable.
    if (services.includes("agentmail")) {
      const am = await applyAgentMail(ctx, envFile);
      changes.push(...am.changes);
      followUp.push(`Mail sends as ${am.email} — that address is the harness's sender identity.`);
      // Setup writes .env and stops there deliberately. Taking the mail tier
      // live is the operator's second edit: a `$VAR` ref under
      // mcp_servers.*.env is a HARD boot gate that treats empty as unset, so
      // uncommenting one before its value exists kills the daemon at next
      // start. That is the same reason setup prints the cloudflared command
      // instead of running it.
      if (am.needsUncomment !== undefined) {
        followUp.push(
          `Take the mail tier live: ${am.needsUncomment} in ${basename(ctx.target.specPath)}, then restart.`,
        );
        // The inbox id is only half of it. The AgentMail credential is
        // usually commented out on the same block, and an MCP child missing
        // it throws at the FIRST SEND rather than at boot — so a harness that
        // looks healthy fails the first time it matters. Name both.
        followUp.push(
          "  Check the AgentMail key ref on that same env block is live too — a missing " +
            "one fails at the first send, not at boot.",
        );
      }
    }
    if (services.includes("slack")) {
      if (hostname === undefined) {
        throw new ServiceSetupError("slack", "no public hostname for the Slack Request URLs", {
          fix: "pass --zone (so setup can derive one) or --hostname, or run the cloudflare step",
        });
      }
      const sl = await applySlack(ctx, hostname, envFile);
      changes.push(...sl.changes);
      followUp.push(...sl.followUp);
    }
    return { changes, followUp, failed: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const service: ServiceId =
      err instanceof ServiceSetupError && err.service !== "harness" ? err.service : "cloudflare";
    changes.push({ service, summary: "step failed", outcome: "failed", error: message });
    return { changes, followUp, failed: true };
  }
}

/**
 * Open a URL in the operator's browser, falling back to printing it.
 *
 * `spawn` with an argv array and no shell: the URL is one this tool built
 * from its own manifest response, but passing any URL through a shell string
 * is how that stops being true later. Failure is never fatal — the caller
 * prints the URL instead, which is all the browser would have done.
 */
export function openInBrowser(url: string): Promise<void> {
  return new Promise((done) => {
    const [cmd, ...prefix] =
      process.platform === "darwin"
        ? ["open"]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", ""]
          : ["xdg-open"];
    try {
      const child = spawn(cmd as string, [...prefix, url], { stdio: "ignore", detached: true });
      child.on("error", () => done());
      child.unref();
      done();
    } catch {
      done();
    }
  });
}

/** Build the io seam over the real terminal. */
export function terminalIo(ask?: (q: string, secret: boolean) => Promise<string>): SetupIo {
  const io: SetupIo = {
    info: (line) => process.stdout.write(`  ${line}\n`),
    warn: (line) => process.stdout.write(`  ~ ${line}\n`),
    openUrl: openInBrowser,
    ...(ask === undefined
      ? {}
      : {
          prompt: (q: string, o: { secret: boolean }) =>
            ask(q, o.secret).then((v) => (v === "" ? undefined : v)),
        }),
  };
  return io;
}

export {
  applyCloudflare,
  applySlack,
  applyThredz,
  portInUse,
  readSetupTarget,
  renderChanges,
  resolveCredentials,
  selectedServices,
  startResponder,
  ServiceSetupError,
};
export type { ServiceId, SetupContext, SetupCredentials, SetupIo, SetupOptions, SetupTarget };

/** Does a harness directory look provisionable at all? Used for a better error. */
export function looksLikeHarness(specPath: string): boolean {
  return existsSync(specPath) && existsSync(dirname(specPath));
}
