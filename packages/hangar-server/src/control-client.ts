/**
 * The `crewhaus.control.v1` client the manager proxies through — re-exported.
 *
 * The client moved to `@crewhaus/gateway-protocol/control-client`, beside the
 * daemon side of the protocol, so every head that drives a daemon (this
 * server, `crewhaus daemon`, and what comes next) shares one client without
 * depending on this HTTP server. This module re-exports every name it used
 * to define, as the same bindings, for one release; import from
 * `@crewhaus/gateway-protocol/control-client` instead.
 */
export {
  CONTROL_LANES,
  CONTROL_LISTENING_RE,
  createControlClient,
  DEFAULT_CONTROL_TIMEOUT_MS,
  isControlLane,
  knownControlPort,
  parseControlPort,
  type ControlClient,
  type ControlClientOptions,
  type ControlDrainBody,
  type ControlLane,
  type ControlOk,
  type ControlRefusal,
  type ControlRefusalCode,
  type ControlResult,
  type ControlStatusBody,
  type ControlTarget,
  type ControlTimerReport,
  type ControlWakeBody,
} from "@crewhaus/gateway-protocol/control-client";
