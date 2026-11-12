/**
 * `@crewhaus/people-service`: profile management for Home and `crewhaus people` (#521,
 * module brief 329). It holds the rules a profile obeys and the people domain's policy;
 * `@crewhaus/people/vault` keeps the records. It never enters a compiled harness.
 */
export {
  type Answer,
  type Done,
  type ExportBuilt,
  type ExportOptions,
  NOT_FOUND,
  type PeopleAdmin,
  type PeopleAdminOptions,
  type PersonData,
  type PersonPatch,
  type ReceiptAnswer,
  type ReceiptRequest,
  type ReceiptSettlement,
  type ReceiptsPort,
  type Refused,
  type ReviewInput,
  SAVED_KEY_ROTATION,
  type StoredClaim,
  createPeopleAdmin,
  currentNotes,
} from "./admin";
export {
  CUSTODIAN_WITHHELD,
  PERSON_PERMISSIONS,
  type PersonPermission,
  type PersonVerdict,
  authorizePerson,
  authorizeSpace,
  roleOn,
} from "./policy";
