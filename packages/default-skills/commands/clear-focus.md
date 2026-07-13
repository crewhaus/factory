---
description: Clear the current focus (moved to trash, restorable — never hard-deleted)
---
The user asked to clear the focus. Call `MemoryClear` scoped to the focus
store, with a justification naming this explicit request. Clearing moves
the focus file into the trash directory — nothing is hard-deleted, and the
REQ entries it carried can be restored with the `crewhaus memory restore`
command and the timestamp from the tool result. Plans, goals, wiki, and
facts are untouched. Confirm to the user what was cleared and how to undo
it.
