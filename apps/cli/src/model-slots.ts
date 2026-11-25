/**
 * The model-slot walk moved to `@crewhaus/ir/slots`, where the compile service
 * and every other reader of a lowered IR can reach it. This path is kept for
 * one release so existing imports keep working; new code imports
 * `@crewhaus/ir/slots`.
 */
export * from "@crewhaus/ir/slots";
