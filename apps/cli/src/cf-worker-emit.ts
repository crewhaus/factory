/**
 * `crewhaus compile --emit-as cf-worker`: the switch moved to
 * `@crewhaus/compile-service`, so a draft can be built for a Cloudflare Worker
 * without the CLI. This path re-exports it for every existing import.
 */
export {
  CF_WORKER_EMIT_TARGETS,
  type CfWorkerEmitOptions,
  emitCfWorkerBundle,
} from "@crewhaus/compile-service";
