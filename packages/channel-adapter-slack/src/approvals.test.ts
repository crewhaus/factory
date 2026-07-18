import { describe, expect, test } from "bun:test";
import {
  APPROVAL_BLOCK_ID_PREFIX,
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  buildApprovalMessage,
  createSlackAdapter,
  parseSlackInteraction,
  signSlackBody,
} from "./index";
import type { InboundEvent } from "./index";

const SECRET = "test-secret-1234567890";

// biome-ignore lint/suspicious/noExplicitAny: test drills into opaque Block Kit JSON.
type Any = any;

const EVENT: InboundEvent = {
  idempotencyKey: "E1",
  workspaceId: "T1",
  channelId: "C1",
  userId: "U1",
  threadTs: "110.0",
  ts: "111.0",
  text: "please run the deploy",
  subtype: "app_mention",
};

/** Craft the `payload=<urlencoded json>` body Slack POSTs when a user clicks a
 *  button on a message built by `buildApprovalMessage`. */
function slackButtonClickBody(
  approvalId: string,
  actionId: string,
  overrides: Record<string, unknown> = {},
): string {
  const built = buildApprovalMessage({
    approvalId,
    toolName: "bash",
    inputPreview: '{"command":"deploy"}',
    surface: "daemon",
  });
  const actionsBlock = (built.blocks as Any[]).find((b) => b.type === "actions");
  const button = actionsBlock.elements.find((e: Any) => e.action_id === actionId);
  const payload = {
    type: "block_actions",
    user: { id: "U9" },
    channel: { id: "C1" },
    message: { ts: "111.0", thread_ts: "110.0" },
    response_url: "https://hooks.slack.test/actions/xyz",
    container: { thread_ts: "110.0" },
    actions: [
      { action_id: button.action_id, block_id: actionsBlock.block_id, value: button.value },
    ],
    ...overrides,
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

describe("buildApprovalMessage (block-kit)", () => {
  test("renders a section, an actions block, and a context hint", () => {
    const msg = buildApprovalMessage({
      approvalId: "appr_abc",
      toolName: "bash",
      inputPreview: '{"command":"ls"}',
      surface: "daemon",
    });
    expect(msg.text).toContain("bash");
    const types = (msg.blocks as Any[]).map((b) => b.type);
    expect(types).toEqual(["section", "actions", "context"]);
  });

  test("both buttons carry the approvalId in value; block_id carries it too", () => {
    const id = "appr_deadbeef";
    const msg = buildApprovalMessage({
      approvalId: id,
      toolName: "t",
      inputPreview: "{}",
      surface: "s",
    });
    const actions = (msg.blocks as Any[]).find((b) => b.type === "actions");
    expect(actions.block_id).toBe(`${APPROVAL_BLOCK_ID_PREFIX}${id}`);
    const ids = actions.elements.map((e: Any) => e.action_id);
    expect(ids).toEqual([APPROVE_ACTION_ID, DENY_ACTION_ID]);
    for (const el of actions.elements) expect(el.value).toBe(id);
    // Approve is primary/green, Deny is danger/red.
    expect(actions.elements[0].style).toBe("primary");
    expect(actions.elements[1].style).toBe("danger");
  });

  test("a triple-backtick in the preview cannot break the code fence", () => {
    const msg = buildApprovalMessage({
      approvalId: "appr_x",
      toolName: "t",
      inputPreview: "before ``` after",
      surface: "s",
    });
    const section = (msg.blocks as Any[]).find((b) => b.type === "section");
    // The only ``` fences are the two we wrote; the injected ones are stripped.
    expect(section.text.text.match(/```/g)?.length).toBe(2);
  });
});

describe("parseSlackInteraction — button payload round-trip", () => {
  test("Approve click round-trips the approvalId + grant + context", () => {
    const parsed = parseSlackInteraction(slackButtonClickBody("appr_round1", APPROVE_ACTION_ID));
    expect(parsed).toEqual({
      kind: "approval_action",
      approvalId: "appr_round1",
      decision: "grant",
      userId: "U9",
      channelId: "C1",
      messageTs: "111.0",
      threadTs: "110.0",
      responseUrl: "https://hooks.slack.test/actions/xyz",
    });
  });

  test("Deny click maps to decision 'deny'", () => {
    const parsed = parseSlackInteraction(slackButtonClickBody("appr_round2", DENY_ACTION_ID));
    expect(parsed.kind).toBe("approval_action");
    if (parsed.kind === "approval_action") {
      expect(parsed.decision).toBe("deny");
      expect(parsed.approvalId).toBe("appr_round2");
    }
  });

  test("recovers the approvalId from block_id when value is absent", () => {
    const payload = {
      type: "block_actions",
      user: { id: "U9" },
      actions: [
        { action_id: APPROVE_ACTION_ID, block_id: `${APPROVAL_BLOCK_ID_PREFIX}appr_fromblock` },
      ],
    };
    const parsed = parseSlackInteraction(`payload=${encodeURIComponent(JSON.stringify(payload))}`);
    expect(parsed.kind === "approval_action" && parsed.approvalId).toBe("appr_fromblock");
  });

  test("skips a non-approval interaction (unknown action_id)", () => {
    const payload = {
      type: "block_actions",
      user: { id: "U9" },
      actions: [{ action_id: "some_other_button", value: "x" }],
    };
    expect(
      parseSlackInteraction(`payload=${encodeURIComponent(JSON.stringify(payload))}`).kind,
    ).toBe("skip");
  });

  test("skips a non-block_actions payload, malformed JSON, and a missing payload", () => {
    const viewSubmit = `payload=${encodeURIComponent(JSON.stringify({ type: "view_submission" }))}`;
    expect(parseSlackInteraction(viewSubmit).kind).toBe("skip");
    expect(parseSlackInteraction("payload=%7Bnot-json").kind).toBe("skip");
    expect(parseSlackInteraction("token=abc&team_id=T1").kind).toBe("skip");
  });

  test("skips when the deciding user is missing (can't attribute the decision)", () => {
    const payload = {
      type: "block_actions",
      actions: [{ action_id: APPROVE_ACTION_ID, value: "appr_x" }],
    };
    expect(
      parseSlackInteraction(`payload=${encodeURIComponent(JSON.stringify(payload))}`).kind,
    ).toBe("skip");
  });
});

describe("actions webhook — signature verification (same signing machinery)", () => {
  test("adapter.verify accepts a correctly signed interactivity body", () => {
    const body = slackButtonClickBody("appr_sig", APPROVE_ACTION_ID);
    const ts = 1_700_000_000;
    const headers = new Headers();
    headers.set("x-slack-request-timestamp", String(ts));
    headers.set("x-slack-signature", signSlackBody({ body, timestamp: ts, signingSecret: SECRET }));
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { now: () => ts * 1000 + 1000 },
    );
    expect(adapter.verify({ headers, body })).toBe(true);
  });

  test("adapter.verify rejects a tampered interactivity body", () => {
    const body = slackButtonClickBody("appr_sig", APPROVE_ACTION_ID);
    const ts = 1_700_000_000;
    const headers = new Headers();
    headers.set("x-slack-request-timestamp", String(ts));
    headers.set("x-slack-signature", signSlackBody({ body, timestamp: ts, signingSecret: SECRET }));
    // Flip Approve → Deny after signing: the signature no longer matches.
    const tampered = body.replace(
      encodeURIComponent(APPROVE_ACTION_ID),
      encodeURIComponent(DENY_ACTION_ID),
    );
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { now: () => ts * 1000 + 1000 },
    );
    expect(adapter.verify({ headers, body: tampered })).toBe(false);
  });
});

describe("createSlackAdapter — approval methods", () => {
  test("postApproval POSTs blocks to the thread and returns the message ts", async () => {
    const captured: Array<{ url: string; body: Any }> = [];
    const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: typeof input === "string" ? input : input.toString(),
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
      });
      return new Response(JSON.stringify({ ok: true, ts: "222.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = createSlackAdapter(
      { botToken: "xoxb-tok", signingSecret: SECRET },
      { apiBaseUrl: "https://slack.test/api", fetch: fakeFetch },
    );
    const res = await adapter.postApproval?.({
      event: EVENT,
      approval: {
        approvalId: "appr_post",
        toolName: "bash",
        inputPreview: "{}",
        surface: "daemon",
      },
    });
    expect(res?.messageTs).toBe("222.0");
    expect(captured[0]?.url).toBe("https://slack.test/api/chat.postMessage");
    expect(captured[0]?.body.channel).toBe("C1");
    expect(captured[0]?.body.thread_ts).toBe("110.0"); // threadTs wins over ts
    expect(Array.isArray(captured[0]?.body.blocks)).toBe(true);
  });

  test("ackApproval prefers response_url with replace_original", async () => {
    const captured: Array<{ url: string; body: Any }> = [];
    const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: typeof input === "string" ? input : input.toString(),
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createSlackAdapter(
      { botToken: "xoxb-tok", signingSecret: SECRET },
      { apiBaseUrl: "https://slack.test/api", fetch: fakeFetch },
    );
    await adapter.ackApproval?.({
      interaction: {
        kind: "approval_action",
        approvalId: "appr_ack",
        decision: "grant",
        userId: "U9",
        responseUrl: "https://hooks.slack.test/actions/xyz",
      },
      decision: "grant",
      by: "slack:U9",
      toolName: "bash",
    });
    expect(captured[0]?.url).toBe("https://hooks.slack.test/actions/xyz");
    expect(captured[0]?.body.replace_original).toBe(true);
    expect(captured[0]?.body.text).toContain("Approved");
  });

  test("ackApproval falls back to chat.update when there is no response_url", async () => {
    const captured: Array<{ url: string; body: Any }> = [];
    const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: typeof input === "string" ? input : input.toString(),
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = createSlackAdapter(
      { botToken: "xoxb-tok", signingSecret: SECRET },
      { apiBaseUrl: "https://slack.test/api", fetch: fakeFetch },
    );
    await adapter.ackApproval?.({
      interaction: {
        kind: "approval_action",
        approvalId: "appr_ack",
        decision: "deny",
        userId: "U9",
        channelId: "C1",
        messageTs: "111.0",
      },
      decision: "deny",
      by: "slack:U9",
    });
    expect(captured[0]?.url).toBe("https://slack.test/api/chat.update");
    expect(captured[0]?.body.ts).toBe("111.0");
    expect(captured[0]?.body.text).toContain("Denied");
  });

  test("parseInteraction delegates to the parser", () => {
    const adapter = createSlackAdapter({ botToken: "xoxb", signingSecret: SECRET });
    const parsed = adapter.parseInteraction?.({
      headers: new Headers(),
      body: slackButtonClickBody("appr_deleg", APPROVE_ACTION_ID),
    });
    expect(parsed?.kind === "approval_action" && parsed.approvalId).toBe("appr_deleg");
  });
});
