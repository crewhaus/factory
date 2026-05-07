#!/bin/sh
# Reads payload JSON from stdin (ignored) and prints a deny decision.
cat >/dev/null
printf '{"decision":"deny","reason":"fixture deny"}\n'
