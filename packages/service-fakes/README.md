# service-fakes

Loopback fakes of the services a harness talks to: a model provider, Slack, GitHub, Thredz and SMTP.
Test-only, and **never published**. The module brief is
[327-service-fakes](https://github.com/crewhaus/docs/blob/main/module-briefs/327-service-fakes.md).

It has no dependencies, so any package's own tests can start a fake with no cycle:

```json
{ "devDependencies": { "service-fakes": "workspace:*" } }
```

Always `workspace:*`, so this package only ever resolves to the copy in this repo;
`scripts/private-packages.test.ts` fails on anything else.

## The fakes

Each is a synchronous factory that binds `127.0.0.1` on an OS-assigned port and returns
`{ url, port, stop() }`. Each attaches through a seam the real client already has, so the code under
test is the code that ships.

| Fake | Attach it through | What it does |
|---|---|---|
| `fakeModel` | `ANTHROPIC_BASE_URL` | The Messages API, plain and SSE. Replies are scripted by `promptDigest(body)`, and a prompt nobody scripted is a 400 naming its digest, so a test cannot pass on a reply nobody wrote. Scripted 401, 429 and 529 faults, and declared prices for assertions |
| `fakeSlack` | `apiBaseUrl`, or `SLACK_API_BASE_URL`, set to `fake.apiBaseUrl` | A sink for Web API calls, with a scope table and rate-limit faults, and signed event, interaction and command deliveries |
| `fakeGitHub` | a client's `baseUrl`, and `fake.gitUrl(name)` as a git remote | An in-memory REST subset, real smart HTTP through `git http-backend`, and signed webhooks |
| `fakeThredz` | a harness's `thredz.base_url` set to `fake.baseUrl` | Answers what a test registers, and 404s the rest as the API does |
| `fakeSmtp` | `sendMail` with `requireTls: false` | Records messages. It offers no STARTTLS, because an upgrade cannot be served in-process |

Every recording has its credentials masked by key name, and a delivery refuses any receiver that is
not on this machine. Credentials and signing secrets are made at runtime, so no secret-shaped literal
is committed.

`listeningAddresses(pid, port)` asks the operating system what a process is really listening on. It
returns `undefined` when it cannot tell, and callers fail on that: could not determine is not no.
