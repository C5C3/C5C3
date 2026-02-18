# Control Plane

The Control Plane consists of a **modular operator architecture** where each OpenStack service has its own dedicated operator. The central `c5c3-operator` handles orchestration and dependency management.

> **Note:** The OpenStack services and their operators documented below are representative of the current implementation. The modular architecture is designed to integrate additional OpenStack services (e.g., Ceilometer, [Limes](https://github.com/sapcc/limes)) via dedicated operators.

## Operator Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Modular Operator Architecture                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONTROL PLANE CLUSTER                                                      │
│  ─────────────────────                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    c5c3-operator (Orchestration)                    │    │
│  │                    Namespace: c5c3-system                           │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │  • ControlPlane CRD        • Dependency Graph               │    │    │
│  │  │  • Infrastructure CRs      • Health Aggregation             │    │    │
│  │  │  • Credential Orchestration                                 │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  └──────────────────────────────┬──────────────────────────────────────┘    │
│                                 │                                           │
│                    ┌────────────┼─────────────┐                             │
│                    │   Creates Service CRs    │                             │
│                    ▼            ▼             ▼                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Service Operators (Namespace: openstack)          │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │   │
│  │   │ keystone-   │  │ glance-     │  │ placement-  │                  │   │
│  │   │ operator    │  │ operator    │  │ operator    │                  │   │
│  │   │ Keystone CR │  │ Glance CR   │  │ Placement CR│                  │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘                  │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │   │
│  │   │ nova-       │  │ neutron-    │  │ cinder-     │                  │   │
│  │   │ operator    │  │ operator    │  │ operator    │                  │   │
│  │   │ Nova CR     │  │ Neutron CR  │  │ Cinder CR   │                  │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘                  │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐                                   │   │
│  │   │ cortex-     │  │ tempest-    │  (optional)                       │   │
│  │   │ operator    │  │ operator    │                                   │   │
│  │   │ Cortex CR   │  │ Tempest CR  │                                   │   │
│  │   └─────────────┘  └─────────────┘                                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                 │                                           │
│          ┌──────────────────────┼──────────────────────┐                    │
│          ▼                      ▼                      ▼                    │
│  ┌─────────────┐       ┌─────────────┐        ┌─────────────┐               │
│  │ MariaDB Op  │       │ RabbitMQ Op │        │ Valkey Op   │               │
│  │  (external) │       │  (external) │        │  (external) │               │
│  └─────────────┘       └─────────────┘        └─────────────┘               │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    K-ORC (Namespace: orc-system)                     │   │
│  │                                                                      │   │
│  │   Declarative Keystone Resource Management                           │   │
│  │   (Services, Endpoints, Users, ApplicationCredentials,               │   │
│  │    Domains, Projects, Roles, Groups)                                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    ovn-operator (Namespace: ovn-system)              │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐                                   │   │
│  │   │ OVN         │  │ OVN         │                                   │   │
│  │   │ Northbound  │  │ Southbound  │    neutron-operator connects      │   │
│  │   │ (3x Raft)   │  │ (3x Raft)   │    via ML2/OVN driver             │   │
│  │   └─────────────┘  └──────┬──────┘                                   │   │
│  │                           │                                          │   │
│  └───────────────────────────┼──────────────────────────────────────────┘   │
│                              │ OVSDB Protocol                               │
├──────────────────────────────┼──────────────────────────────────────────────┤
│                              │                                              │
│  HYPERVISOR CLUSTER          ▼                                              │
│  ──────────────────  ┌─────────────┐                                        │
│                      │ ovn-        │  (DaemonSet on each hypervisor node)   │
│                      │ controller  │                                        │
│                      └─────────────┘                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Advantages of modular architecture:**

* **Single Responsibility**: Each operator has exactly one task
* **Independent Releases**: Service-Operator updates without full-stack deployment (see [Upgrade & Lifecycle](../14-upgrades.md))
* **Better Testability**: Isolated unit and integration tests per operator
* **Flexible Scaling**: Deploy only needed operators
* **Clear Ownership**: Dedicated teams per operator possible

***

## C5C3 Operator

**Repository:** `github.com/c5c3/c5c3`
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
│     └── Creates Memcached StatefulSet                           │
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

***

## Keystone Operator

**Repository:** `github.com/c5c3/c5c3/operators/keystone`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **keystone-operator** manages the Keystone Identity Service. Creation of service users and application credentials is done via K-ORC.

**Provided CRDs:**

| CRD        | API Group                             | Description                 |
| ---------- | ------------------------------------- | --------------------------- |
| `Keystone` | `keystone.openstack.c5c3.io/v1alpha1` | Keystone Service Deployment |

**Keystone CRD:**

```yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: keystone
  namespace: openstack
spec:
  replicas: 3

  image:
    repository: ghcr.io/c5c3/keystone
    tag: "28.0.0"

  database:
    secretRef:
      name: keystone-db-credentials
    database: keystone

  cache:
    backend: dogpile.cache.pymemcache
    servers:
      - memcached-0.memcached:11211
      - memcached-1.memcached:11211
      - memcached-2.memcached:11211

  fernet:
    # Fernet Key Rotation
    rotationSchedule: "0 0 * * 0"  # Weekly
    maxActiveKeys: 3

  federation:
    enabled: false

  bootstrap:
    adminUser: admin
    adminPasswordSecretRef:
      name: keystone-admin-credentials
      key: password
    region: RegionOne

status:
  conditions:
    - type: Ready
      status: "True"
    - type: DatabaseReady
      status: "True"
    - type: FernetKeysReady
      status: "True"
  endpoint: https://keystone.openstack.svc.cluster.local:5000
```

> **Note:** The `image.tag` field accepts upstream version tags (e.g., `28.0.0`), patch revision tags (e.g., `28.0.0-p1`), branch tags (e.g., `stable-2025.2`), and commit SHA tags (e.g., `a1b2c3d`). For the full tag schema and versioning details, see [Container Images — Tag Schema](../17-container-images/02-versioning.md#tag-schema).
>
> **Note:** Service users, application credentials, Keystone services, and endpoints are
> not managed by the keystone-operator, but via K-ORC CRs (see [K-ORC](#openstack-resource-controller-k-orc)).

***

## Glance Operator

**Repository:** `github.com/c5c3/c5c3/operators/glance`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **glance-operator** manages the Glance Image Service with Ceph RBD backend.

**Provided CRDs:**

| CRD      | API Group                           | Description               |
| -------- | ----------------------------------- | ------------------------- |
| `Glance` | `glance.openstack.c5c3.io/v1alpha1` | Glance Service Deployment |

**Glance CRD:**

```yaml
apiVersion: glance.openstack.c5c3.io/v1alpha1
kind: Glance
metadata:
  name: glance
  namespace: openstack
spec:
  replicas: 2

  image:
    repository: ghcr.io/c5c3/glance
    tag: "31.0.0"

  database:
    secretRef:
      name: glance-db-credentials
    database: glance

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: glance-keystone-credentials  # Created by ExternalSecret

  storage:
    backend: rbd
    rbd:
      pool: images
      cephSecretRef:
        name: glance-ceph-credentials
      # Reference to CephClient for keys
      cephClientRef:
        name: glance
        namespace: rook-ceph

  # Dependencies via Conditions
  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: DatabaseReady
      status: "True"
    - type: CephConnected
      status: "True"
  endpoint: https://glance.openstack.svc.cluster.local:9292
```

***

## Placement Operator

**Repository:** `github.com/c5c3/c5c3/operators/placement`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **placement-operator** manages the Placement Service for resource inventory and allocation.

**Provided CRDs:**

| CRD         | API Group                              | Description                  |
| ----------- | -------------------------------------- | ---------------------------- |
| `Placement` | `placement.openstack.c5c3.io/v1alpha1` | Placement Service Deployment |

**Placement CRD:**

```yaml
apiVersion: placement.openstack.c5c3.io/v1alpha1
kind: Placement
metadata:
  name: placement
  namespace: openstack
spec:
  replicas: 2

  image:
    repository: ghcr.io/c5c3/placement
    tag: "14.0.0"

  database:
    secretRef:
      name: placement-db-credentials
    database: placement

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: placement-keystone-credentials  # Created by ExternalSecret

  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
  endpoint: https://placement.openstack.svc.cluster.local:8778
```

***

## Nova Operator

**Repository:** `github.com/c5c3/c5c3/operators/nova`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **nova-operator** manages the Nova Compute Control Plane (API, Scheduler, Conductor).

**Provided CRDs:**

| CRD    | API Group                         | Description             |
| ------ | --------------------------------- | ----------------------- |
| `Nova` | `nova.openstack.c5c3.io/v1alpha1` | Nova Service Deployment |

**Nova CRD:**

```yaml
apiVersion: nova.openstack.c5c3.io/v1alpha1
kind: Nova
metadata:
  name: nova
  namespace: openstack
spec:
  api:
    replicas: 3
  scheduler:
    replicas: 2
    # Optional: Cortex External Scheduler
    externalScheduler:
      enabled: false
      endpoint: https://cortex.openstack.svc.cluster.local:8080
  conductor:
    replicas: 2

  image:
    repository: ghcr.io/c5c3/nova
    tag: "32.1.0"

  database:
    secretRef:
      name: nova-db-credentials
    database: nova
    apiDatabase: nova_api
    cellDatabase: nova_cell0

  messaging:
    secretRef:
      name: nova-rabbitmq-credentials
    hosts:
      - rabbitmq-0.rabbitmq:5672
      - rabbitmq-1.rabbitmq:5672
      - rabbitmq-2.rabbitmq:5672

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: nova-keystone-credentials  # Created by ExternalSecret

  # Service-to-Service Authentication
  serviceAuth:
    placementServiceUserRef:
      name: placement
    neutronServiceUserRef:
      name: neutron
    glanceServiceUserRef:
      name: glance
    cinderServiceUserRef:
      name: cinder

  cells:
    - name: cell1
      # Hypervisor Cluster Mapping
      computeRef:
        name: hypervisor-cell1

  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready
    - kind: Placement
      name: placement
      condition: Ready
    - kind: Glance
      name: glance
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: APIReady
      status: "True"
    - type: SchedulerReady
      status: "True"
    - type: ConductorReady
      status: "True"
  endpoint: https://nova.openstack.svc.cluster.local:8774
  cells:
    - name: cell1
      status: Ready
      computeNodes: 42
```

***

## Neutron Operator

**Repository:** `github.com/c5c3/c5c3/operators/neutron`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **neutron-operator** manages the Neutron Networking Control Plane with OVN integration.

**Provided CRDs:**

| CRD       | API Group                            | Description                |
| --------- | ------------------------------------ | -------------------------- |
| `Neutron` | `neutron.openstack.c5c3.io/v1alpha1` | Neutron Service Deployment |

**Neutron CRD:**

```yaml
apiVersion: neutron.openstack.c5c3.io/v1alpha1
kind: Neutron
metadata:
  name: neutron
  namespace: openstack
spec:
  api:
    replicas: 3

  image:
    repository: ghcr.io/c5c3/neutron
    tag: "27.0.1"

  database:
    secretRef:
      name: neutron-db-credentials
    database: neutron

  messaging:
    secretRef:
      name: neutron-rabbitmq-credentials
    hosts:
      - rabbitmq-0.rabbitmq:5672
      - rabbitmq-1.rabbitmq:5672
      - rabbitmq-2.rabbitmq:5672

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: neutron-keystone-credentials  # Created by ExternalSecret

  # OVN Backend Configuration
  ovn:
    enabled: true
    # OVN Northbound/Southbound Cluster (runs in Control Plane Cluster)
    nbConnection: tcp:ovn-nb.ovn-system:6641
    sbConnection: tcp:ovn-sb.ovn-system:6642

  # ML2 Plugin Configuration
  ml2:
    typeDrivers:
      - geneve
      - vlan
      - flat
    tenantNetworkTypes:
      - geneve
    mechanismDrivers:
      - ovn
    extensionDrivers:
      - port_security

  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: OVNConnected
      status: "True"
  endpoint: https://neutron.openstack.svc.cluster.local:9696
```

***

## OVN Operator

**Repository:** `github.com/c5c3/c5c3/operators/ovn`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `ovn-system`

The **ovn-operator** manages the OVN (Open Virtual Network) cluster, which serves as the SDN backend for Neutron. The operator and the OVN Northbound/Southbound databases run in the **Control Plane Cluster**. The ovn-controller DaemonSets run on each hypervisor node.

**Architecture:**

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    OVN Architecture (Cross-Cluster)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONTROL PLANE CLUSTER                                                      │
│  ─────────────────────                                                      │
│                                                                             │
│  ┌─────────────────┐       ┌─────────────────────────────────────────────┐  │
│  │ Neutron API     │       │       ovn-operator                          │  │
│  │ (neutron-op)    │       │       (ovn-system Namespace)                │  │
│  │                 │       │                                             │  │
│  │ ML2/OVN Driver  │◄─────▶│  ┌─────────────────────────┐                │  │
│  │                 │ (6641)│  │  OVN Northbound DB      │                │  │
│  └─────────────────┘       │  │  (3 Replicas, Raft)     │                │  │
│                            │  │  - Network definitions  │                │  │
│                            │  │  - Logical switches     │                │  │
│                            │  │  - Logical routers      │                │  │
│                            │  └────────────┬────────────┘                │  │
│                            │               │                             │  │
│                            │               ▼                             │  │
│                            │  ┌─────────────────────────┐                │  │
│                            │  │  OVN Southbound DB      │                │  │
│                            │  │  (3 Replicas, Raft)     │                │  │
│                            │  │  - Physical bindings    │                │  │
│                            │  │  - Chassis info         │                │  │
│                            │  │  - Port bindings        │                │  │
│                            │  └────────────┬────────────┘                │  │
│                            │               │                             │  │
│                            └───────────────┼─────────────────────────────┘  │
│                                            │                                │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┼─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─         │
│                                            │ OVSDB Protocol (6642)          │
│  HYPERVISOR CLUSTER                        │                                │
│  ──────────────────                        │                                │
│                            ┌───────────────┼───────────────┐                │
│                            │               │               │                │
│                            ▼               ▼               ▼                │
│                       ┌─────────┐    ┌─────────┐    ┌─────────┐             │
│                       │ Node 1  │    │ Node 2  │    │ Node N  │             │
│                       │         │    │         │    │         │             │
│                       │ ovn-    │    │ ovn-    │    │ ovn-    │             │
│                       │controller    │controller    │controller             │
│                       │(DaemonSet)   │(DaemonSet)   │(DaemonSet)            │
│                       │         │    │         │    │         │             │
│                       │ ovs-    │    │ ovs-    │    │ ovs-    │             │
│                       │vswitchd │    │vswitchd │    │vswitchd │             │
│                       └─────────┘    └─────────┘    └─────────┘             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Provided CRDs:**

| CRD          | API Group              | Description               |
| ------------ | ---------------------- | ------------------------- |
| `OVNCluster` | `ovn.c5c3.io/v1alpha1` | OVN Cluster Deployment    |
| `OVNChassis` | `ovn.c5c3.io/v1alpha1` | Chassis/Node Registration |

**OVNCluster CRD:**

```yaml
apiVersion: ovn.c5c3.io/v1alpha1
kind: OVNCluster
metadata:
  name: ovn
  namespace: ovn-system
spec:
  # OVN Image (Upstream project version)
  ovnImage:
    repository: ghcr.io/c5c3/ovn
    tag: "24.03.4"

  # OVS Image (Upstream project version)
  ovsImage:
    repository: ghcr.io/c5c3/ovs
    tag: "3.4.1"

  # Northbound DB Cluster
  northbound:
    replicas: 3
    storage:
      size: 10Gi
      storageClass: local-path
    resources:
      requests:
        memory: 512Mi
        cpu: 250m

  # Southbound DB Cluster
  southbound:
    replicas: 3
    storage:
      size: 10Gi
      storageClass: local-path
    resources:
      requests:
        memory: 512Mi
        cpu: 250m

  # OVN Controller (DaemonSet on all Hypervisor Nodes)
  controller:
    # Runs automatically on all nodes with label
    nodeSelector:
      node-role.kubernetes.io/hypervisor: ""
    resources:
      requests:
        memory: 256Mi
        cpu: 100m

  # OVS (Open vSwitch) DaemonSet
  ovs:
    nodeSelector:
      node-role.kubernetes.io/hypervisor: ""
    resources:
      requests:
        memory: 512Mi
        cpu: 200m

  # Neutron Integration
  neutronIntegration:
    # Endpoint for Neutron ML2/OVN Driver
    nbConnection:
      service:
        name: ovn-nb
        port: 6641
    sbConnection:
      service:
        name: ovn-sb
        port: 6642

  # TLS for OVN Communication
  tls:
    enabled: true
    certSecretRef:
      name: ovn-tls-certs

status:
  conditions:
    - type: Ready
      status: "True"
    - type: NorthboundReady
      status: "True"
    - type: SouthboundReady
      status: "True"
    - type: ControllersReady
      status: "True"
  endpoints:
    northbound: tcp:ovn-nb.ovn-system.svc.cluster.local:6641
    southbound: tcp:ovn-sb.ovn-system.svc.cluster.local:6642
  chassisCount: 42
  activeControllers: 42
```

**OVNChassis CRD (automatically created):**

```yaml
apiVersion: ovn.c5c3.io/v1alpha1
kind: OVNChassis
metadata:
  name: hypervisor-node-01
  namespace: ovn-system
  # OwnerReference to the Node
  ownerReferences:
    - apiVersion: v1
      kind: Node
      name: hypervisor-node-01
spec:
  # Automatically populated from Node information
  hostname: hypervisor-node-01
  systemId: "abc123-def456-..."

  # Bridge Mappings for Provider Networks
  bridgeMappings:
    - physicalNetwork: provider
      bridge: br-provider
    - physicalNetwork: external
      bridge: br-external

  # Encapsulation for Overlay Networks
  encapsulation:
    type: geneve
    ip: 10.0.1.100  # Node IP

status:
  conditions:
    - type: Ready
      status: "True"
    - type: OVSConnected
      status: "True"
  registeredAt: "2024-01-15T10:30:00Z"
  lastHeartbeat: "2024-01-15T12:45:30Z"
```

**Deployment Flow:**

```text
1. FluxCD deploys ovn-operator in Control Plane Cluster
       │
       ▼
2. c5c3-operator creates OVNCluster CR
       │
       ▼
3. ovn-operator creates in Control Plane Cluster:
   ├── OVN Northbound StatefulSet (3 Replicas)
   └── OVN Southbound StatefulSet (3 Replicas)
       │
       ▼
4. FluxCD deploys in Hypervisor Cluster:
   ├── ovn-controller DaemonSet (connects to OVN SB)
   └── ovs-vswitchd DaemonSet
       │
       ▼
5. Neutron (in Control Plane Cluster) connects to OVN NB
   └── Uses nbConnection from OVNCluster Status
```

**Cross-Cluster Integration:**

```yaml
# In Control Plane Cluster: Neutron connects locally to OVN NB/SB
apiVersion: neutron.openstack.c5c3.io/v1alpha1
kind: Neutron
metadata:
  name: neutron
  namespace: openstack
spec:
  ovn:
    enabled: true
    # c5c3-operator synchronizes these values from Hypervisor Cluster
    clusterRef:
      name: hypervisor-cluster-a
      namespace: infrastructure
    # Alternative: Direct endpoints (populated by c5c3-operator)
    nbConnection: tcp:ovn-nb.hypervisor-a.example.com:6641
    sbConnection: tcp:ovn-sb.hypervisor-a.example.com:6642
```

**Key Features:**

* **High Availability**: Raft-based clustering for NB/SB databases
* **Automatic Chassis Discovery**: OVNChassis CRs are automatically created from Kubernetes Nodes
* **Cross-Cluster Ready**: Designed for Control Plane ↔ Hypervisor Cluster separation
* **TLS Support**: Encrypted communication between all OVN components
* **Bridge Mappings**: Automatic configuration of Provider Networks

***

## Cinder Operator

**Repository:** `github.com/c5c3/c5c3/operators/cinder`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **cinder-operator** manages the Cinder Block Storage Control Plane with Ceph RBD backend.

**Provided CRDs:**

| CRD      | API Group                           | Description               |
| -------- | ----------------------------------- | ------------------------- |
| `Cinder` | `cinder.openstack.c5c3.io/v1alpha1` | Cinder Service Deployment |

**Cinder CRD:**

```yaml
apiVersion: cinder.openstack.c5c3.io/v1alpha1
kind: Cinder
metadata:
  name: cinder
  namespace: openstack
spec:
  api:
    replicas: 2
  scheduler:
    replicas: 2

  image:
    repository: ghcr.io/c5c3/cinder
    tag: "27.0.0"

  database:
    secretRef:
      name: cinder-db-credentials
    database: cinder

  messaging:
    secretRef:
      name: cinder-rabbitmq-credentials
    hosts:
      - rabbitmq-0.rabbitmq:5672
      - rabbitmq-1.rabbitmq:5672
      - rabbitmq-2.rabbitmq:5672

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: cinder-keystone-credentials  # Created by ExternalSecret

  # Ceph RBD Backend
  backends:
    - name: ceph-rbd
      driver: cinder.volume.drivers.rbd.RBDDriver
      rbd:
        pool: volumes
        cephSecretRef:
          name: cinder-ceph-credentials
        cephClientRef:
          name: cinder
          namespace: rook-ceph

  # Default Volume Type
  defaultVolumeType: ceph-rbd

  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: CephConnected
      status: "True"
  endpoint: https://cinder.openstack.svc.cluster.local:8776
  backends:
    - name: ceph-rbd
      status: Ready
      availableCapacityGb: 10240
```

***

## Cortex Operator (Optional)

**Repository:** `github.com/c5c3/c5c3/operators/cortex`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **cortex-operator** manages the optional Cortex Intelligent Scheduler for multi-domain resource placement.

**Provided CRDs:**

| CRD      | API Group                 | Description                 |
| -------- | ------------------------- | --------------------------- |
| `Cortex` | `cortex.c5c3.io/v1alpha1` | Cortex Scheduler Deployment |

**Cortex CRD:**

```yaml
apiVersion: cortex.c5c3.io/v1alpha1
kind: Cortex
metadata:
  name: cortex
  namespace: openstack
spec:
  replicas: 2

  image:
    repository: ghcr.io/c5c3/cortex
    tag: "0.5.0"

  # PostgreSQL for Datasource Storage
  database:
    secretRef:
      name: cortex-db-credentials
    database: cortex

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    appCredentialRef:
      name: cortex-app-credential-secret

  # Enabled Pipelines
  pipelines:
    nova:
      enabled: true
      # Filter and Weigher Configuration
      filters:
        - name: AvailabilityZoneFilter
        - name: ComputeCapabilitiesFilter
      weighers:
        - name: RAMWeigher
          weight: 1.0
        - name: CPUWeigher
          weight: 1.0
    cinder:
      enabled: true

  # Datasources
  datasources:
    prometheus:
      enabled: true
      endpoint: http://prometheus.monitoring:9090
    nova:
      enabled: true
      endpoint: https://nova.openstack.svc.cluster.local:8774

  dependsOn:
    - kind: Nova
      name: nova
      condition: Ready
    - kind: Cinder
      name: cinder
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: PipelinesReady
      status: "True"
  endpoint: https://cortex.openstack.svc.cluster.local:8080
  activePipelines:
    - nova
    - cinder
```

**Integration with Nova (External Scheduler Delegation):**

```text
┌─────────────────────────────────────────────────────────────────┐
│                Nova External Scheduler Flow                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Filtering Phase (Nova)                                      │
│     Nova filters possible compute hosts                         │
│                     │                                           │
│                     ▼                                           │
│  2. Weighing Phase (Nova)                                       │
│     Nova ranks remaining hosts                                  │
│                     │                                           │
│                     ▼                                           │
│  3. External Scheduler (Cortex)                                 │
│     POST /scheduler/nova/external                               │
│     Cortex re-ranks with Pipeline logic (KPIs, Knowledges)      │
│                     │                                           │
│                     ▼                                           │
│  4. Scheduling Phase (Nova)                                     │
│     Nova places VM on highest ranked host                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

> **Note:** Cortex is optional and must be explicitly enabled. Detailed Cortex documentation see section [Cortex Scheduling](../08-cortex-scheduling.md).

***

## Tempest Operator (Optional)

**Repository:** `github.com/c5c3/c5c3/operators/tempest`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **tempest-operator** enables recurring OpenStack integration tests with [Tempest](https://github.com/openstack/tempest). It creates CronJobs that automatically execute Tempest test runs against the deployed OpenStack services and provides the results as status in the CR.

**Provided CRDs:**

| CRD       | API Group                            | Description                 |
| --------- | ------------------------------------ | --------------------------- |
| `Tempest` | `tempest.openstack.c5c3.io/v1alpha1` | Tempest Integration Testing |

**Tempest CRD:**

```yaml
apiVersion: tempest.openstack.c5c3.io/v1alpha1
kind: Tempest
metadata:
  name: tempest
  namespace: openstack
spec:
  # CronJob schedule for recurring test runs
  schedule: "0 2 * * *"  # Nightly at 02:00

  image:
    repository: ghcr.io/c5c3/tempest
    tag: "41.0.0"

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    appCredentialRef:
      name: tempest-app-credential-secret

  # Test run configuration
  tests:
    # Services to test
    services:
      - compute
      - network
      - volume
      - image
      - identity
    # Parallel test execution
    concurrency: 4
    # Regex filter for tests
    includeRegex: "tempest\\.(api|scenario)"
    excludeRegex: "tempest\\.api\\..*\\btest_.*slow"

  dependsOn:
    - kind: Nova
      name: nova
      condition: Ready
    - kind: Neutron
      name: neutron
      condition: Ready
    - kind: Cinder
      name: cinder
      condition: Ready
    - kind: Glance
      name: glance
      condition: Ready
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: TestsPassed
      status: "True"
  lastRun: "2024-01-16T02:00:00Z"
  lastDuration: "45m12s"
  results:
    passedTests: 1247
    failedTests: 0
    skippedTests: 23
    totalTests: 1270
```

**Tempest Test Flow:**

```text
┌─────────────────────────────────────────────────────────────────┐
│                    Tempest Test Flow                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Schedule (CronJob)                                          │
│     CronJob triggers test run on schedule                       │
│                     │                                           │
│                     ▼                                           │
│  2. Job (Kubernetes Job)                                        │
│     Tempest container is started                                │
│                     │                                           │
│                     ▼                                           │
│  3. Tests (Tempest Runner)                                      │
│     API and scenario tests against OpenStack services           │
│     ├── Identity (Keystone)                                     │
│     ├── Compute (Nova)                                          │
│     ├── Network (Neutron)                                       │
│     ├── Block Storage (Cinder)                                  │
│     └── Image (Glance)                                          │
│                     │                                           │
│                     ▼                                           │
│  4. Report (Status Update)                                      │
│     Results are stored in Tempest CR status                     │
│     └── passedTests, failedTests, skippedTests, lastRun         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

> **Note:** Tempest is optional and must be explicitly enabled. It requires that all tested OpenStack services are already successfully deployed and Ready.

***


## Labels Injector

**Repository:** `github.com/cobaltcore-dev/labels-injector`
**Runs in:** Hypervisor Cluster (Deployment)

A lightweight Kubernetes controller that **automatically synchronizes labels from Nodes to Pods**. This enables pods to access important infrastructure metadata.

**Synchronized Labels:**

```text
kubernetes.metal.cloud.sap/name      # Node identifier
kubernetes.metal.cloud.sap/cluster   # Cluster affiliation
kubernetes.metal.cloud.sap/bb        # Baremetal block/group
topology.kubernetes.io/region        # Regional topology
topology.kubernetes.io/zone          # Zone topology
```

**Architecture:**

```text
┌───────────────────────────────────────────────────────────────────┐
│                       Labels Injector                             │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌────────────────────────┐    ┌────────────────────────┐         │
│  │  ValidatingWebhook     │    │  Pod Reconciler        │         │
│  │  (Real-time)           │    │  (Background)          │         │
│  │                        │    │                        │         │
│  │  Intercepts:           │    │  Watches: Pods         │         │
│  │  pods/binding          │    │  Reconciles: All Pods  │         │
│  │                        │    │  on Startup            │         │
│  └───────────┬────────────┘    └───────────┬────────────┘         │
│              │                             │                      │
│              └─────────────┬───────────────┘                      │
│                            │                                      │
│                            ▼                                      │
│               ┌─────────────────────────┐                         │
│               │    Label Transfer       │                         │
│               │                         │                         │
│               │  Node Labels ────▶ Pod Labels                     │
│               │  (Strategic Merge Patch)│                         │
│               └─────────────────────────┘                         │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Dual-Injection Mechanism:**

1. **Webhook-based (Real-time)**: ValidatingWebhook on `pods/binding` - injects labels during scheduling
2. **Controller-based (Reconciliation)**: Background synchronization for existing pods

**Configuration:**

* No CRDs required (works with native K8s resources)
* Webhook: `failurePolicy: Ignore` (non-blocking)
* Minimal RBAC: `nodes [get,list,watch]`, `pods [get,list,watch,patch]`

**Use Cases in CobaltCore:**

* Automatic pod metadata propagation without manual configuration
* Topology-aware scheduling (Region/Zone)
* Operational traceability (which pod runs on which physical node)
* Integration with metal cloud management systems

## OpenStack Resource Controller (K-ORC)

**Repository:** `github.com/k-orc/openstack-resource-controller`
**Runs in:** Control Plane Cluster (Deployment)

K-ORC (Kubernetes OpenStack Resource Controller) enables **declarative management of OpenStack resources via Kubernetes CRDs**. It follows the Infrastructure-as-Code pattern and integrates seamlessly into GitOps workflows.

**Supported OpenStack Services (in CobaltCore):**

| Service                 | Resources                                                                    |
| ----------------------- | ---------------------------------------------------------------------------- |
| **Keystone** (Identity) | Domain, Project, Role, Group, Service, Endpoint, User, ApplicationCredential |

**Architecture:**

```text
┌───────────────────────────────────────────────────────────────────┐
│                    K-ORC (Control Plane Cluster)                  │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    K-ORC Manager Pod                        │  │
│  │                    (orc-system Namespace)                   │  │
│  │                                                             │  │
│  │  Reconciliation Controllers:                                │  │
│  │  └── Keystone: Domain, Project, Role, Group, Service,       │  │
│  │               Endpoint, User, ApplicationCredential         │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│                              │ Gophercloud SDK                    │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │             Keystone Identity API                           │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Key Features:**

* **8 CRD types** for declarative Keystone resource management
* **Management Policies**: `managed` (full lifecycle) or `unmanaged` (read-only import)
* **Import existing resources** via filters (Name, Tags, ID)
* **Credential Management** via `clouds.yaml` in Kubernetes Secrets
* **Dependency Management**: Automatic ordering (e.g., Network before Subnet)
* **Finalizers**: Safe deletion with cleanup in OpenStack

**Credential Management for K-ORC:**

K-ORC requires a `clouds.yaml` secret for authentication against OpenStack APIs.
The c5c3-operator creates K-ORC ApplicationCredential CRs. K-ORC creates the
Application Credentials in Keystone and writes the result to a Kubernetes Secret.
A PushSecret writes this secret to OpenBao, from where it's provided via ESO in the target namespace:

```yaml
# PushSecret: K-ORC Application Credential → OpenBao
# Watches the Secret written by K-ORC and pushes it to OpenBao
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: k-orc-app-credential
  namespace: openstack
spec:
  secretStoreRefs:
    - name: openbao-cluster-store
      kind: ClusterSecretStore
  selector:
    secret:
      name: k-orc-app-credential  # Written by K-ORC
  data:
    - match:
        secretKey: clouds.yaml
        remoteRef:
          remoteKey: kv-v2/data/openstack/k-orc/app-credential
          property: clouds.yaml

---
# ExternalSecret: OpenBao → k-orc-clouds-yaml in orc-system
# Reads the Application Credential from OpenBao and creates the
# Secret that K-ORC mounts as clouds.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: k-orc-clouds-yaml
  namespace: orc-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-cluster-store
    kind: ClusterSecretStore
  target:
    name: k-orc-clouds-yaml
    creationPolicy: Owner  # ESO owns the lifecycle of this Secret
  data:
    - secretKey: clouds.yaml
      remoteRef:
        key: kv-v2/data/openstack/k-orc/app-credential
        property: clouds.yaml
```

The resulting Kubernetes Secret in `orc-system` (created and managed by ESO):

```yaml
# Auto-generated by ESO — do not edit manually
apiVersion: v1
kind: Secret
metadata:
  name: k-orc-clouds-yaml
  namespace: orc-system
  # Owned by ExternalSecret (ESO manages lifecycle)
  ownerReferences:
    - apiVersion: external-secrets.io/v1beta1
      kind: ExternalSecret
      name: k-orc-clouds-yaml
type: Opaque
data:
  clouds.yaml: |
    clouds:
      openstack:
        auth_type: v3applicationcredential
        auth:
          auth_url: https://identity.example.com
          application_credential_id: "abc123..."
          application_credential_secret: "xyz789..."
        region_name: RegionOne
```

**Example: Create Keystone Project:**

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Project
metadata:
  name: customer-project
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml  # References generated secret
  managementPolicy: managed
  resource:
    description: "Customer project"
    enabled: true
    tags: ["customer-a", "production"]
```

> **Note:** The `cloudCredentialsRef.secretName` references a secret provided via the
> path K-ORC → PushSecret → OpenBao → ESO. Credentials are
> automatically rotated via the `CredentialRotation` CRD.

**Use Cases in CobaltCore:**

* Declarative management of Keystone services, endpoints, and users
* Automated provisioning of service accounts and application credentials
* Declarative management of Keystone domains, projects, and roles
* GitOps integration for Identity-as-Code
* Multi-tenant setup with reproducible configurations

**Management Policies:**

* **`managed`**: K-ORC creates, updates, and deletes the OpenStack resource (full lifecycle).
  Finalizers prevent Kubernetes deletion until the OpenStack resource is removed.
  Use for: All bootstrap resources, new service registrations.

* **`unmanaged`**: K-ORC imports an existing OpenStack resource as read-only via filters (name, tags, ID).
  K-ORC does not modify or delete the resource. Status reflects the external state.
  Use for: Brownfield deployments (see [Brownfield Integration](../16-brownfield-integration.md)), shared resources managed by other tools.

**Deployment (HelmRelease):**

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: k-orc
  namespace: flux-system
spec:
  interval: 1h
  url: https://k-orc.github.io/openstack-resource-controller

---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: openstack-resource-controller
  namespace: orc-system
spec:
  interval: 30m
  chart:
    spec:
      chart: openstack-resource-controller
      version: ">=0.1.0"
      sourceRef:
        kind: HelmRepository
        name: k-orc
        namespace: flux-system
  values:
    # clouds.yaml Secret — provided via OpenBao + ESO
    globalCloudConfig:
      secretName: k-orc-clouds-yaml  # Created by ExternalSecret from OpenBao
  install:
    crds: CreateReplace
  upgrade:
    crds: CreateReplace
```

**Bootstrap Resources (Chicken-and-Egg Problem):**

The Keystone Bootstrap Job creates foundational resources (Admin User, Default Domain,
Service Project, Roles) directly via the Keystone API — before K-ORC has credentials.
These resources must be **imported into K-ORC** (`managementPolicy: unmanaged`) so that
K-ORC can reference them when creating dependent resources (Services, Endpoints, Users).

When `spec.korc.bootstrapResources` is configured in the ControlPlane CR, the c5c3-operator
creates K-ORC CRs with `managementPolicy: unmanaged` to import existing bootstrap resources:

* **domains**: Default domain (created by Keystone Bootstrap Job)
* **projects**: Service project, admin project (created by Keystone Bootstrap Job)

Only after these imports are visible in K-ORC can the c5c3-operator create new resources
(Services, Endpoints, Service Users, Application Credentials) with `managementPolicy: managed`.

**Troubleshooting:**

Common issues and diagnostic commands:

| Issue | Diagnostic | Resolution |
| ----- | ---------- | ---------- |
| K-ORC cannot reach Keystone | `kubectl logs -n orc-system -l app=openstack-resource-controller` | Verify `clouds.yaml` secret and Keystone endpoint |
| `clouds.yaml` secret missing | `kubectl get secret k-orc-clouds-yaml -n orc-system` | Check ESO/PushSecret pipeline |
| Service already exists | Check K-ORC CRD status conditions | Use `managementPolicy: unmanaged` to import |
| CRD stuck in Creating | `kubectl describe <crd-kind> <name> -n openstack` | Check dependency ordering and Keystone availability |

## Infrastructure Service Operators

**Runs in:** Control Plane Cluster
**Deployment:** Via FluxCD (HelmRelease)
**Instance Creation:** By c5c3-operator (creates CRs)

The OpenStack Control Plane requires several infrastructure services as backend. The **Operators** are deployed separately via FluxCD, while the **c5c3-operator** creates and manages the corresponding **Custom Resources** (instances).

```text
┌───────────────────────────────────────────────────────────────────┐
│           Infrastructure Services (Control Plane Cluster)         │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  FluxCD deployed Operators:                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │
│  │   MariaDB   │  │   Valkey    │  │  RabbitMQ   │                │
│  │  Operator   │  │  Operator   │  │  Operator   │                │
│  │ (HelmRelease│  │ (HelmRelease│  │ (HelmRelease│                │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                │
│         │                │                │                       │
│         │  watched CRs   │  watched CRs   │  watched CRs          │
│         │                │                │                       │
│  c5c3-operator creates CRs:                                       │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────────┐  │
│  │   MariaDB   │  │   Valkey    │  │  RabbitMQ   │  │Memcached │  │
│  │     CR      │  │     CR      │  │     CR      │  │StatefulS.│  │
│  │             │  │             │  │             │  │          │  │
│  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │  │┌────────┐│  │
│  │ │ Galera  │ │  │ │Sentinel │ │  │ │ Cluster │ │  ││Replicas││  │
│  │ │ Cluster │ │  │ │+ Valkey │ │  │ │  Nodes  │ │  │└────────┘│  │
│  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │  │          │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └────┬─────┘  │
│         │                │                │              │        │
│         └────────────────┴────────────────┴──────────────┘        │
│                                   │                               │
│                                   ▼                               │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │      OpenStack Services (via dedicated Service-Operators)   │  │
│  │  Nova, Neutron, Keystone, Glance, Cinder, Placement         │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## MariaDB Operator

**Repository:** `github.com/mariadb-operator/mariadb-operator`
**License:** MIT

The MariaDB Operator enables declarative management of MariaDB clusters with high availability.

**Key Features:**

* **Galera Clustering**: Synchronous multi-master replication
* **MaxScale Integration**: Proxy, load balancing, automatic failover
* **Backup & Restore**: mariadb-backup, mariadb-dump, S3-compatible backends
* **Point-in-Time Recovery**: Restore to specific point in time
* **TLS**: Integrated cert-manager support
* **Monitoring**: mysqld-exporter for Prometheus

**Example:**

```yaml
apiVersion: k8s.mariadb.com/v1alpha1
kind: MariaDB
metadata:
  name: openstack-db
spec:
  replicas: 3
  galera:
    enabled: true
  maxScale:
    enabled: true
    replicas: 2
  storage:
    size: 100Gi
    storageClassName: ceph-rbd
  metrics:
    enabled: true
```

## Valkey Operator (SAP)

**Repository:** `github.com/SAP/valkey-operator`
**Helm Chart:** `github.com/SAP/valkey-operator-helm`
**License:** Apache 2.0

The Valkey Operator (SAP) enables declarative Valkey deployments with Sentinel-based failover via a single `Valkey` CRD.

**Key Features:**

* **Sentinel Mode**: Automatic failover with Sentinel sidecars
* **Primary-Replica Mode**: Static topology without Sentinel
* **TLS**: Self-signed or cert-manager integration
* **AOF Persistence**: Configurable StorageClasses (immutable after creation)
* **Monitoring**: redis-exporter sidecar (Port 9121) with ServiceMonitor/PrometheusRule
* **Binding Secret**: Automatic generation of connection information

**Example (Sentinel Mode for OpenStack):**

```yaml
apiVersion: cache.cs.sap.com/v1alpha1
kind: Valkey
metadata:
  name: openstack-valkey
spec:
  replicas: 3
  sentinel:
    enabled: true
  tls:
    enabled: true
  metrics:
    enabled: true
    monitor:
      enabled: true
```

## RabbitMQ Cluster Operator

**Repository:** `github.com/rabbitmq/cluster-operator`
**License:** MPL-2.0 (official from Broadcom/VMware)

The official RabbitMQ Operator for Kubernetes with comprehensive lifecycle management.

**Key Features:**

* **Cluster Formation**: Automatic cluster creation and management
* **Graceful Upgrades**: Rolling updates without downtime
* **Policies & Users**: Declarative configuration via CRDs
* **Observability**: Integrated monitoring and logging
* **TLS**: Encrypted communication

**Example:**

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: openstack-rabbitmq
spec:
  replicas: 3
  resources:
    requests:
      memory: 2Gi
      cpu: 1000m
  persistence:
    storageClassName: ceph-rbd
    storage: 50Gi
  rabbitmq:
    additionalConfig: |
      cluster_partition_handling = pause_minority
```

## Memcached (StatefulSet)

**Note:** There is no mature production-ready operator for Memcached. Instead, a simple StatefulSet or Deployment is used. Memcached uses the upstream Docker Hub image (`memcached:1.6`) directly — infrastructure services like Memcached, MariaDB, RabbitMQ, and Valkey are not built by C5C3 (see [Container Images](../17-container-images/#container-registry)).

**Alternatives:**

* **KubeDB**: Commercial operator with Day-2-Operations (Backup, Upgrades, TLS)
* **StatefulSet**: Simple deployment strategy without operator overhead

**Example (StatefulSet):**

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: openstack-memcached
spec:
  serviceName: memcached
  replicas: 3
  selector:
    matchLabels:
      app: memcached
  template:
    spec:
      containers:
      - name: memcached
        image: memcached:1.6
        args: ["-m", "1024", "-c", "4096"]
        ports:
        - containerPort: 11211
        resources:
          requests:
            memory: 1Gi
            cpu: 500m
```

## Operator Reference

**OpenStack Service Operators:**

| Operator               | CRD                  | API Group                              | Description                      |
| ---------------------- | -------------------- | -------------------------------------- | -------------------------------- |
| **c5c3-operator**      | `ControlPlane`       | `c5c3.io/v1alpha1`                     | Orchestration, Dependencies      |
|                        | `SecretAggregate`    | `c5c3.io/v1alpha1`                     | Secret Aggregation               |
|                        | `CredentialRotation` | `c5c3.io/v1alpha1`                     | Credential Lifecycle             |
| **keystone-operator**  | `Keystone`           | `keystone.openstack.c5c3.io/v1alpha1`  | Identity Service                 |
| **glance-operator**    | `Glance`             | `glance.openstack.c5c3.io/v1alpha1`    | Image Service                    |
| **placement-operator** | `Placement`          | `placement.openstack.c5c3.io/v1alpha1` | Resource Tracking                |
| **nova-operator**      | `Nova`               | `nova.openstack.c5c3.io/v1alpha1`      | Compute Service                  |
| **neutron-operator**   | `Neutron`            | `neutron.openstack.c5c3.io/v1alpha1`   | Network Service                  |
| **ovn-operator**       | `OVNCluster`         | `ovn.c5c3.io/v1alpha1`                 | OVN SDN Backend (Control Plane)  |
|                        | `OVNChassis`         | `ovn.c5c3.io/v1alpha1`                 | Chassis/Node Registration        |
| **cinder-operator**    | `Cinder`             | `cinder.openstack.c5c3.io/v1alpha1`    | Block Storage                    |
| **cortex-operator**    | `Cortex`             | `cortex.c5c3.io/v1alpha1`              | Intelligent Scheduler (optional) |
| **tempest-operator**   | `Tempest`            | `tempest.openstack.c5c3.io/v1alpha1`   | Integration Testing (optional)   |

**Infrastructure Service Operators:**

| Service       | Operator                  | License    | HA Mode                  | Maturity   |
| ------------- | ------------------------- | ---------- | ------------------------ | ---------- |
| **MariaDB**   | mariadb-operator          | MIT        | Galera + MaxScale        | Production |
| **Valkey**    | valkey-operator (SAP)     | Apache 2.0 | Sentinel/Primary-Replica | Production |
| **RabbitMQ**  | cluster-operator          | MPL-2.0    | Native Clustering        | Production |
| **Memcached** | StatefulSet (no Operator) | -          | DNS-based                | Stable     |

## OpenStack Service Dependencies

Representative dependencies of currently integrated services. Additional services use the same Infrastructure Operators:

| OpenStack Service | MariaDB | RabbitMQ | Valkey | Memcached       |
| ----------------- | ------- | -------- | ------ | --------------- |
| **Keystone**      | ✓       | -        | -      | ✓ (Token Cache) |
| **Nova**          | ✓       | ✓        | -      | -               |
| **Neutron**       | ✓       | ✓        | -      | -               |
| **Glance**        | ✓       | -        | -      | -               |
| **Cinder**        | ✓       | ✓        | -      | -               |
| **Placement**     | ✓       | -        | -      | -               |
| **Tempest**       | -       | -        | -      | -               |

***
