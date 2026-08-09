# The @kind tier's Sandbox Image (ADR-0037). Zero j2 knowledge, exactly like a user's: no ARG, no
# FROM j2-harness, no USER/CMD/WORKDIR — `j2 up` builds this, then builds the kit-owned wrap on top
# (COPY --from=<harness> /opt/j2 /opt/j2, HOME, PATH, WORKDIR, USER 1000, CMD). Its presence makes
# every @kind bring-up exercise the two-stage build and the preflight.
#
# The build context is THIS directory (ADR-0037), so nothing outside it can be COPY'd in.
#
# A GLIBC base: the retired dev stub was node:24-alpine, and musl is now refused outright — copying
# libstdc++ does not rescue a base whose libc is not glibc, so the preflight names it rather than
# letting it surface as a tool failure mid-turn.
FROM node:24-slim

# git is the one USER contract the wrap does not vendor (relocating git means /usr/lib/git-core,
# templates, and git-remote-https): the post-Ready attach runs `git clone --shared` +
# `git worktree add` INSIDE this container (ADR-0004), and the agent wants the git you chose.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# A marker tool the STOCK Harness image does not carry — the whole point of the feature, made
# assertable: a scenario has the Agent run it through a Working tool, which proves the tools
# execute in THIS image (ADR-0027/0037) rather than in something j2 chose.
RUN printf '#!/bin/sh\necho j2-toolchain-ok\n' > /usr/local/bin/j2-toolchain \
    && chmod 0755 /usr/local/bin/j2-toolchain
