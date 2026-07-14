---
description: Write or refresh the handoff now — make the stores reflect reality
---
Refresh the handoff now. The handoff is generated from your stores, so make
them accurate first: (1) `PlanUpdate` every step whose status is stale —
nothing you did stays `open`, nothing unverified is marked past `claimed`;
(2) `PlanComplete` any step you can prove with real toolUseId evidence;
(3) `FocusWrite` the current focus, the unresolved REQ entries, and the
next actions a fresh session should take. Then tell the user what the
handoff now contains: open steps, next actions, unresolved requirements.
