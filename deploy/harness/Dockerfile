# The STOCK Harness image (ADR-0018): j2-harness:<kitversion>, one release train with the kit.
# An instance builds NO Harness image — its plain-data Agent definitions arrive at pod start via
# the agents ConfigMap (J2_AGENTS_JSON), and boot.mjs assembles + `flue build`s them (~0.5 s,
# fully offline: the flue toolchain and every dependency is baked here, at kit release time).
#
# Build context is the KIT repo root:  docker build -f deploy/harness/Dockerfile -t j2-harness:local .
#
# Image-level contracts (the operator's hardened pod imposes them, ADR-0001):
#   - runAsNonRoot with a NUMERIC uid — kubelet refuses a named USER, so `USER 1000`.
#   - the serving port is TCP-probed for readiness: binding 0.0.0.0:8080 IS `phase: Ready` —
#     which lags container start by the boot build's duration, by design.
#   - git in the runtime image: the post-Ready attach execs `git clone --shared` + `git worktree
#     add` INSIDE this container (ADR-0004), and the coder commits with it.
#
# Secrets: NONE are baked. Agent creds arrive at runtime via the Sandbox spec's env/envFrom;
# the Adapter's token never touches this container (ADR-0013).

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

COPY packages/orchestrator/harness/package.json ./package.json
# Full install (dev deps included): @flue/cli IS the boot-time build toolchain — a bigger image,
# paid once per kit release, in exchange for no per-instance builds and no network at boot.
# --include=dev is load-bearing: NODE_ENV=production above would otherwise omit devDependencies,
# and a missing local `flue` bin makes boot-time `npx flue` fetch the UNRELATED registry package
# named "flue" — a crash-loop with a bewildering log.
RUN npm install --no-audit --no-fund --include=dev

COPY packages/orchestrator/harness/flue.config.ts packages/orchestrator/harness/boot.mjs ./
# The boot build writes src/ and dist/ as uid 1000 — the whole app dir must already be theirs.
RUN chown -R 1000:1000 /app

USER 1000
ENV PORT=8080
EXPOSE 8080
CMD ["node", "boot.mjs"]
