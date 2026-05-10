# Recipe 09 — Voice Agent

> **Status:** stub.

## What you'll learn

Build a realtime voice agent: PCM 16-bit mono / 24 kHz audio in and
out, server- or client-side VAD, hysteresis-gated barge-in (the user
talking over the agent stops the agent's speech mid-utterance), and a
pluggable telephony adapter for Twilio / LiveKit SIP / Vapi.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the underlying chat loop.
- An OpenAI API key (Realtime API) for the default provider.

## Roadmap

1. The `target: voice` spec — `voice.provider`, `voiceId`, `vad`, `bargeInTriggerFrames`, `bargeInWindowMs`.
2. The realtime adapter contract: `connect / sendAudio / commitInput / sendText / interrupt / on / disconnect`.
3. VAD: built-in energy + zero-crossing-rate heuristic; OpenAI server-side option.
4. Barge-in: hysteresis (default 4 speech frames in 200ms) → `adapter.interrupt()`.
5. Call lifecycle: `idle → dialing → connected → on-hold → transferred → terminated`.
6. Telephony adapters: Twilio REST + Calls.update; LiveKit SIP twirp; Vonage in follow-up.
7. The `--smoke <pcm-path>` mode for headless tests.
8. Cost-and-latency tradeoffs of the three providers.

## Run it now

```bash
bun run compile:hello-voice
# Production run requires OPENAI_API_KEY + a real audio source.
# The smoke path uses a fixture PCM file:
bun run smoke:section-24
```

## Pointers to existing material

- **Example:** [`examples/hello-voice/crewhaus.yaml`](../../examples/hello-voice/crewhaus.yaml).
- **Codegen:** [`packages/target-voice`](../../packages/target-voice).
- **Modules:** [`packages/voice-runtime`](../../packages/voice-runtime), [`packages/vad-engine`](../../packages/vad-engine), [`packages/barge-in-controller`](../../packages/barge-in-controller), [`packages/call-session`](../../packages/call-session).
- **Catalog:** §24, §30 (Twilio + LiveKit + Vapi adapters).

## Where to go next

- For browser/computer-use control → [Recipe 10 — Browser Agent](10-browser-agent.md).
- For Slack / Telegram / Discord text channels → [Recipe 03 — Slack Bot](03-slack-bot.md).
