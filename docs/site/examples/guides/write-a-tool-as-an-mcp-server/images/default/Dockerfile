FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Your agents' toolchain goes here — compilers, CLIs, language servers, dotfiles.

# The MCP server. Node 24 runs a .ts file as it is, so the image needs no build step.
COPY semver-mcp.ts /opt/tools/semver-mcp.ts
