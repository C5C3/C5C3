# Hypervisor

## OpenStack Hypervisor Operator

**Repository:** `github.com/c5c3/forge/operators/hypervisor`
**Runs in:** Hypervisor Cluster (Deployment)

The Kubernetes operator for managing the lifecycle of hypervisor nodes. It runs in the **Hypervisor Cluster** and watches Kubernetes Nodes to create and manage Hypervisor CRDs. For the complete state machine and lifecycle flows, see [Hypervisor Lifecycle](../04-architecture/03-hypervisor-lifecycle.md).

**Controller Logic (from Source Code):**

```go
// Watches Kubernetes Nodes and creates Hypervisor CRDs
func (hv *HypervisorController) Reconcile(ctx context.Context, req ctrl.Request) {
    node := &corev1.Node{}
    hv.Get(ctx, req.NamespacedName, node)
    // Creates/Updates Hypervisor CRD based on Node
}
```

**Main Functions:**

* Watches Kubernetes Nodes and creates `Hypervisor` CRDs
* Listens for `Eviction` requests and initiates VM evacuations
* Interacts with OpenStack API for Nova operations
* Manages Hypervisor lifecycle:
  * Onboarding new nodes
  * Maintenance mode
  * Node decommissioning
  * Aggregates and Traits synchronization

**Included Controllers:**

* `hypervisor_controller` - Creates Hypervisor CRDs from Nodes
* `eviction_controller` - Manages VM evacuations
* `onboarding_controller` - Node onboarding workflow
* `hypervisor_maintenance_controller` - Maintenance mode
* `aggregates_controller` - OpenStack Aggregates sync
* `traits_controller` - OpenStack Traits sync

## Virtualization Layer

LibVirt provides the virtualization management layer on each hypervisor node. It supports multiple hypervisor backends:

| Backend              | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| **QEMU/KVM**         | Traditional VMM backend, mature and feature-rich             |
| **Cloud Hypervisor** | Lightweight VMM backend, focused on performance and security |

LibVirt provides a unified interface between the c5c3 agents and the virtual machines, regardless of the backend in use.

**Operating Models:**

| Model                    | Description                                                                                                                                   | Analogy                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **GardenLinux-provided** | LibVirt is part of the GardenLinux OS image. IronCore installs GardenLinux incl. `libvirtd` on bare-metal. c5c3 consumes the existing daemon. | Like Ceph in Storage Cluster — present, only accessed |
| **c5c3-managed**         | LibVirt is deployed as containerized DaemonSet by c5c3. c5c3 fully controls version and configuration.                                        | Like OVS — managed and updated by c5c3                |

**Host Components:**

| Component          | Function                                         | Path                          |
| ------------------ | ------------------------------------------------ | ----------------------------- |
| `libvirtd`         | Virtualization daemon, manages VM lifecycle      | `/usr/sbin/libvirtd`          |
| `QEMU/KVM`         | Traditional VMM backend, executes VMs            | `/usr/bin/qemu-system-x86_64` |
| `cloud-hypervisor` | Lightweight VMM backend, alternative to QEMU     | `/usr/bin/cloud-hypervisor`   |
| `virsh`            | CLI for LibVirt operations (diagnostics)         | `/usr/bin/virsh`              |

**Connection to LibVirt Daemon:**

The c5c3 agents (Hypervisor Node Agent, HA Agent, Nova Compute) communicate with the LibVirt daemon via TCP:

* **Connection URI (QEMU/KVM):** `qemu+tcp://<host>:16509/system`
* **Connection URI (Cloud Hypervisor):** `ch+tcp://<host>:16509/system`
* **Port:** 16509 (libvirtd TCP Listener)
* **Configuration in `libvirtd.conf`:** `listen_tcp = 1`, `auth_tcp = "none"` (authentication via network policies)

**Configuration Files:**

| File                         | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `/etc/libvirt/libvirtd.conf` | Daemon configuration (Listening, Auth, Logging)              |
| `/etc/libvirt/qemu.conf`     | QEMU-specific settings (Security Driver, Cgroup, VNC)        |
| `/etc/libvirt/ch.conf`       | Cloud Hypervisor-specific settings (when using CH backend)   |

**Node Stack Architecture:**

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          HYPERVISOR NODE                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │    VM 1     │  │    VM 2     │  │    VM 3     │  │    VM N     │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         └────────────────┴────────────────┴────────────────┘                │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │              libvirtd (QEMU/KVM or Cloud Hypervisor)                │    │
│  │                                                                     │    │
│  │   TCP Port: 16509                                                   │    │
│  │   URI:      qemu+tcp://<host>:16509/system                          │    │
│  └───────────────────────────┬─────────────────────────────────────────┘    │
│                              │                                              │
│              ┌───────────────┼───────────────┐                              │
│              ▼               ▼               ▼                              │
│  ┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐                    │
│  │  Hypervisor     │ │  HA Agent   │ │ Nova Compute    │                    │
│  │  Node Agent     │ │  (Events)   │ │ (VM Lifecycle)  │                    │
│  │ (Introspection) │ │             │ │                 │                    │
│  └─────────────────┘ └─────────────┘ └─────────────────┘                    │
│                              │                                              │
│                              ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │              GardenLinux (Bare-Metal OS)                            │    │
│  │              or: c5c3 DaemonSet (containerized)                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

> **Note:** For LibVirt/Hypervisor Backend upgrades see [Upgrades](../06-operations/01-upgrades.md).

## Hypervisor Node Agent

**Runs in:** Hypervisor Cluster (DaemonSet on each node)

The Hypervisor Node Agent runs on **every hypervisor node** in the Hypervisor Cluster and provides introspection for virtualization services. It connects via TCP to the local `libvirtd` daemon.

**Implementations:**

| Agent                          | Backend          | Repository                                                 | Status  |
| ------------------------------ | ---------------- | ---------------------------------------------------------- | ------- |
| `kvm-node-agent`               | QEMU/KVM         | `github.com/cobaltcore-dev/kvm-node-agent`                 | Active  |
| `cloud-hypervisor-node-agent`  | Cloud Hypervisor | `github.com/cobaltcore-dev/cloud-hypervisor-node-agent`    | Planned |

**LibVirt Connection:**

The Hypervisor Node Agent connects via TCP to the LibVirt daemon on each node:

```text
Connection URI (QEMU/KVM):         qemu+tcp://<node-ip>:16509/system
Connection URI (Cloud Hypervisor):  ch+tcp://<node-ip>:16509/system
```

Since the connection is via TCP, the DaemonSet doesn't require a host socket mount. The target address is derived from the node IP of each host.

**Main Functions:**

* Collects node-specific information (hardware, LibVirt status)
* Updates `Hypervisor` CRD status with:
  * LibVirt version (`libVirtVersion`)
  * Capabilities (CPU, Memory, NUMA)
  * Domain capabilities
  * Running VM instances
* Provides `Migration` CRD for live migration tracking

## HA Agent (Part of Hypervisor Node Agent)

**Runs in:** Hypervisor Cluster (on each node, as part of Hypervisor Node Agent)

Go-based agent that monitors LibVirt events on each hypervisor node.

**Main Functions:**

* Subscribes to LibVirt Domain Events:
  * Lifecycle changes
  * Reboots
  * Watchdog triggers
  * I/O errors
* Updates Hypervisor status on changes

> **Note:** The HA functionality is integrated into the Hypervisor Node Agent and Hypervisor Operator. See [High Availability](../04-architecture/04-high-availability.md) for the complete failure detection and evacuation architecture.

## OVS Agent

**Repository:** `github.com/c5c3/forge/agents/ovs-agent`
**Runs in:** Hypervisor Cluster (DaemonSet on each node)

The OVS Agent runs on **every hypervisor node** and provides introspection for Open vSwitch (OVS). It is the networking counterpart to the Hypervisor Node Agent.

**Architecture:**

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          HYPERVISOR NODE                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐          │
│  │  Hypervisor     │    │    OVS Agent    │    │  ovn-controller │          │
│  │  Node Agent     │    │    (OVS)        │    │  (OVN→OVS)      │          │
│  │                 │    │                 │    │                 │          │
│  │  → Hypervisor   │    │  → OVSNode CRD  │    │  → Flow Rules   │          │
│  │    CRD Status   │    │    Status       │    │    Programming  │          │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘          │
│           │                      │                      │                   │
│           │                      │    ┌─────────────────┘                   │
│           │                      │    │                                     │
│           ▼                      ▼    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                          ovs-vswitchd                               │    │
│  │  ├── br-int (Integration Bridge) ─────────────▶ VM vNICs            │    │
│  │  ├── br-ex (External Bridge) ─────────────────▶ External Network    │    │
│  │  └── br-provider (Provider Networks) ─────────▶ VLAN/Flat Networks  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      Physical NICs (Bonds)                          │    │
│  │  ├── bond0 (LACP) ──▶ eno1, eno2                                    │    │
│  │  └── bond1 (LACP) ──▶ eno3, eno4                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Main Functions:**

* Collects OVS-specific information:
  * OVS/OVSDB version
  * DPDK status and configuration
  * Bridge configurations (br-int, br-ex, br-provider)
  * Port/Interface inventory
  * Bond/LAG status and health
* Updates `OVSNode` CRD status with:
  * Flow table statistics
  * Interface connectivity
  * OpenFlow connection status
  * OVSDB connection status
  * Error conditions
* Health Monitoring:
  * ovn-controller ↔ ovs-vswitchd communication
  * Orphan port detection
  * Stale flow detection
* Troubleshooting Endpoints:
  * Flow debugging (`ovs-appctl ofproto/trace`)
  * Packet capture trigger
  * Bridge/Port diagnostics

**Provided CRDs:**

| CRD       | API Group              | Description         |
| --------- | ---------------------- | ------------------- |
| `OVSNode` | `ovs.c5c3.io/v1alpha1` | OVS status per node |

**OVSNode CRD:**

```yaml
apiVersion: ovs.c5c3.io/v1alpha1
kind: OVSNode
metadata:
  name: hypervisor-node-01
  namespace: ovn-system
spec:
  # Automatically created/updated by OVS Agent
  nodeRef:
    name: hypervisor-node-01

status:
  # OVS Version Info
  ovsVersion: "3.4.1"
  ovsdVersion: "3.4.1"
  dpdkEnabled: true
  dpdkVersion: "23.11.1"

  # Bridge Status
  bridges:
    - name: br-int
      ports: 156
      flows: 2847
      datapathType: netdev  # or "system" for Kernel
      status: Active
    - name: br-ex
      ports: 2
      flows: 45
      datapathType: netdev
      status: Active
    - name: br-provider
      ports: 8
      flows: 123
      datapathType: netdev
      status: Active

  # Interface Status
  interfaces:
    physical:
      - name: eno1
        status: Up
        speed: 25Gbps
        bond: bond0
      - name: eno2
        status: Up
        speed: 25Gbps
        bond: bond0
    bonds:
      - name: bond0
        mode: balance-tcp  # LACP
        status: Active
        members: 2
        activeMembers: 2

  # OVN Controller Integration
  ovnController:
    connected: true
    sbConnection: "tcp:10.0.0.10:6642"
    chassisId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

  # Flow Statistics
  flowStats:
    totalFlows: 3015
    flowsPerTable:
      - table: 0
        flows: 125
      - table: 10
        flows: 890
      - table: 20
        flows: 456

  # Health Status
  conditions:
    - type: Ready
      status: "True"
    - type: OVSDBConnected
      status: "True"
    - type: OVNControllerConnected
      status: "True"
    - type: AllBridgesHealthy
      status: "True"
    - type: AllBondsHealthy
      status: "True"

  # Metrics
  metrics:
    packetsReceived: 1284739847
    packetsSent: 982374892
    bytesReceived: 1847293847293
    bytesSent: 928374928374
    drops: 0
    errors: 0

  # Detected Issues (if present)
  issues: []
  # Example for Issues:
  # - severity: Warning
  #   message: "Orphan port detected: qvo-abc123"
  #   detectedAt: "2025-02-03T10:15:00Z"
```

**Deployment:**

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ovs-agent
  namespace: ovn-system
spec:
  selector:
    matchLabels:
      app: ovs-agent
  template:
    metadata:
      labels:
        app: ovs-agent
    spec:
      nodeSelector:
        node-role.kubernetes.io/hypervisor: ""
      hostNetwork: true
      hostPID: true
      containers:
      - name: ovs-agent
        image: ghcr.io/c5c3/ovs-agent:latest
        securityContext:
          privileged: true
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        volumeMounts:
        - name: ovs-run
          mountPath: /var/run/openvswitch
        - name: ovs-db
          mountPath: /etc/openvswitch
        resources:
          requests:
            memory: 128Mi
            cpu: 50m
          limits:
            memory: 256Mi
            cpu: 200m
      volumes:
      - name: ovs-run
        hostPath:
          path: /var/run/openvswitch
      - name: ovs-db
        hostPath:
          path: /etc/openvswitch
```

**Interaction with Other Components:**

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CONTROL PLANE CLUSTER                               │
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │ neutron-operator│  │   Hypervisor    │  │   ovn-operator  │              │
│  │                 │  │    Operator     │  │                 │              │
│  │ Reads OVSNode   │  │ Aggregates      │  │ Watches OVSNode │              │
│  │ for Diagnostics │  │ Node Status     │  │ for Health      │              │
│  └─────────────────┘  └────────┬────────┘  └─────────────────┘              │
│                                │                                            │
└────────────────────────────────┼────────────────────────────────────────────┘
                                 │ Watches OVSNode CRDs
                                 │
┌────────────────────────────────┼────────────────────────────────────────────┐
│                         HYPERVISOR CLUSTER                                  │
│                                │                                            │
│   ┌────────────────────────────┼────────────────────────────────────────┐   │
│   │                            │                                        │   │
│   ▼                            ▼                                        ▼   │
│  Node 1                      Node 2                                  Node N │
│  ┌─────────────┐             ┌─────────────┐                   ┌─────────────┐
│  │  OVS Agent  │──▶ OVSNode  │  OVS Agent  │──▶ OVSNode CRD    │  OVS Agent  │
│  └─────────────┘      CRD    └─────────────┘                   └─────────────┘
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## OpenStack Compute Agents

**Runs in:** Hypervisor Cluster (on each node)

* **Nova Compute Agent**: Manages VMs, resource reporting to Nova API
* **ovn-controller**: Manages local networking, programs OVS flows
