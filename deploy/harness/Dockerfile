# The STOCK Harness image (ADR-0018/0027): j2-harness:<kitversion>, one release train with the kit.
# It runs `@j2/harness` — j2's own server on pi-agent-core + Hono. An instance builds NO Harness
# image — its plain-data Agent definitions arrive at pod start via the agents ConfigMap
# (J2_AGENTS_JSON), and main.ts constructs them at runtime: no boot build, no readiness lag.
#
# Build context is the KIT repo root:  docker build -f deploy/harness/Dockerfile -t j2-harness:local .
#
# Image-level contracts (the operator's hardened pod imposes them, ADR-0001):
#   - runAsNonRoot with a NUMERIC uid — kubelet refuses a named USER, so `USER 1000`.
#   - the serving port is TCP-probed for readiness: binding 0.0.0.0:8080 IS `phase: Ready` —
#     and with no build step before listen, Ready no longer lags container start (ADR-0027).
#   - git in the runtime image: the post-Ready attach execs `git clone --shared` + `git worktree
#     add` INSIDE this container (ADR-0004), and the coder commits with it.
#   - ripgrep in the runtime image: the grep working tool shells out to `rg` (ADR-0027).
#
# Secrets: NONE are baked. Agent creds arrive at runtime via the Sandbox spec's env/envFrom;
# the Adapter's token never touches this container (ADR-0013).

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# The package is vendored standalone — this is an image, not a pnpm workspace — so npm resolves
# its manifest directly. The devDependencies are workspace:* test rigging npm cannot parse outside
# the workspace (even under --omit=dev), so they are pruned from the vendored manifest first. The
# runtime deps are exact-pinned where it matters (pi 0.x minors break, ADR-0027).
COPY packages/harness/package.json ./package.json
RUN node -e 'const f="package.json",j=JSON.parse(require("fs").readFileSync(f));delete j.devDependencies;require("fs").writeFileSync(f,JSON.stringify(j,null,2))' \
 && npm install --no-audit --no-fund --omit=dev

# Node 24 strips the types natively — @j2/harness ships as source, no build step (zero-build,
# ADR-0010). Nothing writes under /app at runtime, so no chown: the worktree root is a pod volume.
COPY packages/harness/src ./src

USER 1000
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/main.ts"]
