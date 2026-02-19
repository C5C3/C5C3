# Component Interaction

## Cross-Cluster Communication

The four Kubernetes clusters communicate via various protocols and APIs:

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│                           CROSS-CLUSTER COMMUNICATION                          │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌──────────────────┐                           ┌──────────────────┐           │
│  │ MANAGEMENT       │◀══════ Metrics/Logs ══════│ CONTROL PLANE    │           │
│  │ CLUSTER          │                           │ CLUSTER          │           │
│  │                  │══ OpenBao Secrets (ESO) ═▶│                  │           │
│  │ OpenBao   ───────┼───────────────────────────┼─▶ ESO            │           │
│  │ Greenhouse ◀─────┼───────────────────────────┼─ Prometheus Fed. │           │
│  │ Aurora     ◀─────┼───────────────────────────┼─ API Aggregation │           │
│  └────────┬─────────┘                           └────────┬─────────┘           │
│           │                                              │                     │
│           │ Metrics/Logs                                 │ K8s API             │
│           │                                              │ OpenStack API       │
│           │                                              │                     │
│  ┌────────▼─────────┐                           ┌────────▼─────────┐           │
│  │ HYPERVISOR       │◀══════ K8s API ═══════════│ Control Plane    │           │
│  │ CLUSTER          │                           │ Services         │           │
│  │                  │                           │                  │           │
│  │ Hypervisor Op ───┼── watches K8s Nodes       │ Nova API         │           │
│  │ Hyp. Node Agent  │                           │ Neutron API      │           │
│  │ HA Agent ────────┼── Eviction/Migration CRDs │ Keystone/Glance  │           │
│  │ Nova Agent ──────┼───────────────────────────┼─▶ Cortex         │           │
│  │ ovn-controller   │                           │                  │           │
│  └────────┬─────────┘                           └────────┬─────────┘           │
│           │                                              │                     │
│           │ RBD/iSCSI                                    │ Ceph Admin          │
│           │ Block Storage                                │ Arbiter Mgmt        │
│           │                                              │                     │
│           │           ┌──────────────────┐               │                     │
│           └──────────▶│ STORAGE          │◀──────────────┘                     │
│                       │ CLUSTER          │                                     │
│                       │                  │                                     │
│                       │ Ceph MON/OSD     │        ┌──────────────────┐         │
│                       │ Rook Operator    │        │ ARBITER CLUSTER  │         │
│                       │ RBD/RadosGW      │        │ (Optional/Remote)│         │
│                       │                  │        │                  │         │
│                       │ Ext. Arbiter Op ─┼───────▶│ External MON     │         │
│                       │                  │  K8s   │ (Quorum only)    │         │
│                       └──────────────────┘  API   └──────────────────┘         │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Communication Matrix

| Source Cluster | Target Cluster           | Protocol           | Purpose                             |
| -------------- | ------------------------ | ------------------ | ----------------------------------- |
| Control Plane  | Hypervisor               | OpenStack API      | Nova Compute control                |
| Hypervisor     | Control Plane            | Kubernetes API     | CRD updates (Hypervisor status)     |
| Hypervisor     | Storage                  | RBD/iSCSI          | VM block storage                    |
| **Storage**    | **Arbiter (Remote)**     | **Kubernetes API** | **External Arbiter MON deployment** |
| Management     | Control Plane            | Prometheus Fed.    | Metrics aggregation                 |
| Management     | Hypervisor               | Prometheus Fed.    | Metrics aggregation                 |
| Management     | Storage                  | Prometheus Fed.    | Metrics aggregation                 |
| **all**        | **Management (OpenBao)** | **HTTPS**          | **ESO secret sync**                 |

## Hypervisor Node Agents (in Hypervisor Cluster)

Each hypervisor node in the Hypervisor Cluster runs the following agents:

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       Hypervisor Node (Hypervisor Cluster)                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │  Hypervisor Node Agent │  │    OVS Agent    │  │   Nova Agent    │  │ovn-controll.│ │
│  │  ─────────────  │  │  ─────────────  │  │  ─────────────  │  │ ─────────── │ │
│  │  - LibVirt      │  │  - OVS Status   │  │  - Compute Svc  │  │ - OVN→OVS   │ │
│  │    Introspect   │  │  - Bridge Info  │  │  - VM Lifecycle │  │ - Security  │ │
│  │  - Hypervisor   │  │  - Flow Stats   │  │  - Resources    │  │   Groups    │ │
│  │    CRD Status   │  │  - Bond Health  │  │  - Placement    │  │ - Metadata  │ │
│  │  - Migration    │  │  - OVSNode CRD  │  │                 │  │             │ │
│  │    Tracking     │  │    Status       │  │                 │  │             │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘ │
│           │                    │                    │                  │        │
│           │ K8s API            │ K8s API            │ AMQP             │ OVSDB  │
│           │ (Hypervisor        │ (Hypervisor        │ (Control Plane   │        │
│           │  Cluster)          │  Cluster)          │  Cluster)        │        │
│           └────────────────────┴────────────────────┴──────────────────┘        │
│                                                                                 │
│  ┌───────────────────────────────────┐  ┌─────────────────────────────────────┐ │
│  │             LibVirt               │  │           ovs-vswitchd              │ │
│  │                                   │  │                                     │ │
│  │  ┌─────────────────────────────┐  │  │  ┌─────────┐ ┌────────┐ ┌────────┐  │ │
│  │  │ HA Agent                    │  │  │  │  br-int │ │ br-ex  │ │br-prov │  │ │
│  │  │ - Domain Event Subscription │  │  │  │(Integr.)│ │(Extern)│ │(Provid)│  │ │
│  │  │ - Lifecycle/Watchdog Events │  │  │  └────┬────┘ └───┬────┘ └───┬────┘  │ │
│  │  │ - Eviction/Migration CRDs   │  │  │       │          │          │       │ │
│  │  └─────────────────────────────┘  │  │       └──────────┴──────────┘       │ │
│  │                                   │  │                   │                 │ │
│  │  ┌────────┐┌────────┐┌────────┐   │  │                   ▼                 │ │
│  │  │  VM 1  ││  VM 2  ││  VM N  │───┼──┼──▶ vNICs ◀───────────────────────   │ │
│  │  └────────┘└────────┘└────────┘   │  │                                     │ │
│  │              │                    │  └─────────────────────────────────────┘ │
│  │              │ RBD (Ceph)         │                    │                     │
│  │              ▼                    │                    ▼                     │
│  └───────────────────────────────────┘        Physical NICs (Bonds)             │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │ GardenLinux (Optimized Linux for Hypervisor Nodes)                          ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Agent Overview:**

| Agent                     | Repository                                 | CRD Updates               | Communication        |
| ------------------------- | ------------------------------------------ | ------------------------- | -------------------- |
| **Hypervisor Node Agent** | `cobaltcore-dev/kvm-node-agent`            | `Hypervisor`, `Migration` | K8s API, LibVirt TCP |
| **OVS Agent**             | `c5c3/c5c3-operator/agents/ovs-agent`      | `OVSNode`                 | K8s API, OVSDB       |
| **HA Agent**              | (Part of Hypervisor Node Agent)            | `Eviction`, `Migration`   | LibVirt Events       |
| **Nova Agent**            | (OpenStack Nova)                           | -                         | AMQP (RabbitMQ)      |
| **ovn-controller**        | (OVN)                                      | -                         | OVSDB, OVN SB        |

## Node-Internal System Integration

| Component          | Communication Type                                    | Purpose                                                          |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| LibVirt (libvirtd) | TCP Port 16509 (`qemu+tcp://` or `ch+tcp://`)         | Virtualization API (VM lifecycle, introspection, live migration) |
| Linux Networking   | Kernel APIs                                           | Network and security management                                  |
| os\_vif            | Python API                                            | Virtual interface management                                     |
| systemd/Journald   | D-Bus / Journal API                                   | Service and log management                                       |
| OVS/OVN            | OVSDB                                                 | Software-defined networking                                      |

***
