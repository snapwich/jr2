FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Your agents' toolchain goes here — compilers, CLIs, language servers, dotfiles.

# pnpm on the system PATH, at a fixed version, so that each Sandbox gets the same pnpm.
RUN npm install -g pnpm@10.9.0
