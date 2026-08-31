#!/usr/bin/env bash
#
# The release loop's stand-in for npm (ADR-0043): verdaccio, up or down.
#
#   dist-registry.sh up     wipe the storage, start verdaccio, wait for it to answer
#   dist-registry.sh down   stop it and leave nothing listening on the port
#
# `up` is idempotent — it stops a previous run first, then deletes the storage. The wipe is the
# point: a fresh registry every run is what lets 0.0.0 republish, so no version is ever stamped
# and no manifest is ever edited before publish.
#
# Env: J2_DIST_DIR (runtime state, default <tmp>/j2-dist — OUTSIDE the checkout, see
# scripts/dist-publish.sh's guard), J2_DIST_PORT (default 4873 — the port the packages'
# publishConfig names, so moving it moves the guard too).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${J2_DIST_DIR:-${TMPDIR:-/tmp}/j2-dist}"
port="${J2_DIST_PORT:-4873}"
pid_file="$dir/verdaccio.pid"
log_file="$dir/verdaccio.log"

# A bound port is not yet a serving registry, so the wait is on /-/ping rather than on a connect:
# a publish that races a half-open verdaccio fails as a connection error and reads like a broken
# loop. node is the one runtime this repo can assume, hence no curl/nc dependency.
answering() {
  # shellcheck disable=SC2016 # the ${...} is a JS template literal, not shell
  node -e 'fetch(`http://localhost:${process.argv[1]}/-/ping`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$port"
}

alive() {
  kill -0 -- "-$1" 2>/dev/null || kill -0 "$1" 2>/dev/null
}

stop() {
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(cat "$pid_file")"
  # `npx verdaccio` buries the server two processes under the pid we can record, and the survivors
  # of a single kill keep the port — which the next run then cannot bind. So `up` launches it with
  # job control on and the recorded pid is a process GROUP id: one negative kill takes the tree.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  # Waited on the PROCESS, not on the ping: a verdaccio that has stopped answering can still hold
  # the socket, and the `up` that follows would lose the bind race to a corpse.
  for _ in $(seq 1 50); do
    alive "$pid" || return 0
    sleep 0.2
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
}

# The pid file is this loop's only record of its registry, and an interrupted run destroys it: the
# @dist fixture keeps its state in a temp dir whose name nobody else holds, so a Ctrl-C before
# teardown leaves a verdaccio no caller can name. The port is FIXED by publishConfig (ADR-0043), so
# that orphan makes both faces of the loop unrunnable — `down` must be able to clear it. It kills by
# EVIDENCE, never by port alone: only a process that identifies itself as verdaccio is taken.
port_holders() {
  lsof -t -i "tcp:$port" -sTCP:LISTEN 2>/dev/null && return 0
  fuser -n tcp "$port" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
}

stop_orphan() {
  local pid pgid killed=""
  for pid in $(port_holders); do
    ps -p "$pid" -o args= 2>/dev/null | grep -qi verdaccio || continue
    pgid="$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')"
    kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    killed=yes
  done
  [[ -n "$killed" ]] || return 1
  for _ in $(seq 1 50); do
    answering || return 0
    sleep 0.2
  done
  return 1
}

case "${1:-}" in
  up)
    stop
    # Anything still answering after that is an orphan, and starting over the top of it is worse
    # than failing: the wipe below would miss ITS storage, the new process would lose the bind, and
    # the loop would publish 0.0.0 into a registry that already holds it — the unexplained version
    # conflict the @dist fixture's guard exists to prevent.
    if answering && ! stop_orphan; then
      echo "port $port is held by something that is not verdaccio; free it before running the loop" >&2
      exit 1
    fi
    rm -rf "$dir/registry"
    mkdir -p "$dir/registry"
    # npm demands a token to publish even where the registry wants none, so the loop keeps its own
    # npmrc with a fake one. Callers point NPM_CONFIG_USERCONFIG here: the user's real ~/.npmrc —
    # and any real credential in it — stays out of the loop entirely.
    printf '//localhost:%s/:_authToken="j2-dist"\n' "$port" > "$dir/npmrc"
    # Job control, so the background job leads its own process group (see `stop`).
    set -m
    VERDACCIO_STORAGE_PATH="$dir/registry" nohup npx --yes verdaccio \
      --config "$root/deploy/verdaccio.yaml" --listen "$port" > "$log_file" 2>&1 &
    echo $! > "$pid_file"
    set +m
    # First run pulls verdaccio through npx, so the wait is generous.
    for _ in $(seq 1 300); do
      if answering; then
        echo "verdaccio: http://localhost:$port (log: $log_file)"
        exit 0
      fi
      # A dead child is not a slow one, and the difference is two and a half minutes plus a wrong
      # diagnosis: a lost bind race, a bad config, or a broken npx fetch exits at once.
      if ! alive "$(cat "$pid_file")"; then
        echo "verdaccio exited at startup; see $log_file" >&2
        exit 1
      fi
      sleep 0.5
    done
    echo "verdaccio did not answer on port $port; see $log_file" >&2
    exit 1
    ;;
  down)
    ran="$([[ -f "$pid_file" ]] && echo yes || true)"
    stop
    rm -f "$pid_file"
    if answering && stop_orphan; then
      echo "verdaccio stopped (an orphan on port $port — an interrupted run left no pid file)"
      exit 0
    fi
    if answering; then
      echo "something is still serving port $port and is not verdaccio — not this loop's" >&2
      exit 1
    fi
    if [[ -n "$ran" ]]; then echo "verdaccio stopped"; else echo "verdaccio was not running"; fi
    ;;
  *)
    echo "usage: $(basename "$0") up|down" >&2
    exit 2
    ;;
esac
