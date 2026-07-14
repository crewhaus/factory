---
description: Forget stored memories matching a query (supersede, never hard-delete)
argument-hint: "<query>"
---
The user wants to forget memories matching: $ARGUMENTS

Call `MemoryForget` with that query, with a justification naming this
explicit request. Forgetting supersedes the matching entries with
tombstones — recall stops returning them, but the store stays append-only
and nothing is hard-deleted. Report what was forgotten: the count and a
one-line description of each superseded entry.
