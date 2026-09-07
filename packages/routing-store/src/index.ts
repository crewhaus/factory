/**
 * `@crewhaus/routing-store` — the durable reward scoreboard behind `model_pool`
 * learned routing. A pure `computeReward` maps each observed model call to a
 * scalar; `openScoreboard` persists per-`(routeKey, model)` aggregates so
 * selection improves the more a harness runs. See Section 17.
 */
export {
  computeReward,
  DEFAULT_OBJECTIVE,
  type RewardConfig,
  type RouteObjective,
  type RouteObservation,
} from "./reward.js";
export {
  isObserveOnlyLane,
  QUALITY_LANE_PREFIX,
  SHADOW_LANE_PREFIX,
  shadowLaneQuality,
  shadowRouteKey,
} from "./lanes.js";
export {
  openScoreboard,
  type ArmStats,
  type Scoreboard,
  type ScoreboardOptions,
  type ScoreReader,
} from "./scoreboard.js";
export {
  ROUTE_FREEZE_FILE,
  type RouteFreeze,
  type WriteRouteFreezeOptions,
  clearRouteFreeze,
  freezeScoreboard,
  readRouteFreeze,
  routeFreezePath,
  writeRouteFreeze,
} from "./freeze.js";
export {
  ROUTING_PRIORS_FILE,
  type RawRoutingPriors,
  readRoutingPriorsRaw,
  routingPriorsPath,
} from "./priors-file.js";
