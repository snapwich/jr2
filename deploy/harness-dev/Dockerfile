# The DEV Harness image (ADR-0011 stub-at-the-wire, containerized).
#
# A Workspace is ALWAYS a real Sandbox (ADR-0012) — there is no stubbed workspace mode — so the
# kind tier needs an image that actually serves the Harness wire on :8080 and carries git (the
# post-Ready attach execs `git clone --shared` + `git worktree add` INSIDE this container). Flue's
# real Harness image is not part of this repo, so this image runs the same wire-compatible stub
# `j2 dev` hosts in-process. What that fakes is the LLM, not the data plane: the pod, the RO repos
# volume, the worktrees, the port-forward and the CR lifecycle are all real.
#
# It also carries an AGENT (agent.ts — ADR-0013), which the in-process stub does not. That is what
# makes the pod originate its own tool calls, over MCP, to the Adapter on localhost. So this image
# needs one real dependency (the MCP client): the wire it speaks is the thing under test, and a
# hand-rolled JSON-RPC forgery would prove nothing about it.
#
# Build context is the REPO ROOT so the stub is copied from its one source of truth:
#   docker build -f deploy/harness-dev/Dockerfile -t j2-harness-dev:local .   (`just harness-image`)
#
# Two image-level contracts the operator's hardened pod imposes (ADR-0001):
#   - runAsNonRoot with a NUMERIC uid — kubelet refuses a named USER ("cannot verify user is
#     non-root"), so `USER 1000`, not `USER node`.
#   - the serving port is TCP-probed for readiness, so binding 0.0.0.0:8080 IS `phase: Ready`.
# The worktree root (/work) is NOT the image's problem: j2 mounts a pod volume there (shared with
# the User Container, ADR-0005), which is what makes it writable to an unprivileged uid.

FROM node:24-alpine

# git: the attach step's toolchain (ADR-0004 clone --shared + worktree add).
RUN apk add --no-cache git

WORKDIR /harness
# The Agent's MCP client (the stub Harness itself still has zero deps). Its own manifest, resolved
# here rather than in the pnpm workspace: this is an image, not a package.
COPY deploy/harness-dev/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Node 24 strips the types natively — the stub ships as source, no build step (zero-build, ADR-0010).
COPY packages/orchestrator/src/stub-harness.ts ./stub-harness.ts
COPY deploy/harness-dev/agent.ts ./agent.ts
COPY deploy/harness-dev/main.ts ./main.ts

USER 1000
EXPOSE 8080
CMD ["node", "/harness/main.ts"]
