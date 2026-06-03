# Implementation

CobaltCore's architecture is documented across the preceding chapters — from the [modular operator architecture](../03-components/01-control-plane/) and [CRD definitions](../04-architecture/01-crds.md) to the [config generation pipeline](../05-deployment/03-service-configuration/01-config-generation.md) and [secret management](../05-deployment/02-secret-management.md).
This chapter bridges the gap between architecture and code by documenting the concrete implementation of operators using Kubebuilder v4 conventions and controller-runtime.

The implementation follows a **Keystone-first** strategy: the Keystone Operator is built first as a complete reference implementation, establishing patterns and shared libraries that all subsequent operators will reuse.

## Implementation Philosophy

| Principle | Description |
| --- | --- |
| **One Operator per Service** | Each OpenStack service has a dedicated operator with its own reconciliation loop, CRD, and release lifecycle |
| **Shared Library (Monorepo)** | Common patterns (database, config, secrets, conditions) live in `internal/common/` and are shared via Go Workspace |
| **Kubebuilder v4 + controller-runtime** | Standard tooling — Kubebuilder markers, controller-gen for CRD/RBAC generation, envtest for integration tests. Operators are hand-crafted against controller-runtime rather than scaffolded with `operator-sdk init` (CC-0001) |
| **Go over Templates** | Configuration files are rendered from Go structs, not template languages — enabling type safety and testability |
| **Secrets via ESO** | Operators read Kubernetes Secrets (created by ESO from OpenBao) — they never interact with OpenBao directly |

## Implementation Roadmap

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       IMPLEMENTATION ROADMAP                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 1: Foundation                                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Go Workspace + Monorepo Setup                                      │    │
│  │  Shared Library (internal/common/)                                  │    │
│  │  CI/CD Pipeline + Helm Chart Skeleton                               │    │
│  │  E2E Test Framework (Chainsaw)                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                              │
│                              ▼                                              │
│  Phase 2: Keystone Operator (Reference Implementation)                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Keystone CRD (v1alpha1) + Webhooks                                 │    │
│  │  Keystone Reconciler (DB, Config, Fernet, Deployment, Bootstrap)    │    │
│  │  Keystone Dependencies (MariaDB, Memcached, ESO Secrets)            │    │
│  │  Full Test Suite (Unit + envtest + Chainsaw E2E)                    │    │
│  │  Helm Chart + FluxCD Integration                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                              │
│                              ▼                                              │
│  Phase 3a: c5c3-operator                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ControlPlane CRD + Orchestration Reconciler                        │    │
│  │  Infrastructure CR creation + Readiness waiting                     │    │
│  │  Service CR projection (ControlPlane → per-service CRs)             │    │
│  │  K-ORC integration (bootstrap imports, Services, Endpoints, Users)  │    │
│  │  SecretAggregate + CredentialRotation CRDs                          │    │
│  │  Phased rollout strategy (updatePhase tracking)                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                              │                                              │
│                              ▼                                              │
│  Phase 3b: Remaining Service Operators                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Glance Operator     (MariaDB, Keystone, Ceph)                      │    │
│  │  Placement Operator  (MariaDB, Keystone)                            │    │
│  │  Nova Operator       (MariaDB, RabbitMQ, Keystone, Ceph, Cells)     │    │
│  │  Neutron Operator    (MariaDB, RabbitMQ, Keystone, OVN)             │    │
│  │  Cinder Operator     (MariaDB, RabbitMQ, Keystone, Ceph)            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

> **Current status:** Phases 1 and 2 are implemented — the Keystone Operator is a complete reference implementation. **Phase 3a is largely implemented** (CC-0110, the Keystone-first slice): the c5c3-operator ships the `ControlPlane` and `CredentialRotation` CRDs with working reconcilers, plus the `SecretAggregate` CRD as a types-only placeholder (its reconciler is deferred to CC-0023). The orchestration reconciler provisions the infrastructure (MariaDB + Memcached) and the Keystone CR, then integrates with [K-ORC](../03-components/01-control-plane/05-korc.md) to mint the admin `ApplicationCredential` and register the identity `Service`/`Endpoint` in the catalog. Still planned within Phase 3a: multi-service orchestration, per-pod service users, and the phased rollback strategy (the `updatePhase` values `UpdatingServices`/`Verifying`/`RollingBack` are reserved but not yet active). Phase 3b operators (Glance, Placement, Nova, Neutron, Cinder) are planned.

## Technology Stack

| Component | Version | Purpose |
| --- | --- | --- |
| **Go** | 1.26.4 | Operator implementation language |
| **Operator SDK** | 1.38+ | Code-generation tooling (markers); not used for project scaffolding |
| **controller-runtime** | 0.24+ | Reconciler framework, manager, caching |
| **Kubebuilder** | 4.x | Code generation markers for CRDs, RBAC, webhooks |
| **Chainsaw** | 0.2+ | Declarative E2E testing for Kubernetes operators |
| **Helm** | 3.x | Operator packaging and deployment |
| **GitHub Actions** | — | CI/CD pipeline |

## Why Keystone First

Keystone is the ideal starting point for implementation:

* **Simplest dependency graph** — Keystone requires only MariaDB and Memcached. No RabbitMQ, no Valkey, no Ceph. This minimizes the infrastructure needed for development and testing.
* **Foundation for all other services** — Every OpenStack service authenticates against Keystone. Building it first unblocks all subsequent operators.
* **Non-trivial reconciliation patterns** — Fernet key rotation (generation, CronJob writing a staging Secret, operator-side validation and apply, OpenBao backup via PushSecret) exercises the full reconciliation lifecycle without excessive complexity. Keys are projected into pods and rotate in place — no rolling restart is triggered on rotation (CC-0074).
* **Config generation reference** — The [config generation pipeline](../05-deployment/03-service-configuration/01-config-generation.md) can be validated end-to-end with `keystone.conf` before tackling more complex services like Nova (multiple config files, cell architecture).
* **Plugin/middleware pattern** — Keystone's `api-paste.ini` pipeline and domain-specific configs (e.g., Keycloak backend) establish the generic plugin framework that all services will use.

## Further Reading

- [Project Setup](./01-project-setup.md) — Go workspace, monorepo layout, Makefile targets
- [Shared Library](./02-shared-library.md) — `internal/common/` package design, OpenBao/ESO integration
- [CRD Implementation](./03-crd-implementation.md) — Go types, Kubebuilder markers, webhooks
- [Keystone Reconciler](./04-keystone-reconciler.md) — Sub-reconciler pattern, error handling
- [Keystone Dependencies](./05-keystone-dependencies.md) — Secret flow, MariaDB, Memcached, Fernet rotation
- [Testing](./06-testing.md) — Unit, integration (envtest), E2E (Chainsaw)
- [CI/CD & Packaging](./07-ci-cd-and-packaging.md) — GitHub Actions, Helm charts, FluxCD
- [C5C3 Operator](./08-c5c3-operator.md) — ControlPlane CRD, orchestration reconciler, K-ORC admin credential, rollout strategy
- [OpenBao Deployment](./09-openbao-deployment.md) — Deployment, initialization, secret engines, policies
- [Chaos E2E Testing](./10-chaos-e2e-testing.md) — Chaos Mesh fault injection, resilience scenarios

For the configuration lifecycle concepts that inform this implementation, see [Service Configuration](../05-deployment/03-service-configuration/index.md).
