# The @kind tier's Sandbox Image with a USER and no user context (ADR-0062): its user's home has no
# `~/.pi/agent`, so the pod mounts none. The `contexted-home` workflow makes that folder from the
# domain, and the Agents must not read it.
#
# The same base and git layer as `images/default`, so the build reuses that cache.
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

USER 1000
