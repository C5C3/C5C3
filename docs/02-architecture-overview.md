# Architecture Overview

CobaltCore is based on a **multi-cluster architecture** with four separate Kubernetes clusters, each fulfilling specific tasks and provisioned differently:

## Cluster Overview and Provisioning

| Cluster                   | Function               | Provisioning        | Infrastructure           |
| ------------------------- | ---------------------- | ------------------- | ------------------------ |
| **Management Cluster**    | Observability & UI     | Gardener            | On-Premises              |
| **Control Plane Cluster** | Orchestration          | Gardener            | On-Premises              |
| **Hypervisor Cluster**    | Compute Virtualization | IronCore → Gardener | On-Premises (Bare-Metal) |
| **Storage Cluster**       | Persistent Storage     | IronCore → Gardener | On-Premises (Bare-Metal) |

Consumers (tenants) provision OpenStack environments through [Crossplane](./12-crossplane/), which provides a self-service API on the Management Cluster.

## Provisioning Hierarchy

```text
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                      GARDENER                                       │
│                    (Kubernetes Cluster Lifecycle Management)                        │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  Responsibilities:                                                                  │
│  • Kubernetes Cluster Provisioning & Lifecycle for ALL Clusters                     │
│  • Kubernetes Version Upgrades                                                      │
│  • Node Pool Management & Auto-Scaling                                              │
│  • Cluster Health Monitoring                                                        │
│                                                                                     │
├─────────────────────────────┬───────────────────────────────────────────────────────┤
│                             │                                                       │
│  GARDENER CLUSTER           │  BAREMETAL CLUSTER                                    │
│  (On-Premises)              │                                                       │
│                             │  ┌─────────────────────────────────────────────┐      │
│  ┌───────────────────────┐  │  │                  IronCore                   │      │
│  │   Management Cluster  │  │  │        (Bare-Metal Provisioning)            │      │
│  │   ─────────────────   │  │  ├─────────────────────────────────────────────┤      │
│  │   • Flux Operator     │  │  │                                             │      │
│  │     (GitOps)          │  │  │  • Server Discovery & Inventory             │      │
│  │   • OpenBao           │  │  │  • IPMI/BMC Management                      │      │
│  │     (Secret Mgmt)     │  │  │  • OS Installation (GardenLinux)            │      │
│  │   • ESO (Secret Sync) │  │  │                                             │      │
│  │   • Greenhouse        │  │  │  • Hardware Configuration                   │      │
│  │     (optional)        │  │  │  • Network Bootstrap                        │      │
│  │   • Aurora (optional) │  │  │                                             │      │
│  └───────────────────────┘  │  │          │                     │            │      │
│                             │  │          ▼                     ▼            │      │
│  ┌───────────────────────┐  │  │  ┌──────────────┐      ┌──────────────┐     │      │
│  │   Control Plane       │  │  │  │  Hypervisor  │      │   Storage    │     │      │
│  │   Cluster             │  │  │  │   Cluster    │      │   Cluster    │     │      │
│  │   ─────────────────   │  │  │  ├──────────────┤      ├──────────────┤     │      │
│  │   • c5c3-operator     │  │  │  │ Hypervisor Op│      │ Rook Operator│     │      │
│  │   • Service Operators │  │  │  │ ovn-ctrl (DS)│      │ Ceph MON/OSD │     │      │
│  │   • Infrastructure    │  │  │  │ Hyp. Nodes   │      │ External Arb.│     │      │
│  │   • tempest-op. (opt) │  │  │  │ Node Agents  │      │ Prysm        │     │      │
│  │   • K-ORC             │  │  │  └──────────────┘      └──────────────┘     │      │
│  │   • OVN NB/SB         │  │  │                                             │      │
│  └───────────────────────┘  │  │  Operating System: GardenLinux              │      │
│                             │  └─────────────────────────────────────────────┘      │
│                             │                                                       │
└─────────────────────────────┴───────────────────────────────────────────────────────┘
```

**Provisioning Flow:**

```text
1. IronCore discovers Bare-Metal servers (IPMI/BMC)
       │
       ▼
2. IronCore installs GardenLinux on Bare-Metal
       │  (GardenLinux contains LibVirt with QEMU/KVM or Cloud Hypervisor, or c5c3 deploys LibVirt as DaemonSet)
       │
       ▼
3. Gardener creates Kubernetes clusters on the nodes
       │
       ├──▶ Hypervisor Cluster (for Compute)
       └──▶ Storage Cluster (for Ceph)

4. FluxCD deploys workloads to all clusters
```

## Multi-Cluster Topology

```text
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              MANAGEMENT CLUSTER                                     │
│                         (Gardener)                                                  │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────────┐ │
│  │        FluxCD          │  │       OpenBao          │  │   Greenhouse/Aurora    │ │
│  │     (GitOps Hub)       │  │    (Secret Store)      │  │     (optional)         │ │
│  ├────────────────────────┤  ├────────────────────────┤  ├────────────────────────┤ │
│  │ • Source Controller    │  │ • KV v2 Secrets        │  │ • Monitoring           │ │
│  │ • Kustomize Controller │  │ • PKI Engine           │  │ • Alerting             │ │
│  │ • Helm Controller      │  │ • Kubernetes Auth      │  │ • Dashboard UI         │ │
│  │                        │  │ • HA (3x Raft)         │  │ • Multi-Cluster Views  │ │
│  └───────────┬────────────┘  └───────────┬────────────┘  └────────────────────────┘ │
│              │                           │                                          │
│              │  kubeConfig Secrets       │  ESO reads Secrets                       │
│              │  for Remote Deployment    │  for all clusters                        │
│              │                           │                                          │
└──────────────┼───────────────────────────┼──────────────────────────────────────────┘
               │                           │
               ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                      │
│ ┌──────────────────────────────────┐            ┌──────────────────────────────────┐ │
│ │      CONTROL PLANE CLUSTER       │            │        STORAGE CLUSTER           │ │
│ │       (Gardener)                 │            │    (IronCore → Gardener)         │ │
│ ├──────────────────────────────────┤            ├──────────────────────────────────┤ │
│ │                                  │            │                                  │ │
│ │  Orchestration:                  │            │  Operators:                      │ │
│ │  └─ c5c3-operator                │            │  ├─ Rook Operator                │ │
│ │                                  │   Ceph     │  └─ External Arbiter Operator    │ │
│ │  Service Operators:              │   Keys     │                                  │ │
│ │  ├─ keystone-operator            │◄───────────│  Ceph Services:                  │ │
│ │  ├─ glance-operator ─────────────┼───────────▶│  ├─ MON (3x Quorum)              │ │
│ │  ├─ placement-operator           │   RBD      │  ├─ OSD (Storage Nodes)          │ │
│ │  ├─ nova-operator                │            │  ├─ MDS (optional, CephFS)       │ │
│ │  ├─ neutron-operator             │            │  └─ RadosGW (optional, S3)       │ │
│ │  ├─ cinder-operator ─────────────┼───────────▶│                                  │ │
│ │  ├─ cortex-operator (optional)   │   RBD      │  Observability:                  │ │
│ │  └─ tempest-operator (optional)  │            │  └─ Prysm                        │ │
│ │                                  │            │                                  │ │
│ │  Infrastructure:                 │            │                                  │ │
│ │  ├─ MariaDB (Galera 3x)          │            │  OS: GardenLinux                 │ │
│ │  ├─ RabbitMQ (Cluster 3x)        │            │                                  │ │
│ │  ├─ Valkey (Sentinel 3x)         │            └──────────────────────────────────┘ │
│ │  └─ Memcached                    │                                                 │
│ │                                  │                          ▲                      │
│ │  K-ORC:                          │                          │                      │
│ │  └─ OpenStack Resource Mgmt      │                     Arbiter MON                 │
│ │                                  │                     (Stretched)                 │
│ │  ovn-operator (SDN Backend):     │                          │                      │
│ │  ├─ OVN Northbound DB (3x Raft)  │                   ┌───────┴────────┐            │
│ │  └─ OVN Southbound DB (3x Raft)  │                   │ ARBITER CLUSTER│            │
│ │                                  │                   │   (optional)   │            │
│ └───────────────┬──────────────────┘                   │  Ceph MON only │            │
│                 │                                      └────────────────┘            │
│                 │ Nova/Neutron APIs                                                  │
│                 │ OVN SB (OVSDB)                                                     │
│                 │                                                                    │
│                 ▼                                                                    │
│ ┌──────────────────────────────────────────────────┐                                 │
│ │                 HYPERVISOR CLUSTER               │                                 │
│ │              (IronCore → Gardener)               │                                 │
│ ├──────────────────────────────────────────────────┤                                 │
│ │                                                  │                                 │
│ │  Operators:                                      │                                 │
│ │  ├─ Hypervisor Operator (Node Lifecycle)         │                                 │
│ │  └─ Labels Injector                              │                                 │
│ │                                                  │                                 │
│ │  Node Agents (DaemonSets):                       │                                 │
│ │  ├─ Hypervisor Node Agent (LibVirt Introspection)│         RBD                     │
│ │  ├─ OVS Agent (OVS Introspection) ───────────────┼─────────────────────────────────┤
│ │  ├─ ovn-controller (OVN → OVS)                   │    (VM Disks from Ceph)         │
│ │  ├─ Nova Compute Agent                           │                                 │
│ │  ├─ ovs-vswitchd                                 │                                 │
│ │  └─ HA Agent                                     │                                 │
│ │                                                  │                                 │
│ │  Hypervisor Nodes (GardenLinux):                 │                                 │
│ │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐     │                                 │
│ │  │ Node 1 │ │ Node 2 │ │ Node 3 │ │ Node N │     │                                 │
│ │  │LibVirt │ │LibVirt │ │LibVirt │ │LibVirt │     │                                 │
│ │  │  VMs   │ │  VMs   │ │  VMs   │ │  VMs   │     │                                 │
│ │  │OVS/OVN │ │OVS/OVN │ │OVS/OVN │ │OVS/OVN │     │                                 │
│ │  └────────┘ └────────┘ └────────┘ └────────┘     │                                 │
│ │                                                  │                                 │
│ └──────────────────────────────────────────────────┘                                 │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘

                                    │
                                    │ All clusters managed by Gardener
                                    ▼
                         ┌─────────────────────┐
                         │      GARDENER       │
                         │  (Cluster Lifecycle │
                         │   Management)       │
                         └─────────────────────┘
```

## Cluster Communication

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MANAGEMENT CLUSTER                                 │
│                          (Gardener)                                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐      │
│  │      FluxCD         │  │      OpenBao        │  │  Greenhouse/Aurora  │      │
│  │   (GitOps Hub)      │  │   (Secret Store)    │  │   (Monitoring, UI)  │      │
│  │                     │  │                     │  │                     │      │
│  └──────────┬──────────┘  └──────────┬──────────┘  └──────────┬──────────┘      │
│             │                        │                        │                 │
│             │ kubeConfig             │ ESO Secret Sync        │ Metrics/Logs    │
│             │ Secrets                │ (all clusters)         │                 │
└─────────────┼────────────────────────┼────────────────────────┼─────────────────┘
              │                        │                        │
              ▼                        ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│  ┌───────────────────────────┐                      ┌─────────────────────────┐ │
│  │    CONTROL PLANE CLUSTER  │                      │    STORAGE CLUSTER      │ │
│  │    (Gardener)             │                      │    (IronCore+Gardener)  │ │
│  ├───────────────────────────┤                      ├─────────────────────────┤ │
│  │                           │                      │                         │ │
│  │  c5c3-operator            │                      │  Rook Operator          │ │
│  │  ├─ Orchestration         │                      │  ├─ CephCluster         │ │
│  │  └─ Credential Mgmt       │    Ceph Keys         │  ├─ CephClient CRs      │ │
│  │                           │◄─────────────────────│  │  (glance, cinder,    │ │
│  │  Service Operators:       │    (ESO/OpenBao)     │  │   nova)              │ │
│  │  ├─ keystone-operator     │                      │  └─ RBD Pools           │ │
│  │  ├─ glance-operator ──────┼─────────────────────▶│                         │ │
│  │  ├─ placement-operator    │    RBD Images        │  Ceph Services:         │ │
│  │  ├─ nova-operator         │                      │  ├─ MON (3x Quorum)     │ │
│  │  ├─ neutron-operator ─────┼───┐                  │  ├─ OSD (Storage)       │ │
│  │  ├─ cinder-operator ──────┼───┼─────────────────▶│  └─ RadosGW (optional)  │ │
│  │  ├─ cortex-operator (opt) │   │  RBD Volumes     │                         │ │
│  │  └─ tempest-operator (opt)│   │                  │  External Arbiter Op    │ │
│  │  Infrastructure:          │   │                  │  └─▶ Arbiter Cluster    │ │
│  │  ├─ MariaDB (Galera)      │   │                  │                         │ │
│  │  ├─ RabbitMQ (Cluster)    │   │                  │  Prysm (Observability)  │ │
│  │  ├─ Valkey (Sentinel)     │   │                  │                         │ │
│  │  └─ Memcached             │   │                  └─────────────────────────┘ │
│  │                           │   │                                              │
│  │  K-ORC                    │   │                                              │
│  │  └─ OpenStack Resources   │   │                                              │
│  │                           │   │                                              │
│  │  ovn-operator:            │   │                                              │
│  │  ├─ OVN NB (3x Raft)      │   │                                              │
│  │  └─ OVN SB (3x Raft)      │   │                                              │
│  │                           │   │                                              │
│  └───────────┬───────────────┘   │                                              │
│              │                   │                                              │
│              │ Nova/Neutron      │ OVN SB                                       │
│              │ API Calls         │ (OVSDB)                                      │
│              │                   │                                              │
│              ▼                   ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        HYPERVISOR CLUSTER                               │    │
│  │                       (IronCore → Gardener)                             │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │  Operators:                          Node Agents (DaemonSets):          │    │
│  │  ├─ Hypervisor Operator              ├─ Hypervisor Node Agent           │    │
│  │  └─ Labels Injector                  ├─ OVS Agent                       │    │
│  │                                      ├─ ovn-controller (OVN → OVS)      │    │
│  │                                      ├─ Nova Compute Agent              │    │
│  │                                      ├─ ovs-vswitchd                    │    │
│  │                                      └─ HA Agent                        │    │
│  │                                                                         │    │
│  │  Hypervisor Nodes (GardenLinux):                                        │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │    │
│  │  │   Node 1    │  │   Node 2    │  │   Node 3    │  │   Node N    │     │    │
│  │  │   LibVirt   │  │   LibVirt   │  │   LibVirt   │  │   LibVirt   │     │    │
│  │  │ VMs ◄───────┼──┼─────────────┼──┼─────────────┼──┼── RBD ──────┼─────┼────┤
│  │  │ OVS Bridge  │  │ OVS Bridge  │  │ OVS Bridge  │  │ OVS Bridge  │     │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘     │    │
│  │                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Cluster Responsibilities and Provisioning

### 1. Management Cluster

**Provisioning:** Gardener

* **[Flux Operator](./11-gitops-fluxcd/) + FluxCD**: GitOps hub for multi-cluster deployment of all components (FluxCD lifecycle via FluxInstance CRD)
* **[OpenBao](./13-secret-management.md)**: Central secret store for all credentials (HA, 3x Raft)
* **[External Secrets Operator (ESO)](./13-secret-management.md#eso-integration)**: Secret synchronization between OpenBao and all clusters
* **[Greenhouse](./03-components/03-management.md#greenhouse)**: Centralized monitoring and alerting for all clusters
* **[Aurora Dashboard](./03-components/03-management.md#aurora-dashboard)**: Unified management UI for the entire infrastructure
* Cross-cluster metrics aggregation (see [Observability](./15-observability/))
* Centralized logging (see [Logging](./15-observability/02-logging.md))

### 2. Control Plane Cluster

**Provisioning:** Gardener

* OpenStack Control Plane Services (e.g., Nova API, Neutron API, Keystone, Glance — extensible with additional services). See [Control Plane](./03-components/01-control-plane.md) for details.
* [Cortex Scheduler](./08-cortex-scheduling.md) (intelligent placement, optional)
* Tempest (recurring integration tests, optional)
* [K-ORC](./03-components/01-control-plane.md#openstack-resource-controller-k-orc) (declarative OpenStack resource management via CRDs)
* **ovn-operator** (OVN SDN Backend: Northbound/Southbound DB)
* **[Infrastructure Services](./03-components/01-control-plane.md#infrastructure-service-operators):**
  * MariaDB Operator (Galera cluster for DB backend)
  * Valkey Operator (Sentinel for caching)
  * RabbitMQ Operator (message queue for OpenStack)
  * Memcached Operator (token caching for Keystone)

### 3. Hypervisor Cluster

**Provisioning:** IronCore (Bare-Metal) → Gardener (Cluster Management)

* **[OpenStack Hypervisor Operator](./03-components/02-hypervisor.md)** (lifecycle management of Hypervisor nodes)
* Hypervisor nodes with GardenLinux
* Node-local agents (Hypervisor Node Agent, OVS Agent, ovn-controller, Nova Agent, HA Agent)
* Labels Injector (Node→Pod label synchronization)
* LibVirt-based virtualization (QEMU/KVM, Cloud Hypervisor)
* Virtual machines

### 4. Storage Cluster

**Provisioning:** IronCore (Bare-Metal) → Gardener (Cluster Management)

* Rook Operator for Ceph management (see [Storage](./03-components/04-storage.md))
* Ceph MON Quorum + OSD nodes
* **External Arbiter Operator** (deploys MONs in remote cluster for stretched clusters)
* **[Prysm](./03-components/04-storage.md#prysm---storage-observability-platform)** (storage observability: Ceph, RadosGW, SMART metrics)
* GardenLinux as base OS

### 5. Arbiter Cluster (Optional, for Stretched Clusters)

**Provisioning:** Gardener

* External Ceph MON for quorum decisions
* Deployed by External Arbiter Operator (from Storage Cluster)
* MON only, no OSDs (tiebreaker function)
* Typically at a third site for stretched clusters
