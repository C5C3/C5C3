# OVN Operator

**Repository:** `github.com/c5c3/forge/operators/ovn`
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

## Further Reading

* [Service Operators](./02-service-operators.md) — Neutron operator integrates with OVN
* [Network Architecture](../../04-architecture/07-network.md) — Detailed network topology and OVN integration
* [Hypervisor](../02-hypervisor.md) — Hypervisor cluster where ovn-controller runs
