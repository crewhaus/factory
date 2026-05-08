/**
 * Section 30 — LiveKit SIP telephony adapter for `@crewhaus/call-session`.
 * LiveKit Cloud's SIP gateway provides outbound + inbound SIP trunks; this
 * adapter targets their REST/RPC API for call control.
 */
import { CallSessionError, type TelephonyAdapter } from "../index";

export type LiveKitSipAdapterOptions = {
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly fromNumber: string;
  readonly fetchImpl?: typeof fetch;
};

export function createLiveKitSipAdapter(opts: LiveKitSipAdapterOptions): TelephonyAdapter {
  if (!opts.url) throw new CallSessionError("livekit-sip adapter requires url");
  if (!opts.apiKey) throw new CallSessionError("livekit-sip adapter requires apiKey");
  if (!opts.apiSecret) throw new CallSessionError("livekit-sip adapter requires apiSecret");
  if (!opts.fromNumber) throw new CallSessionError("livekit-sip adapter requires fromNumber");
  const fetchImpl = opts.fetchImpl ?? fetch;
  let activeParticipantId: string | undefined;

  async function rpc(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetchImpl(`${opts.url}/twirp/livekit.SIP/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}:${opts.apiSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new CallSessionError(
        `livekit-sip ${method} returned ${res.status}: ${await res.text()}`,
      );
    }
    return await res.json();
  }

  return {
    kind: "livekit-sip",
    async dial(toUri: string): Promise<void> {
      const result = (await rpc("CreateSIPParticipant", {
        sip_call_to: toUri,
        sip_number: opts.fromNumber,
      })) as { participant_id?: string };
      activeParticipantId = result.participant_id ?? "unknown";
    },
    async answer(): Promise<void> {
      // LiveKit dispatches answer via the room agent — adapter-level no-op.
    },
    async hold(): Promise<void> {
      if (!activeParticipantId) throw new CallSessionError("livekit-sip: no active call to hold");
      await rpc("UpdateSIPParticipant", {
        participant_id: activeParticipantId,
        muted: true,
      });
    },
    async resume(): Promise<void> {
      if (!activeParticipantId) throw new CallSessionError("livekit-sip: no active call to resume");
      await rpc("UpdateSIPParticipant", {
        participant_id: activeParticipantId,
        muted: false,
      });
    },
    async transfer(toUri: string): Promise<void> {
      if (!activeParticipantId)
        throw new CallSessionError("livekit-sip: no active call to transfer");
      await rpc("TransferSIPParticipant", {
        participant_id: activeParticipantId,
        transfer_to: toUri,
      });
    },
    async end(_reason: string): Promise<void> {
      if (!activeParticipantId) return;
      await rpc("DeleteSIPParticipant", { participant_id: activeParticipantId });
      activeParticipantId = undefined;
    },
  };
}
