#!/bin/sh
# Approve the release run that waits at its review Gate for one version.
# Set JR2_URL, JR2_TOKEN and VERSION before you run this script. It needs curl and jq.
set -eu

auth="Authorization: Bearer $JR2_TOKEN"

# The live runs of the release Workflow.
for run in $(curl -fsS -H "$auth" "$JR2_URL/runs" | jq -r '.[] | select(.workflow == "release") | .runId'); do
  # The open Gates of the run, with their meta.
  version=$(curl -fsS -H "$auth" "$JR2_URL/runs/$run" | jq -r '.gates[] | select(.gate == "review") | .meta.version')
  if [ "$version" = "$VERSION" ]; then
    curl -fsS -X POST -H "$auth" -H "Content-Type: application/json" \
      -d '{"type":"approve"}' "$JR2_URL/runs/$run/gates/review/events"
    echo
  fi
done
