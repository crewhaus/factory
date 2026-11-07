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

  test("drops a header named by the wider vocabulary, and keeps the wire's own", () => {
    const masked = maskHeaders(
      new Headers({
        "x-auth": "x",
        "proxy-authorization": "x",
        "x-webhook-url": "x",
        "x-github-event": "push",
        "x-slack-request-timestamp": "1",
      }),
    );
    expect(masked).toEqual({ "x-github-event": "push", "x-slack-request-timestamp": "1" });
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

  // The names the product's classifier treats as credentials. This package is a
  // leaf, so the list is written out: it pins this mask, not the other.
  test.each([
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "SLACK_SIGNING_SECRET",
    "DB_PASSWORD",
    "PGPASSWORD",
    "MYSQL_PWD",
    "pwd",
    "SMTP_PASS",
    "GITHUB_PAT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "credentials",
    "creds",
    "DOCKER_AUTH_CONFIG",
    "auth",
    "authorization",
    "Authorization",
    "SENTRY_DSN",
    "dsn",
    "DATABASE_URL",
    "REDIS_URL",
    "MONGODB_URI",
    "SLACK_WEBHOOK_URL",
    "webhook_url",
    "AZURE_STORAGE_CONNECTION_STRING",
    "ENCRYPTION_KEY",
    "PASSPHRASE",
    "passphrase",
    "COOKIE_SECRET",
    "KEY2",
    "apiKey",
    "APIKey",
    "clientSecret",
    "client_secret",
    "x-api-key",
    "WALLET_MNEMONIC",
    "mnemonic",
    "SEED_PHRASE",
    "seedPhrase",
    "RECOVERY_PHRASE",
    "bearer",
    "otp",
    "salt",
  ])("redacts a string under the credential name %s", (key) => {
    expect(maskBody({ [key]: "value" })).toEqual({ [key]: MASKED });
  });

  // Fields a fake's own assertions read off the wire: these must stay.
  test.each([
    "text",
    "model",
    "channel",
    "thread_ts",
    "author",
    "author_association",
    "path",
    "PATH",
    "bypass_cache",
    "html_url",
    "response_url",
    "base_url",
    "compass_url",
    "url",
    "passed",
  ])("keeps a string under the ordinary name %s", (key) => {
    expect(maskBody({ [key]: "value" })).toEqual({ [key]: "value" });
  });

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
