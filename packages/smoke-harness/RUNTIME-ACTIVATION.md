# Runtime-smoke activation plan

The smoke harness ships three runtime tracks:

| Track | Shapes | Status | Source |
| --- | --- | --- | --- |
| Single-turn agent | `cli`, `browser` | active | `src/runtime.ts` |
| Compile-only daemon | `batch` | active (Anthropic-only) | `src/runtime-service.ts` |
| Service-backed daemon | `channel`, `onchain`, `voice` | scaffolded | `src/runtime-service.ts` |

This doc lays out exactly what each scaffolded shape needs to flip from "skipped" to a real-API end-to-end check. The goal is that once you have the credentials and/or infra in hand, activation is a focused code change rather than a redesign.

## Common prerequisites (all runtime tracks)

- `ANTHROPIC_AUTH_TOKEN` (Claude OAuth) **or** `ANTHROPIC_API_KEY`. Without one, every runtime test skips with a clear message. CI flips skip → fail by setting `CREWHAUS_RUNTIME_SMOKE_REQUIRED=1`.
- Workspace install (`bun install --frozen-lockfile`) so the spawned bundles can resolve their workspace deps.
- `CREWHAUS_SESSION_DIR` is handled automatically by the harness; you don't need to set it.

## `batch` — active today

- **Required envs**: Anthropic auth only.
- **Fixture**: `src/runtime-fixtures/batch.yaml` declares the in-memory adapter with two seed jobs; the daemon self-terminates after drain via the `queue_idle` shortcut in `target-batch-worker`.
- **Asserts**: `worker_start` + 2× `job_start` + 2× `job_end` + `worker_stop` events in stdout, and the magic token `smoke-batch-ok` appears in agent output (proves the model grounded in fixture instructions).
- **Activation status**: nothing to do — once an `ANTHROPIC_*` secret is wired into the `Smoke (runtime)` workflow, this test starts catching batch regressions.

## `channel` — scaffolded

- **Required envs (to leave the first gate)**: `SMOKE_SLACK_BOT_TOKEN`, `SMOKE_SLACK_SIGNING_SECRET`.
- **What's still missing**: the harness has the compile + spawn skeleton but not the inbound-event driver. To finish:
  1. Start the daemon with the Slack gateway listening on `gateway.port` (the fixture pins 18790 to avoid clashes).
  2. POST a Slack-shaped `event_callback` (channel message) to `http://127.0.0.1:18790/slack/events` with a body and an `X-Slack-Signature` HMAC computed against `SMOKE_SLACK_SIGNING_SECRET` — the daemon validates this signature before processing.
  3. Stub `slack.com/api/chat.postMessage` so the agent's outbound `sendMessage` succeeds without hitting real Slack. The cleanest way is a local `Bun.serve` that returns `{ ok: true, ts: "<nonce>" }` and an `SMOKE_SLACK_API_BASE` env override read by `channel-adapter-slack` (the override is not yet implemented in the adapter — add it as part of activation).
  4. After the synthetic webhook lands, poll the daemon's `.jsonl` event log for an `assistant_message` containing the magic token `smoke-channel-ok`.
  5. SIGTERM the daemon; assert clean shutdown via `__gatewayServer.stop(true)`.
- **Test-infra options**:
  - **Mock-Slack**: lowest friction; fully deterministic. Requires the adapter to accept a base-URL override.
  - **Real Slack workspace**: highest fidelity; needs a dedicated bot app + a channel the bot is invited to, plus a webhook simulator that posts inbound events. Slow and credential-heavy.
  - Recommendation: ship the mock-Slack track first; keep a real-workspace switch behind `SMOKE_CHANNEL_USE_REAL_SLACK=1` for occasional manual verification.

## `onchain` — scaffolded

- **Required envs (to leave the first gate)**: `SMOKE_ONCHAIN_RPC` (an EVM JSON-RPC URL).
- **What's still missing**: the trigger needs to fire during the test window. To finish:
  1. Decide on the chain: local `anvil` (cheap, deterministic, requires the foundry toolchain on the runner) or a public testnet (slow finality, costs gas, needs a funded smoke wallet).
  2. Deploy or pre-stage a contract whose `Transfer` event will be subscribed to by the bundle. With anvil, this is a one-line `cast send` against the OpenZeppelin ERC-20 mock; with a testnet, pin a known faucet token.
  3. Before spawning the daemon, fund a test wallet (`SMOKE_ONCHAIN_WALLET_KEY`) and prepare the trigger transaction; after the daemon's `event_subscriber_ready` event lands in stdout, fire the transaction.
  4. Poll the daemon's `.jsonl` for an `assistant_message` containing `smoke-onchain-ok`.
  5. Assert `idempotency_dedupe` did not strip the only event (off-by-one paranoia).
- **Test-infra options**:
  - **Anvil**: spin up via `anvil --port 8545 --chain-id 31337` in a background step; assert the daemon connected to `http://127.0.0.1:8545`. Lowest cost per run; foundry adds an install step to the workflow.
  - **Public testnet**: requires a funded smoke wallet and a stable RPC. Skip this for CI scenarios; useful for "does Base Sepolia actually work end-to-end" smoke runs.
  - Recommendation: anvil for CI, with a manual workflow_dispatch path that points at a testnet RPC for spot checks.

## `voice` — scaffolded

- **Required envs (to leave the first gate)**: `SMOKE_OPENAI_API_KEY` (or `OPENAI_API_KEY`).
- **What's still missing**: a PCM fixture + a way to capture the realtime adapter's response stream. To finish:
  1. Bundle a short (≤3s) PCM clip with a known utterance (e.g. "say smoke voice ok") under `src/runtime-fixtures/voice-clip.pcm`. Keep it lossless 16 kHz mono so the OpenAI Realtime side-channel doesn't need resampling.
  2. The emitted daemon already accepts `--pcm-path` (see `voice/daemon.ts` smoke events `smoke_start`, `smoke_pcm_loaded`); pass the fixture path to it.
  3. Capture the daemon's stdout `voice_event` stream and look for a transcription that includes `smoke-voice-ok`.
  4. Provide a hard timeout — Realtime sessions can hang on barge-in misconfigs; a 60s ceiling is plenty for one utterance.
- **Test-infra options**:
  - **OpenAI Realtime**: the only first-party path today. Cost per run is small but non-zero; gate on a separate `SMOKE_VOICE_BUDGET_OK=1` so the daily cron doesn't burn credits without explicit opt-in.
  - **Vapi**: a separate fixture + provider switch. Useful once we want to assert provider parity; out of scope for the initial activation.
  - Recommendation: ship OpenAI Realtime activation behind both `SMOKE_OPENAI_API_KEY` and `SMOKE_VOICE_BUDGET_OK=1`; cron stays at 1 run / day.

## Activation checklist (when you tackle one of the scaffolds)

1. Add the relevant secrets / configurable env vars to the `Smoke (runtime)` workflow (`.github/workflows/smoke-runtime.yml`). Keep them keyed to `secrets.*` so forks don't get them.
2. Replace the trailing `status: "skipped"` return in `runtime-service.ts` with the real driver code.
3. Add the activation steps to the test plan in the PR description so reviewers can re-run end-to-end.
4. If new test-infra (anvil, OpenAI fixture, etc.) is required, add an install step to the workflow.
5. Update this doc's status table from "scaffolded" → "active".

## Why these are gated by default

These tests issue real API calls (Anthropic + the service-specific provider). Running them on every PR would:
- Cost real money on every push to a draft branch.
- Make the per-PR CI surface flaky (network, rate limits, model variance).
- Surface credentials to forks if mis-wired.

The opt-in workflow design (`workflow_dispatch` + daily cron, separate from per-PR CI) keeps the cheap, deterministic smoke matrix as the default gate and lets the runtime tracks be the catcher's mitt for behavioural regressions on `main`.
