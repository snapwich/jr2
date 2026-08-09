# A Sandbox Image (ADR-0037): the tools your agents can reach, and the shell you get when you
# `kubectl exec` into a running Workspace. This file is yours — j2 never rewrites it and reads
# nothing out of it.
#
# The build context is THIS directory (`images/default/`), so `COPY` paths are relative to it and
# nothing outside it can invalidate the image's content hash.
#
# j2 injects its own runtime at /opt/j2 in a second, kit-owned stage on top of whatever this
# Dockerfile produces — node, ripgrep, the Harness, a writable /home/j2, and PATH appended (never
# prepended, so a toolchain YOU pin wins). So: no USER, no CMD, no WORKDIR, no j2 base image here.
#
# Two things j2 cannot vendor, both proven by `j2 up` before it converges:
#   - `git` — the agent clones, worktrees, and commits with the git you chose;
#   - a glibc base no older than j2's node. alpine/musl cannot run it at all.
#
# The name is the directory name. Add `images/<other>/Dockerfile` for a second Sandbox Image and name
# it from a workflow's `workspace()` spec. This instance has `repos: []`, so `j2 up` builds
# nothing here until it has repos to work on.

FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Your agents' toolchain goes here — compilers, CLIs, language servers, dotfiles.
