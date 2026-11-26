/**
 * Holds each schema of the runtime area's workspace half to its type in the main entry, at
 * compile time, with the helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./runtime-workspace.js";
import type { Expect, Same } from "./type-checks.js";

export type RuntimeWorkspaceSchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.workPrView>, T.WorkPrView>>,
  Expect<Same<z.infer<typeof S.workPublishAnswer>, T.WorkPublishAnswer>>,
  Expect<Same<z.infer<typeof S.workPublishVerdict>, T.WorkPublishVerdict>>,
  Expect<Same<z.infer<typeof S.workPublishView>, T.WorkPublishView>>,
  Expect<Same<z.infer<typeof S.workspaceAnswer>, T.WorkspaceAnswer>>,
  Expect<Same<z.infer<typeof S.workspaceCheckView>, T.WorkspaceCheckView>>,
  Expect<Same<z.infer<typeof S.workspaceList>, T.ListEnvelope<T.WorkspaceSummaryView>>>,
  Expect<Same<z.infer<typeof S.workspaceSummary>, T.WorkspaceSummaryView>>,
  Expect<Same<z.infer<typeof S.workspaceView>, T.WorkspaceView>>,
];
