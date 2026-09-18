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
 * WHY THE CERTIFICATE TEST CONNECTS OVER IMPLICIT TLS. This runtime's
 * `node:tls` cannot upgrade an ALREADY-CONNECTED socket on the server side:
 * neither `tlsServer.emit("connection", socket)` nor
 * `new TLSSocket(socket, { isServer: true })` ever completes the handshake
 * OR errors — the client simply waits. A certificate test built on a
 * STARTTLS server therefore ends on its own deadline, and `ok: false` is
 * satisfied by that abort rather than by any certificate verdict. This file
 * had exactly that test: it took over ten seconds and it passed UNCHANGED
 * with `rejectUnauthorized: false`, which is a security test that cannot
 * fail. The certificate decision is now made where a handshake really
 * happens — a TLS server on its own port, reached with `implicitTls` — which
 * refuses a self-signed certificate in single-digit milliseconds and names
 * it in the error, so the assertion can be on the REASON and not just on
 * failure.
 *
 * WHAT IS STILL NOT COVERED: a SUCCESSFUL STARTTLS upgrade followed by
 * delivery, for that same server-side reason. That gap is real and is stated
 * in the README rather than papered over.
 *
 * The certificate is generated at test time with `openssl` into a temp
 * directory. A machine without `openssl` is a broken test environment rather
 * than a reason to skip: `generateCertificate` throws, because a certificate
 * test that quietly returns early is the same vacuum described above.
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
function generateCertificate(): { key: string; cert: string } {
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
    if (result.exitCode !== 0) {
      throw new Error(`openssl exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
    }
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } catch (cause) {
    // Deliberately fatal. Returning null here would make every test that
    // needs a certificate pass while asserting nothing.
    throw new Error(`could not generate a test certificate: ${String(cause)}`);
  }
}

/**
 * A TLS server on its own port, speaking SMTP from the first byte.
 *
 * This is the shape a handshake actually completes in under this runtime
 * (see the header). A client whose handshake is meant to fail never reads
 * the greeting; a client that WRONGLY accepted the certificate does, and
 * then waits for a reply that never comes — so the two outcomes are
 * distinguishable rather than both arriving as a bare `ok: false`.
 */
function startTlsServer(credentials: { key: string; cert: string }): Promise<{
  server: ReturnType<typeof createTlsServer>;
  port: number;
}> {
  const server = createTlsServer({ key: credentials.key, cert: credentials.cert });
  server.on("secureConnection", (secure: TLSSocket) => {
    secure.write("220 test.invalid ESMTP ready\r\n");
    secure.on("error", () => undefined);
  });
  server.on("tlsClientError", () => undefined);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
    });
  });
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
    // The runner budget must exceed this test's own deadline, or the deadline
    // can never fire: bun's default is 5s, and a 3s deadline plus setup on a
    // loaded runner lands close enough to it that the test would die as an
    // opaque "timed out after 5000ms" instead of reporting its assertions.
  }, 20_000);

  test("a self-signed certificate is refused when it is not trusted", async () => {
    // Over implicit TLS, not STARTTLS — see the header for why the STARTTLS
    // form of this test could not fail.
    const credentials = generateCertificate();
    const { server, port } = await startTlsServer(credentials);
    // Generous beside a handshake that resolves in single-digit milliseconds,
    // and short enough that a client which WRONGLY accepted the certificate
    // ends here on the deadline rather than looking like a refusal.
    const deadline = startDeadline(4_000);
    try {
      const outcome = await sendMail({
        ...baseOptions(port),
        implicitTls: true,
        signal: deadline.signal,
      });
      // The REASON is the assertion. `ok: false` on its own is also what an
      // aborted send returns, which is precisely how the previous version of
      // this test passed with certificate verification turned off.
      if (outcome.ok) throw new Error("the self-signed certificate was accepted");
      expect(outcome.error).toMatch(/self[- ]signed|certificate|CERT_/i);
    } finally {
      deadline.cancel();
      server.close();
    }
  }, 20_000);
});
