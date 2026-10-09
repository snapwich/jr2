# The Effector (ADR-0068): one static binary, `effector`, that the jr2-harness image carries at
# /opt/jr2/bin/effector. The same toolchain and lint as operator/. It imports the standard library
# alone, so nothing is downloaded and the Harness image's Go stage copies this directory only.

# Pin the Go toolchain to the version go.mod declares, as operator/ does, so a build matches CI.
GOTOOLCHAIN ?= go$(shell sed -n 's/^go //p' go.mod)
export GOTOOLCHAIN

SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

LOCALBIN ?= $(shell pwd)/bin
GOLANGCI_LINT ?= $(LOCALBIN)/golangci-lint
GOLANGCI_LINT_VERSION ?= v2.12.2

.PHONY: all
all: build

.PHONY: help
help: ## Display this help.
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: fmt
fmt: ## Run go fmt against code.
	go fmt ./...

.PHONY: vet
vet: ## Run go vet against code.
	go vet ./...

.PHONY: test
test: fmt vet ## Run the tests (loopback only; no docker, no cluster).
	go test ./... -coverprofile cover.out

.PHONY: build
build: fmt vet ## Build the static binary into bin/effector.
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/effector ./cmd/effector

.PHONY: lint
lint: golangci-lint ## Run golangci-lint.
	"$(GOLANGCI_LINT)" run

.PHONY: lint-fix
lint-fix: golangci-lint ## Run golangci-lint and apply its fixes.
	"$(GOLANGCI_LINT)" run --fix

.PHONY: lint-config
lint-config: golangci-lint ## Verify the golangci-lint configuration.
	"$(GOLANGCI_LINT)" config verify

$(LOCALBIN):
	mkdir -p "$(LOCALBIN)"

.PHONY: golangci-lint
golangci-lint: $(GOLANGCI_LINT) ## Download golangci-lint locally if necessary.
$(GOLANGCI_LINT): | $(LOCALBIN)
	@[ -f "$(GOLANGCI_LINT)-$(GOLANGCI_LINT_VERSION)" ] || { \
	  set -e; \
	  echo "Downloading golangci-lint $(GOLANGCI_LINT_VERSION)"; \
	  GOBIN="$(LOCALBIN)" go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION); \
	  mv "$(LOCALBIN)/golangci-lint" "$(GOLANGCI_LINT)-$(GOLANGCI_LINT_VERSION)"; \
	}
	@ln -sf "$$(realpath "$(GOLANGCI_LINT)-$(GOLANGCI_LINT_VERSION)")" "$(GOLANGCI_LINT)"
