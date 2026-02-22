# Storage

## Rook Operator

**Repository:** [`github.com/rook/rook`](https://github.com/rook/rook)
**Runs in:** Storage Cluster

Kubernetes operator for Ceph management. For the cross-cluster storage integration and arbiter architecture, see [Storage Architecture](../04-architecture/06-storage.md).

**Functions:**

* Automated Ceph cluster management
* OSD provisioning and lifecycle
* MON quorum management
* Pool and storage class management

## Ceph Services

**Runs in:** Storage Cluster

* **MON (Monitor)**: Cluster state management, quorum
* **OSD (Object Storage Daemon)**: Data storage on disks
* **RadosGW**: S3/Swift-compatible object storage
* **RBD**: Block storage for VM volumes (used by Hypervisor Cluster)
* **CephFS**: Shared filesystem

## External Arbiter Operator

**Repository:** `github.com/cobaltcore-dev/external-arbiter-operator`
**Runs in:** Storage Cluster (alongside Rook)

The External Arbiter Operator deploys **Ceph Monitors (Arbiter) into remote Kubernetes clusters** for stretched-cluster or multi-storage-cluster scenarios.

**Important:** This operator has **NOTHING to do with LibVirt or VMs** - it is purely for Ceph quorum management.

**Architecture:**

```text
┌────────────────────────────────────┐      ┌─────────────────────────────────┐
│        STORAGE CLUSTER             │      │     ARBITER CLUSTER (Remote)    │
│                                    │      │                                 │
│  ┌─────────────────────────────┐   │      │  ┌─────────────────────────┐    │
│  │  Rook Operator              │   │      │  │  External Arbiter       │    │
│  │  (Ceph Management)          │   │      │  │  (Ceph MON)             │    │
│  └─────────────────────────────┘   │      │  │                         │    │
│                                    │      │  │  - Quorum only          │    │
│  ┌─────────────────────────────┐   │      │  │  - No OSDs              │    │
│  │  External Arbiter Operator  │───┼──────┼─▶│  - Deployed via         │    │
│  │                             │   │ K8s  │  │    kubeconfig           │    │
│  │  CRDs:                      │   │ API  │  └─────────────────────────┘    │
│  │  - RemoteCluster            │   │      │                                 │
│  │  - RemoteArbiter            │   │      │                                 │
│  └─────────────────────────────┘   │      │                                 │
│                                    │      │                                 │
│  ┌─────────────────────────────┐   │      │                                 │
│  │  Ceph MON 1, MON 2          │   │      │                                 │
│  │  Ceph OSDs                  │   │      │                                 │
│  └─────────────────────────────┘   │      │                                 │
│                                    │      │                                 │
└────────────────────────────────────┘      └─────────────────────────────────┘
```

**CRDs:**

* `RemoteCluster` (`ceph.c5c3.io/v1alpha1`): Defines access to a remote Kubernetes cluster via kubeconfig Secret
* `RemoteArbiter` (`ceph.c5c3.io/v1alpha1`): Defines a Ceph Monitor to be deployed in the RemoteCluster

**Use Cases:**

* **Stretched Ceph Clusters**: 2 datacenters (each with MON+OSDs) + 1 arbiter site (MON only for quorum)
* **Multi-Storage-Cluster**: Shared arbiter for multiple storage clusters
* **Geographic Redundancy**: MON quorum distributed across multiple sites

**Main Functions:**

* Deploys Ceph Monitors into remote Kubernetes clusters
* Manages the lifecycle of the remote arbiter
* Checks cluster availability and permissions
* Integrates the arbiter into the existing Ceph MON quorum

## Prysm - Storage Observability Platform

**Repository:** `github.com/cobaltcore-dev/prysm`
**Runs in:** Storage Cluster (as sidecar in RadosGW Pods)

A distributed observability platform for Ceph clusters and RadosGW with CLI interface. Prysm implements a **4-layer architecture** for comprehensive storage monitoring.

**Architecture:**

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           PRYSM ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  LAYER 1: PRODUCERS (Data Collection)                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  LOCAL PRODUCERS             │  REMOTE PRODUCERS                  │  │
│  │  ─────────────────           │  ────────────────                  │  │
│  │  • disk-health-metrics       │  • radosgw-usage (Admin API)       │  │
│  │  • kernel-metrics            │  • bucket-notify (S3 Events)       │  │
│  │  • resource-usage            │                                    │  │
│  │  • ops-log (S3 Operations)   │                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                   │                                     │
│                                   ▼                                     │
│  LAYER 2: NATS MESSAGING                                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Subjects: osd.disk.health, osd.kernel.metrics, rgw.ops-logs      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                   │                                     │
│                                   ▼                                     │
│  LAYER 3: CONSUMERS (Processing)                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  • quota-usage Consumer (Quota Tracking, Alerts)                  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                   │                                     │
│                                   ▼                                     │
│  LAYER 4: OUTPUT                                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  • Prometheus Metrics (Port 8080/9090)                            │  │
│  │  • NATS Publishing                                                │  │
│  │  • Console/Logs                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Producer Types:**

| Producer              | Description                               | Data Source                           |
| --------------------- | ----------------------------------------- | ------------------------------------- |
| `disk-health-metrics` | SMART data, defects, sectors              | `/dev/sd*`, `/dev/nvme*`              |
| `kernel-metrics`      | Kernel statistics, network                | Linux Kernel                          |
| `resource-usage`      | CPU, memory, system resources             | `/proc`, `gopsutil`                   |
| `ops-log`             | S3 operations (requests, latency, errors) | `/var/log/ceph/ceph-rgw-ops.json.log` |
| `radosgw-usage`       | Usage data per tenant                     | RadosGW Admin API                     |
| `bucket-notify`       | S3 bucket events                          | RadosGW Notifications                 |

**Kubernetes Integration (Mutating Webhook):**

```yaml
# Automatic sidecar injection in Rook-Ceph RGW Deployments
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: rook-ceph-rgw
    prysm-sidecar: "yes"  # Trigger for sidecar injection
spec:
  template:
    spec:
      containers:
      - name: prysm-sidecar          # Automatically injected
        image: ghcr.io/c5c3/prysm:v0.0.34
        command: ["prysm", "local-producer", "ops-log"]
        ports:
        - containerPort: 9090        # Prometheus Metrics
        volumeMounts:
        - mountPath: /var/log/ceph   # RadosGW Logs
        - mountPath: /etc/ceph       # Ceph Config
```

**CLI Commands:**

```bash
# Start consumer
prysm consumer quota-usage

# Local Producers
prysm local-producer ops-log --log-file=/var/log/ceph/ops-log.log
prysm local-producer disk-health-metrics --disks=/dev/sda,/dev/sdb
prysm local-producer kernel-metrics
prysm local-producer resource-usage

# Remote Producers
prysm remote-producer radosgw-usage --radosgw-url=http://rgw:8000
prysm remote-producer bucket-notify
```

**Use Cases in CobaltCore:**

* **Storage Infrastructure Monitoring**: Ceph cluster health and performance
* **S3 Operations Tracking**: Audit of all RadosGW operations
* **Quota Management**: Multi-tenant quota monitoring and alerting
* **Hardware Diagnostics**: Proactive disk failure detection via SMART
* **Compliance & Audit**: Operations logging for security policies
