#!/bin/sh
# Approve the release run that waits at its review Gate for one version.
# Set JR2_URL, JR2_TOKEN and VERSION before you run this script. It needs curl and jq.
set -eu

auth="Authorization: Bearer $JR2_TOKEN"

# The open Gates of the live release runs that this token can answer, with their meta.
runs=$(curl -fsS -H "$auth" "$JR2_URL/gates?workflow=release" |
  jq -r --arg v "$VERSION" '.gates[] | select(.gate == "review" and .meta.version == $v) | .runId')
for run in $runs; do
  curl -fsS -X POST -H "$auth" -H "Content-Type: application/json" \
    -d '{"type":"approve"}' "$JR2_URL/runs/$run/gates/review/events"
  echo
done
