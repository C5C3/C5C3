# Infrastructure Service Operators

**Runs in:** Control Plane Cluster
**Deployment:** Via FluxCD (HelmRelease)
**Instance Creation:** By c5c3-operator (creates CRs)

The OpenStack Control Plane requires several infrastructure services as backend. The **Operators** are deployed separately via FluxCD, while the **c5c3-operator** creates and manages the corresponding **Custom Resources** (instances).

```text
┌───────────────────────────────────────────────────────────────────┐
│           Infrastructure Services (Control Plane Cluster)         │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  FluxCD deployed Operators:                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐ │
│  │   MariaDB   │  │   Valkey    │  │  RabbitMQ   │  │ Memcached │ │
│  │  Operator   │  │  Operator   │  │  Cluster +  │  │ Operator  │ │
│  │ (HelmRelease│  │ (HelmRelease│  │  Topology   │  │(HelmRel.) │ │
│  │             │  │             │  │  Operators  │  │           │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘ │
│         │                │                │              │        │
│         │  watched CRs   │  watched CRs   │  watched CRs │        │
│         │                │                │              │        │
│  c5c3-operator creates:                                           │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼─────┐ │
│  │   MariaDB   │  │   Valkey    │  │ RabbitmqCl. │  │ Memcached │ │
│  │     CR      │  │     CR      │  │     CR      │  │    CR     │ │
│  │             │  │             │  │             │  │           │ │
│  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │  │┌─────────┐│ │
│  │ │ Galera  │ │  │ │Sentinel │ │  │ │ Cluster │ │  ││Deploym. ││ │
│  │ │ Cluster │ │  │ │+ Valkey │ │  │ │  Nodes  │ │  ││+ Service││ │
│  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │  │└─────────┘│ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘ │
│         │                │                │              │        │
│         └────────────────┴────────┬───────┴──────────────┘        │
│                                   │                               │
│                                   ▼                               │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │      OpenStack Services (via dedicated Service-Operators)   │  │
│  │  Nova, Neutron, Keystone, Glance, Cinder, Placement         │  │
│  │                                                             │  │
│  │  Service operators create Topology CRs (Vhost, User,        │  │
│  │  Permission) via the Messaging Topology Operator             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## MariaDB Operator

**Repository:** `github.com/mariadb-operator/mariadb-operator`
**License:** MIT

The MariaDB Operator enables declarative management of MariaDB clusters with high availability.

**Key Features:**

* **Galera Clustering**: Synchronous multi-master replication
* **MaxScale Integration**: Proxy, load balancing, automatic failover
* **Backup & Restore**: mariadb-backup, mariadb-dump, S3-compatible backends
* **Point-in-Time Recovery**: Restore to specific point in time
* **TLS**: Integrated cert-manager support
* **Monitoring**: mysqld-exporter for Prometheus

**Example:**

```yaml
apiVersion: k8s.mariadb.com/v1alpha1
kind: MariaDB
metadata:
  name: openstack-db
spec:
  replicas: 3
  galera:
    enabled: true
  maxScale:
    enabled: true
    replicas: 2
  storage:
    size: 100Gi
    storageClassName: ceph-rbd
  metrics:
    enabled: true
```

## Valkey Operator (SAP)

**Repository:** `github.com/SAP/valkey-operator`
**Helm Chart:** `github.com/SAP/valkey-operator-helm`
**License:** Apache 2.0

The Valkey Operator (SAP) enables declarative Valkey deployments with Sentinel-based failover via a single `Valkey` CRD.

**Key Features:**

* **Sentinel Mode**: Automatic failover with Sentinel sidecars
* **Primary-Replica Mode**: Static topology without Sentinel
* **TLS**: Self-signed or cert-manager integration
* **AOF Persistence**: Configurable StorageClasses (immutable after creation)
* **Monitoring**: redis-exporter sidecar (Port 9121) with ServiceMonitor/PrometheusRule
* **Binding Secret**: Automatic generation of connection information

**Example (Sentinel Mode for OpenStack):**

```yaml
apiVersion: cache.cs.sap.com/v1alpha1
kind: Valkey
metadata:
  name: openstack-valkey
spec:
  replicas: 3
  sentinel:
    enabled: true
  tls:
    enabled: true
  metrics:
    enabled: true
    monitor:
      enabled: true
```

## RabbitMQ Cluster Operator

**Repository:** `github.com/rabbitmq/cluster-operator`
**License:** MPL-2.0 (official from Broadcom/VMware)

The official RabbitMQ Operator for Kubernetes with comprehensive lifecycle management. The c5c3-operator creates a `RabbitmqCluster` CR; the Cluster Operator provisions the underlying cluster.

**Key Features:**

* **Cluster Formation**: Automatic cluster creation and management
* **Graceful Upgrades**: Rolling updates without downtime
* **Observability**: Integrated monitoring and logging
* **TLS**: Encrypted communication

**Example:**

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: openstack-rabbitmq
spec:
  replicas: 3
  resources:
    requests:
      memory: 2Gi
      cpu: 1000m
  persistence:
    storageClassName: ceph-rbd
    storage: 50Gi
  rabbitmq:
    additionalConfig: |
      cluster_partition_handling = pause_minority
```

## RabbitMQ Messaging Topology Operator

**Repository:** `github.com/rabbitmq/messaging-topology-operator`
**Documentation:** [Using the RabbitMQ Topology Operator](https://www.rabbitmq.com/kubernetes/operator/using-topology-operator)
**License:** MPL-2.0 (official from Broadcom/VMware)
**Requires:** RabbitMQ Cluster Operator >= 2.0.0

The Messaging Topology Operator manages RabbitMQ resources (vhosts, users, permissions, queues, exchanges, bindings, policies) as Kubernetes CRDs. In CobaltCore, **service operators use the Topology Operator to declaratively provision per-service messaging resources** — replacing imperative bootstrap jobs.

**CRDs provided by the Topology Operator:**

| CRD | API Group | Description |
| --- | --- | --- |
| `Vhost` | `rabbitmq.com/v1beta1` | Virtual host isolation per service |
| `User` | `rabbitmq.com/v1beta1` | RabbitMQ user with auto-generated or provided credentials |
| `Permission` | `rabbitmq.com/v1beta1` | User permissions (configure, write, read) per vhost |
| `Queue` | `rabbitmq.com/v1beta1` | Queue declaration (durable, autoDelete, arguments) |
| `Exchange` | `rabbitmq.com/v1beta1` | Exchange declaration (direct, fanout, topic, headers) |
| `Binding` | `rabbitmq.com/v1beta1` | Binding between exchanges and queues |
| `Policy` | `rabbitmq.com/v1beta1` | Policies applied to queues/exchanges matching a pattern |

**Key Features:**

* **Declarative Resource Management**: Vhosts, users, permissions, queues, exchanges, and bindings as Kubernetes CRs
* **GitOps-Native**: All messaging topology is version-controlled and reconciled by FluxCD
* **Managed + Brownfield**: Supports operator-managed clusters (via `rabbitmqClusterReference`) and external instances (via connection Secret)
* **Immutable Fields**: Queue name, vhost, and cluster reference are immutable after creation — prevents accidental data loss
* **Deletion Policy**: `delete` (default) removes the RabbitMQ resource on CR deletion; `retain` preserves it
* **Cross-Namespace**: Controlled via `rabbitmq.com/topology-allowed-namespaces` annotation on the `RabbitmqCluster`

**CobaltCore Usage Pattern:**

Each service operator (Nova, Neutron, Cinder) creates Topology CRs for its own messaging resources via the shared `messaging/` library (see [Shared Library](../../09-implementation/02-shared-library.md)):

```text
Service Operator                 Topology Operator            RabbitMQ Cluster
─────────────────               ──────────────────           ────────────────
                                                              (provisioned by
                                                               Cluster Operator)
nova-operator ──────────────▶  Vhost CR (nova)
              ──────────────▶  User CR (nova)        ──▶     vhost: /nova
              ──────────────▶  Permission CR (nova)          user: nova (rw)

neutron-operator ───────────▶  Vhost CR (neutron)
                 ───────────▶  User CR (neutron)     ──▶     vhost: /neutron
                 ───────────▶  Permission CR (neutron)       user: neutron (rw)

cinder-operator ────────────▶  Vhost CR (cinder)
                ────────────▶  User CR (cinder)      ──▶     vhost: /cinder
                ────────────▶  Permission CR (cinder)        user: cinder (rw)
```

**Example — Per-Service Topology CRs (Nova):**

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: Vhost
metadata:
  name: nova-vhost
  namespace: openstack
spec:
  name: nova
  rabbitmqClusterReference:
    name: openstack-rabbitmq
---
apiVersion: rabbitmq.com/v1beta1
kind: User
metadata:
  name: nova-rabbitmq-user
  namespace: openstack
spec:
  rabbitmqClusterReference:
    name: openstack-rabbitmq
  importCredentialsSecret:
    name: nova-rabbitmq-credentials    # ESO-provided from OpenBao
---
apiVersion: rabbitmq.com/v1beta1
kind: Permission
metadata:
  name: nova-rabbitmq-permission
  namespace: openstack
spec:
  vhost: nova
  userReference:
    name: nova-rabbitmq-user
  permissions:
    configure: ".*"
    write: ".*"
    read: ".*"
  rabbitmqClusterReference:
    name: openstack-rabbitmq
```

**Brownfield Mode:**

For external RabbitMQ instances not managed by the Cluster Operator, the Topology Operator connects via a Kubernetes Secret containing management API credentials:

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: Vhost
metadata:
  name: nova-vhost
spec:
  name: nova
  rabbitmqClusterReference:
    connectionSecret:
      name: external-rabbitmq-connection   # contains uri, username, password
```

**Important Constraints:**

* The Topology Operator does **not** monitor Kubernetes Secrets for credential changes — update the CR metadata to trigger reconciliation
* Queue properties cannot be modified after creation — use `Policy` CRs instead
* Clusters deployed with imported definitions are not supported (imported credentials overwrite the default user secret)

## Memcached Operator

**Repository:** [`github.com/C5C3/memcached-operator`](https://github.com/C5C3/memcached-operator)
**License:** Apache 2.0

The Memcached Operator enables declarative management of Memcached instances with support for high availability, TLS, monitoring, and security policies.

**Key Features:**

* **Declarative Management**: `Memcached` CR defines desired cluster state
* **High Availability**: Pod anti-affinity, topology spreading, PodDisruptionBudgets
* **Monitoring**: Prometheus exporter sidecar with ServiceMonitor support
* **Security**: TLS encryption, SASL authentication, NetworkPolicy
* **Headless Service**: DNS-based pod discovery for pymemcache HashClient

**Example (Memcached CR):**

```yaml
apiVersion: memcached.c5c3.io/v1alpha1
kind: Memcached
metadata:
  name: openstack-memcached
spec:
  replicas: 3
  image: memcached:1.6
  config:
    maxMemoryMB: 1024
    maxConnections: 4096
  resources:
    requests:
      memory: 1Gi
      cpu: 500m
  highAvailability:
    podAntiAffinity: soft
    podDisruptionBudget:
      minAvailable: 2
  monitoring:
    enabled: true
    exporter:
      image: prom/memcached-exporter:latest
```

## Further Reading

* [C5C3 Operator](./01-c5c3-operator.md) — Creates infrastructure CRs
* [Service Operators](./02-service-operators.md) — OpenStack services that consume these infrastructure backends
* [Control Plane Overview](./) — Service dependency matrix
