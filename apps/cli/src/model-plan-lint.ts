/**
 * The spec-level model-plan checks shared by `crewhaus lint` and
 * `crewhaus doctor --philosophy-alignment` moved to `@crewhaus/compile-service`,
 * whose shared check pipeline runs them; this path re-exports them.
 */
export { type ModelPlanFinding, auditModelPlan } from "@crewhaus/compile-service";
