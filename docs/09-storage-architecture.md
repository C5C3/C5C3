# Storage Architecture

The **Storage Cluster** is a standalone Kubernetes cluster that operates Ceph via Rook.

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

## External Arbiter for Stretched Clusters

The **External Arbiter Operator** (runs in the **Storage Cluster**) enables:

* Deployment of external Ceph monitors in a remote arbiter cluster
* Stretched cluster scenarios with geographic redundancy
* Consensus participation without full OSD infrastructure
* Cross-cluster management via Kubernetes API (to the remote arbiter cluster)

***
