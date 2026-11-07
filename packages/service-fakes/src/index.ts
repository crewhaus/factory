/**
 * Loopback fakes of the services a harness talks to: a model provider, Slack,
 * GitHub, Thredz and SMTP. Test-only and never published. A dependency-free
 * leaf, so any package's tests can start a fake with no cycle.
 */
export {
  type FakeContentBlock,
  type FakeModel,
  type FakeModelFault,
  type FakeModelOptions,
  type FakeModelPrice,
  type FakeModelReply,
  fakeModel,
  promptDigest,
} from "./model";
export {
  type FakeSlack,
  type FakeSlackFault,
  type FakeSlackOptions,
  type FakeSlackScopes,
  type SignedRequest,
  type SlackDeliveryOptions,
  type SlackDeliveryResult,
  type SlackEventOptions,
  fakeSlack,
} from "./slack";
export { type FakeGitHub, type FakeGitHubOptions, fakeGitHub } from "./github";
export {
  type FakeThredz,
  type FakeThredzCall,
  type FakeThredzOptions,
  type FakeThredzReply,
  type FakeThredzRoute,
  fakeThredz,
} from "./thredz";
export { type FakeSmtp, type FakeSmtpMessage, type FakeSmtpOptions, fakeSmtp } from "./smtp";
export { listeningAddresses, parseLsofListeners, parseSsListeners } from "./bind-check";
export { MASKED, type RecordedRequest, maskBody, maskHeaders } from "./record";
export type { FakeService } from "./serve";
export { scanForSecretShapes, secretShapesIn } from "./secret-shapes";
