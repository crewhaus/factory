/**
 * The content-free decision log (#507): every lifecycle step writes a line whose
 * keys are the closed set, which never holds tool input, free text or a user
 * name; a sweep logs before it drops; and the action digest is a pinned function.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DECISION_LOG_KEYS,
  DECISION_LOG_REASONS,
  STORED_LOCAL_ACTOR_RE,
  isId,
} from "@crewhaus/control-contract";
import { _setApprovalSeamsForTest } from "./approvals/decide";
import {
  ACTION_DIGEST_LABEL,
  DEFAULT_APPROVALS_FILENAME,
  LOCAL_ACTOR_LABEL,
  PLACES_DIGEST_LABEL,
  approvalsDigestKey,
  createPendingApprovalStore,
  evictExpiredApprovals,
  hashApprovalInput,
  inputDigestOf,
  placesDigestOf,
  storedLocalActor,
} from "./index";
import {
  ALLOW,
  logLines,
  pending,
  removeTempRoots,
  rendezvousLines,
  tempRoot,
} from "./test-helpers";

afterEach(() => _setApprovalSeamsForTest(undefined));
afterAll(removeTempRoots);

const DAY = 86_400_000;
const REQUIRED = ["v", "at", "event", "decision", "sessionId", "tool", "inputDigest", "surface"];

describe("the log is content-free", () => {
  test("park, defer, decide, consume, supersede, expire and evict: closed keys, no content", async () => {
    const SENTINEL = "SENTINEL-do-not-log-7f3a";
    const BY_TEXT = "Alice Example (on call)";
    const actor = { local: "local:alice@host", display: BY_TEXT };
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const input = { command: `echo ${SENTINEL}` };
    const inputHash = hashApprovalInput("Bash", input);
    const first = pending({
      toolName: "Bash",
      input,
      inputHash,
      places: [{ path: `/tmp/${SENTINEL}`, at: [`/tmp/${SENTINEL}`] }],
    });
    await store.persist(first);
    const until = new Date(Date.now() + DAY).toISOString();
    expect(
      (await store.defer(first.id, { until, reason: "awaiting-someone", actor, via: "cli" }, ALLOW))
        .outcome,
    ).toBe("deferred");
    const granted = await store.decide(first.id, { choice: "grant", actor, via: "cli" }, ALLOW);
    expect(granted.outcome).toBe("decided");
    if (granted.record === null) throw new Error("expected the grant");
    await store.persist({ ...granted.record, consumedAt: new Date().toISOString() });

    const second = pending({
      toolName: "Bash",
      input,
      inputHash: hashApprovalInput("Bash", { n: 2 }),
    });
    await store.persist(second);
    await store.decide(second.id, { choice: "deny", actor }, ALLOW);
    const replaced = await store.supersede(
      second.id,
      { actor, via: "cli", reason: "decided-in-error" },
      ALLOW,
    );
    expect(replaced.outcome).toBe("superseded");

    const stale = pending({
      toolName: "Bash",
      input,
      inputHash: hashApprovalInput("Bash", { n: 3 }),
      createdAt: new Date(Date.now() - 40 * DAY).toISOString(),
    });
    await store.persist(stale);
    expect((await evictExpiredApprovals({ rootDir: root })).evictedIds).toEqual([stale.id]);

    const lines = logLines(root);
    const events = lines.map((l) => l["event"]);
    for (const event of ["park", "defer", "decide", "consume", "supersede", "expire", "evict"]) {
      expect(events).toContain(event);
    }
    const allowed: readonly string[] = DECISION_LOG_KEYS;
    for (const line of lines) {
      expect(Object.keys(line).filter((key) => !allowed.includes(key))).toEqual([]);
      for (const key of REQUIRED)
        expect({ event: line["event"], key, has: key in line }).toEqual({
          event: line["event"],
          key,
          has: true,
        });
      expect(line["v"]).toBe(1);
      expect(line["placesDigest"]).toMatch(/^[0-9a-f]{64}$/);
      expect(line["inputDigest"]).toMatch(/^[0-9a-f]{64}$/);
      const by = line["by"];
      if (by !== undefined) {
        expect(STORED_LOCAL_ACTOR_RE.test(String(by)) || isId("prn", by)).toBe(true);
      }
      const reason = line["reason"];
      if (reason !== undefined) {
        const reasons = (DECISION_LOG_REASONS as Readonly<Record<string, readonly string[]>>)[
          String(line["event"])
        ];
        expect(reasons).toContain(String(reason));
      }
    }
    const raw = lines.map((l) => JSON.stringify(l)).join("\n");
    for (const forbidden of [SENTINEL, "alice", BY_TEXT, inputHash, "echo"]) {
      expect({ forbidden, found: raw.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
    // The decide and defer lines carry the stored actor; the decide line its choice only.
    const decide = lines.find((l) => l["event"] === "decide" && l["decision"] === first.id);
    expect(decide).toMatchObject({ choice: "grant", surface: "cli" });
    expect(String(decide?.["by"])).toMatch(STORED_LOCAL_ACTOR_RE);
    expect(lines.find((l) => l["event"] === "defer")?.["by"]).toBe(decide?.["by"]);
    // A resolve() with no surface is recorded as the legacy door.
    const third = pending({ inputHash: "third" });
    await store.persist(third);
    await store.resolve(third.id, "deny", BY_TEXT);
    expect(
      logLines(root).find((l) => l["event"] === "decide" && l["decision"] === third.id)?.[
        "surface"
      ],
    ).toBe("legacy");
  });
});

describe("archive before evict", () => {
  async function seeded() {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const waiting = pending({ inputHash: "w", createdAt: old });
    // Decided records persisted whole, the way a fixture writes them: past the
    // TTL, `decide` itself would answer `expired`.
    const granted = pending({ inputHash: "g", createdAt: old, decision: "grant", decidedAt: old });
    const denied = pending({ inputHash: "d", createdAt: old, decision: "deny", decidedAt: old });
    const fresh = pending({ inputHash: "f" });
    for (const p of [waiting, granted, denied, fresh]) await store.persist(p);
    expect((await store.decide(waiting.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "expired",
    );
    return { root, waiting, granted, denied, fresh };
  }

  const eventsFor = (root: string, id: string) =>
    logLines(root)
      .filter((l) => l["decision"] === id && (l["event"] === "expire" || l["event"] === "evict"))
      .map((l) => [l["event"], l["reason"]]);

  test("each dropped request gets expire (pending, unspent grant) and evict lines; a deny evict only", async () => {
    const { root, waiting, granted, denied, fresh } = await seeded();
    const swept = await evictExpiredApprovals({ rootDir: root });
    expect(swept.evictedIds.sort()).toEqual([waiting.id, granted.id, denied.id].sort());
    expect(eventsFor(root, waiting.id)).toEqual([
      ["expire", "ttl"],
      ["evict", "ttl"],
    ]);
    expect(eventsFor(root, granted.id)).toEqual([
      ["expire", "ttl"],
      ["evict", "ttl"],
    ]);
    expect(eventsFor(root, denied.id)).toEqual([["evict", "ttl"]]);
    expect(rendezvousLines(root).map((l) => l["id"])).toEqual([fresh.id]);
  });

  test("a rewrite that fails leaves the log lines, and the records, in place", async () => {
    const { root, waiting } = await seeded();
    const before = readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8");
    _setApprovalSeamsForTest({
      beforeRewrite: () => {
        throw new Error("disk full");
      },
    });
    await evictExpiredApprovals({ rootDir: root });
    expect(eventsFor(root, waiting.id)).toEqual([
      ["expire", "ttl"],
      ["evict", "ttl"],
    ]);
    expect(readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8")).toBe(before);
  });

  test("the rewrite keeps the folded record, claims applied, not each id's last line", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    await store.decide(p.id, { choice: "grant", actor: { display: "max" } }, ALLOW);
    // An 0.8.x writer appends a flipped line last.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      join(root, DEFAULT_APPROVALS_FILENAME),
      `${JSON.stringify({ ...p, decision: "deny", decidedBy: "eve", decidedAt: new Date().toISOString() })}\n`,
    );
    await evictExpiredApprovals({ rootDir: root });
    const kept = rendezvousLines(root);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: p.id, decision: "grant", decidedBy: "max" });
  });
});

describe("the action digest (a pin: stored digests join forever)", () => {
  async function fixedKey(): Promise<CryptoKey> {
    const raw = new Uint8Array(32).map((_, i) => i);
    return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  test("inputDigestOf, the places digest and the stored local actor match fixed values", async () => {
    const key = await fixedKey();
    expect(ACTION_DIGEST_LABEL).toBe("decision.action");
    expect(PLACES_DIGEST_LABEL).toBe("decision.places");
    expect(LOCAL_ACTOR_LABEL).toBe("local-actor");
    expect(await inputDigestOf(key, "0123456789abcdef".repeat(4))).toBe(
      "fc4a7347494cc55c0ae68deeee58a8f5f53f3b556717c0ea09f8c0fe9c91507c",
    );
    expect(await placesDigestOf(key, undefined)).toBe(
      "9ca8a1c776056bdb796794821d50a23d29e532d738f30ac11d97425aa0fc6cd9",
    );
    expect(await storedLocalActor(key, "local:alice@host")).toBe(
      "local:#0201a636d83124eb7514b4f3f3580d9802bdd489f297f9af301f376aa57ddca8",
    );
  });

  test("the key reader creates nothing, and reads the key the writers made", async () => {
    const root = tempRoot();
    expect((await approvalsDigestKey(root)).state).toBe("absent");
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    const read = await approvalsDigestKey(root);
    if (read.state !== "present") throw new Error(`expected a key, got ${read.state}`);
    const park = logLines(root).find((l) => l["event"] === "park");
    expect(park?.["inputDigest"]).toBe(await inputDigestOf(read.hmac, p.inputHash));
  });
});
