# The Adapter image (ADR-0013): the jr2-owned sidecar that hosts the Agent's MCP surface inside the
# Sandbox, and is the ONLY process in that pod holding an Orchestrator credential.
#
# Build context is the REPO ROOT (the package ships as source — Node 24 strips the types):
#   docker build -f deploy/adapter/Dockerfile -t jr2-adapter:local .        (`just adapter-image`)
#
# The image-level contracts the operator's hardened pod imposes (ADR-0001) apply to sidecars too —
# they get the same hardened securityContext unless they declare their own — so: a NUMERIC uid
# (kubelet refuses a named USER under runAsNonRoot), and no assumption of a writable filesystem.
#
# It is NOT TCP-probed: the operator probes the primary container (the Harness), which is what
# `phase: Ready` means. The Adapter binds loopback only — the Agent is in this pod, and nothing
# outside it has any business connecting.

FROM node:24-alpine

WORKDIR /adapter

# Deps first (the MCP server the Orchestrator no longer carries), then the source.
COPY packages/adapter/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY packages/adapter/src ./src

USER 1000
EXPOSE 8081
CMD ["node", "/adapter/src/main.ts"]
