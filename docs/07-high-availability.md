# High Availability

## HA Architecture (Hypervisor Operator + HA Agent)

> **Note:** The HA functionality is realized through the interaction of the **OpenStack Hypervisor Operator** (runs as Deployment in the Hypervisor Cluster) and the **HA Agent** (DaemonSet on each node). The **Hypervisor HA Service** already exists but is not yet publicly available. This will change in the future.

```text
                    ┌──────────────────────────────┐
                    │   Hypervisor Operator        │
                    │   (Hypervisor Cluster)       │
                    │                              │
                    │  - Watched: K8s Nodes        │
                    │  - Manages: Hypervisor CRDs  │
                    │  - Handles: Eviction CRDs    │
                    │  - Handles: Migration CRDs   │
                    └──────────────┬───────────────┘
                                   │
                            K8s API (CRDs)
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
           ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   HA Agent       │    │   HA Agent       │    │   HA Agent       │
│   (Node 1)       │    │   (Node 2)       │    │   (Node N)       │
│   (DaemonSet)    │    │   (DaemonSet)    │    │   (DaemonSet)    │
│                  │    │                  │    │                  │
│  LibVirt Events: │    │  LibVirt Events: │    │  LibVirt Events: │
│  - Lifecycle     │    │  - Lifecycle     │    │  - Lifecycle     │
│  - Reboots       │    │  - Reboots       │    │  - Reboots       │
│  - Watchdog      │    │  - Watchdog      │    │  - Watchdog      │
│  - I/O Errors    │    │  - I/O Errors    │    │  - I/O Errors    │
│                  │    │                  │    │                  │
│  Creates/Updates │    │  Creates/Updates │    │  Creates/Updates │
│  Eviction CRDs   │    │  Eviction CRDs   │    │  Eviction CRDs   │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

## Control Plane HA

All infrastructure services in the Control Plane Cluster are deployed redundantly. The failure of individual instances is automatically compensated.

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                    CONTROL PLANE HA STACK                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  MariaDB Galera (3 Nodes)                                       │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                    │    │
│  │  │  Node 1   │◀─▶  Node 2   │◀─▶  Node 3   │  Synchronous Multi-│    │
│  │  │  (R/W)    │  │  (R/W)    │  │  (R/W)    │  Master Replication│    │
│  │  └───────────┘  └───────────┘  └───────────┘                    │    │
│  │           ▲            ▲            ▲                           │    │
│  │           └────────────┼────────────┘                           │    │
│  │                   MaxScale Proxy                                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  RabbitMQ Cluster (3 Nodes)                                     │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                    │    │
│  │  │  Node 1   │◀─▶  Node 2   │◀─▶  Node 3   │  Quorum Queues,    │    │
│  │  │           │  │           │  │           │  pause_minority    │    │
│  │  └───────────┘  └───────────┘  └───────────┘                    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Valkey Sentinel (3 Nodes with Sentinel Sidecars)               │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                    │    │
│  │  │  Primary  │──▶ Replica 1 │  │ Replica 2 │  Automatic         │    │
│  │  │+ Sentinel │  │+ Sentinel │  │+ Sentinel │  Failover via      │    │
│  │  └───────────┘  └───────────┘  └───────────┘  Sentinel Quorum   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  OVN NB/SB (3 Replicas each, Raft Consensus)                    │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                    │    │
│  │  │  Leader   │◀─▶ Follower  │◀─▶ Follower  │  Automatic         │    │
│  │  │  (R/W)    │  │  (R/O)    │  │  (R/O)    │  Leader Election   │    │
│  │  └───────────┘  └───────────┘  └───────────┘                    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Memcached (memcached-operator, Deployment + Headless Service)  │    │
│  │  ┌───────────┐  ┌───────────┐                                   │    │
│  │  │ Instance 1│  │ Instance 2│  DNS-based Discovery,             │    │
│  │  └───────────┘  └───────────┘  Token Caching for Keystone       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Components in Detail:**

| Component       | Replicas | Consensus Mechanism                  | Special Features                                                                  |
| --------------- | -------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| MariaDB Galera  | 3        | Synchronous multi-master replication | Automatic rejoin after partition healing, MaxScale Proxy for read/write splitting |
| RabbitMQ        | 3        | `pause_minority` partition handling  | Quorum queues for guaranteed message delivery, automatic cluster recovery         |
| Valkey Sentinel | 3        | Sentinel Quorum (Majority)           | 3 nodes with Sentinel sidecars, automatic failover of primary node                |
| OVN NB/SB       | 3 each   | Raft Consensus                       | Automatic leader election, deployed via ovn-operator                              |
| Memcached       | 2+       | No consensus (stateless)             | memcached-operator, anti-affinity + PDB, DNS-based discovery                      |

## Data Plane HA

Data Plane HA ensures the availability of virtual machines on hypervisor nodes.

**LibVirt Event Subscription:**

The HA Agent subscribes to the local LibVirt daemon and reacts to the following event types:

| Event Type      | Description                                     | HA Agent Reaction                                                     |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| Lifecycle Event | VM state change (Start, Stop, Crash, Suspend)   | On unexpected stop/crash: Creates Eviction CRD for automatic recovery |
| Reboot Event    | VM restart detected                             | Verifies successful restart, on failure: Eviction CRD                 |
| Watchdog Event  | Guest watchdog triggered (e.g., QEMU i6300esb)  | VM restart on current host, on failure: migration to alternative host |
| I/O Error Event | Disk or network I/O error of the VM             | Notification via Eviction CRD, on persistent error: migration         |

**Component Interaction During Automatic Recovery:**

```text
┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐
│ LibVirt  │───▶│ HA Agent │───▶│ Eviction CRD │───▶│ Hypervisor   │───▶│ Nova API │
│ Event    │    │          │    │ (K8s API)    │    │ Operator     │    │          │
└──────────┘    └──────────┘    └──────────────┘    └──────────────┘    └──────────┘
                                                                            │
                                                                            ▼
                                                                    ┌──────────────┐
                                                                    │ Live         │
                                                                    │ Migration    │
                                                                    └──────────────┘
```

1. **LibVirt** detects an event (e.g., VM crash, watchdog trigger)
2. **HA Agent** receives the event via LibVirt event subscription
3. **HA Agent** creates/updates an **Eviction CRD** in the Hypervisor Cluster
4. **Hypervisor Operator** detects the Eviction CRD and performs preflight checks
5. **Hypervisor Operator** calls the **Nova API** to initiate a live migration
6. Nova orchestrates the migration to a suitable target hypervisor

**Kubernetes Node Conditions:**

The Hypervisor Operator watches the Kubernetes Node objects in the Hypervisor Cluster and reacts to condition changes:

| Node Condition        | Hypervisor Operator Reaction                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `Ready=False`         | Mark node as `NotReady`, after timeout: automatic eviction of all VMs    |
| `Ready=Unknown`       | Mark node as `Unreachable`, after timeout: automatic eviction of all VMs |
| `DiskPressure=True`   | Warning, do not schedule new VMs                                         |
| `MemoryPressure=True` | Warning, do not schedule new VMs                                         |

**ovn-controller Graceful Degradation:**

In case of a disconnect from the OVN Southbound DB, the local ovn-controller on each hypervisor node continues to work in cached mode:

* Existing OpenFlow rules in ovs-vswitchd remain active
* Running VM traffic is not interrupted
* New network configuration changes are only applied after reconnect
* Security group updates are cached and applied after reconnect

## Failure Scenario Matrix

| Component                              | Failure Behavior                                                           | Auto-Recovery                                                                                         | Manual Intervention                                                          |
| -------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Single Hypervisor Node**             | VMs on this node unreachable                                               | HA Agent detects failure, Eviction CRDs are created, automatic live migration to available nodes      | Only if no target capacity available or migration fails                      |
| **MariaDB Node (1 of 3)**              | Galera cluster continues with 2 nodes, no data loss                        | Automatic rejoin after node recovery, IST/SST synchronization                                         | Only with simultaneous failure of 2+ nodes                                   |
| **RabbitMQ Node (1 of 3)**             | Quorum queues remain available, messages processed on remaining nodes      | Automatic cluster rejoin, queue synchronization                                                       | Only with `pause_minority` split and simultaneous multi-node failure         |
| **Valkey Sentinel**                    | Sentinel quorum elects new primary within seconds                          | Automatic failover, replica promoted to primary                                                       | Only with simultaneous failure of primary + majority of sentinels            |
| **OVN NB/SB Raft Leader**              | Raft cluster automatically elects new leader, brief interruption (\<5s)    | Automatic leader election, follower takes over                                                        | Only with simultaneous failure of 2+ Raft nodes                              |
| **c5c3-operator Pod**                  | No new provisioning/orchestration, existing workloads unaffected           | Kubernetes Deployment automatically restarts pod                                                      | Only with persistent error (CrashLoopBackOff)                                |
| **Complete Control Plane Cluster**     | No API operations (VM Create/Delete/Migrate), running VMs continue to work | VMs run unchanged, network remains (ovn-controller cached flows), no automatic control plane recovery | Control plane cluster must be restored, VMs are not manageable during outage |
| **Network Partition Between Clusters** | Hypervisor nodes lose connection to control plane, VMs continue to run     | ovn-controller works in cached mode, VMs remain reachable, RabbitMQ enters `pause_minority`           | Resolve network partition, then automatic reconnect of all components        |

***
