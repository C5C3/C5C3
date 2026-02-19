# Operations

## Claim: Request OpenStack Cluster (Pool Model)

Users create a claim with **explicit pool references** for Hypervisor and Storage clusters:

```yaml
# Claim for Production OpenStack Cluster with pool references
apiVersion: c5c3.io/v1alpha1
kind: OpenStackCluster
metadata:
  name: customer-a-prod
  namespace: tenant-customer-a
spec:
  region: eu-de-1
  size: large

  # Pool references: Which clusters should this OpenStack cluster consume?
  hypervisorClusters:
    - hv-pool-a      # Standard pool (50 nodes)
    - hv-pool-b      # Premium pool (100 nodes) for burst capacity
  storageClusters:
    - st-pool-a      # 500TB NVMe Ceph pool

  # OpenStack Services
  services:
    nova: true
    neutron: true
    cinder: true
    glance: true
    octavia: true    # Load Balancer (optional)

  # Cortex for intelligent scheduling
  cortex:
    enabled: true
    pipelines:
      - nova
      - cinder

  # TLS
  tls:
    enabled: true
    issuerRef: letsencrypt-prod

---
# Second OpenStack Cluster (shared pools)
apiVersion: c5c3.io/v1alpha1
kind: OpenStackCluster
metadata:
  name: customer-b-staging
  namespace: tenant-customer-b
spec:
  region: eu-de-1
  size: small

  # Shared pools - uses the same pools as customer-a
  hypervisorClusters:
    - hv-pool-a      # Shared with customer-a
  storageClusters:
    - st-pool-a      # Shared with customer-a

  services:
    nova: true
    neutron: true
    cinder: true
    glance: true
```

**Pool Sharing Examples:**

| OpenStack Cluster  | Hypervisor Pools     | Storage Pools        | Description               |
| ------------------ | -------------------- | -------------------- | ------------------------- |
| customer-a-prod    | hv-pool-a, hv-pool-b | st-pool-a            | Dedicated + shared pools  |
| customer-b-staging | hv-pool-a            | st-pool-a            | Only shared pools         |
| internal-prod      | hv-pool-b            | st-pool-a, st-pool-b | Premium HV, multi-storage |

## Crossplane + FluxCD Integration

Crossplane is deployed and managed via FluxCD in the Management Cluster:

```text
┌───────────────────────────────────────────────────────────────────┐
│                    FluxCD + Crossplane Integration                │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Git Repository (c5c3-gitops)                                     │
│  ├── apps/                                                        │
│  │   └── crossplane/                                              │
│  │       ├── kustomization.yaml                                   │
│  │       ├── helmrelease.yaml      # Crossplane Core              │
│  │       ├── provider-kubernetes.yaml                             │
│  │       ├── provider-config.yaml  # Control Plane kubeconfig     │
│  │       ├── xrds/                                                │
│  │       │   └── xopenstackcluster.yaml                           │
│  │       └── compositions/                                        │
│  │           ├── openstack-production.yaml                        │
│  │           ├── openstack-staging.yaml                           │
│  │           └── openstack-development.yaml                       │
│  │                                                                │
│  └── clusters/                                                    │
│      └── management/                                              │
│          └── crossplane/           # Kustomization → apps/crossplane
│                                                                   │
│  FluxCD reconciles:                                               │
│  1. Crossplane Helm Chart                                         │
│  2. provider-kubernetes                                           │
│  3. ProviderConfig (kubeconfig Secret)                            │
│  4. XRDs and Compositions                                         │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**FluxCD Kustomization for Crossplane:**

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: crossplane
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  path: ./apps/crossplane
  prune: true
  dependsOn:
    - name: flux-system  # Crossplane runs locally in Management Cluster
```

**HelmRelease for Crossplane:**

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: crossplane
  namespace: flux-system
spec:
  interval: 1h
  url: https://charts.crossplane.io/stable

---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: crossplane
  namespace: crossplane-system
spec:
  interval: 30m
  chart:
    spec:
      chart: crossplane
      version: ">=1.15.0 <2.0.0"
      sourceRef:
        kind: HelmRepository
        name: crossplane
        namespace: flux-system
  values:
    args:
      - --enable-composition-functions
      - --enable-usages
    metrics:
      enabled: true
```

## Multi-Tenancy with Crossplane (Pool Model)

Crossplane enables **self-service provisioning** with **pool sharing** for different teams/tenants:

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                Multi-Tenant OpenStack Provisioning (Pool Model)                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  MANAGEMENT CLUSTER - Tenant Claims                                             │
│  ───────────────────────────────────                                            │
│                                                                                 │
│  Namespace: tenant-team-a          Namespace: tenant-team-b                     │
│  ┌─────────────────────┐          ┌─────────────────────┐                       │
│  │ OpenStackCluster    │          │ OpenStackCluster    │                       │
│  │ "team-a-prod"       │          │ "team-b-staging"    │                       │
│  │                     │          │                     │                       │
│  │ size: large         │          │ size: small         │                       │
│  │ hypervisorClusters: │          │ hypervisorClusters: │                       │
│  │ - hv-pool-a ◄───────┼──────────┼─► hv-pool-a         │  ← Shared Pool        │
│  │ - hv-pool-b         │          │                     │                       │
│  │ storageClusters:    │          │ storageClusters:    │                       │
│  │ - st-pool-a ◄───────┼──────────┼─► st-pool-a         │  ← Shared Pool        │
│  └──────────┬──────────┘          └──────────┬──────────┘                       │
│             │                                │                                  │
│             │ Crossplane creates             │                                  │
│             │ XOpenStackCluster              │                                  │
│             └────────────┬───────────────────┘                                  │
│                          │                                                      │
│                          ▼                                                      │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                        CONTROL PLANE CLUSTER                              │  │
│  │                                                                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  Namespace: openstack-team-a-prod                                   │  │  │
│  │  │  ┌───────────────────────────────────────────────────────────────┐  │  │  │
│  │  │  │ ControlPlane "team-a-prod"                                    │  │  │  │
│  │  │  │                                                               │  │  │  │
│  │  │  │ compute:                                                      │  │  │  │
│  │  │  │   hypervisorClusters: [hv-pool-a, hv-pool-b]                  │  │  │  │
│  │  │  │ storage:                                                      │  │  │  │
│  │  │  │   storageClusters: [st-pool-a]                                │  │  │  │
│  │  │  │                                                               │  │  │  │
│  │  │  │ → Keystone, Nova API, Neutron API, Glance, Cinder, Cortex     │  │  │  │
│  │  │  └───────────────────────────────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  Namespace: openstack-team-b-staging                                │  │  │
│  │  │  ┌───────────────────────────────────────────────────────────────┐  │  │  │
│  │  │  │ ControlPlane "team-b-staging"                                 │  │  │  │
│  │  │  │                                                               │  │  │  │
│  │  │  │ compute:                                                      │  │  │  │
│  │  │  │   hypervisorClusters: [hv-pool-a]  ← Shared                   │  │  │  │
│  │  │  │ storage:                                                      │  │  │  │
│  │  │  │   storageClusters: [st-pool-a]     ← Shared                   │  │  │  │
│  │  │  │                                                               │  │  │  │
│  │  │  │ → Keystone, Nova API, Neutron API, Glance (minimal)           │  │  │  │
│  │  │  └───────────────────────────────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                           │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│             │                                │                                  │
│             │ Nova/OVN Agents                │                                  │
│             ▼                                ▼                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                     HYPERVISOR CLUSTER POOLS                              │  │
│  │                                                                           │  │
│  │  ┌─────────────────────────────┐  ┌─────────────────────────────┐         │  │
│  │  │ hv-pool-a (50 Nodes)        │  │ hv-pool-b (100 Nodes)       │         │  │
│  │  │                             │  │                             │         │  │
│  │  │ ┌─────────┐ ┌─────────┐     │  │ ┌─────────┐ ┌─────────┐     │         │  │
│  │  │ │ team-a  │ │ team-b  │     │  │ │ team-a  │ │         │     │         │  │
│  │  │ │ VMs     │ │ VMs     │     │  │ │ VMs     │ │         │     │         │  │
│  │  │ └─────────┘ └─────────┘     │  │ └─────────┘ └─────────┘     │         │  │
│  │  │                             │  │                             │         │  │
│  │  │ Isolation via:              │  │ Isolation via:              │         │  │
│  │  │ - Host Aggregates           │  │ - Host Aggregates           │         │  │
│  │  │ - Availability Zones        │  │ - Availability Zones        │         │  │
│  │  │ - Placement Constraints     │  │ - Placement Constraints     │         │  │
│  │  └─────────────────────────────┘  └─────────────────────────────┘         │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│             │                                                                   │
│             │ Cinder Volumes                                                    │
│             ▼                                                                   │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                      STORAGE CLUSTER POOLS                                │  │
│  │                                                                           │  │
│  │  ┌────────────────────────────────────────────────────────┐               │  │
│  │  │ st-pool-a (Ceph 500TB)                                 │               │  │
│  │  │                                                        │               │  │
│  │  │ ┌────────────────────┐  ┌────────────────────┐         │               │  │
│  │  │ │ team-a Volumes     │  │ team-b Volumes     │         │               │  │
│  │  │ │ (RBD Pool: team-a) │  │ (RBD Pool: team-b) │         │               │  │
│  │  │ └────────────────────┘  └────────────────────┘         │               │  │
│  │  │                                                        │               │  │
│  │  │ Isolation via:                                         │               │  │
│  │  │ - Separate RBD pools per tenant                        │               │  │
│  │  │ - CRUSH rules for placement                            │               │  │
│  │  │ - Quotas per pool                                      │               │  │
│  │  └────────────────────────────────────────────────────────┘               │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Complete Provisioning Flow (Pool Model)

```text
┌────────────────────────────────────────────────────────────────────────────────────┐
│                  Crossplane Provisioning Flow (Pool Model)                         │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│  PHASE 1: Provision Infrastructure Pools (independently)                           │
│  ═════════════════════════════════════════════════════                             │
│                                                                                    │
│  1a. Control Plane Cluster Claim                                                   │
│      ┌─────────────────────────────────────┐                                       │
│      │  kind: ControlPlaneCluster          │                                       │
│      │  name: eu-de-1-control-plane        │                                       │
│      │  spec:                              │                                       │
│      │    region: eu-de-1                  │                                       │
│      │    workers: 5                       │                                       │
│      └───────────────┬─────────────────────┘                                       │
│                      │                                                             │
│                      ▼                                                             │
│      ┌─────────────────────────────────────┐                                       │
│      │  Gardener Shoot                     │                                       │
│      │  "eu-de-1-control-plane"            │                                       │
│      │  → K8s Control Plane Cluster        │                                       │
│      └─────────────────────────────────────┘                                       │
│                                                                                    │
│  1b. Hypervisor Pool Claims (parallel)                                             │
│      ┌───────────────────────┐  ┌───────────────────────┐                          │
│      │ kind: HypervisorCluster  │ kind: HypervisorCluster                          │
│      │ name: hv-pool-a       │  │ name: hv-pool-b       │                          │
│      │ workers: 50           │  │ workers: 100          │                          │
│      └───────────┬───────────┘  └───────────┬───────────┘                          │
│                  │                          │                                      │
│                  ▼                          ▼                                      │
│      ┌───────────────────────┐  ┌───────────────────────┐                          │
│      │ Gardener Shoot        │  │ Gardener Shoot        │                          │
│      │ "hv-pool-a"           │  │ "hv-pool-b"           │                          │
│      │ 50 Hypervisor Nodes   │  │ 100 Hypervisor Nodes  │                          │
│      └───────────────────────┘  └───────────────────────┘                          │
│                                                                                    │
│  1c. Storage Pool Claims (parallel)                                                │
│      ┌───────────────────────┐                                                     │
│      │ kind: StorageCluster  │                                                     │
│      │ name: st-pool-a       │                                                     │
│      │ capacity: 500Ti       │                                                     │
│      └───────────┬───────────┘                                                     │
│                  │                                                                 │
│                  ▼                                                                 │
│      ┌───────────────────────┐                                                     │
│      │ Gardener Shoot        │                                                     │
│      │ "st-pool-a"           │                                                     │
│      │ Ceph 500TB            │                                                     │
│      └───────────────────────┘                                                     │
│                                                                                    │
│  PHASE 2: Provision OpenStack Cluster (after pool ready)                           │
│  ═══════════════════════════════════════════════════════════                       │
│                                                                                    │
│  2. OpenStackCluster Claims with pool references                                   │
│     ┌─────────────────────────────────────────────────────────────────────────┐    │
│     │  kind: OpenStackCluster                                                 │    │
│     │  name: customer-a-prod                                                  │    │
│     │  spec:                                                                  │    │
│     │    region: eu-de-1                                                      │    │
│     │    size: large                                                          │    │
│     │    hypervisorClusters:         # Pool references                        │    │
│     │      - hv-pool-a               # ← Reference to provisioned pools       │    │
│     │      - hv-pool-b                                                        │    │
│     │    storageClusters:                                                     │    │
│     │      - st-pool-a               # ← Reference to provisioned pools       │    │
│     └───────────────────────────────────────┬─────────────────────────────────┘    │
│                                             │                                      │
│                                             ▼                                      │
│  3. Crossplane creates ControlPlane CR in Control Plane Cluster                    │
│     ┌─────────────────────────────────────────────────────────────────────────┐    │
│     │  apiVersion: c5c3.io/v1alpha1                                           │    │
│     │  kind: ControlPlane                                                     │    │
│     │  metadata:                                                              │    │
│     │    name: customer-a-prod                                                │    │
│     │    namespace: openstack-customer-a-prod                                 │    │
│     │  spec:                                                                  │    │
│     │    compute:                                                             │    │
│     │      hypervisorClusters:                                                │    │
│     │        - hv-pool-a             # Nova Agents connect to these pools     │    │
│     │        - hv-pool-b                                                      │    │
│     │    storage:                                                             │    │
│     │      storageClusters:                                                   │    │
│     │        - st-pool-a             # Cinder volumes on these pools          │    │
│     │    openstack:                                                           │    │
│     │      keystone: { replicas: 3 }                                          │    │
│     │      nova: { api: { replicas: 5 } }                                     │    │
│     │      ...                                                                │    │
│     └───────────────────────────────────────┬─────────────────────────────────┘    │
│                                             │                                      │
│                                             ▼                                      │
│  4. c5c3-operator orchestrates OpenStack Services                                  │
│     ┌─────────────────────────────────────────────────────────────────────────┐    │
│     │  c5c3-operator + Service Operators in Control Plane Cluster:            │    │
│     │                                                                         │    │
│     │  • Infrastructure CRs: MariaDB, RabbitMQ, Valkey, Memcached             │    │
│     │  • Service CRs → Service Operators: Keystone, Nova, Neutron, etc.       │    │
│     │  • Optional: Cortex (Intelligent Scheduler)                             │    │
│     │                                                                         │    │
│     │  Nova/OVN Agents are deployed on the referenced                         │    │
│     │  Hypervisor clusters (hv-pool-a, hv-pool-b)                             │    │
│     │                                                                         │    │
│     │  Cinder uses the referenced Storage clusters (st-pool-a)                │    │
│     └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                    │
│  PHASE 3: Pool Sharing (multiple OpenStack clusters use the same pools)            │
│  ════════════════════════════════════════════════════════════════════════          │
│                                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │                                                                             │   │
│  │  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  │   │
│  │  │ customer-a-prod     │  │ customer-b-staging  │  │ internal-prod       │  │   │
│  │  │                     │  │                     │  │                     │  │   │
│  │  │ hypervisorClusters: │  │ hypervisorClusters: │  │ hypervisorClusters: │  │   │
│  │  │ - hv-pool-a ────────┼──┼─► hv-pool-a         │  │ - hv-pool-b         │  │   │
│  │  │ - hv-pool-b         │  │                     │  │                     │  │   │
│  │  │                     │  │ storageClusters:    │  │ storageClusters:    │  │   │
│  │  │ storageClusters:    │  │ - st-pool-a ◄───────┼──┼─► st-pool-a         │  │   │
│  │  │ - st-pool-a ────────┼──┼────────────────────►│  │                     │  │   │
│  │  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘  │   │
│  │                                                                             │   │
│  │  Pool isolation via:                                                        │   │
│  │  • Nova: Host Aggregates + Availability Zones                               │   │
│  │  • Cinder: Storage Backends + Volume Types                                  │   │
│  │  • Neutron: Network Segmentation                                            │   │
│  │                                                                             │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## Advantages of Crossplane in CobaltCore (Pool Model)

| Advantage                 | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| **Pool-based Scaling**    | Hypervisor and Storage pools can be scaled independently                 |
| **Resource Sharing**      | Multiple OpenStack clusters can use the same pools (efficiency)          |
| **Flexible Assignment**   | One OpenStack cluster can consume 1..N Hypervisor and 1..M Storage pools |
| **Dedicated Pools**       | Premium customers can receive dedicated pools                            |
| **Self-Service**          | Teams can request OpenStack clusters and choose pool assignment          |
| **Abstraction**           | Complexity of Gardener + c5c3-operator is hidden by simple API           |
| **Governance**            | Compositions enforce standards (security, sizing, compliance)            |
| **Multi-Tenancy**         | Namespace isolation for different teams/customers                        |
| **GitOps-ready**          | Claims can be versioned in Git                                           |
| **Drift Detection**       | Crossplane automatically corrects manual changes                         |
| **Composition Revisions** | Controlled updates of cluster and pool templates                         |
| **Lifecycle Management**  | Pools and clusters can be scaled and updated independently               |

## Pool Isolation Strategies

The pool model enables various isolation strategies:

| Strategy            | Description                                     | Use Case                       |
| ------------------- | ----------------------------------------------- | ------------------------------ |
| **Shared Pools**    | Multiple OpenStack clusters share pools         | Cost-efficient for staging/dev |
| **Dedicated Pools** | One OpenStack cluster has exclusive pools       | Production, compliance         |
| **Hybrid**          | Mix of shared and dedicated                     | Standard + burst capacity      |
| **Tiered Pools**    | Different pools for different performance tiers | NVMe vs. HDD storage           |

**Isolation at Pool Level:**

```yaml
# Example: Dedicated pool for compliance requirements
apiVersion: crossplane.c5c3.io/v1alpha1
kind: HypervisorCluster
metadata:
  name: hv-pool-compliance
  namespace: infrastructure
spec:
  region: eu-de-1
  name: hv-pool-compliance
  workers: 20
  labels:
    dedicated: "true"
    compliance: "sox"
    isolation: "physical"
  ironcore:
    machinePool: ironcore-dedicated-rack-1
    machineClass: baremetal-kvm-isolated

---
# OpenStack Cluster using the dedicated pool
apiVersion: c5c3.io/v1alpha1
kind: OpenStackCluster
metadata:
  name: finance-prod
  namespace: tenant-finance
spec:
  region: eu-de-1
  size: large
  hypervisorClusters:
    - hv-pool-compliance    # Dedicated, isolated pool
  storageClusters:
    - st-pool-encrypted     # Encrypted storage pool
```

## Git Repository Structure (Pool Model)

```text
c5c3-gitops/
├── apps/
│   ├── crossplane/                        # Crossplane Setup
│   │   ├── kustomization.yaml
│   │   ├── helmrelease.yaml               # Crossplane Core
│   │   ├── providers/
│   │   │   └── provider-kubernetes.yaml   # For Gardener Shoots + ControlPlane CRs
│   │   ├── provider-configs/
│   │   │   ├── gardener.yaml              # Gardener API access (provider-kubernetes)
│   │   │   └── control-plane.yaml         # Control Plane Cluster kubeconfig (provider-kubernetes)
│   │   ├── xrds/                          # Pool Model XRDs
│   │   │   ├── xcontrolplanecluster.yaml  # Control Plane Cluster
│   │   │   ├── xhypervisorcluster.yaml    # Hypervisor Pool
│   │   │   ├── xstoragecluster.yaml       # Storage Pool
│   │   │   └── xopenstackcluster.yaml     # OpenStack Cluster (with pool refs)
│   │   └── compositions/
│   │       ├── controlplane-production.yaml    # Control Plane Composition
│   │       ├── hypervisor-pool.yaml            # Hypervisor Pool Composition
│   │       ├── storage-pool.yaml               # Storage Pool Composition
│   │       ├── openstack-production.yaml       # OpenStack Composition
│   │       ├── openstack-staging.yaml
│   │       └── openstack-development.yaml
│   └── ...
├── clusters/
│   └── management/
│       ├── crossplane/                    # Kustomization for Crossplane
│       └── ...
│
├── infrastructure/                        # Infrastructure Pool Claims
│   ├── eu-de-1/                           # Region: Europe
│   │   ├── kustomization.yaml
│   │   ├── control-plane.yaml             # ControlPlaneCluster Claim
│   │   ├── hypervisor-pools/
│   │   │   ├── hv-pool-a.yaml             # 50 Node Standard Pool
│   │   │   └── hv-pool-b.yaml             # 100 Node Premium Pool
│   │   └── storage-pools/
│   │       ├── st-pool-a.yaml             # 500TB NVMe Pool
│   │       └── st-pool-b.yaml             # 1PB HDD Pool
│   └── us-east-1/                         # Region: US
│       ├── kustomization.yaml
│       ├── control-plane.yaml
│       ├── hypervisor-pools/
│       │   └── hv-pool-us.yaml
│       └── storage-pools/
│           └── st-pool-us.yaml
│
└── tenants/                               # Tenant-specific OpenStack Claims
    ├── team-a/
    │   ├── kustomization.yaml
    │   └── openstack-clusters/
    │       ├── prod.yaml                  # Uses: hv-pool-a, hv-pool-b, st-pool-a
    │       └── staging.yaml               # Uses: hv-pool-a, st-pool-a
    ├── team-b/
    │   ├── kustomization.yaml
    │   └── openstack-clusters/
    │       └── staging.yaml               # Uses: hv-pool-a, st-pool-a (shared)
    └── internal/
        ├── kustomization.yaml
        └── openstack-clusters/
            └── prod.yaml                  # Uses: hv-pool-b, st-pool-a, st-pool-b
```

**Pool Overview per Region:**

| Region    | Control Plane           | Hypervisor Pools                | Storage Pools                      |
| --------- | ----------------------- | ------------------------------- | ---------------------------------- |
| eu-de-1   | eu-de-1-control-plane   | hv-pool-a (50), hv-pool-b (100) | st-pool-a (500TB), st-pool-b (1PB) |
| us-east-1 | us-east-1-control-plane | hv-pool-us (75)                 | st-pool-us (750TB)                 |

***
