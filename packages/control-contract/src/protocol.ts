/** The wire id and the headers of `crewhaus.hangar.v1`. */

export const PROTOCOL_ID = "crewhaus.hangar.v1";
export const API_PREFIX = "/api/v1";
export const PROTOCOL_HEADER = "CrewHaus-Protocol";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
/** What an `Idempotency-Key` header may hold. */
export const IDEMPOTENCY_VALUE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";
