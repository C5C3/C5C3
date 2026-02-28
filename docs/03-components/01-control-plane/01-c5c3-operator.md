# C5C3 Operator

**Repository:** `github.com/c5c3/forge`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `c5c3-system`

The **c5c3-operator** is the central orchestration operator. It manages dependency management between services, creates infrastructure CRs, and coordinates credential lifecycle management. It does **not** deploy OpenStack services directly - that's handled by the dedicated service-operators.

**Responsibilities:**

```text
┌─────────────────────────────────────────────────────────────────┐
│                c5c3-operator Responsibilities                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Infrastructure Orchestration                                │
│     ├── Creates MariaDB CR → MariaDB Operator                   │
│     ├── Creates RabbitMQ CR → RabbitMQ Operator                 │
│     ├── Creates Valkey CR → Valkey Operator                     │
│     └── Creates Memcached CR → Memcached Operator               │
│                                                                 │
│  2. Dependency Management                                       │
│     ├── Dependency graph between services                       │
│     ├── Set conditions on Service CRs                           │
│     └── Readiness aggregation                                   │
│                                                                 │
│  3. Credential & Service Catalog Orchestration                  │
│     ├── Import bootstrap resources into K-ORC (unmanaged):      │
│     │   Domain, Service Project, Roles (created by Keystone     │
│     │   Bootstrap Job — must be imported before K-ORC can act)  │
│     ├── Create K-ORC CRs for Keystone Services (managed)        │
│     ├── Create K-ORC CRs for Endpoints (managed)                │
│     ├── Create K-ORC CRs for Service Users (managed)            │
│     ├── Create K-ORC CRs for Application Credentials (managed)  │
│     ├── Manage SecretAggregate CRs                              │
│     └── Coordinate CredentialRotation                           │
│                                                                 │
│  4. Service CR Creation                                         │
│     ├── Creates Keystone CR → keystone-operator                 │
│     ├── Creates Glance CR → glance-operator                     │
│     ├── Creates Placement CR → placement-operator               │
│     ├── Creates Nova CR → nova-operator                         │
│     ├── Creates Neutron CR → neutron-operator                   │
│     ├── Creates Cinder CR → cinder-operator                     │
│     ├── Creates Cortex CR → cortex-operator (optional)          │
│     └── Creates Tempest CR → tempest-operator (optional)        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

For the Go type definitions, orchestration reconciler, and rollout strategy, see [C5C3 Operator Implementation](../../09-implementation/08-c5c3-operator.md).

**Provided CRDs:**

| CRD                  | API Group          | Description                              |
| -------------------- | ------------------ | ---------------------------------------- |
| `ControlPlane`       | `c5c3.io/v1alpha1` | Top-level CRD for entire Control Plane   |
| `SecretAggregate`    | `c5c3.io/v1alpha1` | Aggregates secrets from multiple sources |
| `CredentialRotation` | `c5c3.io/v1alpha1` | Automatic credential rotation            |

**ControlPlane CRD Example:**

```yaml
apiVersion: c5c3.io/v1alpha1
kind: ControlPlane
metadata:
  name: production
  namespace: openstack
spec:
  # Infrastructure (c5c3-operator creates CRs for external operators)
  infrastructure:
    mariadb:
      replicas: 3
      storageSize: 100Gi
      storageClass: ceph-rbd
    rabbitmq:
      replicas: 3
      storageSize: 20Gi
    valkey:
      replicas: 3
      sentinel:
        enabled: true
    memcached:
      replicas: 3
      memory: 1Gi

  # OpenStack Services (c5c3-operator creates CRs for Service-Operators)
  services:
    keystone:
      enabled: true
      replicas: 3
    glance:
      enabled: true
      replicas: 2
    placement:
      enabled: true
      replicas: 2
    nova:
      enabled: true
      api:
        replicas: 3
      scheduler:
        replicas: 2
      conductor:
        replicas: 2
    neutron:
      enabled: true
      api:
        replicas: 3
    cinder:
      enabled: true
      api:
        replicas: 2
      scheduler:
        replicas: 2

  # Optional: Cortex (Intelligent Scheduler)
  cortex:
    enabled: false  # Optional
    replicas: 2

  # Optional: Tempest (Integration Testing)
  tempest:
    enabled: false  # Optional
    schedule: "0 2 * * *"  # Nightly test runs

  # K-ORC Integration
  korc:
    enabled: true
    bootstrapResources:
      - domains
      - projects

  # Global Settings
  global:
    region: RegionOne
    tls:
      enabled: true
      issuerRef:
        name: letsencrypt-prod
        kind: ClusterIssuer
    monitoring:
      enabled: true
```

**Deployment Order (Dependency Graph):**

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Deployment Dependency Graph                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 1: Infrastructure                                                    │
│  ┌─────────┐  ┌──────────┐  ┌───────┐  ┌──────────┐                         │
│  │ MariaDB │  │ RabbitMQ │  │Valkey │  │ Memcached│                         │
│  └────┬────┘  └────┬─────┘  └───┬───┘  └────┬─────┘                         │
│       │            │            │           │                               │
│       └────────────┴─────┬──────┴───────────┘                               │
│                          │                                                  │
│                          ▼                                                  │
│  Phase 2: Identity    ┌─────────┐                                           │
│                       │Keystone │  depends: MariaDB, Memcached              │
│                       └────┬────┘                                           │
│                            │                                                │
│                            ▼                                                │
│  Phase 3:          ┌──────────────┐                                         │
│  Service Catalog   │    K-ORC     │  depends: Keystone                      │
│                    │              │                                         │
│                    │ 1. Import    │  Import bootstrap resources             │
│                    │    bootstrap │  (Domain, Project, Roles)               │
│                    │    (unmanaged│  from Keystone Bootstrap Job            │
│                    │              │                                         │
│                    │ 2. Create    │  Register Services + Endpoints          │
│                    │    Services, │  for Glance, Nova, Neutron,             │
│                    │    Endpoints │  Cinder, Placement                      │
│                    │    (managed) │                                         │
│                    │              │                                         │
│                    │ 3. Create    │  Service Users +                        │
│                    │    Users,    │  Application Credentials                │
│                    │    AppCreds  │  for all OpenStack services             │
│                    │    (managed) │                                         │
│                    └──────┬───────┘                                         │
│                           │                                                 │
│                ┌──────────┴──────────┐                                      │
│                ▼                     ▼                                      │
│  Phase 4: ┌───────┐           ┌───────────┐                                 │
│  Core     │ Glance│           │ Placement │  depends: Keystone, K-ORC       │
│           └───┬───┘           └─────┬─────┘  (needs Service Catalog entries)│
│               │                     │                                       │
│               └──────────┬──────────┘                                       │
│                          │                                                  │
│              ┌───────────┼───────────┐                                      │
│              ▼           ▼           ▼                                      │
│  Phase 5: ┌──────┐  ┌─────────┐  ┌────────┐                                 │
│  Compute  │ Nova │  │ Neutron │  │ Cinder │                                 │
│           └──┬───┘  └─────┬───┘  └───┬────┘                                 │
│              │  depends:  │          │                                      │
│              │  Keystone, │          │                                      │
│              │  K-ORC,    │          │                                      │
│              │  Placement,│          │                                      │
│              │  RabbitMQ, │          │                                      │
│              │  Glance    │          │                                      │
│              └────────────┴──────────┘                                      │
│                                │                                            │
│                                ▼                                            │
│  Phase 6: (optional)       ┌────────┐                                       │
│  Scheduler                 │ Cortex │  depends: Nova, Cinder                │
│                            └───┬────┘                                       │
│                                │                                            │
│                                ▼                                            │
│  Phase 7: (optional)     ┌─────────┐                                        │
│  Testing                 │ Tempest │  depends: Nova, Neutron, Cinder,       │
│                          └─────────┘  Glance, Keystone                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Helm Chart Deployment (via FluxCD):**

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: c5c3
  namespace: flux-system
spec:
  interval: 1h
  url: https://c5c3.github.io/c5c3-operator

---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: c5c3-operator
  namespace: c5c3-system
spec:
  interval: 30m
  chart:
    spec:
      chart: c5c3-operator
      version: ">=0.1.0"
      sourceRef:
        kind: HelmRepository
        name: c5c3
        namespace: flux-system
  values:
    replicaCount: 2
    metrics:
      enabled: true
  install:
    crds: CreateReplace
  upgrade:
    crds: CreateReplace
```

## Further Reading

* [Service Operators](./02-service-operators.md) — Operators created and managed by c5c3-operator
* [K-ORC](./05-korc.md) — Keystone resource management coordinated by c5c3-operator
* [Infrastructure Operators](./06-infrastructure-operators.md) — Infrastructure CRs created by c5c3-operator
* [C5C3 Operator Implementation](../../09-implementation/08-c5c3-operator.md) — Go types, reconciler, rollout strategy
