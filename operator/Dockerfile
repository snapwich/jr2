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

# Copy the Go source (relies on .dockerignore to filter)
COPY . .

# Build
# the GOARCH has no default value to allow the binary to be built according to the host where the command
# was called. For example, if we call make docker-build in a local env which has the Apple Silicon M1 SO
# the docker BUILDPLATFORM arg will be linux/arm64 when for Apple x86 it will be linux/amd64. Therefore,
# by leaving it empty we can ensure that the container and binary shipped on it will have the same platform.
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -a -o manager cmd/main.go

# The same image is the manager and the cache agent (`/manager repo-cache`,
# ADR-0051), so it carries what the agent execs: git, ssh, and the CA bundle
# for https remotes. The manager keeps its non-root seat; the cache agent's
# DaemonSet overrides it to root, because a node agent writes a hostPath the
# kubelet creates root-owned.
FROM alpine:3.21
RUN apk add --no-cache git openssh-client ca-certificates
WORKDIR /
COPY --from=builder /workspace/manager /manager
USER 65532:65532

ENTRYPOINT ["/manager"]
