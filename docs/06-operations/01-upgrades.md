# Upgrades

## Versioning Strategy

CobaltCore uses **upstream project versions** as image tags, not the OpenStack release series. The current version table and tag schema are documented in [Container Images — Container Registry](../08-container-images/index.md#container-registry). For details on branch strategy and automated updates, see [Container Images — Versioning](../08-container-images/02-versioning.md).

**OpenStack Release Cadence:**

* OpenStack releases biannually: **YYYY.1** (Spring) and **YYYY.2** (Fall)
* Each project has its own SemVer versioning (e.g., Nova 32.x.x)
* **SLURP** (Skip Level Upgrade Release Process): Every second release is SLURP-compatible, enabling annual upgrade cycles (SLURP-to-SLURP)

```text
Releases:    2024.2    2025.1    2025.2    2026.1    2026.2
             (SLURP)             (SLURP)             (SLURP)
                │                   │                   │
                └───────────────────┘                   │
                  Skip-Level possible                   │
                                    └───────────────────┘
                                      Skip-Level possible
```

**CobaltCore Operator Versioning:**

* c5c3-operator and Service-Operators use SemVer
* FluxCD HelmReleases define SemVer ranges (e.g., `>=0.1.0`)
* CRD API Versions: Currently all `v1alpha1`

## Upgrade Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          UPGRADE ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    MANAGEMENT CLUSTER                               │    │
│  │                                                                     │    │
│  │   Git Push ──▶ FluxCD ──▶ HelmRelease Reconciliation                │    │
│  │                  │                                                  │    │
│  │                  │  1. Operator Chart Update                        │    │
│  │                  │  2. CRD Update (CreateReplace)                   │    │
│  │                  │  3. Remediation on Error (retries: 3)            │    │
│  │                  ▼                                                  │    │
│  └──────────────────┼──────────────────────────────────────────────────┘    │
│                     │                                                       │
│  ┌──────────────────▼──────────────────────────────────────────────────┐    │
│  │                    CONTROL PLANE CLUSTER                            │    │
│  │                                                                     │    │
│  │   ┌───────────────┐    ┌───────────────────────────────────────┐    │    │
│  │   │ c5c3-operator │───▶│ Service CR Update (image.tag)         │    │    │
│  │   └───────────────┘    └──────────────┬────────────────────────┘    │    │
│  │                                       │                             │    │
│  │                          ┌────────────▼──────────────┐              │    │
│  │                          │ Service-Operator Reconcile│              │    │
│  │                          │                           │              │    │
│  │                          │  1. DB Schema Migration   │              │    │
│  │                          │  2. Config Update         │              │    │
│  │                          │  3. Rolling Update Pods   │              │    │
│  │                          │  4. Health Check          │              │    │
│  │                          └───────────────────────────┘              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    HYPERVISOR CLUSTER                               │    │
│  │                                                                     │    │
│  │   DaemonSet Updates: ovn-controller, OVS, Nova Compute Agent        │    │
│  │   Strategy: RollingUpdate (maxUnavailable: 1)                       │    │
│  │   Coordination with VM Live Migration when needed                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## OpenStack Service Upgrade

### Upgrade Flow per Service

Each Service-Operator automatically performs the following steps during an upgrade:

```text
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Image Tag   │    │  DB Schema   │    │   Config     │    │   Rolling    │
│  Update in   │───▶│  Migration   │───▶│   Rendering  │───▶│   Update     │
│  Service CR  │    │  (db-sync)   │    │   (ConfigMap)│    │   API Pods   │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
       │                   │                   │                   │
       ▼                   ▼                   ▼                   ▼
  Git Commit or      Job: <service>       New ConfigMap       Deployment
  c5c3-operator      -manage db sync      with updated        RollingUpdate
  modifies CR        Expand + Contract    configuration       maxUnavailable: 1
```

1. **Image Tag Update**: The `image.tag` field in the Service CR is updated (either directly or by the c5c3-operator)
2. **DB Schema Migration**: The operator starts a `db-sync` job with the new image. This executes Alembic migrations (Expand/Contract pattern)
3. **Config Rendering**: The ConfigMap with the service configuration is updated if needed
4. **Rolling Update**: The API/Worker Pods are updated with the new image and configuration via Rolling Update

### Patch Revision Upgrades

In addition to upstream version upgrades, CobaltCore supports **patch revision upgrades** — rebuilds of the same upstream version with additional patches applied. Patch revisions use the tag format `<upstream-version>-p<N>` (e.g., `28.0.0-p1`).

A patch revision upgrade follows the same flow as a regular upgrade (image tag update → db-sync → rolling update), but typically only the rolling update is needed since the database schema does not change between patch revisions.

```text
28.0.0  →  28.0.0-p1  →  28.0.0-p2    (patch revisions, same upstream code)
28.0.0  →  29.0.0                       (upstream version upgrade)
```

For details on how patch revisions are created and when they are used, see [Container Images — Patching](../08-container-images/03-patching.md).

### DB Schema Migration (db-sync)

Each OpenStack service uses Alembic for database migrations:

| Service   | DB-Sync Command                                                          | Databases                        |
| --------- | ------------------------------------------------------------------------ | -------------------------------- |
| Keystone  | `keystone-manage db_sync`                                                | `keystone`                       |
| Nova      | `nova-manage api_db sync` + `nova-manage db sync`                        | `nova_api`, `nova`, `nova_cell0` |
| Neutron   | `neutron-db-manage upgrade heads`                                        | `neutron`                        |
| Glance    | `glance-manage db_sync`                                                  | `glance`                         |
| Cinder    | `cinder-manage db sync`                                                  | `cinder`                         |
| Placement | `placement-manage db sync` (no dedicated DB migration for minor updates) | `placement`                      |

**Expand/Contract Pattern:**

* **Expand**: New columns/tables are added (backward compatible, old pods continue to work)
* **Contract**: Old columns/tables are removed (only after rolling update of all pods)
* Some services (Nova, Neutron) support `--expand` and `--contract` flags for controlled migrations

**Nova Cell Database Migration:**

```text
nova-manage api_db sync          # API DB first
nova-manage db sync              # Cell0 and Cell1 DBs
nova-manage db online_data_migrations  # Online migrations (no downtime)
```

### Service Upgrade Order

The order for an OpenStack release upgrade:

```text
Phase 1: Keystone (Identity)
    │     Must be updated first (all services depend on it)
    ▼
Phase 2: Glance (Image) + Placement (Resource Tracking)
    │     Can be updated in parallel
    ▼
Phase 3: Nova (Compute)
    │     Depends on Keystone, Glance, Placement
    ▼
Phase 4: Neutron (Network)
    │     Depends on Keystone
    ▼
Phase 5: Cinder (Block Storage)
    │     Depends on Keystone
    ▼
Phase 6: Hypervisor Agents
          Nova Compute Agent, ovn-controller
```

The c5c3-operator enforces this order through its dependency management:

* Service CRs have `dependencies` with required conditions (e.g., Nova requires Keystone `Ready`)
* The operator only updates Service CRs when dependencies have `Ready` status

### Rolling Update Strategy for API Pods

| Service        | Replicas | maxUnavailable | maxSurge | Expected Downtime |
| -------------- | -------- | -------------- | -------- | ----------------- |
| Keystone API   | 3        | 1              | 1        | None (HA)         |
| Glance API     | 3        | 1              | 1        | None (HA)         |
| Placement API  | 3        | 1              | 1        | None (HA)         |
| Nova API       | 3        | 1              | 1        | None (HA)         |
| Nova Scheduler | 2        | 1              | 1        | None (HA)         |
| Nova Conductor | 2        | 1              | 1        | None (HA)         |
| Neutron API    | 3        | 1              | 1        | None (HA)         |
| Cinder API     | 3        | 1              | 1        | None (HA)         |

All API services run with at least 3 replicas. Through rolling updates with `maxUnavailable: 1`, the service remains reachable during the upgrade.

## Infrastructure Upgrades

### MariaDB Galera

MariaDB is managed by the **MariaDB Operator**. Upgrades follow the Galera protocol:

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Node 1     │    │  Node 2     │    │  Node 3     │
│  (Primary)  │    │  (Replica)  │    │  (Replica)  │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       │  1. Node 3 is updated               │
       │                  │            ┌─────▼─────┐
       │                  │            │  Upgrade  │
       │                  │            │  + Rejoin │
       │                  │            └─────┬─────┘
       │                  │                  │
       │  2. Node 2 is updated               │
       │            ┌─────▼─────┐            │
       │            │  Upgrade  │            │
       │            │  + Rejoin │            │
       │            └─────┬─────┘            │
       │                  │                  │
       │  3. Node 1 (Primary) last           │
 ┌─────▼─────┐            │                  │
 │  Upgrade  │  Failover to Node 2/3         │
 │  + Rejoin │            │                  │
 └─────┬─────┘            │                  │
       │                  │                  │
       ▼                  ▼                  ▼
    Cluster synchronized (IST/SST)
```

**Important:**

* MaxScale Proxy handles failover automatically
* Galera requires sequential node upgrades (no parallel upgrades)
* During upgrade, at least 2 of 3 nodes must be available
* IST (Incremental State Transfer) for brief outages, SST (State Snapshot Transfer) for longer ones

**MariaDB Major Version Upgrade:**

* MariaDB major upgrades (e.g., 10.11 → 11.4) require special care
* `mysql_upgrade` must be executed after the upgrade
* The MariaDB Operator controls this via `spec.image` and `spec.updateStrategy`

### RabbitMQ

The **RabbitMQ Cluster Operator** supports rolling upgrades:

* Sequential pod upgrade (one node at a time)
* Automatic Partition Handling (`pause_minority`)
* Queue mirroring ensures availability during the upgrade
* Quorum Queues: Raft-based replication, tolerates failure of one node

**Limitations:**

* RabbitMQ does not support skip-level upgrades (always version by version)
* Erlang/OTP version must be compatible

### Valkey Sentinel

The **Valkey Operator** (SAP) manages Valkey Sentinel upgrades:

* Sentinel sidecars monitor the primary and initiate failover when needed
* Rolling update of replicas first, then the primary
* Sentinel detects the new primary automatically

### Memcached

The **memcached-operator** manages Memcached upgrades:

* Update the `image` field in the `Memcached` CR to trigger a rolling update
* The operator performs a controlled rollout of the new Deployment
* PodDisruptionBudgets (when configured) ensure minimum availability during rollout
* Memcached is a pure cache — data loss on restart is acceptable
* No state transfer required, pods start with empty cache

## Network Upgrades (OVN/OVS)

### OVN Upgrade

OVN consists of multiple components running in different clusters:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                     OVN UPGRADE ORDER                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONTROL PLANE CLUSTER:                                                     │
│                                                                             │
│  1. OVN Northbound DB (3x Raft)         ──▶ Schema migration automatic      │
│  2. OVN Southbound DB (3x Raft)         ──▶ Schema migration automatic      │
│                                                                             │
│  HYPERVISOR CLUSTER:                                                        │
│                                                                             │
│  3. ovn-controller (DaemonSet)           ──▶ RollingUpdate maxUnavailable:1 │
│                                                                             │
│  4. OVS (DaemonSet)                      ──▶ RollingUpdate maxUnavailable:1 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**OVN NB/SB Database Schema:**

* OVN has its own OVSDB schemas that change between versions
* Schema migration happens automatically on startup of the new version
* Raft consensus ensures all replicas are in sync
* During migration, new ports temporarily cannot be created

**Version Skew Tolerance:**

* OVN Northbound/Southbound must have the same version
* ovn-controller can be one minor version behind the NB/SB DBs
* OVS can be updated independently from OVN (within the compatibility matrix)

### ovn-controller DaemonSet Upgrade

The ovn-controller runs on each hypervisor node. During DaemonSet rolling update:

* `maxUnavailable: 1` — only one node at a time
* Existing flows remain active (OVS retains programmed flows)
* New flows cannot be programmed during controller restart
* Typical interruption: \< 10 seconds per node
* Running VM traffic is not affected (flows already in OVS)

### OVS Upgrade on Hypervisor Nodes

OVS upgrades require special care as they affect the network datapath:

* DaemonSet rolling update with `maxUnavailable: 1`
* ovs-vswitchd restart: Brief datapath interruption (\< 1 second with DPDK)
* Bridge configurations and flows are restored after restart
* If needed: Coordination with Hypervisor Maintenance mode for VM migration before OVS upgrade

### LibVirt/Hypervisor Backend Upgrade

LibVirt and the hypervisor backend (QEMU/KVM or Cloud Hypervisor) form the virtualization layer on the hypervisor nodes. The upgrade procedure depends on the operating model (see [Hypervisor Components](../03-components/02-hypervisor.md)):

**Model 1: GardenLinux-provided**

LibVirt is part of the GardenLinux OS image. An upgrade is coupled to the OS upgrade:

```text
Gardener Rolling Update
       │
       ▼
Hypervisor Maintenance Mode (Scheduling Stop)
       │
       ▼
VM Live Migration (all VMs to other nodes)
       │
       ▼
Node Reboot with new GardenLinux Image (incl. new LibVirt/hypervisor backend version)
       │
       ▼
Re-Enable (Hypervisor is reactivated in Nova)
```

**Model 2: c5c3-managed**

LibVirt runs as a containerized DaemonSet. An upgrade occurs via DaemonSet rolling update:

* `maxUnavailable: 1` — only one node at a time
* **Important:** Before `libvirtd` restart, all running VMs must be migrated from the node (VM quiescence)
* The Hypervisor Operator coordinates this automatically via Maintenance mode

**Coordination with Hypervisor Maintenance Mode:**

In both models, the hypervisor must be put into Maintenance mode before `libvirtd` restart (see [Hypervisor Lifecycle](../04-architecture/03-hypervisor-lifecycle.md)). Running VMs must be migrated before the LibVirt daemon restart, as a `libvirtd` restart interrupts the connection to VM processes (QEMU or Cloud Hypervisor).

**LibVirt Version Tracking:**

The current LibVirt version of each node is captured by the Hypervisor Node Agent in the Hypervisor CRD status (`libVirtVersion`). This enables:

* Monitoring LibVirt versions across all hypervisor nodes
* Detection of version skew between nodes
* Validation of minimum version during onboarding (Testing phase)

## Operator Upgrades

### c5c3-operator Upgrade

The c5c3-operator is updated via FluxCD HelmRelease:

```yaml
spec:
  chart:
    spec:
      version: ">=0.1.0"    # SemVer Range
  install:
    crds: CreateReplace
  upgrade:
    crds: CreateReplace      # CRDs are automatically updated
```

**Flow:**

1. New Helm chart is pushed to Git or available in HelmRepository
2. FluxCD detects new version (within SemVer range)
3. CRDs are updated (`CreateReplace`)
4. Operator Deployment is updated (Rolling Update)
5. New operator instance takes over via Leader Election
6. Reconciliation of existing CRs with the new operator logic

**Leader Election during Upgrade:**

* The old pod releases the leader lock
* The new pod acquires the leader lock
* Brief pause in reconciliation (typically \< 30 seconds)
* No impact on running OpenStack services

### Service-Operator Upgrades

Each Service-Operator (keystone-operator, nova-operator, etc.) is updated independently:

* FluxCD HelmRelease per operator
* SemVer ranges for controlled upgrades
* CRD updates via `CreateReplace`
* `remediation.retries: 3` for automatic retry on errors

**Independence of Operator Upgrades:**

* Service-Operators can be updated individually
* No dependency between operator versions (except to c5c3-operator)
* Existing CRs remain functional even when the operator is updated

### CRD API Version Evolution

All CobaltCore CRDs are currently `v1alpha1`. The planned evolution:

| Phase     | API Version | Meaning                                             |
| --------- | ----------- | --------------------------------------------------- |
| Current   | `v1alpha1`  | Unstable API, breaking changes possible             |
| Future    | `v1beta1`   | Stable API, no breaking changes without deprecation |
| Long-term | `v1`        | Stable API, long-term compatibility                 |

**During API Version Migration:**

* Conversion Webhooks translate between old and new API versions
* Storage Version Migration updates stored objects in etcd
* Old API versions are maintained for at least one release series

## Cross-Cluster Upgrade Coordination

The four clusters can fundamentally be updated independently, with the following constraints:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                   CROSS-CLUSTER UPGRADE ORDER                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 1: Management Cluster                                                │
│           Flux Operator, FluxCD, OpenBao, ESO, Greenhouse                   │
│           ──▶ Must be first, as it's the GitOps source for all others       │
│                                                                             │
│  Phase 2: Control Plane Cluster                                             │
│           Operators, OpenStack APIs, Infrastructure                         │
│           ──▶ After Management, before Hypervisor                           │
│                                                                             │
│  Phase 3: Hypervisor Cluster                                                │
│           Node Agents, ovn-controller, OVS, Nova Compute                    │
│           ──▶ After Control Plane (keep agent versions compatible)          │
│                                                                             │
│  Phase 4: Storage Cluster (only own infrastructure)                         │
│           Prysm, External Arbiter Operator                                  │
│           ──▶ Independent of Phase 2-3                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Critical Dependencies:**

* **Management → all**: OpenBao must be reachable (ESO Secret Sync)
* **Control Plane → Hypervisor**: Nova API version must be compatible with Nova Compute Agent
* **Control Plane → Hypervisor**: OVN NB/SB version must be compatible with ovn-controller
* **Control Plane → Storage**: Cinder API must be compatible with RBD client libraries

**Flux Operator Upgrade:**

The Flux Operator itself is updated as a HelmRelease. The operator then automatically manages the FluxCD version according to the SemVer range defined in the `FluxInstance` (e.g., `2.x`). Manual re-bootstrap is not necessary.

**FluxCD Reconciliation during Upgrades:**

* FluxCD runs in the Management Cluster and deploys to all clusters
* For cross-cluster upgrades: `flux suspend kustomization <name>` for targeted control
* After completion: `flux resume kustomization <name>`

<!-- TODO: Add link to a runbook or operational guide for cross-cluster upgrade procedures once available -->
