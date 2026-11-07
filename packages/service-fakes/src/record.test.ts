import { describe, expect, test } from "bun:test";
import { MASKED, maskBody, maskHeaders, parseBody } from "./record";

describe("maskHeaders", () => {
  test("drops credential headers and keeps the rest", () => {
    const masked = maskHeaders(
      new Headers({
        authorization: "Bearer x",
        "x-api-key": "x",
        cookie: "x",
        "x-custom-token": "x",
        "content-type": "application/json",
      }),
    );
    expect(masked).toEqual({ "content-type": "application/json" });
  });
});

describe("maskBody", () => {
  test.each(["api_key", "token", "client_secret", "password", "signingSecret"])(
    "redacts a string under %s, at any depth",
    (key) => {
      expect(maskBody({ [key]: "value" })).toEqual({ [key]: MASKED });
      expect(maskBody({ outer: [{ [key]: "value" }] })).toEqual({ outer: [{ [key]: MASKED }] });
    },
  );

  test("redacts an object under a credential name whole", () => {
    expect(maskBody({ secret: { inner: "value" } })).toEqual({ secret: MASKED });
  });

  test("keeps counts and flags whose names look like credentials", () => {
    expect(maskBody({ max_tokens: 64, has_key: true, token: null })).toEqual({
      max_tokens: 64,
      has_key: true,
      token: null,
    });
  });

  test("keeps everything else, unchanged", () => {
    const body = { text: "hello", list: [1, "two"], nested: { name: "n" } };
    expect(maskBody(body)).toEqual(body);
  });
});

describe("parseBody", () => {
  test("JSON, a form, an empty body and text that is neither", () => {
    expect(parseBody("application/json", '{"a":1}')).toEqual({ a: 1 });
    expect(parseBody("application/x-www-form-urlencoded", "a=1&b=two")).toEqual({
      a: "1",
      b: "two",
    });
    expect(parseBody("application/json", "")).toBeNull();
    expect(parseBody("text/plain", "not json")).toBe("not json");
  });
});
