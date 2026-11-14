/**
 * The creation area through the API (#515): `specs.schema`, the schema the structured
 * editor renders for one harness, with its effective configuration. It answers the same
 * body as `GET /api/h/:id/spec/schema`: both are `specSchemaView`. Every file is read
 * through the one containment rule the per-harness routes use, and the router masks the
 * answer at its exit.
 */
import { runsOwnCode } from "@crewhaus/harness-registry";
import { harnessPathOf } from "../harness-paths";
import { type SpecView, specSchemaView } from "../spec-edit";
import type { V1Handler } from "./context";
import { V1Error } from "./errors";
import { harnessOf, liveDirOr409 } from "./resolve";

const specsSchema: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const hangarRoot = ctx.deps.hangarRoot;
  const view: SpecView = {
    entry,
    harnessDir: dir,
    // Only a harness adopted here with `crewhaus harness adopt` has its own code check its spec.
    adopted: runsOwnCode(entry),
    contain: (segments) => {
      const found = harnessPathOf(dir, hangarRoot, segments);
      if (found.ok) return found.path;
      throw found.reason === "escapes"
        ? new V1Error({
            status: 404,
            code: "not_found",
            reason: "path_escapes",
            message: "That file is not inside this harness.",
          })
        : new V1Error({
            status: 403,
            code: "forbidden",
            reason: "home_records",
            message: "That file holds Home's own records and is not served here.",
          });
    },
  };
  const body = await specSchemaView(view);
  return { status: 200, body: { harness: entry.id, ...body }, scrubDir: dir };
};

export const CREATION_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "specs.schema": specsSchema,
};
