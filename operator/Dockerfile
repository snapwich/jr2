# Build the manager binary — on the BUILD platform, cross-compiling to TARGETARCH below. The Go
# toolchain does not survive qemu user-mode emulation (`fatal error: fault`), and the foreign half
# of a multi-arch `just kit-push` (ADR-0044) is exactly that; this is kubebuilder's own
# `docker-buildx` pattern, applied in place instead of sed-ed into a Dockerfile.cross.
FROM --platform=$BUILDPLATFORM golang:1.26 AS builder
ARG TARGETOS
ARG TARGETARCH

WORKDIR /workspace
# Copy the Go Modules manifests
COPY go.mod go.mod
COPY go.sum go.sum
# cache deps before building and copying source so that we don't need to re-download as much
# and so that source changes don't invalidate our downloaded layer
RUN go mod download

# git-lfs for the cache agent (ADR-0053): it gets the LFS objects that a pod on its node asks for.
# The OFFICIAL release at the SAME version and per-arch sha256 as deploy/harness/Dockerfile, so the
# cache agent and every seat run one git-lfs; internal/repocache/lfspin_test.go fails when the two
# pins differ. Fetched here, on the build platform, for TARGETARCH: the release binary is static.
ARG GIT_LFS_VERSION=3.8.1
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) lfs_sha='e72cf723a4a660438862282e8aecf3885fc8123e88bfcad534cf6b941a354b75' ;; \
      arm64) lfs_sha='67895dd77b63329796bc5efdd47b57f218e1f7b98717ebaf936a8238dbcaec0f' ;; \
      *) echo "jr2: no static git-lfs asset for TARGETARCH='${TARGETARCH}' — the cache agent cannot vendor git-lfs for this architecture" >&2; exit 1 ;; \
    esac; \
    tgz="git-lfs-linux-${TARGETARCH}-v${GIT_LFS_VERSION}.tar.gz"; \
    curl -fsSLo "/tmp/${tgz}" "https://github.com/git-lfs/git-lfs/releases/download/v${GIT_LFS_VERSION}/${tgz}"; \
    echo "${lfs_sha}  /tmp/${tgz}" | sha256sum -c -; \
    tar -xzf "/tmp/${tgz}" -C /tmp "git-lfs-${GIT_LFS_VERSION}/git-lfs"; \
    install -m 0755 "/tmp/git-lfs-${GIT_LFS_VERSION}/git-lfs" /workspace/git-lfs

# Copy the Go source (relies on .dockerignore to filter)
COPY . .

# Build
# the GOARCH has no default value to allow the binary to be built according to the host where the command
# was called. For example, if we call make docker-build in a local env which has the Apple Silicon M1 SO
# the docker BUILDPLATFORM arg will be linux/arm64 when for Apple x86 it will be linux/amd64. Therefore,
# by leaving it empty we can ensure that the container and binary shipped on it will have the same platform.
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -a -o manager cmd/main.go

# The same image is the manager and the cache agent (`/manager repo-cache`,
# ADR-0051), so it carries what the agent execs: git, git-lfs (ADR-0053), ssh,
# and the CA bundle for https remotes. The manager keeps its non-root seat; the cache agent's
# DaemonSet overrides it to root, because a node agent writes a hostPath the
# kubelet creates root-owned.
FROM alpine:3.21
RUN apk add --no-cache git openssh-client ca-certificates
WORKDIR /
COPY --from=builder /workspace/manager /manager
COPY --from=builder /workspace/git-lfs /usr/local/bin/git-lfs
RUN git lfs version
USER 65532:65532

ENTRYPOINT ["/manager"]
