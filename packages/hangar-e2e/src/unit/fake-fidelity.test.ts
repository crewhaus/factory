import { afterAll, describe, expect, test } from "bun:test";
import { fakeSmtp } from "service-fakes";
// tool-notify exports no `./smtp`, and this one test file is the only reader.
import { sendMail } from "../../../tool-notify/src/smtp";

describe("fakeSmtp against the real sendMail", () => {
  const fake = fakeSmtp();
  afterAll(() => fake.stop());

  test("what was sent is what it recorded, dot-stuffing and all", async () => {
    const message = [
      "From: a@example.invalid",
      "To: b@example.invalid",
      "Subject: hello",
      "",
      "first line",
      ".starts with a dot",
      "..starts with two",
      "last line",
    ].join("\n");
    const outcome = await sendMail({
      host: "127.0.0.1",
      port: fake.port,
      pinnedIp: "127.0.0.1",
      implicitTls: false,
      requireTls: false,
      rejectUnauthorized: true,
      ehloName: "client.invalid",
      envelopeFrom: "a@example.invalid",
      envelopeTo: ["b@example.invalid", "c@example.invalid"],
      message,
      signal: AbortSignal.timeout(5_000),
      maxReplyBytes: 64 * 1024,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.secured).toBe(false);
    expect(outcome.authenticated).toBe(false);
    expect(outcome.accepted).toEqual(["b@example.invalid", "c@example.invalid"]);
    expect(fake.messages()).toEqual([
      {
        from: "a@example.invalid",
        to: ["b@example.invalid", "c@example.invalid"],
        data: message.replaceAll("\n", "\r\n"),
      },
    ]);
  });

  test("the fake offers no STARTTLS, so a client that requires TLS sends nothing", async () => {
    const before = fake.messages().length;
    const outcome = await sendMail({
      host: "127.0.0.1",
      port: fake.port,
      pinnedIp: "127.0.0.1",
      implicitTls: false,
      requireTls: true,
      rejectUnauthorized: true,
      ehloName: "client.invalid",
      envelopeFrom: "a@example.invalid",
      envelopeTo: ["b@example.invalid"],
      message: "Subject: no\n\nno\n",
      signal: AbortSignal.timeout(5_000),
      maxReplyBytes: 64 * 1024,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("it sent over a plain connection");
    expect(outcome.error).toContain("did not offer STARTTLS");
    expect(fake.messages()).toHaveLength(before);
  });
});
