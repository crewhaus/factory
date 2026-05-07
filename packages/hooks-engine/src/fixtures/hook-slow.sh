#!/bin/sh
# Sleeps longer than any reasonable timeout so the test can verify SIGKILL.
cat >/dev/null
sleep 30
printf '{"decision":"allow"}\n'
