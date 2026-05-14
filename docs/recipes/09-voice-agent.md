---
test:
  spec: examples/hello-voice/crewhaus.yaml
  bun_scripts:
    - smoke:section-24
---

# Recipe 09 — Voice Agent

Build a realtime voice agent: PCM 16-bit mono / 24 kHz audio in and
out, server- or client-side VAD, hysteresis-gated barge-in (the user
talking over the agent cuts off the agent's speech mid-utterance), and
a pluggable telephony adapter for Twilio / LiveKit / Vapi.

You'd reach for `target: voice` when:

- The user **speaks**, not types — phone IVR replacement, voice-first
  product UX, drive-through ordering.
- You need **sub-second response start** — text-to-speech that begins
  streaming as the model's first tokens land.
- You need **barge-in** — the user can interrupt the agent without
  waiting for a "pause" beat.

If you want a phone-shaped *chat* (text bubbles), use a channel
adapter ([Recipe 03](03-slack-bot.md) for Slack, [Recipes 37–40](37-channel-telegram.md)
for other channels). If you want voice but offline (no realtime
latency requirements), build a [batch worker](08-batch-worker.md) that
transcribes file uploads.

<details>
<summary><strong>Architectural context</strong> — realtime is a different harness, not "CLI with audio"</summary>

OpenAI's Realtime API and the Codex App Server's bidirectional
JSON-RPC pattern ([docs/AI-Harness-Systems.md](../AI-Harness-Systems.md))
are the strongest signals that **realtime is a categorically
different harness shape**, not a thin wrapper over the chat loop.
Three properties don't compose backward into the polling REST model:

- **Audio framing** — 24 kHz PCM in *and* out, with VAD-driven turn
  boundaries instead of HTTP request/response framing.
- **Barge-in** — the user can interrupt the model mid-utterance,
  which means TTS must be cancellable per-frame, not per-message. The
  hysteresis-gated barge-in in this recipe (4 frames in a 200 ms
  window) is the same shape OpenAI's Realtime VAD events use.
- **Sub-second response-start latency** — the model must begin
  streaming tokens *and* TTS must begin pronouncing them well before
  the full response is known. This is incompatible with a `POST /run`
  + poll loop; it requires the persistent bidirectional channel that
  OpenAI's Realtime API and the App Server JSON-RPC pattern provide.

`voice` lowers to `IrVoiceV0`, which the emitter wires into a
provider-specific realtime adapter (`openai-realtime`, `vapi`). The
permissions layer still applies — tool calls inside a voice session
hit the same policy engine — but the surface is event-driven rather
than turn-driven. If you can tolerate 2-3 seconds of latency on
response start, you almost certainly want a channel adapter with TTS
on top, not the realtime target; the realtime path is cost- and
operations-heavier and only justified when latency is the product.

</details>

## Prerequisites

- An OpenAI API key (Realtime API) for the default provider, or a
  Vapi account.
- A working microphone / audio output for live testing. For headless
  tests, a PCM fixture works (see `--smoke`).
- [Recipe 01](01-cli-coding-agent.md) for the underlying chat-loop
  semantics — voice is single-turn calls into the same engine, with
  audio framing on top.

## The smallest spec

The bundled example [`examples/hello-voice/crewhaus.yaml`](../../examples/hello-voice/crewhaus.yaml):

```yaml
name: hello-voice
target: voice
agent:
  model: gpt-4o-realtime-preview
  instructions: |
    You are a brief voice assistant. Answer the user's spoken question
    in one short sentence (<=25 words). Speak naturally; the SDK
    handles audio.
voice:
  provider: openai
  voiceId: alloy
  vad: server
  bargeInTriggerFrames: 4
  bargeInWindowMs: 200
permissions:
  mode: default
```

The shape:

- **`agent.model:`** — must be a realtime-capable model. OpenAI's
  `gpt-4o-realtime-preview` is the default; Vapi exposes its own
  realtime model.
- **`voice.provider:`** — `openai` or `vapi`. The provider determines
  the realtime SDK that lazy-loads.
- **`voiceId:`** — the TTS voice. Provider-specific. OpenAI: `alloy`,
  `echo`, `fable`, `nova`, `onyx`, `shimmer`. Vapi: see their docs.
- **`vad:`** — `server` (provider-side VAD; recommended) or
  `client` (the runtime's energy-based VAD).
- **`bargeInTriggerFrames` / `bargeInWindowMs`** — barge-in
  hysteresis: 4 frames of speech in 200ms cuts off the agent's TTS.

Build the smoke smoke target to validate the bundle wiring without
needing a real audio source:

```bash
bun run smoke:section-24
```

For a live run you'd add `--microphone <device>` and `--speaker
<device>` flags, or wire to a telephony adapter (covered below).

## Audio framing

All providers normalize to **PCM 16-bit signed mono, 24 kHz**. The
realtime adapter handles upsampling/downsampling if your hardware
delivers something else (8 kHz from a SIP trunk, 48 kHz from a
browser mic).

Frames are 20ms = 480 samples = 960 bytes. The VAD operates frame-by-frame;
barge-in detection counts frames within `bargeInWindowMs`.

## VAD — voice activity detection

Two modes:

- **`vad: server`** — the provider's own VAD. For OpenAI Realtime
  this is the recommended default. The provider tells you when speech
  starts and stops; you don't run your own detector.
- **`vad: client`** — the runtime's built-in detector: energy
  (RMS amplitude) + zero-crossing rate. Lighter on the provider
  (you only send audio when speech is detected) but more
  end-to-end-latency variability.

Trade-offs:

| Mode      | Latency           | Cost                       | When to use                              |
| --------- | ----------------- | -------------------------- | ---------------------------------------- |
| `server`  | Lowest            | Provider charges per-stream | Default. Use unless cost-constrained.     |
| `client`  | Slightly higher   | Fewer provider-side frames | Cost-constrained or unreliable network. |

## Barge-in — interrupting the agent

When the agent is speaking and the user starts talking, you want the
agent to stop **immediately**, not finish its sentence. The barge-in
controller:

1. Counts speech frames in a sliding `bargeInWindowMs` window.
2. When `bargeInTriggerFrames` is reached, calls
   `adapter.interrupt()` on the realtime SDK.
3. The TTS stream cuts off mid-utterance; the agent's truncated text
   becomes a partial assistant turn in the transcript.
4. The user's new utterance starts a new turn.

The defaults (4 frames in 200ms = 80ms of speech) are tuned for
conversational interruption while ignoring brief noises (cough,
keyboard click, breath). Tune higher (`bargeInTriggerFrames: 8`,
`bargeInWindowMs: 400`) for noisy environments; tune lower
(`bargeInTriggerFrames: 2`, `bargeInWindowMs: 100`) for very
responsive systems.

## Call lifecycle

```
idle → dialing → connected → on-hold → transferred → terminated
        │            │           │           │             │
        │            ▼           ▼           ▼             │
        │       (steady-     (call put    (handed off    (final
        │        state       on hold by   to human or    state, log
        │        flow)       agent or     another        flushed)
        │                    user)         agent)
        ▼
   (telephony adapter
   dialing remote leg)
```

The state machine is in `call-session`
([packages/call-session](../../packages/call-session)). Every state
transition emits an event:

| Event                | Payload                                          |
| -------------------- | ------------------------------------------------ |
| `session_created`    | `{ callId, provider, voiceId }`                  |
| `transcript_partial` | `{ role, text, isFinal: false }`                 |
| `transcript_final`   | `{ role, text, isFinal: true }`                  |
| `audio_chunk`        | `{ role, samples, durationMs }`                  |
| `tool_use`           | Standard tool-use event from chat loop           |
| `interrupt`          | `{ initiator: "user" \| "agent", reason }`        |
| `transfer`           | `{ to, reason }`                                 |
| `disconnect`         | `{ reason: "hangup" \| "timeout" \| "error" }`    |

These flow into the JSONL session log alongside `assistant_message`
and friends.

## Telephony adapters

The bundled `voice` target is microphone/speaker by default. For real
phone calls, layer a telephony adapter:

### Twilio

```yaml
voice:
  provider: openai
  voiceId: alloy
  telephony:
    adapter: twilio
    accountSid: $TWILIO_ACCOUNT_SID
    authToken: $TWILIO_AUTH_TOKEN
    fromNumber: $TWILIO_FROM_NUMBER
```

Twilio routes the call to the worker via a media stream WebSocket.
The worker bridges Twilio frames (8 kHz µ-law) to the realtime
provider (24 kHz PCM).

### LiveKit SIP

```yaml
voice:
  telephony:
    adapter: livekit-sip
    apiKey: $LIVEKIT_API_KEY
    apiSecret: $LIVEKIT_API_SECRET
    sipServer: sip.livekit.cloud
```

LiveKit is the path if you want SIP-native (e.g. existing PBX
integration). The bridge happens server-side in LiveKit, so the
worker sees plain WebRTC tracks.

### Vapi

```yaml
voice:
  provider: vapi
  apiKey: $VAPI_API_KEY
```

Vapi is the simplest path — they own the whole telephony stack and
expose a single SDK. The realtime provider, TTS voice, and barge-in
all live inside Vapi; the worker just provides agent instructions
and tool definitions.

## Smoke mode

`--smoke <pcm-path>` lets you run headless against a fixture audio
file. The smoke harness loads the PCM, plays it into the input
buffer, captures the agent's output frames, and writes them to
stdout (or a configured output path).

This is how `bun run smoke:section-24` works — a tiny fixture in
`examples/hello-voice/` plus an assertion that the run produces N
output frames in expected time. Use the same pattern in CI for any
voice agent: record a 5-second test prompt, smoke against it, assert
on transcript text.

## Things that look like voice but aren't

| Symptom                                                            | Wrong shape  | Right shape                                    |
| ------------------------------------------------------------------ | ------------ | ---------------------------------------------- |
| You want a phone bot but the user "types" via DTMF.                | voice         | [channel](03-slack-bot.md) with a DTMF adapter |
| Async voicemail / transcribe-and-reply.                            | voice         | [batch](08-batch-worker.md) + transcription tool |
| Voice **and** a screen — multimodal kiosk UX.                      | voice         | [browser](10-browser-agent.md) with audio inputs |

Voice is the right answer when **realtime audio in / realtime audio
out** is the user experience. If you only need one of those, a
different shape is cheaper.

## Production knobs

- **Per-tenant rate limits.** Voice calls are expensive; pair voice
  with [managed](11-managed-multitenant.md) for per-tenant minute
  budgets.
- **Recording.** Set `voice.recording.path: ./recordings/` to capture
  raw PCM + transcript for QA / training. Always combine with PII
  redaction ([Recipe 23](23-pii-redaction-and-encryption.md)).
- **Latency targets.** First-token TTS should arrive ≤300ms after
  user end-of-utterance. The grafana dashboard from [Recipe 17](17-observability.md)
  carries `voice_first_token_latency_ms` as a default panel.

## What to read next

- **Computer use, not voice.** [Recipe 10 — Browser Agent](10-browser-agent.md).
- **Multi-tenant voice.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- **Test voice quality.** [Recipe 34 — Building Custom Graders](34-building-custom-graders.md)
  — graders for audio fidelity, transcript accuracy, latency.

## Pointers to source

- **Example:** [`examples/hello-voice/crewhaus.yaml`](../../examples/hello-voice/crewhaus.yaml).
- **Codegen:** [`packages/target-voice`](../../packages/target-voice).
- **Voice runtime:** [`packages/voice-runtime`](../../packages/voice-runtime).
- **VAD engine:** [`packages/vad-engine`](../../packages/vad-engine).
- **Barge-in controller:** [`packages/barge-in-controller`](../../packages/barge-in-controller).
- **Call session:** [`packages/call-session`](../../packages/call-session).
- **Spec schema (voice variant):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts) (search `voiceSchema`).
- **Module catalog reference:** §24 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
