# The @kind tier's Sandbox Image (ADR-0037). Zero j2 knowledge, exactly like a user's: no ARG, no
# `FROM j2-harness`, nothing about /opt/j2. `j2 up` builds this file ONCE, straight to its content
# tag — there is no wrap stage any more — and the runtime arrives at pod time on a volume. Its
# presence makes every @kind bring-up exercise the build, the preflight, and the injection.
#
# The build context is THIS directory (ADR-0037), so nothing outside it can be COPY'd in.
#
# A GLIBC base: the retired dev stub was node:24-alpine, and musl is now refused outright — copying
# libstdc++ does not rescue a base whose libc is not glibc, so the preflight names it rather than
# letting it surface as a tool failure mid-turn.
FROM node:24-slim

# git is the one floor item j2 does not vendor (relocating git means /usr/lib/git-core, templates,
# and git-remote-https): the post-Ready attach runs `git clone --shared` + `git worktree add`
# INSIDE this container (ADR-0004), and the agent wants the git you chose.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# A marker tool the STOCK Harness image does not carry — the whole point of the feature, made
# assertable: a scenario has the Agent run it through a Working tool, which proves the tools
# execute in THIS image (ADR-0027/0037) rather than in something j2 chose.
RUN printf '#!/bin/sh\necho j2-toolchain-ok\n' > /usr/local/bin/j2-toolchain \
    && chmod 0755 /usr/local/bin/j2-toolchain

# Deliberately NOT /work, and deliberately present: WORKDIR is the image author's, and j2 overrides
# the container's command and nothing else (ADR-0037). A human's `kubectl exec` lands here, which
# the retired wrap — it forced WORKDIR /work — could not have produced. It has no effect on the
# Agent: every Working tool carries its own cwd.
RUN mkdir -p /srv/j2-e2e
WORKDIR /srv/j2-e2e

# No USER on purpose: this is the no-USER FALLBACK image (ADR-0037), so the pod must run it as uid
# 1000 with HOME=/home/j2 on an emptyDir. A scenario asserts exactly that — it is the one branch of
# the composition that no image can prove about itself.
