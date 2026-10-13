/**
 * An API base URL loses its trailing slashes in one pass.
 *
 * `/\/+$/` tries every start inside a run of slashes that is not at the end
 * of the base URL's path and rescans the rest of the run from each before
 * giving the start up: quadratic in the run's length. The base URL is the
 * model's (`apiBaseUrl` has no length limit) and the path is built before
 * the origin is checked, so the strip is a loop.
 *
 * A Teams webhook path is checked a segment at a time. Its pattern's
 * `[^/]+@` overlapped the `@`, so it tried every `@` of a run and rescanned
 * the rest of the segment from each: quadratic in a URL the call wrote
 * (`url` has no length limit), before the allow-list was asked.
 *
 * Nothing is sent: the origin is not on the allow-list, so the call is
 * refused after the path is built and before any request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _resetNotifyConfig, chatPost, registerNotifyConfig, webhookPost } from "./index";
import { isTeamsWebhookPath } from "./lib/webhook-path";

/**
 * Every regular expression run over a string holding `run` while `body`
 * runs. Each is recorded once, and one whose source is not in `allowed` is
 * refused on the spot (it throws instead of running), so a pattern that
 * would rescan the run from every position in it fails the test at once
 * instead of being waited out. `String#replace`, `match`, `split`, `search`
 * and `RegExp#test` all go through `exec` once it is replaced. Counted, not
 * timed: the machine's speed decides nothing.
 */
async function regexRunsOver<T>(
  run: string,
  body: () => T | Promise<T>,
  allowed: ReadonlyArray<string> = [],
): Promise<{ runs: string[]; outcome: T | Error }> {
  const runs: string[] = [];
  const realExec = RegExp.prototype.exec;
  let last: string | undefined;
  let holds = false;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (input !== last) {
      last = input;
      holds = typeof input === "string" && input.includes(run);
    }
    if (holds) {
      const seen = `/${this.source}/ over ${input.length} characters`;
      if (!runs.includes(seen)) runs.push(seen);
      if (!allowed.includes(this.source)) throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { runs, outcome: await body() };
  } catch (err) {
    return { runs, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

/** Every string up to `max` characters long over `alphabet`. */
function allStrings(alphabet: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    out.push(...layer);
  }
  return out;
}

/** `[input, output]` for each input, as one string, so a failure names the input. */
function answers(inputs: ReadonlyArray<string>, f: (s: string) => unknown): string[] {
  return inputs.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(f(s))}`);
}

const TOKEN_VAR = "CREWHAUS_TEST_TRIM_BOT_TOKEN";

afterEach(() => {
  _resetNotifyConfig();
  Reflect.deleteProperty(process.env, TOKEN_VAR);
});

describe("an API base URL with a run of slashes in its path", () => {
  test("no pattern rescans the run while the request is built", async () => {
    const slashes = "/".repeat(100_000);
    const apiBaseUrl = `https://chat.example.invalid/api${slashes}x/`;
    // Control: the count sees a pattern String#replace runs over the run.
    expect((await regexRunsOver(slashes, () => apiBaseUrl.replace(/\/+$/, ""))).runs).toEqual([
      `/\\/+$/ over ${apiBaseUrl.length} characters`,
    ]);
    process.env[TOKEN_VAR] = ["test", "bot", "token"].join("-");
    registerNotifyConfig({ allowed_origins: [], allowed_secret_envs: [TOKEN_VAR] });
    // The hook stays in place until the call has answered.
    const posted = await regexRunsOver(slashes, () =>
      chatPost.execute({
        platform: "slack",
        apiBaseUrl,
        tokenEnv: TOKEN_VAR,
        channel: "C1",
        text: "hi",
      }),
    );
    expect(posted.runs).toEqual([]);
    expect(String(posted.outcome)).toContain("allow-list");
  });
});

describe("a Teams webhook path with a run of @ in its segment", () => {
  // The pattern as it was.
  const TEAMS = /^\/webhookb2\/[^/]+@[^/]+\/IncomingWebhook\/.+/i;

  test("isTeamsWebhookPath answers what the pattern answered", () => {
    const inputs: string[] = [];
    for (const prefix of [
      "/webhookb2/",
      "/WebHookB2/",
      "/webhookb2",
      "webhookb2/",
      "//webhookb2/",
    ]) {
      for (const segment of allStrings(["a", "@", "/"], 4)) {
        for (const marker of ["/IncomingWebhook/", "/INCOMINGwebhook/", "/IncomingWebhook", ""]) {
          for (const rest of ["", "x", "\n", "\u2028x", "/"]) {
            inputs.push(prefix + segment + marker + rest);
          }
        }
      }
    }
    // Every code unit, in a letter of each fixed part, in the segment and
    // after the marker.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(
        `/webhoo${ch}b2/a@b/IncomingWebhook/x`,
        `/webhookb2/a${ch}b/IncomingWebhook/x`,
        `/webhookb2/a@b/Incoming${ch}ebhook/x`,
        `/webhookb2/a@b/IncomingWebhook/${ch}`,
      );
    }
    expect(answers(inputs, isTeamsWebhookPath)).toEqual(answers(inputs, (s) => TEAMS.test(s)));
  }, 20_000);

  test("no pattern rescans the run before the allow-list is asked", async () => {
    const ats = "@".repeat(100_000);
    // Control: the count sees the old pattern run over the run.
    const path = `/webhookb2/${ats}`;
    expect((await regexRunsOver(ats, () => TEAMS.test(path))).runs).toEqual([
      `/${TEAMS.source}/ over ${path.length} characters`,
    ]);
    registerNotifyConfig({ allowed_origins: [], allowed_secret_envs: [] });
    // The Slack and Discord shapes are anchored and stop at the first
    // character that differs.
    const shapes = ["^\\/services\\/T[^/]+\\/B[^/]+\\/.+", "^\\/api\\/webhooks\\/\\d+\\/.+"];
    const origin = "https://hooks.example.invalid";
    const plain = await regexRunsOver(
      ats,
      () => webhookPost.execute({ url: `${origin}/webhookb2/${ats}`, payload: { a: 1 } }),
      shapes,
    );
    expect(plain.runs.map((r) => r.replace(/ over .*/, ""))).toEqual(shapes.map((p) => `/${p}/`));
    expect(String(plain.outcome)).toContain("allow-list");
    // As before: a Teams webhook path is refused as a credential.
    const teams = await regexRunsOver(
      ats,
      () =>
        webhookPost.execute({
          url: `${origin}/webhookb2/${ats}/IncomingWebhook/x`,
          payload: { a: 1 },
        }),
      shapes,
    );
    expect(String(teams.outcome)).toContain("incoming-webhook URL");
  });
});
