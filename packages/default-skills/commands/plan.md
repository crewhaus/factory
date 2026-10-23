---
description: Show the current plan with claimed vs proven status for every step
---
Show the current plan. Call `PlanRead` and render the active plan: every
step with the status `PlanRead` gives it (`open`, `in_progress`, `claimed`,
`proven`, or `proven (unverified)`). Say plainly which steps are verified:
only `proven` means `PlanComplete` checked real toolUseId evidence against
the event log. `claimed` is self-reported, and so is `proven (unverified)`:
its cited ids were recorded without being checked, because proof checking
was off when it was completed. Where the harness requires proof, a plan is
complete only when every step is `proven`: name the steps that still need
it. Include the current focus and any unresolved REQ entries from
`FocusRead`. If no plan exists, say so and offer to start one. This is a
read — change nothing.
