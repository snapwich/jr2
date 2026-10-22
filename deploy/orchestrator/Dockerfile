# The Orchestrator Kit image (ADR-0069): jr2-orchestrator:<kitversion>, one release train with the
# Harness and the operator. It holds `@jr2/orchestrator` and its dependency closure. It holds
# nothing of any Instance: an Instance publishes its Assembly to the running process
# (`PUT /assembly`), and the process boots from the current Assembly on its own volume.
#
# Build context is the KIT repo root:  docker build -f deploy/orchestrator/Dockerfile -t jr2-orchestrator:local .
# `KIT_IMAGES.orchestrator` (packages/cli/src/build.ts) and the row in scripts/kit-push.sh name this
# path. Move the file and you must move both.
#
# THE LAYOUT IS LOAD-BEARING. The closure is installed HOISTED at /instance/node_modules, and
# WORKDIR is /instance. An Assembly lives at /instance/.jr2/assemblies/<hash>/ (the state volume
# mounts at /instance/.jr2). The publisher strips the Kit closure from the Assembly (ADR-0069), so
# a bare `import "xstate"` in a Workflow walks up past the Assembly's own node_modules and finds
# /instance/node_modules/xstate. That walk IS the rule "a package the Kit image ships resolves
# from the image". It gives one copy of `@jr2/orchestrator`, `xstate` and `zod` per process, so
# class identity holds by construction (ADR-0054). Do not install the closure under a
# subdirectory, and do not nest it: Node would not find it from the Assembly.
#
# THE THIRD-PARTY CLOSURE IS PINNED. closure.json beside this file names every third-party package
# in the image at the version the kit's pnpm-lock.yaml resolves, and the install forces each one
# with npm `overrides`. So one Kit tag names the same bytes on every day it is built, and the image
# runs the versions every test tier runs. packages/cli/test/orchestrator-image.test.ts asserts that
# closure.json equals the lockfile's closure, and the install step below asserts that npm installed
# exactly closure.json.
#
# No USER, as the image an Instance produced had none. No label here: `jr2.dev/kind=kit` rides
# the build command line, so this file stays plain (ADR-0039).

# ---------------------------------------------------------------------------------------------
# Pack stage — discarded. It turns the two kit packages into the tarballs a registry would serve.
# It runs on the BUILD platform: a tarball is the same bytes on every architecture, so a
# multi-arch build packs once and never runs this stage under qemu.
# ---------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:24-slim AS pack

WORKDIR /kit
COPY packages/agent-protocol ./agent-protocol
COPY packages/orchestrator ./orchestrator

# A `workspace:` range is pnpm's spelling, and npm cannot read it. pnpm rewrites it to the exact
# version at publish. This does the same rewrite, from the manifests copied here, so the tarballs
# carry the same edges the published packages carry. A `workspace:` dependency on a package this
# stage did not copy fails the build and names the package: a new kit package must join this
# image's sources, or the image would fetch a different copy of it from a registry.
# devDependencies go first: they are test rigging (`@jr2/harness`), and nothing installs them here.
# `--ignore-scripts`: `@jr2/orchestrator`'s `prepack` builds the docs bundle with pnpm and the whole
# repo (ADR-0072), which this stage has neither of. The bundle is for an Instance's Assistant, in the
# package an Instance installs from npm; the Orchestrator's process never reads it.
RUN node -e ' \
  const fs = require("fs"); \
  const dirs = ["agent-protocol", "orchestrator"]; \
  const read = (d) => JSON.parse(fs.readFileSync(`${d}/package.json`, "utf8")); \
  const versions = Object.fromEntries(dirs.map((d) => [read(d).name, read(d).version])); \
  for (const d of dirs) { \
    const j = read(d); \
    delete j.devDependencies; \
    for (const [name, range] of Object.entries(j.dependencies ?? {})) { \
      if (!range.startsWith("workspace:")) continue; \
      if (!(name in versions)) { console.error(`jr2: ${j.name} depends on ${name} (${range}), which this image does not pack`); process.exit(1); } \
      j.dependencies[name] = versions[name]; \
    } \
    fs.writeFileSync(`${d}/package.json`, JSON.stringify(j, null, 2)); \
  }' \
 && mkdir /tgz \
 && (cd agent-protocol && npm pack --ignore-scripts --pack-destination /tgz) \
 && (cd orchestrator && npm pack --ignore-scripts --pack-destination /tgz)

# ---------------------------------------------------------------------------------------------
# The image itself.
# ---------------------------------------------------------------------------------------------
FROM node:24-slim

# The entrypoint is a zero-build `.ts` file, run by tsx as it was in the image an Instance produced.
RUN npm install -g --no-audit --no-fund tsx@4

WORKDIR /instance
ENV NODE_ENV=production

# Install the two tarballs, hoisted. The `@jr2` scope points at an address that answers nothing,
# so every `@jr2/*` package MUST come from the tarballs: the orchestrator's `@jr2/agent-protocol`
# edge is satisfied by the sibling tarball at the same version, or the install fails. Without
# this, a version also on npmjs would install silently from there, and the image would hold
# bytes this checkout did not build. The rest of the closure (xstate, zod, hono, …) is third-party
# and comes from the registry, each package forced to its closure.json version by `overrides`.
#
# After the install, npm's own record of the tree (node_modules/.package-lock.json) is checked:
# every installed package is a `@jr2` package or a closure.json package at its pinned version,
# every closure.json package is installed, and NOTHING is nested. A nested copy is the ADR-0054
# failure (two `zod`s, and Menus that are empty with no error), so the build fails and names it.
# The manifest npm writes names the deleted tarballs, so it goes too: /instance holds
# node_modules and the volume, nothing else.
COPY --from=pack /tgz /tmp/tgz
COPY deploy/orchestrator/closure.json /tmp/closure.json
RUN node -e ' \
  const fs = require("fs"); \
  const overrides = JSON.parse(fs.readFileSync("/tmp/closure.json", "utf8")); \
  fs.writeFileSync("package.json", JSON.stringify({ private: true, overrides }, null, 2));' \
 && npm install --omit=dev --no-audit --no-fund --@jr2:registry=http://127.0.0.1:9/ /tmp/tgz/*.tgz \
 && node -e ' \
  const fs = require("fs"); \
  const closure = JSON.parse(fs.readFileSync("/tmp/closure.json", "utf8")); \
  const tree = JSON.parse(fs.readFileSync("node_modules/.package-lock.json", "utf8")).packages; \
  const bad = []; \
  const seen = new Set(); \
  for (const [key, entry] of Object.entries(tree)) { \
    if (!key.startsWith("node_modules/")) continue; \
    const parts = key.split("node_modules/"); \
    const name = parts.at(-1); \
    if (parts.length > 2) { bad.push(`${key} is nested: the image must hold one copy of ${name}`); continue; } \
    if (entry.link || name.startsWith("@jr2/")) continue; \
    seen.add(name); \
    if (!(name in closure)) bad.push(`${name}@${entry.version} is not in closure.json`); \
    else if (closure[name] !== entry.version) bad.push(`${name} installed at ${entry.version}, closure.json pins ${closure[name]}`); \
  } \
  for (const name of Object.keys(closure)) if (!seen.has(name)) bad.push(`${name} is in closure.json but not installed`); \
  if (bad.length) { for (const b of bad) console.error(`jr2: ${b}`); process.exit(1); }' \
 && rm -rf /tmp/tgz /tmp/closure.json package.json package-lock.json \
 && test -f node_modules/@jr2/orchestrator/bin/server.ts \
 && test -f node_modules/@jr2/agent-protocol/package.json

EXPOSE 4000
CMD ["tsx", "node_modules/@jr2/orchestrator/bin/server.ts"]
