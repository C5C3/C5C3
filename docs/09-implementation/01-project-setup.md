# Project Setup

This page documents the monorepo layout, Go workspace configuration, and developer tooling for building CobaltCore operators.

## Go Workspace

CobaltCore uses a **Go Workspace** (`go.work`) to manage multiple operator modules alongside a [shared library](./02-shared-library.md) in a single repository. This avoids the overhead of separate repositories and tagged releases for shared code — all operators develop against the same `internal/common/` revision at all times.

```go
// go.work
go 1.26.3

use (
    ./internal/common
    ./operators/c5c3
    ./operators/keystone
)
```

> **Note:** Additional operator modules (glance, nova, neutron, cinder, placement) will be added as they are implemented.

Each `use` directive points to a Go module with its own `go.mod`. The workspace ensures that `internal/common` is resolved locally rather than fetched from a registry.

## Project Scaffolding

Operators follow **Kubebuilder v4 / controller-runtime conventions** but are **hand-crafted rather than generated with `operator-sdk init`**. Both `operators/keystone/main.go` and `operators/c5c3/main.go` carry an explicit deviation note (CC-0001): `operator-sdk init` scaffolds a `config/`, `internal/controller/`, a `Dockerfile`, and a per-module `Makefile` that would be immediately deleted for this minimal layout, so the manager setup is written directly against controller-runtime instead. There is no `PROJECT` file.

The `main.go` of every operator delegates manager wiring to the shared [`bootstrap`](./02-shared-library.md#bootstrap) package:

```go
// operators/keystone/main.go (abridged)
func main() {
    if err := bootstrap.Run(bootstrap.ManagerConfig{
        Scheme:           scheme,
        LeaderElectionID: "keystone.openstack.c5c3.io",
        SetupFunc: func(mgr ctrl.Manager, enableWebhooks bool) error {
            // register the Keystone reconciler + webhook
            return nil
        },
    }); err != nil {
        ctrl.Log.WithName("setup").Error(err, "unable to run manager")
        os.Exit(1)
    }
}
```

Operator SDK and `controller-gen` are still used as **code-generation tooling** (DeepCopy methods, CRD/RBAC/webhook manifests via `make generate` / `make manifests`), just not for the initial project scaffolding.

## Monorepo Directory Structure

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       MONOREPO LAYOUT                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  c5c3/forge/                                                                │
│  ├── go.work                          # Go Workspace root                   │
│  ├── Makefile                         # Top-level build targets             │
│  │                                                                          │
│  ├── internal/                                                              │
│  │   └── common/                      # Shared library                      │
│  │       ├── go.mod                   # module: github.com/c5c3/forge/      │
│  │       │                            #   internal/common                   │
│  │       ├── bootstrap/               # Manager initialization             │
│  │       ├── conditions/              # Condition helpers                   │
│  │       ├── config/                  # INI config rendering                │
│  │       ├── database/                # MariaDB CR interaction              │
│  │       ├── deployment/              # Deployment/Service/PDB/HPA helpers  │
│  │       ├── job/                     # Job/CronJob management              │
│  │       ├── secrets/                 # ESO secret readiness, PushSecret    │
│  │       ├── plugins/                 # Plugin/middleware framework         │
│  │       ├── policy/                  # oslo.policy rendering/validation    │
│  │       ├── tls/                     # cert-manager integration            │
│  │       ├── types/                   # Shared Go type definitions          │
│  │       └── testutil/                # Test utilities and simulators       │
│  │                                                                          │
│  ├── operators/                                                             │
│  │   ├── keystone/                    # Keystone Operator (reference)       │
│  │   │   ├── go.mod                                                         │
│  │   │   ├── main.go                                                        │
│  │   │   ├── Dockerfile                                                     │
│  │   │   ├── api/v1alpha1/            # CRD types + webhooks                │
│  │   │   │   ├── keystone_types.go                                          │
│  │   │   │   ├── keystone_webhook.go                                        │
│  │   │   │   └── zz_generated.deepcopy.go                                   │
│  │   │   ├── internal/                                                      │
│  │   │   │   ├── controller/           # Reconciler + sub-reconcilers       │
│  │   │   │   │   ├── keystone_controller.go                                 │
│  │   │   │   │   └── reconcile_*.go     # one file per sub-reconciler       │
│  │   │   │   ├── metrics/              # Operator Prometheus metrics        │
│  │   │   │   └── testutil/                                                  │
│  │   │   ├── config/                  # Kubebuilder metadata                │
│  │   │   │   ├── crd/                                                       │
│  │   │   │   └── webhook/                                                   │
│  │   │   ├── dashboards/              # Grafana dashboard JSON              │
│  │   │   └── helm/                    # Helm chart                          │
│  │   │       └── keystone-operator/                                         │
│  │   └── c5c3/                        # Orchestration operator (stub: main.go only) │
│  │                                                                          │
│  ├── hack/                            # CI/dev helper scripts               │
│  │   ├── deploy-infra.sh / teardown-infra.sh                                │
│  │   ├── install-test-deps.sh                                              │
│  │   └── kind-config.yaml, boilerplate.go.txt                              │
│  ├── scripts/                         # constraint / residue helpers        │
│  │                                                                          │
│  ├── tests/                                                                 │
│  │   ├── e2e/                         # Chainsaw E2E (keystone, infra, c5c3)│
│  │   │   ├── chainsaw-config.yaml                                           │
│  │   │   ├── keystone/                                                      │
│  │   │   ├── keystone-operator/                                            │
│  │   │   ├── infrastructure/                                               │
│  │   │   └── c5c3/                                                          │
│  │   ├── e2e-chaos/                    # Chaos Mesh E2E (see ch. 10)        │
│  │   ├── tempest/                      # Tempest API conformance            │
│  │   ├── unit/                         # Shell-script unit tests            │
│  │   ├── ci/                           # CI-wiring verification scripts     │
│  │   └── lib/                                                               │
│  │                                                                          │
│  └── releases/                        # Per-release configuration           │
│      ├── 2025.2/                                                            │
│      └── 2026.1/                                                            │
│          ├── source-refs.yaml         # Git refs for container builds       │
│          ├── extra-packages.yaml      # Additional Python packages          │
│          ├── test-refs.yaml           # Tempest test git refs               │
│          ├── upper-constraints.txt    # pip constraints                     │
│          └── test-excludes/           # per-service Tempest excludes        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Module Dependencies

Each operator module references the shared library via a `replace` directive for local development:

```go
// operators/keystone/go.mod
module github.com/c5c3/forge/operators/keystone

go 1.26.3

require (
    github.com/c5c3/forge/internal/common v0.0.0
    sigs.k8s.io/controller-runtime v0.24.1
    k8s.io/api v0.36.1
    k8s.io/apimachinery v0.36.1
    k8s.io/client-go v0.36.1
    // + cert-manager, external-secrets, mariadb-operator,
    //   prometheus-operator and robfig/cron APIs
)

replace github.com/c5c3/forge/internal/common => ../../internal/common
```

> **Note:** The `replace` directive is only relevant when building outside the Go Workspace (e.g., in CI without `go.work`). Within the workspace, `go.work`'s `use` directive takes precedence.

## Makefile Targets

The top-level Makefile orchestrates builds across all operators:

| Target | Description |
| --- | --- |
| `make generate` | Run controller-gen to generate DeepCopy methods and CRD manifests for all operators |
| `make generate-common` | Generate DeepCopy methods for `internal/common/types` only |
| `make manifests` | Generate CRD, RBAC, and webhook manifests into `config/` directories |
| `make build` | Compile all operator binaries |
| `make test` | Run unit tests across all modules (see [Testing](./06-testing.md)) |
| `make test-common` | Run unit tests for `internal/common` only |
| `make test-operator` | Run unit tests for a single operator (requires `OPERATOR=`) |
| `make test-race` | Run all tests with the Go race detector (`-race`; CI sets `RACE_FLAGS="-count=1"`) |
| `make test-integration` | Run envtest integration tests (see [Testing](./06-testing.md#integration-tests-envtest)) |
| `make test-integration-common` | Run envtest integration tests for `internal/common` only |
| `make lint` | Run golangci-lint across all modules |
| `make fmt` / `make format-check` | Apply / verify `gofumpt` formatting |
| `make govulncheck` | Scan modules for known Go vulnerabilities |
| `make shellcheck` / `make test-shell` | Lint (`hack/*.sh` + operator rotation scripts under `operators/*/internal/controller/scripts/`) and unit-test shell scripts (`tests/unit/`) |
| `make chainsaw-lint` | Lint all Chainsaw test/config YAML |
| `make docker-build` | Build container images (requires `OPERATOR=keystone\|c5c3`) |
| `make helm-package` | Package Helm charts (requires `OPERATOR=keystone\|c5c3`) |
| `make e2e` | Run Chainsaw E2E tests against a live cluster (see [Testing](./06-testing.md#e2e-tests-with-chainsaw)) |
| `make e2e-chaos` | Run Chaos Mesh fault-injection E2E (see [Chaos E2E Testing](./10-chaos-e2e-testing.md)) |
| `make e2e-prometheus` | Run the kube-prometheus-stack observability E2E suite |
| `make tempest-test` | Run Tempest API conformance tests (requires `SERVICE=`, e.g. `keystone`) |
| `make verify-invalid-cr-fixtures` | Verify generated invalid-CR webhook fixtures are current |
| `make stage-prometheus-dashboard` | Stage the operator Grafana dashboard JSON into `deploy/kind/prometheus/` for the observability E2E |
| `make sync-crds` | Copy generated CRDs to Helm chart `crds/` directory |
| `make verify-crd-sync` | Check for CRD drift between controller-gen output and Helm chart |
| `make deploy-infra` | Deploy infrastructure dependencies (Flux, ESO, OpenBao, MariaDB, Memcached) |
| `make teardown-infra` | Clean up infrastructure dependencies |
| `make install-test-deps` | Install test dependencies |

By default the Makefile operates on `OPERATORS ?= keystone c5c3`. Individual operators can be targeted via the `OPERATOR` variable (which overrides the default set):

```bash
make build OPERATOR=keystone
make test OPERATOR=keystone
make docker-build OPERATOR=keystone
```

> **Pinned tool versions** (single source of truth for local + CI runs): `GOFUMPT_VERSION=v0.9.2`, `ENVTEST_K8S_VERSION=1.35`. CI additionally pins `CONTROLLER_GEN_VERSION=v0.20.1` and `GOLANGCI_LINT_VERSION=v2.11.4`. Several targets (`deploy-infra`, `teardown-infra`, `install-test-deps`) delegate to scripts under `hack/`.

## Developer Prerequisites

| Tool | Version | Purpose |
| --- | --- | --- |
| **Go** | 1.26+ | Build and test |
| **operator-sdk** | 1.38+ | Code generation (markers); not used for scaffolding |
| **controller-gen** | 0.20+ | CRD/RBAC/DeepCopy generation |
| **gofumpt** | v0.9.2 | Formatting (`make fmt` / `format-check`) |
| **kind** | 0.24+ | Local Kubernetes cluster for testing |
| **chainsaw** | 0.2+ | E2E test execution |
| **helm** | 3.x | Chart packaging |
| **golangci-lint** | 2.11+ | Linting |
| **docker** / **podman** | — | Container image builds |
| **kubectl** | 1.35+ | Cluster interaction |
