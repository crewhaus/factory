---
description: Clear the plan files (moved to trash, restorable — never hard-deleted)
---
The user asked to clear the plan. Call `MemoryClear` scoped to the plan
store, with a justification naming this explicit request. Clearing moves
the plan files into the trash directory — nothing is hard-deleted. Confirm
to the user what was cleared and how to restore it (the
`crewhaus memory restore` command with the timestamp from the tool result).
Focus, goals, wiki, and facts are untouched.
