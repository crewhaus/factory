import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chatAuthRefusal } from "./chat-auth";

/** A token made at run time, as a deployment's secret would be. */
const token = (): string => `chat-${crypto.randomUUID()}`;

const UNAUTHORIZED = {
  status: 401,
  code: "UNAUTHORIZED",
  message: "a valid bearer token is required",
};
const NO_CHAT_TOKEN = {
  status: 503,
  code: "NO_CHAT_TOKEN",
  message: "this worker has no CHAT_TOKEN secret: set one with `wrangler secret put CHAT_TOKEN`",
};

describe("chatAuthRefusal", () => {
  let digest: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    digest?.mockRestore();
    digest = undefined;
  });

  test("a worker without a CHAT_TOKEN secret refuses every request with 503", async () => {
    const sent = `Bearer ${token()}`;
    for (const secret of [undefined, null, "", "   ", "\n", 42, {}, ["x"]]) {
      expect(await chatAuthRefusal(sent, secret)).toEqual(NO_CHAT_TOKEN);
      expect(await chatAuthRefusal(null, secret)).toEqual(NO_CHAT_TOKEN);
    }
  });

  test("no header, another scheme, a wrong token and one of another length get the same 401", async () => {
    const secret = token();
    const sameLength = `chat-${crypto.randomUUID()}`;
    expect(sameLength.length).toBe(secret.length);
    const answers = await Promise.all(
      [
        null,
        "",
        `Basic ${btoa(`user:${secret}`)}`,
        `Token ${secret}`,
        `Bearer${secret}`,
        "Bearer ",
        `Bearer ${sameLength}`,
        `Bearer ${secret}x`,
        `Bearer ${secret.slice(0, -1)}`,
        `Bearer x ${secret}`,
      ].map((header) => chatAuthRefusal(header, secret)),
    );
    for (const answer of answers) expect(answer).toEqual(UNAUTHORIZED);
    // One refusal for all of them: nothing in the answer tells them apart.
    expect(new Set(answers).size).toBe(1);
  });

  test("the right token passes, whatever the scheme's case and the whitespace around it", async () => {
    const secret = token();
    for (const header of [
      `Bearer ${secret}`,
      `bearer ${secret}`,
      `BEARER ${secret}`,
      `  Bearer \t ${secret}  `,
    ]) {
      expect(await chatAuthRefusal(header, secret)).toBeUndefined();
    }
    // A secret saved with a trailing newline (`echo … | wrangler secret put`) still matches.
    expect(await chatAuthRefusal(`Bearer ${secret}`, `${secret}\n`)).toBeUndefined();
  });

  test("both values are digested on every comparison, a match and every kind of mismatch alike", async () => {
    const secret = token();
    const calls: number[] = [];
    for (const header of [
      `Bearer ${secret}`,
      `Bearer chat-${crypto.randomUUID()}`,
      "Bearer short",
      null,
    ]) {
      digest = spyOn(crypto.subtle, "digest");
      await chatAuthRefusal(header, secret);
      calls.push(digest.mock.calls.length);
      digest.mockRestore();
      digest = undefined;
    }
    expect(calls).toEqual([2, 2, 2, 2]);
  });
});
