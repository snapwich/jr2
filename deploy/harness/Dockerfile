# The STOCK Harness image (ADR-0018/0027): j2-harness:<kitversion>, one release train with the kit.
# It runs `@j2/harness` — j2's own server on pi-agent-core + Hono. An instance builds NO Harness
# image, and this one holds no Agents: each admission carries the plain-data definition it runs
# (ADR-0049), so main.ts boots knowing only what the instance can REACH (J2_HARNESS_JSON) — no boot
# build, no readiness lag.
#
# Build context is the KIT repo root:  docker build -f deploy/harness/Dockerfile -t j2-harness:local .
# That exact path is load-bearing beyond this comment: ADR-0038's kit-checkout detection resolves
# it from the CLI's own module URL, so moving this file changes when `j2 up` builds kit images.
#
# It has THREE placements, and every line below serves all three:
#   1. the Instance Harness deployment (ADR-0031) and the fallback Sandbox Image — the image runs
#      as itself, on its own CMD;
#   2. the INJECTION SOURCE (ADR-0037): an init container runs it as `/opt/j2/bin/init-copy <dir>`
#      to publish /opt/j2 into a pod volume that the primary container — the USER'S Sandbox Image,
#      byte-for-byte, no j2 layers — mounts at /opt/j2 with its command overridden to this CMD.
#   3. nothing else. There is NO build-time wrap any more: j2 never builds a stage on top of a
#      user's image, so a Sandbox Image's tag is not coupled to this image's, and an image the user
#      baked on their own registry is runnable without j2 ever touching it.
#
# So **/opt/j2 is a published surface**, not an implementation detail. Its shape —
#   bin/node · bin/rg · bin/work-acl · bin/init-copy · lib/*.so · src/ · node_modules/ · package.json
# — is copied verbatim onto a volume that lands in a stranger's filesystem. Moving anything inside
# it (or making bin/ and lib/ non-siblings, see the rpath below) breaks every Sandbox, on a base
# this repo never sees. `/opt/j2` and not `/app`, because a user's base may already use /app and a
# WORKDIR there would shadow it — one layout for both placements, never two.
#
# Image-level contracts (the operator's hardened pod imposes them, ADR-0001):
#   - runAsNonRoot with a NUMERIC uid — kubelet refuses a named USER, so `USER 1000`. It applies to
#     the j2-owned seats per container (ADR-0005); the User Container is exempt.
#   - the serving port is TCP-probed for readiness: binding 0.0.0.0:8080 IS `phase: Ready` —
#     and with no build step before listen, Ready no longer lags container start (ADR-0027).
#   - git in the runtime image: the post-Ready attach execs `git clone --shared` + `git worktree
#     add` INSIDE the primary container (ADR-0004), and the coder commits with it. It stays
#     apt-installed HERE and remains a USER contract for a Sandbox Image (ADR-0037): relocating git
#     means /usr/lib/git-core, the template dir, and git-remote-https → curl + openssl + a CA store.
#     j2 vendors what is self-contained (a static rg, node's two C++ libs) and asks for the rest.
#   - ripgrep in the runtime image: the grep Working tool shells out to `rg` (ADR-0027). It is no
#     longer apt's — it is the vendored static-musl binary at /opt/j2/bin/rg, reachable because the
#     HARNESS PROCESS appends /opt/j2/bin to PATH at startup (startup.ts). Dropping apt's ripgrep
#     does not fail loudly without that append: grep silently falls through to plain `grep`
#     (working-tools.ts).
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
#     is also why /opt/j2/lib must stay a SIBLING of /opt/j2/bin — init-copy publishes the whole
#     tree, so $ORIGIN/../lib is the one form that survives landing in a stranger's image.
RUN set -eux; \
    mkdir -p /opt/j2/bin /opt/j2/lib; \
    cp /usr/local/bin/node /opt/j2/bin/node; \
    cp -L /usr/lib/*-linux-gnu/libstdc++.so.6 /usr/lib/*-linux-gnu/libgcc_s.so.1 /opt/j2/lib/; \
    patchelf --set-rpath '$ORIGIN/../lib' /opt/j2/bin/node; \
    /opt/j2/bin/node -e ''

# work-acl, compiled here and STATIC for the same reason rg is vendored static: the attach script
# runs it inside the USER'S image (it stamps ADR-0005's default ACL on each repo root), on a libc
# j2 does not control. It writes the ACL xattr itself, so there is no libacl to link and glibc's
# `-static` is clean (nothing here touches NSS). The smoke test proves the hand-built blob is one
# the KERNEL accepts — setxattr validates it — and that getfacl reads it back as ADR-0005's line;
# `acl` is installed for that check alone and discarded with the stage.
COPY deploy/harness/work-acl.c /tmp/work-acl.c
RUN set -eux; \
    apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev acl \
 && rm -rf /var/lib/apt/lists/*; \
    gcc -Os -static -o /opt/j2/bin/work-acl /tmp/work-acl.c; \
    mkdir /tmp/acl-smoke; \
    /opt/j2/bin/work-acl /tmp/acl-smoke; \
    getfacl -d --omit-header /tmp/acl-smoke | grep -qx 'group::rwx'

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

# The injection command (ADR-0037). Mode 0755 and inside the published tree on purpose: the init
# container has no other way to name it, and a volume populated by `cp -a` carries it along, so the
# script that publishes the runtime is itself part of what was published.
COPY --chmod=0755 deploy/harness/init-copy /opt/j2/bin/init-copy

# $HOME, created at build as an image layer. This is the STOCK image's own home; a Sandbox Image
# brings its own (ADR-0037 respects the image's USER and HOME), and one that declares neither gets
# uid 1000 with an emptyDir at /home/j2 from the operator — which is the value startup.ts falls
# back to, so the two placements name one path. node:24-slim already owns uid 1000 as `node` with
# /home/node; adopting that would make the stock image the odd one out. The attach's first act is
# `git config --global safe.directory '*'`, which writes $HOME/.gitconfig, and an agent's toolchain
# wants ~/.npm, ~/.cargo, ~/.cache regardless.
RUN mkdir -p /home/j2 && chown 1000:0 /home/j2 && chmod 0775 /home/j2
ENV HOME=/home/j2

# APPENDED, never prepended (ADR-0037), and here for the HUMAN: an interactive `exec` shell in this
# image inherits the image's env, which no process-level setting can reach. The Harness process
# does the same append for itself and its tool children (startup.ts) — that is the copy that counts
# in a Sandbox, where none of this image's env is present. Both may apply at once; the append is
# idempotent.
ENV PATH="${PATH}:/opt/j2/bin"

USER 1000
ENV PORT=8080
EXPOSE 8080

# Last, and for the HUMAN on `kubectl exec` — where a shell lands in this image. It has no effect
# on the Agent: every Working tool takes an explicit cwd from the definition (`def.cwd ?? "/work"`,
# spec.ts) and the Harness process's own cwd is never read.
WORKDIR /work

# Absolute, so it never depends on WORKDIR — and byte-identical to the command the operator
# overrides a Sandbox Image's primary container with, because both start the same process from the
# same /opt/j2.
CMD ["/opt/j2/bin/node", "/opt/j2/src/main.ts"]
