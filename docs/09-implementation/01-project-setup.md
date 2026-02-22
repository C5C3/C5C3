# Project Setup

This page documents the monorepo layout, Go workspace configuration, and developer tooling for building CobaltCore operators.

## Go Workspace

CobaltCore uses a **Go Workspace** (`go.work`) to manage multiple operator modules alongside a [shared library](./02-shared-library.md) in a single repository. This avoids the overhead of separate repositories and tagged releases for shared code — all operators develop against the same `internal/common/` revision at all times.

```go
// go.work
go 1.25

use (
    ./internal/common
    ./operators/keystone
    ./operators/glance
    ./operators/placement
    ./operators/nova
    ./operators/neutron
    ./operators/cinder
    ./operators/c5c3
)
```

Each `use` directive points to a Go module with its own `go.mod`. The workspace ensures that `internal/common` is resolved locally rather than fetched from a registry.

## Operator SDK Initialization

Each operator is scaffolded with Operator SDK:

```bash
cd operators/keystone
operator-sdk init \
  --domain openstack.c5c3.io \
  --repo github.com/c5c3/c5c3/operators/keystone

operator-sdk create api \
  --group keystone \
  --version v1alpha1 \
  --kind Keystone \
  --resource --controller
```

This generates the base project structure: `main.go`, `api/v1alpha1/` types, `internal/controller/` reconciler, and Kubebuilder configuration.

## Monorepo Directory Structure

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       MONOREPO LAYOUT                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  c5c3/c5c3/                                                                 │
│  ├── go.work                          # Go Workspace root                   │
│  ├── Makefile                         # Top-level build targets             │
│  │                                                                          │
│  ├── internal/                                                              │
│  │   └── common/                      # Shared library                      │
│  │       ├── go.mod                   # module: github.com/c5c3/c5c3/       │
│  │       │                            #   internal/common                   │
│  │       ├── conditions/              # Condition helpers                   │
│  │       ├── config/                  # INI config rendering                │
│  │       ├── database/                # MariaDB CR interaction              │
│  │       ├── deployment/              # Deployment/Service helpers          │
│  │       ├── job/                     # Job/CronJob management              │
│  │       ├── secrets/                 # ESO secret readiness, PushSecret    │
│  │       ├── plugins/                 # Plugin/middleware framework         │
│  │       ├── tls/                     # cert-manager integration            │
│  │       └── types/                   # Shared Go type definitions          │
│  │                                                                          │
│  ├── operators/                                                             │
│  │   ├── keystone/                    # Keystone Operator                   │
│  │   │   ├── go.mod                                                         │
│  │   │   ├── main.go                                                        │
│  │   │   ├── api/v1alpha1/            # CRD types + webhooks                │
│  │   │   │   ├── keystone_types.go                                          │
│  │   │   │   ├── keystone_webhook.go                                        │
│  │   │   │   └── zz_generated.deepcopy.go                                   │
│  │   │   ├── internal/controller/     # Reconciler                          │
│  │   │   │   ├── keystone_controller.go                                     │
│  │   │   │   └── keystone_controller_test.go                                │
│  │   │   ├── config/                  # Kubebuilder metadata                │
│  │   │   │   ├── crd/                                                       │
│  │   │   │   ├── rbac/                                                      │
│  │   │   │   └── manager/                                                   │
│  │   │   └── helm/                    # Helm chart                          │
│  │   │       └── keystone-operator/                                         │
│  │   ├── glance/                      # (same structure)                    │
│  │   ├── nova/                        # (same structure)                    │
│  │   └── ...                                                                │
│  │                                                                          │
│  ├── tests/                                                                 │
│  │   └── e2e/                         # Chainsaw E2E tests                  │
│  │       ├── chainsaw-config.yaml                                           │
│  │       └── keystone/                                                      │
│  │           ├── basic-deployment/                                          │
│  │           ├── fernet-rotation/                                           │
│  │           └── ...                                                        │
│  │                                                                          │
│  └── releases/                        # Per-release configuration           │
│      └── 2025.2/                                                            │
│          ├── source-refs.yaml         # Git refs for container builds       │
│          └── extra-packages.yaml      # Additional Python packages          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Module Dependencies

Each operator module references the shared library via a `replace` directive for local development:

```go
// operators/keystone/go.mod
module github.com/c5c3/c5c3/operators/keystone

go 1.25

require (
    github.com/c5c3/c5c3/internal/common v0.0.0
    sigs.k8s.io/controller-runtime v0.23.1
    k8s.io/apimachinery v0.35.1
    k8s.io/client-go v0.35.1
)

replace github.com/c5c3/c5c3/internal/common => ../../internal/common
```

> **Note:** The `replace` directive is only relevant when building outside the Go Workspace (e.g., in CI without `go.work`). Within the workspace, `go.work`'s `use` directive takes precedence.

## Makefile Targets

The top-level Makefile orchestrates builds across all operators:

| Target | Description |
| --- | --- |
| `make generate` | Run controller-gen to generate DeepCopy methods and CRD manifests for all operators |
| `make manifests` | Generate CRD, RBAC, and webhook manifests into `config/` directories |
| `make build` | Compile all operator binaries |
| `make test` | Run unit tests across all modules (see [Testing](./06-testing.md)) |
| `make test-integration` | Run envtest integration tests (see [Testing](./06-testing.md#integration-tests-envtest)) |
| `make docker-build` | Build container images for all operators |
| `make helm-package` | Package Helm charts for all operators (see [CI/CD & Packaging](./07-ci-cd-and-packaging.md#helm-chart-structure)) |
| `make lint` | Run golangci-lint across all modules |
| `make e2e` | Run Chainsaw E2E tests against a live cluster (see [Testing](./06-testing.md#e2e-tests-with-chainsaw)) |

Individual operators can be targeted via the `OPERATOR` variable:

```bash
make build OPERATOR=keystone
make test OPERATOR=keystone
make docker-build OPERATOR=keystone
```

## Developer Prerequisites

| Tool | Version | Purpose |
| --- | --- | --- |
| **Go** | 1.25+ | Build and test |
| **operator-sdk** | 1.38+ | Project scaffolding |
| **controller-gen** | 0.16+ | CRD/RBAC/DeepCopy generation |
| **kind** | 0.24+ | Local Kubernetes cluster for testing |
| **chainsaw** | 0.2+ | E2E test execution |
| **helm** | 3.x | Chart packaging |
| **golangci-lint** | 2.10+ | Linting |
| **docker** / **podman** | — | Container image builds |
| **kubectl** | 1.35+ | Cluster interaction |
