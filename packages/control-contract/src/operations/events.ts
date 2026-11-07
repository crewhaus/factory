import { READ, STREAM_ONLY } from "./shared.js";

export const EVENT_OPERATIONS = [
  {
    ...READ,
    id: "events.fleet",
    method: "GET",
    path: "/api/v1/events",
    permission: "home.read",
    request: "streamQuery",
    response: "eventFrame",
    stream: "sse",
    cliTwin: null,
    noTwinReason: STREAM_ONLY,
    qualifiers: ["filtered"],
  },
  {
    ...READ,
    id: "events.harness",
    method: "GET",
    path: "/api/v1/harnesses/{h}/events",
    permission: "h.read",
    request: "streamQuery",
    response: "eventFrame",
    stream: "sse",
    cliTwin: null,
    noTwinReason: STREAM_ONLY,
    qualifiers: [],
  },
] as const;
