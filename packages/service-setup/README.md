# @crewhaus/service-setup

Provisioning for the external services a harness needs but cannot create itself: a Slack app, a
Cloudflare tunnel with a public hostname, and a Thredz wiki space.

A spec says *that* it wants a Slack channel, a public URL and a hosted wiki. Turning that into
apps, hostnames and spaces has always been a click-path through three consoles. This package is
that click-path as code, and it powers `crewhaus services setup`.

```bash
crewhaus services setup crewhaus.yaml --zone example.com --port 3000
```

## What it does

| Service | What setup creates | What it writes back |
| --- | --- | --- |
| Cloudflare | a named tunnel (found or created), a public hostname pointed at the daemon's events port, and the proxied DNS record | nothing — the tunnel is account state |
| Thredz | a wiki space, `individual` by default so the harness's memory stays private to its key | `thredz.space` in the spec |
| Slack | an app built from a manifest, with both request URLs set, then installed to the workspace | the bot token, signing secret, app id and OAuth client pair in the harness `.env` |

Everything is derived from the spec. The credential variable **names** come from the spec's own
`$VAR` refs, so a fleet that prefixes per role and a lone harness using bare defaults both work
without this package knowing either convention exists.

## Two things worth knowing

**Setup stands in for the daemon while Slack verifies.** A Slack app's request URL has to answer
a `url_verification` challenge, and the thing that would answer is the compiled daemon — which
refuses to boot without the signing secret that only the app-creation response carries. Setup
breaks the circle by binding the events port itself for the length of the run and echoing the
challenge, then releasing the port. If something is already listening, it skips that entirely and
lets the daemon answer.

**Provisioning credentials are a different tier from harness credentials.** The Cloudflare API
token, the Slack app-configuration token and the Thredz key are read once, used, and dropped —
never written into a spec, never written into `.env`. What lands in the harness is only what the
daemon itself needs. That boundary is why this is a separate command from `channel provision`
rather than an `--apply` flag on it.

## Credentials

Setup looks for each token in the process environment, then the harness `.env`, then prompts.
A filled `.env` makes the command non-interactive. There is no flag for a token — a credential on
an argv line lands in shell history and in every process listing on the machine.

| Variable | Where to mint it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → API tokens. Needs *Account · Cloudflare Tunnel · Edit*, *Zone · DNS · Edit*, *Zone · Zone · Read* |
| `SLACK_CONFIG_TOKEN` | api.slack.com/apps → Your App Configuration Tokens. Short-lived; there is no API to mint one |
| `THREDZ_API_KEY` | thredz.crewhaus.ai → API keys, with a wiki read-write grant. One key per agent — a key owns at most one individual space |

## Safety

- Every write to `.env` preserves comments and ordering, promotes a `# KEY=` stub in place, and
  leaves the file at `0600`.
- The Cloudflare ingress write is read-merge-write. A plain `PUT` replaces the whole
  configuration, so a naive write would delete every other harness's hostname.
- Setup never installs or restarts the cloudflared connector. It prints the command for you.
- Nothing here shells out, and no module reads `process.env` or calls global `fetch` — the
  environment and the network are injected, so the whole surface is testable without credentials.

## Library use

```ts
import { readSetupTarget, applyCloudflare, applyThredz, applySlack } from "@crewhaus/service-setup";

const target = readSetupTarget("crewhaus.yaml", { eventsPort: 3000 });
const ctx = { target, options: { zone: "example.com" }, credentials, io };
const cf = await applyCloudflare(ctx);
await applySlack(ctx, cf.hostname, "./.env");
```

`plan.ts` documents the step order and why it is what it is; `responder.ts` documents the
verification deadlock and how it dissolves.

## License

Apache-2.0
