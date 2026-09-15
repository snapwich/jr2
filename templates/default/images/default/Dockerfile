# A Sandbox Image (ADR-0037): the tools your agents can reach, and the shell you get when you
# `kubectl exec` into a running Workspace. This file is yours — j2 never rewrites it and reads
# nothing out of it.
#
# The build context is THIS directory (`images/default/`), so `COPY` paths are relative to it and
# nothing outside it can invalidate the image's content hash.
#
# j2 never builds on top of this file. Your image is run byte-for-byte: j2 mounts its own runtime
# at /opt/j2 when the pod starts and overrides the container's COMMAND to launch the Harness from
# there, appending (never prepending) /opt/j2/bin to PATH — so a toolchain YOU pin wins. Your
# `USER` and `HOME` are respected, dotfiles included; declare neither and the pod runs uid 1000
# with HOME=/home/j2. Your `ENTRYPOINT`/`CMD` simply do not run — a container has one command and
# the Harness must own it. A process you need running anyway gets its own seat: the User Container
# (`user:` on `workspace()`, ADR-0005).
#
# Two things j2 cannot vendor, both proven by `j2 up` before it converges:
#   - `git` — the agent clones, worktrees, and commits with the git you chose;
#   - a glibc base no older than j2's node. alpine/musl cannot run it at all.
#
# This one folder is a path convention; there is no `images/` scan (ADR-0049/0050). A SECOND Sandbox
# Image is a docker context that travels with the Machine that names it — put the folder beside the
# workflow module and pass `image: import.meta.resolve("./my-image")` to `workspace()`, and `j2 up`
# finds it by walking the registered Machines. `image` also takes a registry REF (anything that is
# not a `file:` URL) for an image you baked and host yourself, which j2 never builds. This instance
# builds it once a registered Machine composes a Sandbox (a `workspace()` with `repos`).

FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Your agents' toolchain goes here — compilers, CLIs, language servers, dotfiles.
