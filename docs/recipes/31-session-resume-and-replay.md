# Recipe 31 — Session Resume and Replay

Resume a prior chat session by id, replay the JSONL event log into
a fresh runtime, branch off a graph checkpoint to explore alternative
paths, and use Studio's trace-replay viewer to step through a past
run at 1×/2×/4× or raw speed.

You'd use resume / replay when:

- The agent's process was **interrupted** (crash, deploy, signal) and
  you want to pick up the conversation.
- A user **comes back later** to continue an earlier interaction
  (channel bots default to this via session keying).
- You want to **inspect what happened** — for debugging, eval, or
  customer support.

For one-shot CLI invocations, resume is unused but cheap to keep
enabled.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- [Recipe 17 — Observability](17-observability.md) for the
  trace-event taxonomy.

## Session anatomy

Every run writes two files under `.crewhaus/sessions/`:

```
.crewhaus/sessions/
  sess_abc123def4567890.json      # metadata
  sess_abc123def4567890.jsonl     # append-only event log
```

The 16-hex session id (`sess_<16hex>`) prints at the start of every
run. File permissions are `0o600` — only the owning user can read.

### Metadata

```json
{
  "sessionId": "sess_abc123def4567890",
  "specName": "hello",
  "createdAt": "2026-05-11T08:00:00Z",
  "lastTurnAt": "2026-05-11T08:42:13Z",
  "turnCount": 7,
  "modelTokensIn": 4821,
  "modelTokensOut": 1043
}
```

The metadata is **updated on every turn** (atomic rename). The JSONL
log is the source of truth for content; the metadata is for fast
listing.

### Event log

Append-only, one JSON object per line. Event kinds:

| Kind                | Replayable? | Content                                              |
| ------------------- | ----------- | ---------------------------------------------------- |
| `user_message`      | yes          | The user's input + any system reminders.             |
| `assistant_message` | yes          | The model's reply text + tool_use content blocks.    |
| `tool_use`          | no (already nested in assistant_message) | One tool invocation about to run. |
| `tool_result`       | no (already nested) | The tool's output or a truncation pointer.        |
| `error`             | no           | A recovered or unrecovered error with taxonomy.       |
| `compaction`        | no           | A snip or autocompact event with token deltas.        |

## Resume path

```bash
bun apps/cli/src/index.ts run examples/hello-cli/crewhaus.yaml \
  --resume sess_abc123def4567890
```

The runtime:

1. Loads metadata to confirm the spec name matches.
2. Walks the JSONL, picking up only `user_message` and `assistant_message`
   events.
3. Reconstructs a `MessageParam[]` — the model's conversation history.
4. Starts a new turn at the next user input.

### Why only those two event kinds

`tool_use` and `tool_result` are already **nested inside** the
assistant_message and user_message content arrays — the replay walks
the conversation, not the side effects. Replaying side effects would
re-execute them (re-write that file, re-call that API), which is the
opposite of what resume should do.

`error` and `compaction` events are **observability-only**. They
inform the human reader of what happened; the runtime doesn't need
them to replay.

The result: resume is **safe** — replaying never re-runs tool
side effects. The conversation history reaches the model exactly as
it would on a fresh turn.

## Channel-bot session keying

For long-running daemons ([Recipe 03](03-slack-bot.md)), sessions
are derived deterministically from the routing key:

```
sess_<sha256(routing.sessionKey)[:16]>
```

So a Slack thread with `routing.sessionKey: thread` always produces
the same session id, and every reply in the thread resumes the
prior turn automatically.

The `routing.sessionKey` options:

| Value     | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `thread`  | One session per Slack thread / Telegram chat / Discord channel. |
| `user`    | One session per user across all channels.                      |
| `channel` | One session per channel (rarely useful).                       |

This is why a channel bot picks up where the conversation left off
without any explicit "resume" — the routing key derives the session
id, and the runtime resumes by id.

## Branching (graph target only)

For `target: graph` ([Recipe 05](05-stateful-graph.md)), checkpoints
let you fork mid-run:

```bash
bun run run:hello-graph -- --branch-from run_<id> checkpoint_2
```

The runtime:

1. Loads checkpoint 2's state from `.crewhaus/checkpoints/run_<id>/checkpoint_2.json`.
2. Spawns a new run id whose initial state is checkpoint 2.
3. Continues from there.

Branches share the **upstream prefix** of state but diverge from the
checkpoint onward. So you can:

- Run two branches in parallel to compare alternative completions.
- Roll back a bad decision by branching off the checkpoint before
  it.
- Run an eval that produces side-by-side comparisons for the same
  prefix.

`crewhaus diff run_<id> run_<branchedId>` shows which state keys
diverged and at which checkpoint.

## Eviction

Sessions older than **30 days** (mtime-based) are evicted on the
next `list()` call. This is the runtime's only automatic deletion —
nothing else garbage-collects sessions.

To force eviction:

```bash
touch -t 202001010000 .crewhaus/sessions/sess_*.json
crewhaus sessions list   # this triggers the eviction check
```

To extend retention beyond 30 days:

```bash
CREWHAUS_SESSION_RETENTION_DAYS=180 crewhaus sessions list
```

Or volume-mount `.crewhaus/sessions/` and rely on storage-tier
retention policies.

For **regulated workloads** that need years of session retention,
use the audit log ([Recipe 22](22-compliance-and-audit.md)) — it
has its own retention policy independent of session files.

## Studio trace-replay

The Studio webview ([Recipe 35](35-studio-walkthrough.md)) embeds a
trace replay engine:

```typescript
import { replay } from "@crewhaus/trace-viewer";

for await (const event of replay(events, { speed: 1 })) {
  render(event);
}
```

Speed options:

| Speed   | Behavior                                                  |
| ------- | --------------------------------------------------------- |
| `"raw"` | Replay at real-time, capped at 5s per gap.                |
| `1`     | Same as raw but capped at 1s per gap.                     |
| `2`     | 0.5× real-time gaps.                                       |
| `4`     | 0.25× real-time gaps.                                      |

The 5s gap cap means a 10-minute pause between turns replays in 5s
at speed 1 — long thinking gaps don't make the replay sit there.

The viewer renders:

- **User messages** as bubbles.
- **Assistant messages** with markdown rendering + nested tool calls.
- **Tool calls** as collapsed cards (click to expand and see args + output).
- **Errors** highlighted in red.
- **Compaction events** as gray bars.

## CLI surface

```bash
crewhaus sessions list           # show all sessions with metadata
crewhaus sessions show <id>      # pretty-print the JSONL log
crewhaus sessions purge <id>     # delete one session
crewhaus sessions purge --before 2026-04-01  # bulk purge by date
crewhaus sessions export <id> > export.jsonl  # dump for archival
```

## Reading the JSONL log

```bash
SESSION=$(ls -t .crewhaus/sessions/sess_*.jsonl | head -1)
cat "$SESSION" | jq -r 'select(.kind == "user_message") | .payload.content'
```

prints every user message in order. To see assistant text:

```bash
cat "$SESSION" | jq -r 'select(.kind == "assistant_message") | .payload.content[] | select(.type == "text") | .text'
```

To see tool calls:

```bash
cat "$SESSION" | jq -c 'select(.kind == "tool_use") | { tool: .payload.name, input: .payload.input }'
```

These one-liners are the right starting point for debugging — full
search infrastructure (Recipe 17) is overkill for one session.

## Tool result truncation

Outputs over 10 KB are truncated in the JSONL log with a pointer to
the full content stored separately:

```json
{ "kind": "tool_result", "payload": { "truncated": true, "previewBytes": 10240, "fullPath": ".crewhaus/tool-results/<runId>/<callId>.txt" } }
```

`.crewhaus/tool-results/<runId>/` carries the full content. Sessions
preserved for resume **don't** need these files (replay doesn't
re-read tool results), but archival workflows usually want both the
JSONL and the result store.

## Things that look like resume but aren't

| Symptom                                                          | Better tool                                       |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| Want to **re-run** a session from scratch with deterministic same output. | Set `temperature: 0` in spec + replay user messages. |
| Want to **fork** a session mid-conversation.                     | Graph branching (`--branch-from`) for graph targets only. |
| Want to share a session with a coworker.                          | `crewhaus sessions export <id>` + import the JSONL.  |
| Want to keep an audit trail.                                       | Audit log ([Recipe 22](22-compliance-and-audit.md)). |

## What to read next

- **Graph-only state forking.** [Recipe 05 — Stateful Graph](05-stateful-graph.md).
- **Studio trace timeline.** [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md).
- **Audit log (different retention story).** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).

## Pointers to source

- **Session store:** [`packages/session-store`](../../packages/session-store).
- **Event log:** [`packages/event-log`](../../packages/event-log).
- **Branch history (graph only):** [`packages/branch-history`](../../packages/branch-history).
- **Checkpoint store:** [`packages/checkpoint-store`](../../packages/checkpoint-store).
- **Trace viewer / replay:** [`packages/trace-viewer`](../../packages/trace-viewer).
- **Module catalog reference:** §10 (sessions/event-log), §19 (branch-history), §31 (trace-viewer) in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
