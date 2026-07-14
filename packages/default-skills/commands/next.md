---
description: Propose the next action from the current plan
---
Propose the single next action. Read the plan with `PlanRead` and the focus
with `FocusRead`, then pick one: the first open step of the active plan, or
the top unresolved REQ entry if no plan step is actionable. State the
proposed action and why it is next in one or two lines, then wait for the
user's go-ahead instead of starting it.
