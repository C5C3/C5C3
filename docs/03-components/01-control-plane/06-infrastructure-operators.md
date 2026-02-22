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
│  │  Operator   │  │  Operator   │  │  Operator   │  │ Operator  │ │
│  │ (HelmRelease│  │ (HelmRelease│  │ (HelmRelease│  │(HelmRel.) │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘ │
│         │                │                │              │        │
│         │  watched CRs   │  watched CRs   │  watched CRs │        │
│         │                │                │              │        │
│  c5c3-operator creates CRs:                                       │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼─────┐ │
│  │   MariaDB   │  │   Valkey    │  │  RabbitMQ   │  │ Memcached │ │
│  │     CR      │  │     CR      │  │     CR      │  │    CR     │ │
│  │             │  │             │  │             │  │           │ │
│  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │  │┌─────────┐│ │
│  │ │ Galera  │ │  │ │Sentinel │ │  │ │ Cluster │ │  ││Deploym. ││ │
│  │ │ Cluster │ │  │ │+ Valkey │ │  │ │  Nodes  │ │  ││+ Service││ │
│  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │  │└─────────┘│ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘ │
│         │                │                │              │        │
│         └────────────────┴────────────────┴──────────────┘        │
│                                   │                               │
│                                   ▼                               │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │      OpenStack Services (via dedicated Service-Operators)   │  │
│  │  Nova, Neutron, Keystone, Glance, Cinder, Placement         │  │
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

The official RabbitMQ Operator for Kubernetes with comprehensive lifecycle management.

**Key Features:**

* **Cluster Formation**: Automatic cluster creation and management
* **Graceful Upgrades**: Rolling updates without downtime
* **Policies & Users**: Declarative configuration via CRDs
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
