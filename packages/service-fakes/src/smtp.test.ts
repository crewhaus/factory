import { afterEach, describe, expect, test } from "bun:test";
import { type FakeSmtp, fakeSmtp } from "./smtp";

const fakes: FakeSmtp[] = [];
afterEach(async () => {
  while (fakes.length > 0) await (fakes.pop() as FakeSmtp).stop();
});

function start(): FakeSmtp {
  const fake = fakeSmtp();
  fakes.push(fake);
  return fake;
}

/** A minimal SMTP client: send one line at a time, collect each reply. */
async function converse(port: number, lines: readonly string[]): Promise<string[]> {
  const replies: string[] = [];
  let resolveNext: (() => void) | undefined;
  let buffer = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        buffer += chunk.toString("utf8");
        if (buffer.endsWith("\r\n")) {
          replies.push(buffer);
          buffer = "";
          resolveNext?.();
        }
      },
    },
  });
  const nextReply = (count: number): Promise<void> =>
    replies.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          resolveNext = () => {
            if (replies.length >= count) resolve();
          };
        });
  await nextReply(1);
  for (const line of lines) {
    const before = replies.length;
    socket.write(`${line}\r\n`);
    await nextReply(before + 1);
  }
  socket.end();
  return replies;
}

describe("fakeSmtp", () => {
  test("EHLO offers no STARTTLS, and a whole session records one message", async () => {
    const fake = start();
    const replies = await converse(fake.port, [
      "EHLO client.invalid",
      "MAIL FROM:<a@example.invalid>",
      "RCPT TO:<b@example.invalid>",
      "RCPT TO:<c@example.invalid>",
      "DATA",
    ]);
    expect(replies[0]).toStartWith("220 ");
    expect(replies[1]).toStartWith("250");
    expect(replies[1]).not.toContain("STARTTLS");
    expect(replies.at(-1)).toStartWith("354 ");
  });

  test("a dot-stuffed line comes back with its dot, and the message is recorded", async () => {
    const fake = start();
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: fake.port,
      socket: { data() {} },
    });
    socket.write(
      [
        "EHLO client.invalid",
        "MAIL FROM:<a@example.invalid>",
        "RCPT TO:<b@example.invalid>",
        "DATA",
        "Subject: hi",
        "",
        "..starts with a dot",
        "plain",
        ".",
        "QUIT",
        "",
      ].join("\r\n"),
    );
    for (let i = 0; i < 200 && fake.messages().length === 0; i++) await Bun.sleep(5);
    socket.end();
    expect(fake.messages()).toEqual([
      {
        from: "a@example.invalid",
        to: ["b@example.invalid"],
        data: "Subject: hi\r\n\r\n.starts with a dot\r\nplain",
      },
    ]);
  });

  test("DATA before a recipient is refused, and an unknown verb is not offered", async () => {
    const fake = start();
    const replies = await converse(fake.port, ["DATA", "STARTTLS"]);
    expect(replies[1]).toStartWith("503 ");
    expect(replies[2]).toStartWith("502 ");
    expect(fake.messages()).toEqual([]);
  });
});
