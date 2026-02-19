# Logging

## Logging Architecture

All components in CobaltCore log to stdout/stderr (12-Factor principle). A log shipper (DaemonSet) collects container logs from each node and forwards them to a central log store.

```text
┌─────────────────────────────────────────────────────────────────┐
│                      MANAGEMENT CLUSTER                         │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Central Log Store                            │  │
│  │           (Loki / OpenSearch)                             │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │  │
│  │  │ CP Logs     │  │ HV Logs     │  │ Mgmt Logs   │        │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘        │  │
│  └────────▲──────────────────▲──────────────────▲────────────┘  │
│           │                  │                  │               │
└───────────┼──────────────────┼──────────────────┼───────────────┘
            │                  │                  │
   ┌────────┘                  │                  └────────┐
   │                           │                           │
┌──┴──────────────┐  ┌─────────┴────────┐  ┌───────────────┴─┐
│ CONTROL PLANE   │  │ HYPERVISOR       │  │ MANAGEMENT      │
│                 │  │                  │  │                 │
│ Fluent Bit      │  │ Fluent Bit       │  │ Fluent Bit      │
│ (DaemonSet)     │  │ (DaemonSet)      │  │ (DaemonSet)     │
│                 │  │                  │  │                 │
│ Container Logs: │  │ Container Logs:  │  │ Container Logs: │
│ • OS Services   │  │ • Agent Logs     │  │ • Greenhouse    │
│ • Infra         │  │ • LibVirt        │  │ • FluxCD        │
│ • OVN           │  │ • OVS            │  │ • ESO           │
└─────────────────┘  └──────────────────┘  └─────────────────┘
```

## OpenStack Service Logs

### Log Format

All OpenStack services use `oslo.log` as logging framework. The standard format is:

```text
%(asctime)s.%(msecs)03d %(process)d %(levelname)s %(name)s [%(global_request_id)s %(request_id)s] %(message)s
```

**Example:**

```text
2025-06-15 14:23:01.042 7 INFO keystone.auth [req-abc-123 - - - - -] Authentication successful for user admin
```

The `request_id` and `global_request_id` enable correlation of logs across service boundaries.

### Service Logs per Operator

| Service   | Log Source                     | Typical Log Contents                           |
| --------- | ------------------------------ | ---------------------------------------------- |
| Keystone  | keystone-api Pod               | Auth events, token validation, federation      |
| Nova      | nova-api, nova-conductor Pods  | VM lifecycle, scheduling decisions, migrations |
| Neutron   | neutron-server Pod             | Network/subnet/port CRUD, L3 agent events      |
| Glance    | glance-api Pod                 | Image upload/download, format conversion       |
| Cinder    | cinder-api, cinder-volume Pods | Volume lifecycle, attach/detach, snapshots     |
| Placement | placement-api Pod              | Resource provider updates, allocation claims   |

## Infrastructure Logs

| Component | Log Source                 | Description                                       |
| --------- | -------------------------- | ------------------------------------------------- |
| MariaDB   | MariaDB Pods (Galera)      | Slow queries, replication status, connection pool |
| RabbitMQ  | RabbitMQ Pods              | Queue events, connection lifecycle, cluster state |
| Valkey    | Valkey Pods (Sentinel)     | Failover events, memory warnings, client errors   |
| OVN       | ovn-northd, ovn-controller | Logical flow updates, chassis registration        |
| Memcached | Memcached Pods             | Eviction events, connection limits                |

## Hypervisor Logs

| Log Source              | Description                                                                     |
| ----------------------- | ------------------------------------------------------------------------------- |
| Hypervisor Node Agent   | Node lifecycle, resource discovery                                              |
| OVS Agent               | Bridge configuration, flow programming                                          |
| HA Agent                | Failure detection, evacuation trigger                                           |
| Nova Compute Agent      | VM operations, live migration, resize                                           |
| ovn-controller          | Local flow programming, chassis events                                          |
| LibVirt                 | Domain events, emulator logs — see [LibVirt Telemetry](04-libvirt-telemetry.md) |

## Log Collection Pipeline

### Fluent Bit (DaemonSet)

Fluent Bit runs as DaemonSet in each cluster and collects container logs from `/var/log/containers/`.

**Pipeline:**

1. **Input:** Tail plugin reads container log files
2. **Parser:** JSON / CRI parser for container runtime format
3. **Filter:** Kubernetes metadata enrichment (pod name, namespace, labels)
4. **Output:** Forward to central log store in Management Cluster

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
spec:
  selector:
    matchLabels:
      app: fluent-bit
  template:
    metadata:
      labels:
        app: fluent-bit
    spec:
      containers:
        - name: fluent-bit
          image: fluent/fluent-bit:latest
          volumeMounts:
            - name: varlog
              mountPath: /var/log
              readOnly: true
            - name: config
              mountPath: /fluent-bit/etc
      volumes:
        - name: varlog
          hostPath:
            path: /var/log
        - name: config
          configMap:
            name: fluent-bit-config
```

**Fluent Bit Configuration (excerpt):**

```text
[INPUT]
    Name              tail
    Path              /var/log/containers/*.log
    Parser            cri
    Tag               kube.*
    Refresh_Interval  5
    Mem_Buf_Limit     50MB

[FILTER]
    Name                kubernetes
    Match               kube.*
    Kube_URL            https://kubernetes.default.svc:443
    Merge_Log           On
    Keep_Log            Off

[OUTPUT]
    Name                forward
    Match               *
    Host                log-aggregator.management.svc
    Port                24224
    tls                 On
```

## Central Log Store

The central log store in the Management Cluster receives logs from all clusters. Two options:

| Option     | Description                                      | Advantages                  |
| ---------- | ------------------------------------------------ | --------------------------- |
| Loki       | Log aggregation optimized for labels and Grafana | Lightweight, Grafana-native |
| OpenSearch | Full-text search engine with dashboards          | Powerful search, own UI     |

The choice of backend is deployment-specific. Both options integrate via Greenhouse dashboards.

## Audit Logging

### Kubernetes Audit Logs

Kubernetes Audit Logging captures API server requests and is configured via the audit policy. Audit logs are fed into the same log pipeline.

### OpenStack Audit Logs

OpenStack services support CADF-compliant audit logging via `oslo.messaging` notifications:

* **Keystone:** Authentication events, token creation, role assignments
* **Nova:** VM create/delete/migrate, flavor changes
* **Neutron:** Network/subnet/port operations, security group rules

Audit events are treated as separate log streams and can be routed to a dedicated index/tenant in the log store.

***
