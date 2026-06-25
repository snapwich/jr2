# Sandbox image: the flue Harness hosting j2 Agents.
#
# Build context is the REPO ROOT (so the shared tsconfig base is available):
#   docker build -f harness/Dockerfile -t j2-harness:poc3 .
#
# Two stages: build runs `flue build` (needs Node >= 22.18, dev deps) to produce
# dist/server.mjs; runtime carries dist + pruned prod node_modules (the bundle
# externalizes @flue/runtime, so node_modules is required at runtime).

# --- build ---
FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@10.9.0 --activate
# harness/tsconfig.json extends ../tsconfig.base.json; place the base one level
# above the app dir so the relative extends resolves.
COPY tsconfig.base.json /tsconfig.base.json
WORKDIR /app
COPY harness/package.json ./
# No per-package lockfile in the monorepo; resolve from package.json for a
# self-contained image build.
RUN pnpm install --no-frozen-lockfile
COPY harness/tsconfig.json harness/flue.config.ts ./
COPY harness/src ./src
RUN pnpm build && pnpm prune --prod

# --- runtime ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    WORKTREE_DIR=/workspace \
    # Trust the backend's private CA when mounted (see deploy/poc-sidecar.yaml).
    NODE_EXTRA_CA_CERTS=/etc/ssl/vllm/ca.pem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
# Runs as the base image's non-root `node` user (uid 1000) via the pod
# securityContext; nothing here needs root.
CMD ["node", "dist/server.mjs"]
