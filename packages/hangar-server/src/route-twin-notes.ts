/**
 * What each write in the route table has for a command-line equivalent, when
 * it is not a core command kind (whose own `cliTwin` the route table carries).
 *
 * One entry per receipted route without a core kind. Each note either names
 * the real command in backticks or says plainly that there is none: a write
 * the console offers is never shown beside a command the CLI does not have.
 * `apps/cli/src/cli-twins.test.ts` checks every command named here against
 * the CLI's verb inventory, and that every such route has a note, so a route
 * added to the table adds its line here.
 *
 * Data only: the notes are not served yet.
 */

const NONE = "No command-line equivalent.";

/** A note naming the one command that does the same thing. */
const same = (command: string): string => `Same as \`${command}\`.`;

export const ROUTE_TWIN_NOTES: Readonly<Record<string, string>> = Object.freeze({
  // The registry and the fleet.
  addHarness: same("crewhaus harness add <dir>"),
  scan: same("crewhaus harness scan"),
  addGroup: same("crewhaus harness group <name>"),
  groupProc: same("crewhaus daemon start|stop|restart --group <name>"),
  addScanRoot: NONE,
  removeHarness: same("crewhaus harness remove <id>"),
  setHidden: NONE,
  relocate: same("crewhaus harness relocate <id> <dir>"),
  setGroups: NONE,
  setTags: NONE,
  setPin: "Same as `crewhaus harness pin <id>`; add `--off` to unpin.",
  setNotes: NONE,
  setGroupsAll: NONE,
  removeGroup: NONE,
  removeScanRoot: NONE,
  // Supervision.
  controlWake: same("crewhaus daemon wake <id> --lane <lane>"),
  adjudicateReview:
    "Pass or fail is `crewhaus review resolve <item> --note pass|fail`; up or down is `crewhaus rate --session <session> --turn <turn> --thumbs up|down --adjudicate` and then that resolve. Run either in the harness directory.",
  submitJob:
    "Same as the job's own command: `crewhaus doctor`, `crewhaus compile crewhaus.yaml -o dist`, `crewhaus eval crewhaus.yaml --dataset <dataset> --graders <graders>` or `crewhaus dream run crewhaus.yaml`.",
  pinSession: NONE,
  pinBaseline: same("crewhaus eval-report baseline set <run>"),
  // Home itself.
  demoInstall: "Same as `cp -R <starter-dir> <dir> && crewhaus harness add <dir>`.",
  setNotifications: NONE,
  clearNotifications: NONE,
  setReadOnly: NONE,
  // The spec.
  specEdit: NONE,
  specPatch: NONE,
  specPin:
    "Same as `crewhaus deploy rollback <name> <env> <version> --require-approval`, or `crewhaus deploy promote <name> <from> <to>` when it moves the current version forward.",
  specRollback: same("crewhaus deploy rollback <name> <env> <version> --require-approval"),
  specPropose: same("crewhaus propose <candidate> --current crewhaus.yaml --source manual"),
  wizardCreate: NONE,
  graderWrite: NONE,
  datasetBuilderStep: NONE,
  mcpConnectorWrite: NONE,
  mcpConnectorRemove: NONE,
  // Memory.
  memoryForget: NONE,
  memorySweep: same("crewhaus memory sweep --spec <spec>"),
  memoryMigrate: same("crewhaus migrate memories"),
  continuityRestore: NONE,
  knowledgeSync: "Same as `crewhaus knowledge sync --pull` or `crewhaus knowledge sync --push`.",
  wikiWrite: same("crewhaus wiki write <slug> --body-file <file> --expect <version>"),
  wikiSignals: NONE,
  wikiArchive: NONE,
  watchmeToggle: same("crewhaus watchme start|stop"),
  watchmeApply: NONE,
  watchmePublish: same("crewhaus watchme publish"),
  // Evals.
  evalLaunch: same("crewhaus eval crewhaus.yaml --dataset <dataset> --graders <graders>"),
  evalSuiteRun: same("crewhaus eval suite <suite> --tier <tier>"),
  judgeCalibrate: same("crewhaus judge calibrate"),
  gradersSuggest: same("crewhaus graders suggest"),
  gradersTest: same("crewhaus graders test"),
  redteamGenerate: same("crewhaus redteam generate"),
  sentinelRun: same(
    "crewhaus eval crewhaus.yaml --dataset <dataset> --graders <graders> --sentinel --baseline <baseline>",
  ),
  optimizerRun: same("crewhaus optimize crewhaus.yaml --dataset <dataset> --graders <graders>"),
  flywheelRun: same("crewhaus flywheel init|run"),
  experimentRecord: same("crewhaus experiment record|assign --name <name> --version <version>"),
  annotateSample: NONE,
  // Data and feedback.
  datasetMine: same("crewhaus dataset mine"),
  datasetSynthesize: same("crewhaus dataset synthesize"),
  datasetRefreshGoldens: same("crewhaus dataset refresh-goldens"),
  distillRun: same("crewhaus distill --all-sessions --register <dataset>"),
  fewshotHarvest: same("crewhaus fewshot harvest"),
  faqDistill: same("crewhaus faq distill"),
  lessonsUpdate: same("crewhaus lessons update"),
  adviceRun: same("crewhaus advise"),
  adviceApply: NONE,
  // Credentials and channels.
  envSet: NONE,
  envUnset: NONE,
  credentialsSetAcross: NONE,
  doctorRun: same("crewhaus doctor"),
  secretsRotate: NONE,
  channelVerify: same("crewhaus channel verify crewhaus.yaml"),
  channelProvisionRun: same(
    "crewhaus channel provision crewhaus.yaml --platform <platform> --base-url <url>",
  ),
  channelProbe: NONE,
  channelSynthetic: NONE,
  // Security.
  egressReview: NONE,
  piiTune: same("crewhaus pii tune"),
  justificationCalibrate: same("crewhaus justification calibrate"),
  onchainTune: same("crewhaus onchain tune crewhaus.yaml"),
  complianceEvidence: same("crewhaus compliance evidence --framework <framework> --period current"),
  retentionSweep: same("crewhaus retention sweep"),
  retentionPurge: same("crewhaus retention purge"),
  // Thredz.
  thredzWikiWrite: NONE,
  thredzWikiRollback: NONE,
  thredzRecordCreate: NONE,
  thredzRecordDelete: NONE,
  thredzRecordRestore: NONE,
  thredzTaskUpdate: NONE,
  thredzCardCreate: NONE,
  thredzListenerCreate: NONE,
  thredzKeyCreate: NONE,
  thredzKeyRotate: NONE,
  // Settings and the advisor.
  settingsWrite: NONE,
  advisorAct: "Same as the command shown on the item, where it has one.",
  advisorDismiss: NONE,
  advisorReopen: NONE,
  advisorReportRun: NONE,
  advisorIssueSubmit: NONE,
  // Runtime processes.
  mcpServerStart: same("crewhaus serve --mcp crewhaus.yaml"),
  mcpServerStop: NONE,
  devStart: same("crewhaus dev crewhaus.yaml"),
  devStop: NONE,
});
