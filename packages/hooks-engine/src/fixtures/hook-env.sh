#!/bin/sh
# Echoes inherited env keys as a newline-separated `decision:env-list` payload.
# Wrapped in JSON so runHooks parses it; the env-list itself is in the
# `reason` field so the test can split it without parsing nested JSON.
cat >/dev/null
keys=$(env | awk -F= '{print $1}' | sort | tr '\n' ',' | sed 's/,$//')
# Escape backslashes and quotes for safe JSON embedding.
esc=$(printf '%s' "$keys" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '{"decision":"allow","reason":"ENV_KEYS=%s"}\n' "$esc"
