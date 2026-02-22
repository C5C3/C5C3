# Control Plane

The Control Plane consists of a **modular operator architecture** where each OpenStack service has its own dedicated operator. The central `c5c3-operator` handles orchestration and dependency management.

> **Note:** The OpenStack services and their operators documented below are representative of the current implementation. The modular architecture is designed to integrate additional OpenStack services (e.g., Ceilometer, [Limes](https://github.com/sapcc/limes)) via dedicated operators.

## Operator Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Modular Operator Architecture                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONTROL PLANE CLUSTER                                                      │
│  ─────────────────────                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    c5c3-operator (Orchestration)                    │    │
│  │                    Namespace: c5c3-system                           │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │  • ControlPlane CRD        • Dependency Graph               │    │    │
│  │  │  • Infrastructure CRs      • Health Aggregation             │    │    │
│  │  │  • Credential Orchestration                                 │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  └──────────────────────────────┬──────────────────────────────────────┘    │
│                                 │                                           │
│                    ┌────────────┼─────────────┐                             │
│                    │   Creates Service CRs    │                             │
│                    ▼            ▼             ▼                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Service Operators (Namespace: openstack)          │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │   │
│  │   │ keystone-   │  │ glance-     │  │ placement-  │                  │   │
│  │   │ operator    │  │ operator    │  │ operator    │                  │   │
│  │   │ Keystone CR │  │ Glance CR   │  │ Placement CR│                  │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘                  │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │   │
│  │   │ nova-       │  │ neutron-    │  │ cinder-     │                  │   │
│  │   │ operator    │  │ operator    │  │ operator    │                  │   │
│  │   │ Nova CR     │  │ Neutron CR  │  │ Cinder CR   │                  │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘                  │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐                                   │   │
│  │   │ cortex-     │  │ tempest-    │  (optional)                       │   │
│  │   │ operator    │  │ operator    │                                   │   │
│  │   │ Cortex CR   │  │ Tempest CR  │                                   │   │
│  │   └─────────────┘  └─────────────┘                                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                 │                                           │
│          ┌──────────────────────┼──────────────────────┐                    │
│          ▼                      ▼                      ▼                    │
│  ┌─────────────┐       ┌─────────────┐        ┌─────────────┐               │
│  │ MariaDB Op  │       │ RabbitMQ Op │        │ Valkey Op   │               │
│  │  (external) │       │  (external) │        │  (external) │               │
│  └─────────────┘       └─────────────┘        └─────────────┘               │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    K-ORC (Namespace: orc-system)                     │   │
│  │                                                                      │   │
│  │   Declarative Keystone Resource Management                           │   │
│  │   (Services, Endpoints, Users, ApplicationCredentials,               │   │
│  │    Domains, Projects, Roles, Groups)                                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    ovn-operator (Namespace: ovn-system)              │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐                                   │   │
│  │   │ OVN         │  │ OVN         │                                   │   │
│  │   │ Northbound  │  │ Southbound  │    neutron-operator connects      │   │
│  │   │ (3x Raft)   │  │ (3x Raft)   │    via ML2/OVN driver             │   │
│  │   └─────────────┘  └──────┬──────┘                                   │   │
│  │                           │                                          │   │
│  └───────────────────────────┼──────────────────────────────────────────┘   │
│                              │ OVSDB Protocol                               │
├──────────────────────────────┼──────────────────────────────────────────────┤
│                              │                                              │
│  HYPERVISOR CLUSTER          ▼                                              │
│  ──────────────────  ┌─────────────┐                                        │
│                      │ ovn-        │  (DaemonSet on each hypervisor node)   │
│                      │ controller  │                                        │
│                      └─────────────┘                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Advantages of modular architecture:**

* **Single Responsibility**: Each operator has exactly one task
* **Independent Releases**: Service-Operator updates without full-stack deployment (see [Upgrade & Lifecycle](../../06-operations/01-upgrades.md))
* **Better Testability**: Isolated unit and integration tests per operator
* **Flexible Scaling**: Deploy only needed operators
* **Clear Ownership**: Dedicated teams per operator possible

## Operator Reference

**OpenStack Service Operators:**

| Operator               | CRD                  | API Group                              | Description                      |
| ---------------------- | -------------------- | -------------------------------------- | -------------------------------- |
| **c5c3-operator**      | `ControlPlane`       | `c5c3.io/v1alpha1`                     | Orchestration, Dependencies      |
|                        | `SecretAggregate`    | `c5c3.io/v1alpha1`                     | Secret Aggregation               |
|                        | `CredentialRotation` | `c5c3.io/v1alpha1`                     | Credential Lifecycle             |
| **keystone-operator**  | `Keystone`           | `keystone.openstack.c5c3.io/v1alpha1`  | Identity Service                 |
| **glance-operator**    | `Glance`             | `glance.openstack.c5c3.io/v1alpha1`    | Image Service                    |
| **placement-operator** | `Placement`          | `placement.openstack.c5c3.io/v1alpha1` | Resource Tracking                |
| **nova-operator**      | `Nova`               | `nova.openstack.c5c3.io/v1alpha1`      | Compute Service                  |
| **neutron-operator**   | `Neutron`            | `neutron.openstack.c5c3.io/v1alpha1`   | Network Service                  |
| **ovn-operator**       | `OVNCluster`         | `ovn.c5c3.io/v1alpha1`                 | OVN SDN Backend (Control Plane)  |
|                        | `OVNChassis`         | `ovn.c5c3.io/v1alpha1`                 | Chassis/Node Registration        |
| **memcached-operator** | `Memcached`          | `memcached.c5c3.io/v1alpha1`           | Memcached Cluster Management     |
| **cinder-operator**    | `Cinder`             | `cinder.openstack.c5c3.io/v1alpha1`    | Block Storage                    |
| **cortex-operator**    | `Cortex`             | `cortex.c5c3.io/v1alpha1`              | Intelligent Scheduler (optional) |
| **tempest-operator**   | `Tempest`            | `tempest.openstack.c5c3.io/v1alpha1`   | Integration Testing (optional)   |

**Infrastructure Service Operators:**

| Service       | Operator                  | License    | HA Mode                  | Maturity   |
| ------------- | ------------------------- | ---------- | ------------------------ | ---------- |
| **MariaDB**   | mariadb-operator          | MIT        | Galera + MaxScale        | Production |
| **Valkey**    | valkey-operator (SAP)     | Apache 2.0 | Sentinel/Primary-Replica | Production |
| **RabbitMQ**  | cluster-operator          | MPL-2.0    | Native Clustering        | Production |
| **Memcached** | memcached-operator (C5C3) | Apache 2.0 | Anti-Affinity + PDB      | Production |

## OpenStack Service Dependencies

Representative dependencies of currently integrated services. Additional services use the same Infrastructure Operators:

| OpenStack Service | MariaDB | RabbitMQ | Valkey | Memcached       |
| ----------------- | ------- | -------- | ------ | --------------- |
| **Keystone**      | ✓       | -        | -      | ✓ (Token Cache) |
| **Nova**          | ✓       | ✓        | -      | -               |
| **Neutron**       | ✓       | ✓        | -      | -               |
| **Glance**        | ✓       | -        | -      | -               |
| **Cinder**        | ✓       | ✓        | -      | -               |
| **Placement**     | ✓       | -        | -      | -               |
| **Tempest**       | -       | -        | -      | -               |

## Further Reading

* [C5C3 Operator](./01-c5c3-operator.md) — Central orchestration operator
* [Service Operators](./02-service-operators.md) — Keystone, Glance, Placement, Nova, Neutron, Cinder
* [OVN Operator](./03-ovn-operator.md) — Cross-cluster SDN backend
* [Optional Services](./04-optional-services.md) — Cortex, Tempest, Labels Injector
* [K-ORC](./05-korc.md) — Declarative Keystone resource management
* [Infrastructure Operators](./06-infrastructure-operators.md) — MariaDB, Valkey, RabbitMQ, Memcached
* [Architecture Overview](../../02-architecture-overview.md)
