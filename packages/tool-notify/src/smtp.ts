/**
 * An SMTP client, written out rather than pulled in.
 *
 * SMTP is a line protocol with about eight verbs, and the parts that are
 * easy to get wrong are the parts a dependency would hide: whether the
 * session actually reached TLS before the password went across, whether a
 * multi-line reply was read to its end, whether a line beginning with `.`
 * ended the message early, and whether anything at all bounds how long the
 * conversation may run or how much a hostile server may make the client
 * buffer. Each of those is handled here, explicitly:
 *
 *   - **TLS is required by default.** `requireTls` starts true. A server
 *     that does not advertise STARTTLS, or that fails the upgrade, ends the
 *     session BEFORE any credential is sent. Turning it off is an explicit
 *     argument, and the result says the session was in the clear.
 *   - **Credentials never appear anywhere.** They arrive already resolved
 *     from an environment variable name, are written once, and the
 *     transcript records `AUTH PLAIN <redacted>` — the base64 blob is never
 *     kept, logged or returned.
 *   - **Every phase is deadline-bounded.** One `AbortSignal` covers connect,
 *     handshake, every read and the whole DATA transfer; when it fires the
 *     socket is destroyed rather than left to the OS.
 *   - **Reads are capped.** A reply that grows past the cap ends the session.
 *     The cap bounds what is ever held in memory, not what is kept after
 *     buffering, so a server that streams megabytes at the greeting cannot
 *     make this process grow.
 *   - **The message is dot-stuffed** before DATA, by `mime.ts`.
 *
 * What it does NOT do: no connection pooling, no pipelining, no DSN, no
 * CRAM-MD5 or XOAUTH2, no retry. One message, one session, one answer.
 */
import { Buffer } from "node:buffer";
import { type Socket, connect as netConnect } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { dotStuff } from "./lib/mime";
import { expandIpv6, normalizeIpv4 } from "./net";

/**
 * The SNI name to present, or `undefined` when the host is an IP literal.
 *
 * RFC 6066 §3 forbids a literal address in `server_name`, and both Node and
 * Bun refuse to set one — so a harness pointed at an SMTP server by address
 * would otherwise fail during the handshake with an error about the option
 * rather than about the connection. Certificate verification still runs; it
 * simply matches on the address instead of on a name.
 */
function sniFor(host: string): string | undefined {
  const bare = host.replace(/^\[/, "").replace(/\]$/, "");
  if (normalizeIpv4(bare) !== null) return undefined;
  if (bare.includes(":") && expandIpv6(bare) !== null) return undefined;
  return host;
}

export type SmtpReply = {
  readonly code: number;
  readonly lines: readonly string[];
};

export type SmtpOptions = {
  readonly host: string;
  readonly port: number;
  /** The address vetted by the SSRF gate; the socket dials this, not `host`. */
  readonly pinnedIp: string;
  /** True for implicit TLS (port 465). False starts plain and may STARTTLS. */
  readonly implicitTls: boolean;
  /** Refuse to continue in the clear. Default true at the call site. */
  readonly requireTls: boolean;
  /** Rejects an untrusted certificate. Only a test has a reason to relax it. */
  readonly rejectUnauthorized: boolean;
  readonly username?: string | undefined;
  /** Already resolved from an environment variable NAME by the caller. */
  readonly password?: string | undefined;
  readonly authMethod?: "plain" | "login" | "auto" | undefined;
  /** The name the client announces in EHLO. */
  readonly ehloName: string;
  readonly envelopeFrom: string;
  readonly envelopeTo: readonly string[];
  /** The complete RFC 5322 message, not yet dot-stuffed. */
  readonly message: string;
  readonly signal: AbortSignal;
  /** Cap on a single reply, and on what is buffered while reading one. */
  readonly maxReplyBytes: number;
};

export type SmtpOutcome =
  | {
      readonly ok: true;
      readonly secured: boolean;
      readonly authenticated: boolean;
      readonly accepted: readonly string[];
      readonly rejected: ReadonlyArray<{ readonly address: string; readonly reply: string }>;
      /** The server's reply to the final dot — where a queue id usually is. */
      readonly queued: string;
      readonly transcript: readonly string[];
      readonly capabilities: readonly string[];
    }
  | { readonly ok: false; readonly error: string; readonly transcript: readonly string[] };

class SmtpError extends Error {
  override readonly name = "SmtpError";
}

/** Longest single line this client will accept, per RFC 5321 §4.5.3.1.6. */
const MAX_LINE = 1000;

/**
 * The EHLO argument, per RFC 5321 §4.1.1.1: a domain, or an address literal
 * in square brackets. Nothing else, and in particular nothing carrying a CR,
 * an LF or a space.
 *
 * SMTP is a line protocol, so a CRLF inside ANY command argument does not
 * produce a malformed command — it produces a SECOND command, which the
 * server executes. A `RCPT TO:` smuggled in behind an EHLO name would add a
 * recipient that `allowed_recipients` never saw, which is the whole gate
 * gone. Every caller-supplied value that reaches a command line is therefore
 * checked here, at the last place before the socket, rather than only at the
 * schema that happens to be in front of it today.
 */
const EHLO_NAME =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])$/;

/** An envelope path: no whitespace, no angle brackets, no control character. */
const ENVELOPE_ADDRESS = /^[^\s<>\r\n\0,;]+$/;

/** The reason an argument may not go on a command line, or `null`. */
function commandArgumentError(options: SmtpOptions): string | null {
  if (options.ehloName.length > 255 || !EHLO_NAME.test(options.ehloName)) {
    return 'the EHLO name must be a domain or a bracketed address literal, e.g. "crewhaus.invalid" — a value carrying a space or a line break is refused, because SMTP would read the remainder as a command of its own';
  }
  for (const address of [options.envelopeFrom, ...options.envelopeTo]) {
    if (address.length > 254 || !ENVELOPE_ADDRESS.test(address)) {
      return `"${address.replace(/[\r\n]/g, "\\n").slice(0, 80)}" is not an envelope address this client will put on a command line`;
    }
  }
  for (const credential of [options.username, options.password]) {
    if (credential !== undefined && /[\0\r\n]/.test(credential)) {
      // The SASL blob is base64, so this cannot inject a line — but a NUL in
      // a credential silently re-splits the PLAIN message into different
      // fields, which fails in a way nobody can read off the wire.
      return "an SMTP credential may not contain a NUL or a line break";
    }
  }
  return null;
}

/**
 * One SMTP session over one socket, with a reply parser that understands
 * multi-line replies and a buffer that cannot grow past a cap.
 */
class Session {
  private socket: Socket | TLSSocket;
  private readonly maxReplyBytes: number;
  private readonly signal: AbortSignal;
  private buffer = "";
  private closed = false;
  private failure: Error | null = null;
  private waiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  readonly transcript: string[] = [];

  constructor(socket: Socket | TLSSocket, maxReplyBytes: number, signal: AbortSignal) {
    this.socket = socket;
    this.maxReplyBytes = maxReplyBytes;
    this.signal = signal;
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer, "utf8") > this.maxReplyBytes) {
        // Cut the session rather than the string: a server that keeps
        // talking past the cap is not one to keep reading from.
        this.fail(
          new SmtpError(
            `the server sent more than ${this.maxReplyBytes} bytes in a single reply — session abandoned`,
          ),
        );
        return;
      }
      this.waiter?.resolve();
    });
    socket.on("error", (err: Error) => this.fail(err));
    socket.on("close", () => {
      this.closed = true;
      this.waiter?.resolve();
    });
  }

  /** Replace the underlying socket after a STARTTLS upgrade. */
  upgrade(socket: TLSSocket): void {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    this.socket = socket;
    this.buffer = "";
    this.closed = false;
    this.attach(socket);
  }

  private fail(err: Error): void {
    if (this.failure === null) this.failure = err;
    this.waiter?.reject(err);
  }

  destroy(): void {
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }

  /**
   * Write one command or the body, under the session's deadline.
   *
   * A socket whose peer stops reading applies backpressure and the write
   * callback simply never fires. Without the abort listener the deadline
   * would elapse, nothing would notice, and the tool would hang past its own
   * timeout — so the abort destroys the socket and the write rejects.
   */
  write(text: string, logged: string): Promise<void> {
    this.transcript.push(`C: ${logged}`);
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) {
        reject(new SmtpError("deadline elapsed before the client could send"));
        return;
      }
      const onAbort = (): void => {
        this.destroy();
        reject(new SmtpError("deadline elapsed while sending to the server"));
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      this.socket.write(text, "utf8", (err) => {
        this.signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Pull one complete reply out of the buffer, or `null` if it is partial. */
  private parse(): SmtpReply | null {
    let index = 0;
    const lines: string[] = [];
    let code = 0;
    while (true) {
      const newline = this.buffer.indexOf("\r\n", index);
      if (newline === -1) {
        if (this.buffer.length - index > MAX_LINE) {
          throw new SmtpError("the server sent a line longer than SMTP allows");
        }
        return null;
      }
      const line = this.buffer.slice(index, newline);
      index = newline + 2;
      const match = line.match(/^(\d{3})([ -]?)(.*)$/);
      if (match === null) {
        throw new SmtpError("the server sent a reply this client could not parse");
      }
      code = Number.parseInt(match[1] as string, 10);
      lines.push(match[3] as string);
      if (match[2] !== "-") {
        this.buffer = this.buffer.slice(index);
        return { code, lines };
      }
    }
  }

  async read(): Promise<SmtpReply> {
    const signal = this.signal;
    while (true) {
      if (this.failure !== null) throw this.failure;
      const reply = this.parse();
      if (reply !== null) {
        this.transcript.push(`S: ${reply.code} ${reply.lines.join(" | ")}`);
        return reply;
      }
      if (this.closed) throw new SmtpError("the server closed the connection mid-reply");
      if (signal.aborted) throw new SmtpError("deadline elapsed while waiting for the server");
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          this.waiter = null;
          reject(new SmtpError("deadline elapsed while waiting for the server"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.waiter = {
          resolve: () => {
            signal.removeEventListener("abort", onAbort);
            this.waiter = null;
            resolve();
          },
          reject: (err) => {
            signal.removeEventListener("abort", onAbort);
            this.waiter = null;
            reject(err);
          },
        };
      });
    }
  }

  /** Send a command and read its reply. */
  async command(text: string, logged = text): Promise<SmtpReply> {
    await this.write(`${text}\r\n`, logged);
    return this.read();
  }
}

function connectSocket(options: SmtpOptions): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    // An `abort` that has ALREADY fired never fires again, so a listener
    // added after it is never called and the dial would wait on the OS
    // timeout instead of on the deadline.
    if (options.signal.aborted) {
      reject(new SmtpError("the deadline had already elapsed before the connection was attempted"));
      return;
    }
    const onAbort = (): void => {
      socket.destroy();
      reject(new SmtpError("deadline elapsed before the SMTP connection was established"));
    };
    const socket = options.implicitTls
      ? tlsConnect({
          host: options.pinnedIp,
          port: options.port,
          rejectUnauthorized: options.rejectUnauthorized,
          ...(sniFor(options.host) !== undefined ? { servername: sniFor(options.host) } : {}),
        })
      : netConnect({ host: options.pinnedIp, port: options.port });
    const settled = (fn: () => void): void => {
      options.signal.removeEventListener("abort", onAbort);
      fn();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    socket.once(options.implicitTls ? "secureConnect" : "connect", () =>
      settled(() => resolve(socket)),
    );
    socket.once("error", (err: Error) => settled(() => reject(err)));
  });
}

function upgradeSocket(socket: Socket, options: SmtpOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      socket.destroy();
      reject(new SmtpError("the deadline elapsed before the STARTTLS handshake began"));
      return;
    }
    const tlsSocket = tlsConnect({
      socket,
      // The identity the certificate must match. `servername` carries it for
      // a named host; for an IP literal, where SNI is not allowed, `host` is
      // what the identity check falls back to — without it an upgraded
      // socket has no name to verify against at all.
      host: options.host,
      rejectUnauthorized: options.rejectUnauthorized,
      ...(sniFor(options.host) !== undefined ? { servername: sniFor(options.host) } : {}),
    });
    const onAbort = (): void => {
      tlsSocket.destroy();
      reject(new SmtpError("deadline elapsed during the STARTTLS handshake"));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    tlsSocket.once("secureConnect", () => {
      options.signal.removeEventListener("abort", onAbort);
      resolve(tlsSocket);
    });
    tlsSocket.once("error", (err: Error) => {
      options.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/** Capability names from an EHLO reply, uppercased, in the server's order. */
function capabilitiesOf(reply: SmtpReply): string[] {
  return reply.lines.slice(1).map((line) => line.trim().toUpperCase());
}

function advertises(capabilities: readonly string[], name: string): string | undefined {
  return capabilities.find((c) => c === name || c.startsWith(`${name} `));
}

/**
 * Run one session and deliver one message.
 *
 * Never throws: a protocol failure, a refused recipient and a blown deadline
 * all come back as an outcome, with the transcript so far, because the
 * transcript is what makes an SMTP problem diagnosable without a packet
 * capture.
 */
export async function sendMail(options: SmtpOptions): Promise<SmtpOutcome> {
  let session: Session | null = null;
  try {
    // Before the socket, not after: a refusal here has sent nothing.
    const badArgument = commandArgumentError(options);
    if (badArgument !== null) throw new SmtpError(badArgument);
    const socket = await connectSocket(options);
    session = new Session(socket, options.maxReplyBytes, options.signal);
    const s = session;

    const greeting = await s.read();
    if (greeting.code !== 220) {
      throw new SmtpError(`the server refused the connection: ${greeting.code}`);
    }

    let ehlo = await s.command(`EHLO ${options.ehloName}`);
    if (ehlo.code !== 250) {
      throw new SmtpError(`EHLO was refused: ${ehlo.code} ${ehlo.lines.join(" ")}`);
    }
    let capabilities = capabilitiesOf(ehlo);
    let secured = options.implicitTls;

    if (!secured && advertises(capabilities, "STARTTLS") !== undefined) {
      const ready = await s.command("STARTTLS");
      if (ready.code !== 220) {
        throw new SmtpError(`STARTTLS was refused: ${ready.code} ${ready.lines.join(" ")}`);
      }
      const upgraded = await upgradeSocket(socket as Socket, options);
      s.upgrade(upgraded);
      secured = true;
      // RFC 3207 §4.2: everything the server said before the upgrade is
      // discarded, because it was said by whoever was on the wire.
      ehlo = await s.command(`EHLO ${options.ehloName}`);
      if (ehlo.code !== 250) {
        throw new SmtpError(`EHLO after STARTTLS was refused: ${ehlo.code}`);
      }
      capabilities = capabilitiesOf(ehlo);
    }

    if (!secured && options.requireTls) {
      // Before AUTH, before MAIL FROM: nothing has left this process yet.
      throw new SmtpError(
        "the server did not offer STARTTLS and requireTls is set, so the session was ended before anything was sent. Set requireTls false only for a host you control on a network you trust.",
      );
    }

    // -- authentication ---------------------------------------------------

    let authenticated = false;
    if (options.username !== undefined && options.password !== undefined) {
      const authCap = advertises(capabilities, "AUTH");
      const offered = (authCap ?? "").split(/\s+/).slice(1);
      const wanted = options.authMethod ?? "auto";
      const canPlain = offered.includes("PLAIN");
      const canLogin = offered.includes("LOGIN");
      const method =
        wanted === "plain"
          ? "plain"
          : wanted === "login"
            ? "login"
            : canPlain
              ? "plain"
              : canLogin
                ? "login"
                : null;
      if (authCap === undefined) {
        throw new SmtpError(
          "the server does not advertise AUTH, but a username was supplied — sending the credential anyway would hand it to a server that never asked for it",
        );
      }
      if (method === null) {
        throw new SmtpError(
          `the server offers AUTH ${offered.join(" ")}, none of which this client implements (it speaks PLAIN and LOGIN)`,
        );
      }
      if (method === "plain") {
        const blob = Buffer.from(
          `\u0000${options.username}\u0000${options.password}`,
          "utf8",
        ).toString("base64");
        await s.write(`AUTH PLAIN ${blob}\r\n`, "AUTH PLAIN <redacted>");
        const reply = await s.read();
        if (reply.code !== 235) {
          throw new SmtpError(`authentication failed: ${reply.code} ${reply.lines.join(" ")}`);
        }
      } else {
        const start = await s.command("AUTH LOGIN");
        if (start.code !== 334) {
          throw new SmtpError(`AUTH LOGIN was refused: ${start.code}`);
        }
        await s.write(
          `${Buffer.from(options.username, "utf8").toString("base64")}\r\n`,
          "<username, redacted>",
        );
        const askPassword = await s.read();
        if (askPassword.code !== 334) {
          throw new SmtpError(`the server did not ask for a password: ${askPassword.code}`);
        }
        await s.write(
          `${Buffer.from(options.password, "utf8").toString("base64")}\r\n`,
          "<password, redacted>",
        );
        const reply = await s.read();
        if (reply.code !== 235) {
          throw new SmtpError(`authentication failed: ${reply.code} ${reply.lines.join(" ")}`);
        }
      }
      authenticated = true;
    }

    // -- envelope ---------------------------------------------------------

    const sizeCap = advertises(capabilities, "SIZE");
    if (sizeCap !== undefined) {
      const limit = Number.parseInt(sizeCap.split(/\s+/)[1] ?? "", 10);
      const bytes = Buffer.byteLength(options.message, "utf8");
      if (Number.isFinite(limit) && limit > 0 && bytes > limit) {
        throw new SmtpError(
          `the message is ${bytes} bytes and the server accepts at most ${limit} — refused here rather than after the whole body has been uploaded`,
        );
      }
    }

    const mailFrom = await s.command(`MAIL FROM:<${options.envelopeFrom}>`);
    if (mailFrom.code !== 250) {
      throw new SmtpError(
        `the server refused the sender: ${mailFrom.code} ${mailFrom.lines.join(" ")}`,
      );
    }

    const accepted: string[] = [];
    const rejected: Array<{ address: string; reply: string }> = [];
    for (const address of options.envelopeTo) {
      const rcpt = await s.command(`RCPT TO:<${address}>`);
      if (rcpt.code === 250 || rcpt.code === 251) accepted.push(address);
      else rejected.push({ address, reply: `${rcpt.code} ${rcpt.lines.join(" ")}` });
    }
    if (accepted.length === 0) {
      await s.command("QUIT").catch(() => undefined);
      return {
        ok: false,
        error: `every recipient was refused: ${rejected
          .map((r) => `${r.address} (${r.reply})`)
          .join("; ")}`,
        transcript: s.transcript,
      };
    }

    // -- body -------------------------------------------------------------

    const data = await s.command("DATA");
    if (data.code !== 354) {
      throw new SmtpError(`the server refused DATA: ${data.code} ${data.lines.join(" ")}`);
    }
    await s.write(dotStuff(options.message), `<message body, ${options.message.length} chars>`);
    const queued = await s.read();
    if (queued.code !== 250) {
      throw new SmtpError(`the message was not accepted: ${queued.code} ${queued.lines.join(" ")}`);
    }

    await s.command("QUIT").catch(() => undefined);
    return {
      ok: true,
      secured,
      authenticated,
      accepted,
      rejected,
      queued: queued.lines.join(" "),
      transcript: s.transcript,
      capabilities,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, transcript: session?.transcript ?? [] };
  } finally {
    session?.destroy();
  }
}
