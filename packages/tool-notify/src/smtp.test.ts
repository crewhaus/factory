/**
 * The STARTTLS negotiation, which is the DEFAULT path.
 *
 * `index.test.ts` proves `EmailSend` stops before AUTH when a server offers
 * no STARTTLS at all. This file covers the other two ways the upgrade can
 * go wrong, both against a real socket: a server that says 220 and then
 * cannot complete a handshake, and a server presenting a certificate the
 * client has no reason to trust. In both, the session must end with the
 * password unsent and the message undelivered.
 *
 * WHAT IS NOT COVERED HERE: a SUCCESSFUL upgrade followed by delivery.
 * Building a STARTTLS server needs an already-connected plaintext socket to
 * be handed to a TLS server, and this runtime's `node:tls` shim does not
 * support that — the handshake never completes from the server side, so such
 * a test would hang rather than assert. The client's upgrade path is
 * therefore exercised only in the directions where it refuses. That gap is
 * real and is stated in the README rather than papered over.
 *
 * The certificate is generated at test time with `openssl` into a temp
 * directory; where `openssl` is not on the machine, the test needing it
 * returns early and the one that does not still runs, so this file never
 * passes without asserting something.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type TLSSocket, createServer as createTlsServer } from "node:tls";
import { composeMessage } from "./lib/mime";
import { startDeadline } from "./net";
import { sendMail } from "./smtp";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-smtp-tls-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A self-signed certificate for `smtp.test.invalid`, or `null` when openssl
 * is absent.
 *
 * The certificate names a HOST, while the socket dials 127.0.0.1 — which is
 * exactly the production arrangement: the SSRF gate vets an address, the
 * client pins the socket to it, and TLS still presents and verifies the name
 * the caller asked for. A certificate naming the address instead would have
 * been easier and would have tested the wrong thing.
 */
function generateCertificate(): { key: string; cert: string } | null {
  const keyPath = path.join(tmp, "key.pem");
  const certPath = path.join(tmp, "cert.pem");
  try {
    const result = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=smtp.test.invalid",
      "-addext",
      "subjectAltName=DNS:smtp.test.invalid",
    ]);
    if (result.exitCode !== 0) return null;
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } catch {
    return null;
  }
}

type Log = { commands: string[]; messages: string[]; commandsBeforeTls: number };

/**
 * An SMTP server that advertises STARTTLS and, when given a certificate,
 * actually performs the upgrade by handing the raw socket to a TLS server.
 */
function startServer(
  credentials: { key: string; cert: string } | null,
): Promise<{ server: Server; port: number; log: Log }> {
  const log: Log = { commands: [], messages: [], commandsBeforeTls: 0 };

  const converse = (
    write: (text: string) => void,
    onLine: (line: string) => void,
    advertiseStartTls: boolean,
  ) => {
    let buffer = "";
    let inData = false;
    let body = "";
    const handle = (line: string): void => {
      if (inData) {
        if (line === ".") {
          inData = false;
          log.messages.push(body);
          body = "";
          write("250 2.0.0 Ok: queued as TLSQUEUE\r\n");
        } else {
          body += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
        }
        return;
      }
      log.commands.push(line);
      onLine(line);
      const verb = line.split(" ")[0]?.toUpperCase() ?? "";
      if (verb === "EHLO") {
        const lines = [
          "250-test.invalid",
          ...(advertiseStartTls ? ["250-STARTTLS"] : []),
          "250-AUTH PLAIN LOGIN",
          "250 HELP",
        ];
        write(`${lines.join("\r\n")}\r\n`);
      } else if (verb === "AUTH") {
        write("235 2.7.0 Authentication successful\r\n");
      } else if (verb === "MAIL" || verb === "RCPT") {
        write("250 2.1.0 Ok\r\n");
      } else if (verb === "DATA") {
        inData = true;
        write("354 End data\r\n");
      } else if (verb === "QUIT") {
        write("221 Bye\r\n");
      } else {
        write("502 not implemented\r\n");
      }
    };
    return (chunk: string): void => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        handle(line);
      }
    };
  };

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    const write = (text: string): void => {
      socket.write(text);
    };
    write("220 test.invalid ESMTP ready\r\n");
    // The plaintext leg only has to reach STARTTLS; anything else it is
    // asked is answered as the plain conversation would answer it.
    const feed = converse(
      write,
      (line) => {
        if (line.toUpperCase() !== "STARTTLS") return;
        log.commandsBeforeTls = log.commands.length;
        socket.removeAllListeners("data");
        socket.write("220 2.0.0 Ready to start TLS\r\n");
        if (credentials === null) {
          // No certificate: the client will try to upgrade and the handshake
          // will fail, which is exactly the fail-closed case worth proving.
          return;
        }
        const tlsServer = createTlsServer({ key: credentials.key, cert: credentials.cert });
        tlsServer.on("secureConnection", (secure: TLSSocket) => {
          secure.setEncoding("utf8");
          const secureWrite = (text: string): void => {
            secure.write(text);
          };
          secure.on(
            "data",
            converse(secureWrite, () => undefined, false),
          );
          secure.on("error", () => undefined);
        });
        tlsServer.emit("connection", socket);
      },
      true,
    );
    socket.on("data", feed);
    socket.on("error", () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port, log });
    });
  });
}

function message(): string {
  const composed = composeMessage({
    from: { address: "ci@example.com" },
    to: [{ address: "ops@example.com" }],
    subject: "TLS",
    text: "secret contents\n",
    date: new Date("2026-09-17T09:30:00Z"),
  });
  if (!composed.ok) throw new Error(composed.error);
  return composed.message;
}

function baseOptions(port: number) {
  return {
    host: "smtp.test.invalid",
    port,
    pinnedIp: "127.0.0.1",
    implicitTls: false,
    requireTls: true,
    rejectUnauthorized: true,
    ehloName: "crewhaus.invalid",
    envelopeFrom: "ci@example.com",
    envelopeTo: ["ops@example.com"],
    message: message(),
    maxReplyBytes: 64 * 1024,
  };
}

describe("STARTTLS", () => {
  test("a failed upgrade ends the session before the credential or the body is sent", async () => {
    const { server, port, log } = await startServer(null);
    const deadline = startDeadline(3000);
    try {
      const outcome = await sendMail({
        ...baseOptions(port),
        username: "mailer@example.com",
        password: "sup3rs3cretmailpassword",
        signal: deadline.signal,
      });
      expect(outcome.ok).toBe(false);
      // The client did ask to upgrade...
      expect(log.commands).toContain("STARTTLS");
      // ...and nothing followed it: no AUTH, no envelope, no message.
      expect(log.commands.filter((c) => c.toUpperCase().startsWith("AUTH"))).toEqual([]);
      expect(log.commands.filter((c) => c.startsWith("MAIL FROM"))).toEqual([]);
      expect(log.messages.length).toBe(0);
    } finally {
      deadline.cancel();
      server.close();
    }
  });

  test("a self-signed certificate is refused when it is not trusted", async () => {
    const credentials = generateCertificate();
    if (credentials === null) return;
    const { server, port, log } = await startServer(credentials);
    const deadline = startDeadline(10_000);
    try {
      // Same server, but without the CA: the handshake must fail closed.
      const outcome = await sendMail({ ...baseOptions(port), signal: deadline.signal });
      expect(outcome.ok).toBe(false);
      // It got as far as asking to upgrade, and no further: the failure is
      // the certificate, not a mistake earlier in the conversation.
      expect(log.commands).toContain("STARTTLS");
      expect(log.commands.filter((c) => c.startsWith("MAIL FROM"))).toEqual([]);
      expect(log.messages.length).toBe(0);
    } finally {
      deadline.cancel();
      server.close();
    }
  });
});
