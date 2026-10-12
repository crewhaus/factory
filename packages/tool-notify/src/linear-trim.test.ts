/**
 * An API base URL loses its trailing slashes in one pass.
 *
 * `/\/+$/` tries every start inside a run of slashes that is not at the end
 * of the base URL's path and rescans the rest of the run from each before
 * giving the start up: quadratic in the run's length. The base URL is the
 * model's (`apiBaseUrl` has no length limit) and the path is built before
 * the origin is checked, so the strip is a loop.
 *
 * Nothing is sent: the origin is not on the allow-list, so the call is
 * refused after the path is built and before any request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _resetNotifyConfig, chatPost, registerNotifyConfig } from "./index";

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
