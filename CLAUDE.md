<!--
# SPDX-FileCopyrightText: Copyright 2026 SAP SE or an SAP affiliate company
#
# SPDX-License-Identifier: Apache-2.0
-->

# CLAUDE.md — CobaltCore (C5C3)

## Project Overview

CobaltCore (C5C3) is a **Kubernetes-native OpenStack distribution** for operating Hosted Control Planes. It uses a modular operator architecture built with Go, Operator SDK, and controller-runtime. The system deploys OpenStack services (Keystone, Nova, Neutron, Glance, Cinder, Placement) across a 4-cluster topology (Management, Control Plane, Hypervisor, Storage).

**This repository** (`C5C3/C5C3`) contains the **architecture documentation** (VitePress site). The implementation code lives in the **`c5c3/forge`** monorepo (see [docs/09-implementation/](docs/09-implementation/index.md)).

## Repository Structure

```
C5C3/
├── docs/                          # VitePress documentation site
│   ├── 01-introduction.md
│   ├── 02-architecture-overview.md
│   ├── 03-components/             # Component docs (control plane, hypervisor, storage, mgmt)
│   ├── 04-architecture/           # Deep dives (CRDs, HA, networking, storage)
│   ├── 05-deployment/             # GitOps, secrets, service configuration
│   ├── 06-operations/             # Upgrades, observability, brownfield
│   ├── 07-crossplane/             # Consumer/tenant provisioning
│   ├── 08-container-images/       # Build pipeline, versioning, patching, SBOM
│   ├── 09-implementation/         # *** IMPLEMENTATION GUIDE — see below ***
│   └── .vitepress/                # VitePress config + theme
├── LICENSES/
├── package.json                   # VitePress dev dependencies
├── .mega-linter.yml               # Linting config
├── cspell.yaml                    # Spell checking with custom word list
├── .lychee.toml                   # Link checker config
└── REUSE.toml                     # REUSE/SPDX licensing (Apache-2.0, SAP SE)
```

## Implementation Guide (docs/09-implementation/)

**This is the primary reference for building CobaltCore operators.** All implementation follows a Keystone-first strategy — Keystone is the reference implementation, and all subsequent operators reuse its patterns.

### Key Documents

| Document | What It Defines |
|---|---|
| [01-project-setup.md](docs/09-implementation/01-project-setup.md) | Go workspace (`go.work`), monorepo layout (`c5c3/forge/`), Makefile targets, developer prerequisites |
| [02-shared-library.md](docs/09-implementation/02-shared-library.md) | `internal/common/` packages: conditions, config, database, deployment, job, secrets, plugins, policy, tls, types |
| [03-crd-implementation.md](docs/09-implementation/03-crd-implementation.md) | Go type definitions, Kubebuilder markers, validation/defaulting webhooks, versioning strategy |
| [04-keystone-reconciler.md](docs/09-implementation/04-keystone-reconciler.md) | Sub-reconciler pattern, reconciliation flow, controller setup, RBAC markers, error handling |
| [05-keystone-dependencies.md](docs/09-implementation/05-keystone-dependencies.md) | OpenBao/ESO secret flow, MariaDB/Memcached interaction, Fernet lifecycle, bootstrap process |
| [06-testing.md](docs/09-implementation/06-testing.md) | Testing pyramid: unit (go test), integration (envtest), E2E (Chainsaw + kind) |
| [07-ci-cd-and-packaging.md](docs/09-implementation/07-ci-cd-and-packaging.md) | GitHub Actions pipeline, Dockerfile, Helm chart packaging, FluxCD integration, release process |
| [08-c5c3-operator.md](docs/09-implementation/08-c5c3-operator.md) | ControlPlane CRD, orchestration reconciler, infrastructure lifecycle, rollout strategy |
| [09-openbao-deployment.md](docs/09-implementation/09-openbao-deployment.md) | OpenBao deployment, initialization, secret engines, auth methods, policies |

### Forge Monorepo Layout (c5c3/forge)

```
c5c3/forge/
├── go.work                        # Go 1.25 workspace
├── internal/common/               # Shared library (all operators depend on this)
│   ├── conditions/                # Status condition helpers
│   ├── config/                    # INI config rendering (Go structs, no templates)
│   ├── database/                  # MariaDB CR interaction + db_sync jobs
│   ├── deployment/                # Deployment/Service creation
│   ├── job/                       # Job/CronJob management
│   ├── secrets/                   # ESO secret readiness + PushSecret helpers
│   ├── plugins/                   # Plugin/middleware config rendering
│   ├── policy/                    # oslo.policy file rendering + validation
│   ├── tls/                       # cert-manager integration
│   └── types/                     # Shared Go types (ImageSpec, DatabaseSpec, etc.)
├── operators/
│   ├── keystone/                  # Reference implementation
│   ├── glance/
│   ├── nova/
│   ├── neutron/
│   ├── cinder/
│   ├── placement/
│   └── c5c3/                      # Orchestration operator (ControlPlane CRD)
└── tests/e2e/                     # Chainsaw E2E tests
```

## Technology Stack

| Component | Version | Purpose |
|---|---|---|
| Go | 1.26.3 | Operator language |
| Operator SDK | 1.38+ | Code generation (markers); not used for scaffolding |
| controller-runtime | 0.24+ | Reconciler framework |
| Kubebuilder | 4.x | CRD/RBAC/webhook markers |
| Chainsaw | 0.2+ | Declarative E2E testing |
| Helm | 3.x | Operator packaging |
| GitHub Actions | — | CI/CD |
| VitePress | 1.6+ | Documentation site |

## Architecture Principles

- **One Operator per OpenStack Service**: Dedicated reconciliation loop, CRD, and release lifecycle per service
- **Shared Library in Monorepo**: `internal/common/` shared via Go Workspace — no separate versioning
- **Go over Templates**: Config files rendered from Go structs for type safety + testability
- **Secrets via ESO**: Operators read K8s Secrets created by External Secrets Operator from OpenBao — never access OpenBao directly
- **Managed + Brownfield**: `clusterRef` (operator provisions infra) XOR `host`/`port` (external infra)
- **Immutable ConfigMaps**: Config content hashed into ConfigMap name — changes trigger rolling restarts
- **Sub-Reconciler Pattern**: Each reconciler has ordered sub-reconcilers, each setting its own status condition. Keystone's real chain is `secrets → databaseTLS → dbConnectionSecret → config → {fernet | credential | networkPolicy (parallel)} → database → policyValidation → deployment → httpRoute → healthCheck → hpa → bootstrap → trustFlush`
- **Database credentials out of ConfigMaps**: the DB password is rendered into a derived `<name>-db-connection` Secret and injected via `OS_DATABASE__CONNECTION`, never written into `keystone.conf` (CC-0080)
- **Database TLS**: opt-in mTLS to MariaDB/MaxScale via cert-manager from a shared OpenStack DB CA, three modes (NotRequired/ExternallyManaged/Managed) (CC-0106)
- **Split-compute-write key rotation**: rotation CronJobs write a staging Secret with narrow RBAC; the operator validates and applies to the production Secret, keeping token-forgery primitives out of the CronJob (CC-0081)

## Key Patterns for New Operators

When implementing a new service operator, follow the Keystone reference:

1. **Set up** `operators/<service>/` hand-crafted (not `operator-sdk init`, CC-0001): a `main.go` delegating to `common/bootstrap.Run`, plus `api/v1alpha1/`, `internal/controller/`, `config/`, `helm/` directories
2. **CRD types** in `api/v1alpha1/<service>_types.go` — reuse `commonv1.DatabaseSpec` (incl. `TLS *DatabaseTLSSpec`), `commonv1.CacheSpec`, `commonv1.MessagingSpec`, `commonv1.PolicySpec` from shared types
3. **Reconciler** with sub-reconciler pattern: `reconcileSecrets()` → `reconcileDatabaseTLS()` → `reconcileDBConnectionSecret()` → `reconcileConfig()` → `reconcileFernetKeys()`/`reconcileCredentialKeys()`/`reconcileNetworkPolicy()` → `reconcileDatabase()` → `reconcilePolicyValidation()` → `reconcileDeployment()` → `reconcileBootstrap()` (Keystone adds `reconcileHTTPRoute`, `reconcileHealthCheck`, `reconcileHPA`, `reconcileTrustFlush`)
4. **Status conditions** (aggregate `Ready`): `SecretsReady`, `DatabaseTLSReady`, `FernetKeysReady`, `CredentialKeysReady`, `DatabaseReady`, `PolicyValidReady`, `DeploymentReady`, `KeystoneAPIReady`, `HPAReady`, `NetworkPolicyReady`, `HTTPRouteReady`, `BootstrapReady`, `TrustFlushReady`
5. **Config generation**: CRD spec → resolve secrets → apply defaults → render INI → immutable ConfigMap
6. **Owner references**: `ctrl.SetControllerReference()` on all created resources
7. **Testing**: Unit tests for config/logic, envtest for reconciler, Chainsaw for E2E

## CRD API Groups

| API Group | CRD | Operator |
|---|---|---|
| `c5c3.io` | `ControlPlane`, `SecretAggregate`, `CredentialRotation` | c5c3-operator |
| `keystone.openstack.c5c3.io` | `Keystone` | keystone-operator |
| `nova.openstack.c5c3.io` | `Nova` | nova-operator |
| `neutron.openstack.c5c3.io` | `Neutron` | neutron-operator |
| `glance.openstack.c5c3.io` | `Glance` | glance-operator |
| `cinder.openstack.c5c3.io` | `Cinder` | cinder-operator |
| `placement.openstack.c5c3.io` | `Placement` | placement-operator |

## Development Commands (docs site)

```bash
npm install            # Install VitePress dependencies
npm run docs:dev       # Local dev server at http://localhost:5173/C5C3/
npm run docs:build     # Build static site
npm run docs:preview   # Preview built site
```

## Development Commands (forge monorepo)

```bash
make generate                    # controller-gen DeepCopy + CRD manifests
make manifests                   # CRD, RBAC, webhook manifests
make build [OPERATOR=keystone]   # Compile operator binaries
make test [OPERATOR=keystone]    # Unit tests
make test-integration            # envtest integration tests
make e2e [OPERATOR=keystone]     # Chainsaw E2E tests (requires kind cluster)
make lint                        # golangci-lint
make docker-build                # Container images
make helm-package                # Helm charts
```

## Conventions

- **Language**: Documentation in English, code in Go
- **Licensing**: Apache-2.0 (SAP SE), REUSE/SPDX compliant — all files need SPDX headers
- **Linting**: MegaLinter for docs, golangci-lint 2.10+ for Go
- **Spell check**: cspell with custom word list in `cspell.yaml`
- **Link checking**: lychee (excludes localhost URLs)
- **CRD versioning**: Start at `v1alpha1`, promote to `v1beta1` then `v1` with conversion webhooks
- **Commit style**: Conventional-ish prefixes (`chore`, `feat`, `fix`, `plan`, `docs`)
- **Container images**: `gcr.io/distroless/static:nonroot` base, non-root UID 65532, statically linked Go binaries
- **Registry**: `ghcr.io/c5c3/` for operator images and Helm charts (OCI)
