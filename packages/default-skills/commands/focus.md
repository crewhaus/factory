---
description: Set the current focus (or show it when called with no text)
argument-hint: "<text>"
---
The user wants to set the current focus to: $ARGUMENTS

If the text above is empty, call `FocusRead` and show the current focus
instead. Otherwise call `FocusWrite` to set the focus to exactly that text,
keeping the existing REQ entries intact, then confirm the new focus back to
the user in one line.
