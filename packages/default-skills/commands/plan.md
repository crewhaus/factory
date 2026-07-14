---
description: Show the current plan with claimed vs proven status for every step
---
Show the current plan. Call `PlanRead` and render the active plan: every
step with its status (`open`, `in_progress`, `claimed`, `proven`).
Distinguish claimed from proven explicitly — a step is proven only when
`PlanComplete` verified real toolUseId evidence against the event log;
everything else is self-reported. Include the current focus and any
unresolved REQ entries from `FocusRead`. If no plan exists, say so and
offer to start one. This is a read — change nothing.
