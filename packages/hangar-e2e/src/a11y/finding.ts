/** What every accessibility helper returns. None of them throws on a finding. */
export type A11yFinding = {
  readonly rule: string;
  readonly detail: string;
};
