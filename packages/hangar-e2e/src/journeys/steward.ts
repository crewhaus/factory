/**
 * A steward harness for the delivery journeys: a fake GitHub on a loopback port with a real
 * git server half, the harness's bindings and token as its own boot would leave them, an
 * accepted work item, and the publish engine a run of the harness uses. Not a journey.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { openWorkStore } from "@crewhaus/tool-work/work-items";
import {
  type BindingsFile,
  type WorkspaceEngine,
  createWorkspaceEngine,
  syncOutcomes,
  writeBindings,
} from "@crewhaus/tool-work/workspace";
import { type FakeGitHub, fakeGitHub } from "service-fakes";

export const STEWARD_REPO = "acme/budget-app";
export const STEWARD_TITLE = "Round currency the same way in every export";
/** The variable the token is read from: the harness's own, never Home's. */
const TOKEN_VARIABLE = "STEWARD_E2E_HOST";

const HARNESS = { by: "sys:runtime", via: "tool", role: "harness" } as const;

export type Steward = {
  readonly fake: FakeGitHub;
  readonly engine: WorkspaceEngine;
  readonly wi: string;
  /**
   * A run of the harness makes the change and publishes it, judged as meeting the item, with
   * the judge's `rationale` when one is given.
   */
  publish(rationale?: string): ReturnType<WorkspaceEngine["publish"]>;
  /** Home's tracker reads the pull request and moves the item with it. */
  track(): ReturnType<typeof syncOutcomes>;
  /** How many pull requests were asked for. */
  creates(): number;
  stop(): Promise<void>;
};

/** Make `dir` (a seeded harness) a steward of one repository with one accepted item. */
export async function steward(dir: string): Promise<Steward> {
  const token = ["e2e", "host", randomUUID()].join("-");
  const fake = fakeGitHub({ repos: [STEWARD_REPO], requireToken: token });
  fake.commitOnBranch(STEWARD_REPO, "main", "First");
  const bindings: BindingsFile = {
    v: 1,
    tokenEnv: TOKEN_VARIABLE,
    repositories: [
      {
        name: "app",
        host: "github",
        repo: STEWARD_REPO,
        base: "main",
        branchPrefix: "crewhaus/",
        checks: [],
        checkTimeoutMs: 60_000,
        pullRequests: {
          draft: true,
          maxFiles: 20,
          maxLines: 800,
          revalidate: "rebase",
          require: ["acceptance"],
        },
        server: { api: fake.url, git: fake.url },
        allowPrivateTarget: true,
      },
    ],
  };
  writeBindings(dir, bindings);
  writeFileSync(join(dir, ".env"), `${TOKEN_VARIABLE}=${token}\n`, { mode: 0o600 });
  const env = { PATH: process.env["PATH"], [TOKEN_VARIABLE]: token };
  const engine = createWorkspaceEngine({
    harnessDir: dir,
    bindings: () => bindings,
    env,
    checkRunner: null,
    name: "steward",
  });
  const made = await openWorkStore(dir).create(
    {
      title: STEWARD_TITLE,
      kind: "fix",
      acceptance: ["Every export rounds currency half to even"],
    },
    { by: mintId("prn"), via: "home", role: "person" },
  );
  if (!made.ok) throw new Error(made.message);
  const wi = made.item.id;
  return {
    fake,
    engine,
    wi,
    publish: async (rationale = "It does.") => {
      const opened = await engine.open(wi, { actor: HARNESS });
      if (!opened.ok) throw new Error(`the workspace did not open: ${opened.message}`);
      const at = join(dir, opened.worktree, "src", "rounding.ts");
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, 'export const rounding = "half-even";\n');
      return engine.publish({
        wi,
        actor: HARNESS,
        mode: "harness",
        text: { title: STEWARD_TITLE, summary: "Exports round currency half to even." },
        judge: async () => ({ label: "meets", abstain: false, rationale }),
      });
    },
    track: () => syncOutcomes(dir, { env }),
    creates: () =>
      fake.writes().filter((w) => w.method === "POST" && w.path.endsWith("/pulls")).length,
    stop: () => fake.stop(),
  };
}
