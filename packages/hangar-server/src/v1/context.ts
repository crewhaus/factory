/**
 * What a versioned-API handler is handed: the operation it serves, its parsed params,
 * query and body, the caller's authority (`RequestAccess`), and Home's own parts. A
 * handler answers a body and a status; the router masks every answer at its one exit.
 */
import type { DeviceRequests } from "@crewhaus/access-control";
import type { OperationRow, ReceiptVia } from "@crewhaus/control-contract";
import type { ControlService, Projection } from "@crewhaus/control-service";
import type { ControlClient, ControlTarget } from "@crewhaus/gateway-protocol/control-client";
import type { HangarHarnessEntry, HangarRegistry } from "@crewhaus/harness-registry";
import type { ApiRunInput, StartResult } from "@crewhaus/harness-supervisor";
import type { Caller, HomeAccess, RequestAccess } from "../access";
import type { TextScrubber } from "../mask";
import type { StreamSourceDecl } from "./event-map";
import type { StreamPlan, StreamTimings } from "./stream";

/** The daemon's state as Home's supervisor sees it. */
export type DaemonState = "running" | "starting" | "draining" | "stopped" | "crashed" | "unknown";

/** A daemon's control answer: its `/status` body, or why it could not be asked. */
export type DaemonStatus =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

export type V1Deps = {
  readonly hangarRoot: string;
  /** Where installed plugins live (`~/.crewhaus/plugins`). */
  readonly pluginsDir: string;
  readonly registry: HangarRegistry;
  readonly control: ControlService;
  readonly home: HomeAccess;
  readonly devices: DeviceRequests;
  readonly now: () => number;
  readonly onWarn: (message: string) => void;
  readonly version: string;
  /** The owner's public address for Home, when set. */
  readonly baseUrl?: string;
  readonly harnessScrub: (dir: string) => TextScrubber;
  readonly fleetScrub: () => TextScrubber;
  /** What Home's supervisor says the daemon is doing. */
  readonly daemonState: (entry: HangarHarnessEntry) => Promise<DaemonState>;
  /** The daemon's own control status, when one is reachable. */
  readonly daemonStatus: (entry: HangarHarnessEntry) => Promise<DaemonStatus>;
  /**
   * Start one job for a run the control API queued, through Home's supervisor: its plan
   * passes `apiRun`. Absent: Home starts no jobs, and a job run is refused.
   */
  readonly startRunJob?: (entry: HangarHarnessEntry, apiRun: ApiRunInput) => Promise<StartResult>;
  /** Stop the job a run Home started is running in; `false` when Home holds none for it. */
  readonly stopRunJob?: (entry: HangarHarnessEntry, runId: string) => Promise<boolean>;
  /** The control client Home reaches daemons with, and where a harness's daemon listens. */
  readonly controlClient?: ControlClient;
  readonly controlTarget?: (entry: HangarHarnessEntry) => Promise<ControlTarget>;
  /** Stop a harness's daemon the way `crewhaus daemon stop` does, for retire. */
  readonly stopDaemon: (entry: HangarHarnessEntry) => Promise<{
    readonly ok: boolean;
    readonly detail: string;
  }>;
  /**
   * An event stream's abort signal and its end: the client going away, its session
   * ending, or its re-check refusing it. A stream calls `dispose` once it finishes, for
   * every reason. Absent: a stream closes only when its client goes.
   */
  readonly streamSignal?: (req: Request) => {
    readonly signal: AbortSignal | undefined;
    readonly dispose: () => void;
  };
  /**
   * The caller's authority as the access records stand now. A stream's reads run after
   * its handler returned, so each batch decides on this, never on the request's own.
   */
  readonly accessNow?: (caller: Caller) => RequestAccess;
  /** A stream's pacing, shortened by tests. */
  readonly streamTimings?: StreamTimings;
};

export type V1Context = {
  readonly req: Request;
  readonly url: URL;
  readonly op: OperationRow;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** The request body, checked against the operation's request schema. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly access: RequestAccess;
  readonly deps: V1Deps;
  /** The `Idempotency-Key` the caller sent, checked. */
  readonly idempotency?: string;
  /** Which door this came through, for the receipts it writes. */
  readonly via: ReceiptVia;
  /** The caller as a receipt's actor: a `prn_`, or absent for Home's own OS user. */
  readonly actor?: string;
  /** The credential (`crd_…`) the caller authenticated with, when it used one. */
  readonly credentialRef?: string;
  /** Every area's ref resolvers, by kind. */
  readonly refResolvers: ReadonlyMap<string, RefResolver>;
  /** Every area's capability providers. */
  readonly capabilityProviders: readonly CapabilityProvider[];
  /** Every area's projections, with the area that registered each. */
  readonly projections: ReadonlyArray<{
    readonly area: string;
    readonly projection: Projection<unknown>;
  }>;
  /** Every area's sources of a harness's event stream. */
  readonly streamSources: readonly StreamSourceDecl[];
};

/** A handler's answer with a body. `scrubDir` names the harness whose secrets the masker scrubs. */
export type V1BodyAnswer = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly scrubDir?: string;
};

/** A handler's answer: a body, or an event stream. */
export type V1Answer =
  | V1BodyAnswer
  | {
      readonly status: 200;
      /** An event stream: the router sends it through the one stream writer. */
      readonly stream: StreamPlan;
      readonly scrubDir?: string;
    };

export type V1Handler = (ctx: V1Context) => Promise<V1Answer>;

/** A ref kind's resolver: what `refs.resolve` answers for `<scope>/<kind>/<id>`. */
export type RefResolver = (
  ctx: V1Context,
  ref: { readonly scope: string; readonly kind: string; readonly id: string },
) => Promise<V1Answer>;

/** One capability key a provider can answer for a harness, beside the core's eight. */
export type CapabilityProvider = {
  readonly key: string;
  answer(
    entry: HangarHarnessEntry,
    ctx: V1Context,
  ): Promise<
    | { readonly supported: true }
    | { readonly supported: false; readonly reason: string; readonly verb: string | null }
    | { readonly supported: "unknown"; readonly reason: string }
  >;
};
