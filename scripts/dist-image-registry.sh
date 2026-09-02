#!/usr/bin/env bash
#
# The release loop's stand-in for the Kit image HOME (ADR-0044), exactly as scripts/dist-registry.sh
# stands in for npm. Two registries, both local, and the same rule over both: fake the registry,
# never the mechanism.
#
#   dist-image-registry.sh up        start it (idempotent) and point the kind nodes at it
#   dist-image-registry.sh down      stop it and take the port back
#   dist-image-registry.sh address   print `localhost:<port>` and nothing else
#
# The upstream kind local-registry pattern, deliberately unimproved: a `registry:2` container joined
# to the kind docker network, plus a containerd `hosts.toml` on every node mapping the ref host
# `localhost:<port>` to that container. What it replaces is `kind load` at the published names —
# which put the bytes on the node without a pull ever happening, so the one thing an installed kit
# does with Kit images (pull `<kitRegistry>/j2-<x>:<kitversion>`) was covered by no tier at all.
# That is the failure class ADR-0043 exists to delete, met a second time at a second registry.
#
# The storage is NOT wiped per `up`, and that asymmetry with verdaccio is the point: the wipe there
# serves npm's one rule — a version may never be republished — and a registry has no such rule, so
# `0.0.0` is simply overwritten. The staleness that DOES survive is the node's (ADR-0044's accepted
# remainder: `IfNotPresent` keeps the first bytes a node saw of a re-pushed dev tag), and no wipe
# here could reach it — the escape is a fresh cluster.
#
# Env: J2_DIST_IMAGE_PORT (default 5001 — the address scenarios put in `kitRegistry`).
set -euo pipefail

port="${J2_DIST_IMAGE_PORT:-5001}"
# In the `j2-dist` family, like the rest of the loop's state, so a stray container says whose it is.
name="j2-dist-registry"
address="localhost:$port"

# node is the one runtime this repo can assume (see scripts/dist-registry.sh) — so no curl/nc. ANY
# HTTP answer counts as "something serves this port": a registry answers /v2/ with 200 or 401, and
# either way the port is taken.
answering() {
  # shellcheck disable=SC2016 # the ${...} is a JS template literal, not shell
  node -e 'fetch(`http://localhost:${process.argv[1]}/v2/`).then(() => process.exit(0), () => process.exit(1))' "$port"
}

running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" == "true" ]]
}

exists() {
  [[ -n "$(docker ps -aq --filter "name=^${name}$" 2>/dev/null)" ]]
}

# The kind cluster this loop is pointed at — whatever the CURRENT kube context names, the same
# address `j2 up` will resolve moments later (ADR-0019), never a cluster name written down here.
kind_cluster() {
  local context
  context="$(kubectl config current-context 2>/dev/null || true)"
  case "$context" in
    kind-*) echo "${context#kind-}" ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  up)
    if ! running; then
      # A stopped container of our own is a previous run's corpse, not a conflict: it holds the name
      # and nothing else. An interrupted run leaves exactly this, and `up` must clear it — the
      # container name is this loop's whole record of its registry, so recovery is by name.
      exists && docker rm -f "$name" >/dev/null
      if answering; then
        echo "port $port is held by something that is not $name; free it before running the loop" >&2
        exit 1
      fi
      docker run -d --name "$name" --restart=always -p "127.0.0.1:$port:5000" registry:2 >/dev/null
      # First run pulls registry:2, so the wait is generous. A bound port is not yet a serving
      # registry, and a push that races the bind fails as a connection error that reads like a
      # broken loop.
      for _ in $(seq 1 120); do
        answering && break
        sleep 0.5
      done
      if ! answering; then
        echo "$name did not answer on port $port; see \`docker logs $name\`" >&2
        exit 1
      fi
    fi

    if ! cluster="$(kind_cluster)"; then
      echo "warning: the current kube context is not a kind cluster — $address serves, but no node was pointed at it" >&2
      exit 0
    fi

    # The NODES reach the registry by container name on the kind network; inside a node, localhost is
    # the node. The published port above is the host's own door — what `docker buildx --push` and a
    # human's `docker pull` use — and both spellings must name the same registry, which is why the
    # hosts.toml below is keyed by the ref host (`localhost:<port>`) and points at the container.
    docker network connect kind "$name" >/dev/null 2>&1 || true

    for node in $(kind get nodes --name "$cluster"); do
      # containerd reads a hosts.toml only where it has been TOLD to look, and kind's default config
      # says nothing — deploy/kind.yaml carries the `config_path` patch that makes /etc/containerd/
      # certs.d live. A cluster created before that patch ignores everything below in silence and
      # resolves `localhost:<port>/j2-harness:...` against the node itself, so the failure would land
      # minutes later as an ImagePullBackOff pointing at nothing.
      if ! docker exec "$node" grep -q 'certs.d' /etc/containerd/config.toml; then
        echo "node $node has no containerd registry config_path — this cluster predates deploy/kind.yaml's" >&2
        echo "patch; recreate it: kind delete cluster --name $cluster && just e2e-dist-up" >&2
        exit 1
      fi
      docker exec "$node" mkdir -p "/etc/containerd/certs.d/$address"
      printf '[host."http://%s:5000"]\n' "$name" |
        docker exec -i "$node" cp /dev/stdin "/etc/containerd/certs.d/$address/hosts.toml"
    done
    echo "kit images: $address (container $name, pulled by the $cluster nodes)"
    ;;
  down)
    if exists; then
      docker rm -f "$name" >/dev/null
      if answering; then
        echo "something is still serving port $port and is not this loop's registry" >&2
        exit 1
      fi
      echo "kit image registry stopped"
    else
      echo "kit image registry was not running"
    fi
    ;;
  address)
    # stdout, alone and unadorned: callers read this (scripts/dist-publish.sh, the @dist fixture,
    # `just dist-up`) rather than each spelling the port a second time.
    echo "$address"
    ;;
  *)
    echo "usage: $(basename "$0") up|down|address" >&2
    exit 2
    ;;
esac
