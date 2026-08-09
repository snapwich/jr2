# The STOCK Harness image (ADR-0018/0027): j2-harness:<kitversion>, one release train with the kit.
# It runs `@j2/harness` — j2's own server on pi-agent-core + Hono. An instance builds NO Harness
# image — its plain-data Agent definitions arrive at pod start via the agents ConfigMap
# (J2_AGENTS_JSON), and main.ts constructs them at runtime: no boot build, no readiness lag.
#
# Build context is the KIT repo root:  docker build -f deploy/harness/Dockerfile -t j2-harness:local .
# That exact path is load-bearing beyond this comment: ADR-0038's kit-checkout detection resolves
# it from the CLI's own module URL, so moving this file changes when `j2 up` builds kit images.
#
# It is ALSO the source of the wrap (ADR-0037). A Sandbox Image is the user's own Dockerfile, then
# a second kit-owned stage on top of it whose first act is
#   COPY --from=<this image> /opt/j2 /opt/j2
# so **/opt/j2 is a published surface**, not an implementation detail. Its shape —
#   bin/node · bin/rg · lib/*.so · src/ · node_modules/ · package.json
# — is copied verbatim into every Sandbox Image. Moving anything inside it (or making bin/ and lib/
# non-siblings, see the rpath below) breaks every wrapped image, on a base this repo never sees.
# `/opt/j2` and not `/app`, here and in the wrap, because a user's base may already use /app and a
# WORKDIR there would shadow it — one layout for both placements, never two.
#
# Image-level contracts (the operator's hardened pod imposes them, ADR-0001):
#   - runAsNonRoot with a NUMERIC uid — kubelet refuses a named USER, so `USER 1000`.
#   - the serving port is TCP-probed for readiness: binding 0.0.0.0:8080 IS `phase: Ready` —
#     and with no build step before listen, Ready no longer lags container start (ADR-0027).
#   - git in the runtime image: the post-Ready attach execs `git clone --shared` + `git worktree
#     add` INSIDE this container (ADR-0004), and the coder commits with it. It stays apt-installed
#     HERE and remains a USER contract for a Sandbox Image (ADR-0037): relocating git means
#     /usr/lib/git-core, the template dir, and git-remote-https → curl + openssl + a CA store. j2
#     vendors what is self-contained (a static rg, node's two C++ libs) and asks for the rest.
#   - ripgrep in the runtime image: the grep Working tool shells out to `rg` (ADR-0027). It is no
#     longer apt's — it is the vendored static-musl binary at /opt/j2/bin/rg, reachable here only
#     because PATH APPENDS /opt/j2/bin below. Dropping apt's ripgrep without that append does not
#     fail loudly: grep silently falls through to plain `grep` (working-tools.ts).
#
# Secrets: NONE are baked. Agent creds arrive at runtime via the Sandbox spec's env/envFrom;
# the Adapter's token never touches this container (ADR-0013).

# ---------------------------------------------------------------------------------------------
# Vendor stage — discarded. Assembles /opt/j2/{bin,lib}: the parts of the runtime that must work
# on a base image j2 does not control (ADR-0037's "j2 vendors what it can").
# ---------------------------------------------------------------------------------------------
FROM node:24-slim AS vendor

# TARGETARCH is BuildKit's, and it is per-stage: declaring it in the final stage would not reach here.
ARG TARGETARCH
ARG RG_VERSION=15.2.0

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates patchelf \
 && rm -rf /var/lib/apt/lists/*

# ripgrep, the OFFICIAL static-musl release: zero shared-library deps, so it runs on any base the
# user brings — which is the whole reason it is vendored rather than left as a third contract.
# Pinned version + literal per-arch sha256, because a build that silently accepts a moved asset is
# a supply chain, not a dependency. An unhandled arch is a HARD failure naming itself: s390x/ppc64
# have no musl asset, and skipping quietly would surface much later, mid-turn, as a grep tool error
# on a pod nobody is watching.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) rg_arch='x86_64-unknown-linux-musl';  rg_sha='33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c' ;; \
      arm64) rg_arch='aarch64-unknown-linux-musl'; rg_sha='800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915' ;; \
      *) echo "j2: no static-musl ripgrep asset for TARGETARCH='${TARGETARCH}' — the Harness cannot vendor rg for this architecture" >&2; exit 1 ;; \
    esac; \
    tgz="ripgrep-${RG_VERSION}-${rg_arch}.tar.gz"; \
    curl -fsSLo "/tmp/${tgz}" "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${tgz}"; \
    echo "${rg_sha}  /tmp/${tgz}" | sha256sum -c -; \
    tar -xzf "/tmp/${tgz}" -C /tmp; \
    mkdir -p /opt/j2/bin; \
    install -m 0755 "/tmp/ripgrep-${RG_VERSION}-${rg_arch}/rg" /opt/j2/bin/rg; \
    /opt/j2/bin/rg --version

# node, relocated. Two traps, both verified in docker rather than reasoned about:
#   - `cp -L` is load-bearing: libstdc++.so.6 is a SYMLINK, and a plain `cp` copies a dangling link
#     into an image where its target does not exist.
#   - the rpath is load-bearing: without it, this node on a base lacking libstdc++ dies with
#     "error while loading shared libraries: libstdc++.so.6"; with it, the same binary runs. That
#     is also why /opt/j2/lib must stay a SIBLING of /opt/j2/bin — the wrap copies the whole tree,
#     so $ORIGIN/../lib is the one form that survives relocation into a stranger's image.
RUN set -eux; \
    mkdir -p /opt/j2/bin /opt/j2/lib; \
    cp /usr/local/bin/node /opt/j2/bin/node; \
    cp -L /usr/lib/*-linux-gnu/libstdc++.so.6 /usr/lib/*-linux-gnu/libgcc_s.so.1 /opt/j2/lib/; \
    patchelf --set-rpath '$ORIGIN/../lib' /opt/j2/bin/node; \
    /opt/j2/bin/node -e ''

# ---------------------------------------------------------------------------------------------
# The image itself.
# ---------------------------------------------------------------------------------------------
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=vendor /opt/j2/bin /opt/j2/bin
COPY --from=vendor /opt/j2/lib /opt/j2/lib

WORKDIR /opt/j2
ENV NODE_ENV=production

# The package is vendored standalone — this is an image, not a pnpm workspace — so npm resolves
# its manifest directly. The devDependencies are workspace:* test rigging npm cannot parse outside
# the workspace (even under --omit=dev), so they are pruned from the vendored manifest first. The
# runtime deps are exact-pinned where it matters (pi 0.x minors break, ADR-0027).
COPY packages/harness/package.json ./package.json
RUN node -e 'const f="package.json",j=JSON.parse(require("fs").readFileSync(f));delete j.devDependencies;require("fs").writeFileSync(f,JSON.stringify(j,null,2))' \
 && npm install --no-audit --no-fund --omit=dev

# Node 24 strips the types natively — @j2/harness ships as source, no build step (zero-build,
# ADR-0010). Nothing writes under /opt/j2 at runtime, so no chown: the worktree root is a pod volume.
COPY packages/harness/src ./src

# $HOME, created at build as an image layer — the same three lines the wrap emits, so the stock
# image and a wrapped one are one layout. node:24-slim already owns uid 1000 as `node` with
# /home/node; adopting that would diverge from the wrap, where uid 1000 on a stranger's base has no
# home at all. The attach's first act is `git config --global safe.directory '*'`, which writes
# $HOME/.gitconfig, and an agent's toolchain wants ~/.npm, ~/.cargo, ~/.cache regardless.
RUN mkdir -p /home/j2 && chown 1000:0 /home/j2 && chmod 0775 /home/j2
ENV HOME=/home/j2

# APPENDED, never prepended (ADR-0037). Working tools spawn without an env override, so children
# inherit this PATH; appending means the user's own toolchain wins inside a wrapped image and j2's
# is the fallback. Here in the stock image the append is what makes the vendored `rg` resolvable
# at all, now that apt's ripgrep is gone.
ENV PATH="${PATH}:/opt/j2/bin"

USER 1000
ENV PORT=8080
EXPOSE 8080

# Last, and for the HUMAN on `kubectl exec` — with the User Container deleted (ADR-0037) this is
# where a shell lands. It has no effect on the Agent: every Working tool takes an explicit cwd from
# the definition (`def.cwd ?? "/work"`, spec.ts) and the Harness process's own cwd is never read.
WORKDIR /work

# Absolute, and byte-identical to the wrap's, so it never depends on WORKDIR.
CMD ["/opt/j2/bin/node", "/opt/j2/src/main.ts"]
