/**
 * The versioned API's run stream, read over `fetch`: `GET /api/v1/runs/<run>/events`
 * with `?harness=<id>` always sent and `Last-Event-ID` when resuming. Each frame
 * reaches `onFrame({id, event, data})`; the end of the connection reaches `onEnd`
 * once, with why. A bearer header is sent from this tab's session, which is why
 * this is `fetch` and not `EventSource`.
 *
 * `parseFrames` is pure and exported for tests.
 */

import { getSession, recoverSession } from "../api.js";

const PROTOCOL = "crewhaus.hangar.v1";

/** One `id:` / `event:` / `data:` block → `{id, event, data}`, or null (a comment). */
function frameOf(raw) {
  let id = null;
  let event = "message";
  const data = [];
  for (const line of raw.split("\n")) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (clean.startsWith(":")) continue;
    if (clean.startsWith("id:")) id = clean.slice(3).trim();
    else if (clean.startsWith("event:")) event = clean.slice(6).trim();
    else if (clean.startsWith("data:")) data.push(clean.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    parsed = null;
  }
  return { id, event, data: parsed };
}

/** An incremental parser: `push(text)` answers the frames that text completed. */
export function parseFrames() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk).replace(/\r\n/g, "\n");
      const out = [];
      let at = buffer.indexOf("\n\n");
      while (at !== -1) {
        const frame = frameOf(buffer.slice(0, at));
        if (frame !== null) out.push(frame);
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf("\n\n");
      }
      return out;
    },
  };
}

/** The address of a run's stream. */
export function streamPath(run, harness) {
  return `/api/v1/runs/${encodeURIComponent(run)}/events?harness=${encodeURIComponent(harness)}`;
}

/**
 * Open one connection: a run's stream, or any other v1 stream `path` names (Home's
 * fleet stream, a harness's). `lastEventId` resumes after that cursor. Answers
 * `{close}`; `onEnd(reason)` gets `"ended"`, `"dropped"`, `"refused:<status>"`
 * or `"closed"` (this side closed it).
 */
export function openRunStream({
  run,
  harness,
  path = null,
  lastEventId = null,
  onFrame,
  onEnd,
  fetchImpl,
}) {
  const controller = new AbortController();
  let ended = false;
  const end = (reason) => {
    if (ended) return;
    ended = true;
    onEnd?.(reason);
  };
  const doFetch = fetchImpl ?? fetch;
  (async () => {
    const headers = { accept: "text/event-stream", "CrewHaus-Protocol": PROTOCOL };
    const session = getSession();
    if (session) headers.authorization = `Bearer ${session}`;
    if (typeof lastEventId === "string" && lastEventId !== "")
      headers["Last-Event-ID"] = lastEventId;
    let res;
    try {
      res = await doFetch(path ?? streamPath(run, harness), {
        headers,
        signal: controller.signal,
      });
    } catch {
      end(controller.signal.aborted ? "closed" : "dropped");
      return;
    }
    if (res.status === 401) {
      void recoverSession({ stream: true });
      end("refused:401");
      return;
    }
    if (!res.ok || res.body === null || res.body === undefined) {
      end(`refused:${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = parseFrames();
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        end(controller.signal.aborted ? "closed" : "dropped");
        return;
      }
      if (chunk.done) break;
      for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        if (controller.signal.aborted) return;
        onFrame(frame);
      }
    }
    end(controller.signal.aborted ? "closed" : "ended");
  })();
  return {
    close() {
      controller.abort();
      end("closed");
    },
  };
}
