# This instance's Sandbox Image (ADR-0037): what the coder and reviewer Agents' Working tools can
# reach, and the shell you land in with `kubectl -n coding exec -it <pod> -c harness -- sh`.
#
# `images/default` is the fallback leg of the resolution chain (a `workspace()` spec's `image` →
# `images/default` → the stock Harness), and this instance's workflows name no image, so every
# Workspace here runs this one. The build context is this directory.
#
# Zero j2 knowledge on purpose: j2 builds this file, then adds its own stage on top — the Harness
# runtime at /opt/j2, a writable /home/j2, and PATH appended so anything pinned below wins. Hence
# no USER, no CMD, no WORKDIR, and no j2 base image. `j2 up` proves git, $HOME, node and rg all
# work as uid 1000 before it converges.
#
# The repo this instance orchestrates is a Neovim plugin, so the toolchain is lua-flavoured; a
# different repo means a different list, and that is the whole point of the file existing.

FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git ca-certificates curl make \
    lua5.1 luarocks \
  && rm -rf /var/lib/apt/lists/*
