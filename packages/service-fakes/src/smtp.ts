/**
 * `fakeSmtp`: a recording SMTP server on loopback, reached through tool-notify's
 * `sendMail` with `requireTls: false`.
 *
 * It offers no STARTTLS, on purpose. A successful STARTTLS upgrade cannot be
 * served in-process: this runtime's `node:tls` cannot upgrade an
 * already-connected socket on the server side, so the handshake neither
 * finishes nor fails. What TLS proves is left to tool-notify's own suite, which
 * tests it where a handshake really happens.
 */
import type { FakeService } from "./serve";

export type FakeSmtpMessage = {
  readonly from: string;
  readonly to: readonly string[];
  /** The message as sent: dot-unstuffed, lines joined with CRLF. */
  readonly data: string;
};

export type FakeSmtpOptions = {
  /** The name it announces in its greeting and in EHLO. */
  readonly hostname?: string;
};

export type FakeSmtp = FakeService & {
  messages(): readonly FakeSmtpMessage[];
};

type Connection = {
  buffer: string;
  inData: boolean;
  from: string;
  to: string[];
  lines: string[];
};

const addressIn = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? "";

/** Start a fake SMTP server. */
export function fakeSmtp(opts: FakeSmtpOptions = {}): FakeSmtp {
  const name = opts.hostname ?? "fake-smtp.invalid";
  const messages: FakeSmtpMessage[] = [];

  /** The reply to one line; `undefined` while a message is being received. */
  const onLine = (state: Connection, line: string): string | undefined => {
    if (state.inData) {
      if (line === ".") {
        messages.push({ from: state.from, to: state.to, data: state.lines.join("\r\n") });
        state.inData = false;
        state.from = "";
        state.to = [];
        state.lines = [];
        return "250 2.0.0 queued";
      }
      state.lines.push(line.startsWith(".") ? line.slice(1) : line);
      return undefined;
    }
    const verb = line.split(/[\s:]/, 1)[0]?.toUpperCase() ?? "";
    switch (verb) {
      case "EHLO":
        return `250-${name}\r\n250 8BITMIME`;
      case "HELO":
        return `250 ${name}`;
      case "MAIL":
        state.from = addressIn(line);
        return "250 2.1.0 ok";
      case "RCPT":
        state.to.push(addressIn(line));
        return "250 2.1.5 ok";
      case "DATA":
        if (state.to.length === 0) return "503 5.5.1 RCPT first";
        state.inData = true;
        return "354 end with <CRLF>.<CRLF>";
      case "RSET":
        state.from = "";
        state.to = [];
        return "250 2.0.0 ok";
      case "NOOP":
        return "250 2.0.0 ok";
      case "QUIT":
        return "221 2.0.0 bye";
      default:
        return `502 5.5.2 ${verb} is not offered`;
    }
  };

  const listener = Bun.listen<Connection>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", inData: false, from: "", to: [], lines: [] };
        socket.write(`220 ${name} ESMTP\r\n`);
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buffer += chunk.toString("utf8");
        for (;;) {
          const end = state.buffer.indexOf("\r\n");
          if (end === -1) return;
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 2);
          const reply = onLine(state, line);
          if (reply === undefined) continue;
          socket.write(`${reply}\r\n`);
          if (reply.startsWith("221")) {
            socket.end();
            return;
          }
        }
      },
    },
  });

  return {
    url: `smtp://127.0.0.1:${listener.port}`,
    port: listener.port,
    messages: () => [...messages],
    stop: async () => {
      listener.stop(true);
    },
  };
}
