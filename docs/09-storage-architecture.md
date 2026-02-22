# Storage Architecture

The **Storage Cluster** is a standalone Kubernetes cluster that operates Ceph via Rook. For the storage component overview, see [Components -- Storage](./03-components/04-storage.md).

## Cross-Cluster Storage Integration

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                              STORAGE CLUSTER                                 │
│                      (Standalone Kubernetes Cluster)                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                           Rook Operator                                │  │
│  │  - Automated Ceph lifecycle management                                 │  │
│  │  - OSD provisioning, MON quorum management                             │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                             MON Quorum                                 │  │
│  │  ┌───────────┐   ┌───────────┐   ┌───────────────────────────────┐     │  │
│  │  │   MON 1   │   │   MON 2   │   │  External Arbiter (MON 3)     │     │  │
│  │  │  (Site A) │   │  (Site B) │   │  (Managed by Ext. Arbiter     │     │  │
│  │  │           │   │           │   │   Operator in Storage Cluster)│     │  │
│  │  └───────────┘   └───────────┘   └───────────────────────────────┘     │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                      ▲                                       │
│                                      │ Remote Management                     │
│                                      │ via K8s API                           │
│  ┌───────────────────────────────────┼────────────────────────────────────┐  │
│  │                      OSD Nodes    │                                    │  │
│  │  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐                 │  │
│  │  │  OSD 1  │   │  OSD 2  │   │  OSD 3  │   │  OSD N  │                 │  │
│  │  └─────────┘   └─────────┘   └─────────┘   └─────────┘                 │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                      │                                       │
│                                      │ RBD / iSCSI / CephFS                  │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Storage Services (exposed to other clusters):                         │  │
│  │  ├── RBD (Block) ──────────────────────▶ Hypervisor Cluster (VM Disks) │  │
│  │  ├── RadosGW (Object) ─────────────────▶ S3/Swift API                  │  │
│  │  └── CephFS (File) ────────────────────▶ Shared Filesystems            │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Observability (Prysm - Sidecar in RGW Pods)                           │  │
│  │  - S3 Operations Logging & Audit                                       │  │
│  │  - Disk SMART Metrics, Kernel Stats, Resource Usage                    │  │
│  │  - RadosGW Usage & Quota Tracking                                      │  │
│  │  - Output: Prometheus (9090), NATS, Logs                               │  │
│  │  - Exports to Greenhouse (Management Cluster)                          │  │
│  │  See also: [Observability](./15-observability/)                         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                │
        ▼                                ▼                                ▼
┌───────────────────┐          ┌───────────────────┐          ┌───────────────────┐
│  HYPERVISOR       │          │  CONTROL PLANE    │          │  MANAGEMENT       │
│  CLUSTER          │          │  CLUSTER          │          │  CLUSTER          │
│                   │          │                   │          │                   │
│  VMs use RBD      │          │  Ext. Arbiter Op  │          │  Greenhouse       │
│  for volumes      │          │  manages MON 3    │          │  collects metrics │
└───────────────────┘          └───────────────────┘          └───────────────────┘
```

For the cross-cluster communication paths, see [Component Interaction](./05-component-interaction.md).

## External Arbiter for Stretched Clusters

The **External Arbiter Operator** (runs in the **Storage Cluster**) enables:

* Deployment of external Ceph monitors in a remote arbiter cluster
* Stretched cluster scenarios with geographic redundancy
* Consensus participation without full OSD infrastructure
* Cross-cluster management via Kubernetes API (to the remote arbiter cluster)

For the RemoteCluster and RemoteArbiter CRD definitions, see [CRDs](./04-crds.md#remotecluster-crd-cephc5c3iov1alpha1). For HA considerations of the storage layer, see [High Availability](./07-high-availability.md).

<!-- TODO: Add section on RBD client configuration on hypervisor nodes (librbd, ceph.conf distribution, Ceph keyring management) -->
<!-- TODO: Add section on Ceph pool configuration (RBD pool naming, CRUSH rules, replication factor) -->
<!-- TODO: Add section on Cinder integration (block storage service, volume types, backend configuration) -->
<!-- TODO: Add section on storage performance considerations (network bandwidth, latency requirements, IOPS) -->
