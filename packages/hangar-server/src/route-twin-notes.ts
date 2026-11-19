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
 * Where Home previews first (a dry run by default, and a typed confirmation
 * before the real run), the note names the command's preview form first and
 * says what the command does without it.
 *
 * Served as they are by `GET /api/twin-notes`, and shown beside each write in
 * the console: data, never a route row's `cliTwin`, which only a core command
 * kind carries.
 */

const NONE = "No command-line equivalent.";

/** A note naming the one command that does the same thing. */
const same = (command: string): string => `Same as \`${command}\`.`;

/** A note for a write Home previews first: the CLI's dry run, and what it does without one. */
const dryRunFirst = (command: string, act: string): string =>
  `Same as \`${command} --dry-run\`; without \`--dry-run\` the CLI ${act} at once and asks for no confirmation.`;

export const ROUTE_TWIN_NOTES: Readonly<Record<string, string>> = Object.freeze({
  // The registry and the fleet.
  addHarness: same("crewhaus harness add <dir>"),
  scan: same("crewhaus harness scan"),
  addGroup: same("crewhaus harness group <name>"),
  groupProc: same("crewhaus daemon start|stop|restart --group <name>"),
  addScanRoot:
    "Same as `crewhaus harness scan --root <dir>`, which keeps the root and scans it at once, as Home does; adding a root without scanning it has no command-line equivalent.",
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
  graderWrite:
    "Structured edits are `crewhaus criteria apply <edits-file> --expect <revision>`, with the same `sha256:` revision Home shows; loosening a protected criterion also needs `--confirm <spec-name>` and the harness's owner. The CLI also adds a line to the criteria history, and Home's write does not. Replacing the whole file has no command-line equivalent.",
  datasetBuilderStep: NONE,
  mcpConnectorWrite: NONE,
  mcpConnectorRemove: NONE,
  pluginUseWrite: "No command-line equivalent: edit `plugins:` in crewhaus.yaml.",
  // Memory.
  memoryForget:
    "Same as `crewhaus memory forget <fact-id> --spec <spec> --reason <reason>`, run in the harness folder. The CLI asks you to confirm unless you add `--yes`, and with `--query <text>` also forgets every fact that matches some text, which Home does not offer.",
  memorySweep:
    "Same as `crewhaus memory sweep --spec <spec>` without the preview: the CLI has no dry run, and tombstones expired facts at once.",
  memoryMigrate: dryRunFirst("crewhaus migrate memories", "migrates"),
  continuityRestore:
    "Same as `crewhaus state restore --trash <stamp>`, run in the harness folder. Home waits for the continuity store's lock first, so it never restores while a running agent writes the same files; the CLI restores at once.",
  knowledgeSync:
    "Same as `crewhaus knowledge sync --pull --dry-run` or `crewhaus knowledge sync --push --dry-run`; without `--dry-run` the CLI syncs at once and asks for no confirmation.",
  wikiWrite: same("crewhaus wiki write <slug> --body-file <file> --expect <version>"),
  wikiSignals: NONE,
  wikiArchive:
    "Same as `crewhaus wiki archive <slug> --expect <version>`, run in the harness folder; add `--undo` to publish the article again. The CLI always needs the article's current version, and Home checks it only when it has one.",
  watchmeToggle: same("crewhaus watchme start|stop"),
  watchmeApply: NONE,
  watchmePublish: dryRunFirst("crewhaus watchme publish", "publishes"),
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
  experimentRecord:
    "Same as `crewhaus experiment record --name <name> --version <version> --outcome pass|fail`, or `crewhaus experiment assign --name <name> --key <request>`.",
  annotateSample: NONE,
  // Data and feedback.
  datasetMine: same("crewhaus dataset mine"),
  datasetSynthesize: same("crewhaus dataset synthesize"),
  datasetRefreshGoldens:
    "Same as `crewhaus dataset refresh-goldens --dataset <dataset>`, with `registry:` before the dataset's name, which previews; with `--apply` the CLI writes a new version at once and asks for no confirmation.",
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
  secretsRotate:
    "Home does not rotate secrets yet. `crewhaus secrets rotate <name> --backend file`, run in the harness folder, makes the new value itself and stores it in `.crewhaus/secrets`, so the value never appears on a command line.",
  channelVerify: same("crewhaus channel verify crewhaus.yaml"),
  channelProvisionRun: same(
    "crewhaus channel provision crewhaus.yaml --platform <platform> --base-url <url>",
  ),
  channelProbe: NONE,
  channelSynthetic: NONE,
  // Security.
  egressReview:
    "No command-line equivalent records a verdict on one decision. `crewhaus egress review`, run in the harness folder, summarises its egress decisions instead, and with `--propose` suggests policy changes.",
  piiTune:
    "No command-line equivalent writes a policy you give. `crewhaus pii tune --secret <secret>` proposes one from redaction history, and writes it only with `--write`.",
  justificationCalibrate: same("crewhaus justification calibrate"),
  onchainTune:
    "No command-line equivalent applies a policy you give. `crewhaus onchain tune crewhaus.yaml` proposes one from receipt history and changes nothing in the spec.",
  complianceEvidence: same("crewhaus compliance evidence --framework <framework> --period current"),
  retentionSweep: dryRunFirst("crewhaus retention sweep", "sweeps"),
  retentionPurge: dryRunFirst("crewhaus retention purge", "purges"),
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
