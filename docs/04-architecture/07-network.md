# Network Architecture

The network components are distributed across **two clusters**:

## OVN (Open Virtual Network) - Cross-Cluster

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│                                                                                │
│  CONTROL PLANE CLUSTER                     HYPERVISOR CLUSTER                  │
│  ═══════════════════════                   ══════════════════════════════      │
│                                                                                │
│  ┌───────────────────────┐                                                     │
│  │  Neutron API Server   │                                                     │
│  │  (Network Management) │                                                     │
│  └───────────┬───────────┘                                                     │
│              │                                                                 │
│              │ API Calls                                                       │
│              │                                                                 │
│  ┌───────────▼───────────┐                                                     │
│  │ OVN Northbound DB     │                                                     │
│  │ (Logical Config)      │                                                     │
│  └───────────┬───────────┘                                                     │
│              │                                                                 │
│              │                                                                 │
│  ┌───────────▼───────────┐                                                     │
│  │ OVN Southbound DB     │                                                     │
│  │ (Physical Mapping)    │                                                     │
│  └───────────┬───────────┘                                                     │
│              │                                                                 │
│              │ OVSDB Protocol                                                  │
│              │                                                                 │
│              └──────────────────────────────────────────┐                      │
│                                                         │                      │
│                                           ┌─────────────┼─────────────┐        │
│                                           │             │             │        │
│                                           ▼             ▼             ▼        │
│                                  ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│                                  │OVN         │ │OVN         │ │OVN         │  │
│                                  │Controller  │ │Controller  │ │Controller  │  │
│                                  │(Node 1)    │ │(Node 2)    │ │(Node N)    │  │
│                                  │            │ │            │ │            │  │
│                                  │┌──────────┐│ │┌──────────┐│ │┌──────────┐│  │
│                                  ││ovs-      ││ ││ovs-      ││ ││ovs-      ││  │
│                                  ││vswitchd  ││ ││vswitchd  ││ ││vswitchd  ││  │
│                                  │└──────────┘│ │└──────────┘│ │└──────────┘│  │
│                                  └────────────┘ └────────────┘ └────────────┘  │
│                                        │             │             │           │
│                                        └─────────────┼─────────────┘           │
│                                                      │                         │
│                                                      ▼                         │
│                                             ┌────────────────┐                 │
│                                             │   VM Traffic   │                 │
│                                             │   (Overlay)    │                 │
│                                             └────────────────┘                 │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Network Components by Cluster

| Component         | Cluster       | Function                      |
| ----------------- | ------------- | ----------------------------- |
| Neutron API       | Control Plane | Network management API        |
| OVN Northbound DB | Control Plane | Logical network configuration |
| OVN Southbound DB | Control Plane | Physical-to-logical mapping   |
| OVN Controller    | Hypervisor    | Local network implementation  |
| ovs-vswitchd      | Hypervisor    | Virtual switch on each node   |

For the agent overview on hypervisor nodes, see [Component Interaction](./02-component-interaction.md#hypervisor-node-agents-in-hypervisor-cluster).

## OVN Architecture Detail

OVN (Open Virtual Network) forms the SDN backend for CobaltCore. The Northbound and Southbound databases run in the Control Plane Cluster, deployed and managed by the [ovn-operator](../03-components/01-control-plane/03-ovn-operator.md).

**Data Flow Through the OVN Stack:**

```text
┌─────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE CLUSTER                                              │
│                                                                     │
│  ┌──────────────────┐                                               │
│  │  Neutron API     │  ML2/OVN Plugin writes logical                │
│  │  (neutron-       │  network configuration (Ports, Subnets,       │
│  │   operator)      │  Routers, Security Groups)                    │
│  └────────┬─────────┘                                               │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────┐                                               │
│  │  OVN Northbound  │  Logical network objects                      │
│  │  DB (3x Raft)    │  (Logical Switches, Logical Routers,          │
│  │                  │   ACLs, Load Balancers)                       │
│  └────────┬─────────┘                                               │
│           │ ovn-northd                                              │
│           │ (Translator: logical → physical)                        │
│           ▼                                                         │
│  ┌──────────────────┐                                               │
│  │  OVN Southbound  │  Physical bindings, Chassis registration,     │
│  │  DB (3x Raft)    │  Port Bindings, MAC/IP Mappings               │
│  │                  │                                               │
│  └────────┬─────────┘                                               │
│           │                                                         │
└───────────┼─────────────────────────────────────────────────────────┘
            │ OVSDB Protocol (TCP 6642)
            │
┌───────────┼─────────────────────────────────────────────────────────┐
│  HYPERVISOR CLUSTER                                                 │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────┐                                               │
│  │  ovn-controller  │  Reads SB DB, programs local                  │
│  │  (per node)      │  OpenFlow rules in ovs-vswitchd               │
│  └────────┬─────────┘                                               │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────┐                                               │
│  │  ovs-vswitchd    │  OpenFlow rules control packet forwarding,    │
│  │  (per node)      │  Encapsulation (Geneve), Security Groups      │
│  └──────────────────┘                                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Raft Consensus for NB/SB:**

Both the OVN Northbound and Southbound DB run as 3-replica Raft clusters. The [ovn-operator](../03-components/01-control-plane/03-ovn-operator.md) in the Control Plane Cluster manages deployment and configuration. A leader handles write operations, the two followers replicate synchronously. On leader failure, Raft consensus automatically elects a new leader (see also [High Availability](./04-high-availability.md)).

## Network Segmentation

CobaltCore uses several logically separated network zones:

| Network Zone             | Purpose                      | Involved Clusters         | Typical Implementation                                   |
| ------------------------ | ---------------------------- | ------------------------- | -------------------------------------------------------- |
| **Management Network**   | K8s API, SSH, Monitoring     | All clusters              | Dedicated VLAN, not routable from tenant networks        |
| **Data/Tenant Network**  | VM-to-VM communication       | Hypervisor Cluster        | Geneve Overlay (default) or Provider VLAN                |
| **Storage Network**      | Ceph RBD, OSD Replication    | Hypervisor ↔ Storage      | Dedicated VLAN or physical network, high bandwidth       |
| **External/API Network** | OpenStack APIs, Floating IPs | Control Plane, Hypervisor | Routable, public or semi-public                          |
| **Provider Network(s)**  | Direct L2 access for VMs     | Hypervisor Cluster        | VLAN-based, optional, for workloads with L2 requirements |

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    NETWORK ZONES                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Management Network (all clusters)                                  │
│  ════════════════════════════════                                   │
│  K8s API, SSH, Monitoring, FluxCD                                   │
│                                                                     │
│  Data/Tenant Network (Hypervisor Cluster)                           │
│  ═════════════════════════════════════════                          │
│  VM-to-VM: Geneve Overlay (UDP 6081)                                │
│  Isolation via VNI (Virtual Network Identifier)                     │
│                                                                     │
│  Storage Network (Hypervisor ↔ Storage)                             │
│  ══════════════════════════════════════                             │
│  Ceph RBD (TCP 6789 MON, TCP 6800-7300 OSD)                         │
│  High bandwidth, low latency                                        │
│                                                                     │
│  External/API Network                                               │
│  ════════════════════                                               │
│  OpenStack APIs (HTTPS), Floating IPs, NAT                          │
│                                                                     │
│  Provider Network(s) (optional)                                     │
│  ══════════════════════════════                                     │
│  Direct L2 access via VLAN tagging                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Control-Plane API Exposure and Pod Network Policy

Service operators manage the network surface of their own API workloads as part of reconciliation. The Keystone Operator is the reference implementation (see [Keystone Reconciler](../09-implementation/04-keystone-reconciler.md)); other service operators follow the same pattern.

- **Gateway API HTTPRoute (CC-0065).** When a service CR sets `spec.gateway`, the operator reconciles a `gateway.networking.k8s.io/HTTPRoute` that attaches the service's ClusterIP Service to a pre-existing `Gateway` (referenced by `parentRef`), matching on `hostname` and `path`. The Gateway/GatewayClass themselves are infrastructure managed outside the operator. TLS is terminated at the Gateway, so the API pods speak plain HTTP internally and `status.endpoint` is derived as `https://{hostname}/v3`. The operator detects whether the Gateway API CRD is installed at startup (via the RESTMapper) and only watches/reconciles HTTPRoutes when it is — clusters without Gateway API still run, and `spec.gateway` is rejected through the `HTTPRouteReady` condition rather than crashing the controller.
- **NetworkPolicy (CC-0039).** When `spec.networkPolicy` is set, the operator emits a `NetworkPolicy` that allows ingress on the API port (TCP 5000 for Keystone) only from declared sources and auto-derives egress to DNS, the database (from `database.clusterRef`), and the cache (from `cache.clusterRef`). The operator pod itself can additionally be isolated via an opt-in chart-level NetworkPolicy (CC-0090).
- **Database TLS / mutual TLS (CC-0106).** Connections from API/job pods to MariaDB (via MaxScale) can be encrypted and mutually authenticated. When `spec.database.tls.enabled` is true, the operator issues a client certificate from a shared OpenStack DB CA (cert-manager `ClusterIssuer`), mounts it at `/etc/keystone/db-tls/`, and appends pymysql `ssl_*` parameters (`prefer`/`require`/`verify-ca`/`verify-full`) to the connection URL. This is a per-service network-security control orthogonal to the OVN tenant data plane described above; see [Secret Management](../05-deployment/02-secret-management.md) for the certificate trust domain.

## OVS Bridge Layout per Hypervisor Node

Each hypervisor node has multiple OVS bridges that handle different network functions. The OVS Agent monitors the state of the bridges and reports via OVSNode CRD (see [CRDs](./01-crds.md#ovsnode-crd-ovsc5c3iov1alpha1)).

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Hypervisor Node                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │                        br-int (Integration Bridge)               │       │
│  │                                                                  │       │
│  │  VM vNICs ◀──▶ Security Group Flows ◀──▶ Tunnel Ports (Geneve)   │       │
│  │                                                                  │       │
│  │  - All VM interfaces (tap devices) connected                     │       │
│  │  - OpenFlow rules for Security Groups (ACLs)                     │       │
│  │  - Tunnel Ports for Geneve overlay to other nodes                │       │
│  │  - Metadata Proxy Port                                           │       │
│  │  - Patch Port to br-ex                                           │       │
│  └──────────┬──────────────────────────────────────────┬────────────┘       │
│             │ Patch Port                               │ Tunnel Port        │
│             ▼                                          │ (Geneve)           │
│  ┌──────────────────────┐                              │                    │
│  │   br-ex              │                              │                    │
│  │   (External Bridge)  │                              │                    │
│  │                      │                              │                    │
│  │  - Floating IP NAT   │                              │                    │
│  │  - External Gateway  │                              │                    │
│  │  - Provider Network  │                              │                    │
│  │    Uplink            │                              │                    │
│  └──────────┬───────────┘                              │                    │
│             │                                          │                    │
│  ┌──────────▼───────────┐                              │                    │
│  │ br-provider          │                              │                    │
│  │ (Provider Bridge)    │                              │                    │
│  │ (optional)           │                              │                    │
│  │                      │                              │                    │
│  │ - VLAN Tagging       │                              │                    │
│  │ - Direct L2          │                              │                    │
│  │   Access             │                              │                    │
│  └──────────┬───────────┘                              │                    │
│             │                                          │                    │
│  ┌──────────▼──────────────────────────────────────────▼─────────────┐      │
│  │                    Physical NICs / Bonds                          │      │
│  │                                                                   │      │
│  │  ┌─────────────────────┐    ┌─────────────────────┐               │      │
│  │  │  bond0              │    │  bond1              │               │      │
│  │  │  (balance-tcp)      │    │  (balance-tcp)      │               │      │
│  │  │  ┌──────┐ ┌──────┐  │    │  ┌──────┐ ┌──────┐  │               │      │
│  │  │  │ eth0 │ │ eth1 │  │    │  │ eth2 │ │ eth3 │  │               │      │
│  │  │  └──────┘ └──────┘  │    │  └──────┘ └──────┘  │               │      │
│  │  └─────────────────────┘    └─────────────────────┘               │      │
│  │  ▲ External/Provider            ▲ Overlay/Storage                 │      │
│  └───────────────────────────────────────────────────────────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Bridge Overview:**

| Bridge          | Function                                             | Typical Ports                                                     | Flows                                            |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| **br-int**      | Integration Bridge --- central datapath for all VMs  | VM vNICs (tap), Tunnel Ports (Geneve), Patch Port to br-ex        | Security Group ACLs, MAC Learning, ARP Responder |
| **br-ex**       | External Bridge --- connection to external networks  | Patch Port from br-int, physical uplink (or Patch to br-provider) | Floating IP NAT, External Gateway Routing        |
| **br-provider** | Provider Bridge (optional) --- direct L2 access      | VLAN-tagged uplink, physical port                                 | VLAN tagging/stripping for Provider Networks     |

<!-- TODO: Add section on DPDK support (when enabled, configuration, performance implications). The OVSNode CRD supports dpdkEnabled and dpdkVersion fields. -->

## Provider Networks vs. Overlay Networks

CobaltCore supports two network models for VM connectivity:

**Overlay (Geneve) --- Default for Tenant Networks:**

* Automatic network isolation via VNI (Virtual Network Identifier)
* No physical VLAN setup required
* Encapsulation via Geneve (UDP Port 6081) between hypervisor nodes
* Neutron creates logical networks, OVN automatically maps them to Geneve tunnels
* Suitable for most workloads

**Provider (VLAN/Flat) --- For Direct L2 Access:**

* Requires physical VLAN setup on switches (VLAN trunk to hypervisors)
* VM gets direct L2 access to physical network
* Higher performance (no encapsulation overhead)
* Configuration via [neutron-operator](../03-components/01-control-plane/02-service-operators.md) (Provider Network Definition) and OVN NB (Logical Switch with localnet port)
* Typical use cases: Legacy applications with L2 requirements, bare-metal-like network connectivity
