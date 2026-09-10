# This instance's Sandbox Image (ADR-0037): what the coder and reviewer Agents' Working tools can
# reach, and the shell you land in with `kubectl -n coding exec -it <pod> -c harness -- sh`.
#
# `images/default` is the middle leg of the resolution chain (a `workspace()`'s `image` option →
# `images/default` → the stock Harness), and this instance's workflows name no image, so every
# Workspace here runs this one. The build context is this directory.
#
# Zero j2 knowledge on purpose: j2 never builds a stage on top of this file. The image runs
# byte-for-byte — j2 mounts the Harness runtime at /opt/j2 at POD time, overrides the container's
# command to launch it from there, and appends (never prepends) /opt/j2/bin to PATH, so anything
# pinned below wins. Hence no USER, no CMD, no WORKDIR, and no j2 base image; declaring no USER is
# what elects the uid-1000 seat with HOME=/home/j2. The pod's `preflight` init step proves git,
# $HOME and node all work there before the Harness starts.
#
# The repo this instance orchestrates is a Neovim plugin, so the toolchain is lua-flavoured; a
# different repo means a different list, and that is the whole point of the file existing.

FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git ca-certificates curl make \
    lua5.1 luarocks \
  && rm -rf /var/lib/apt/lists/*
