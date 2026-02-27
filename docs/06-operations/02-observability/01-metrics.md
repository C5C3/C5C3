# Metrics

## Prometheus Architecture

Each cluster operates its own Prometheus instance that collects local metrics. The instances in the Control Plane and Hypervisor Cluster are aggregated to the Management Cluster via Prometheus Federation.

```text
┌─────────────────────────────────────────────────────────┐
│                    MANAGEMENT CLUSTER                       │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Prometheus (Federation)                               │  │
│  │                                                       │  │
│  │  federate?match[]={job=~".+"}                         │  │
│  │       ▲                ▲                              │  │
│  └───────┼────────────────┼──────────────────────────────┘  │
│          │                │                                 │
│  ┌───────┴────┐   ┌───────┴────┐                            │
│  │ Grafana    │   │Alertmanager│                            │
│  │ Dashboards │   │            │                            │
│  └────────────┘   └────────────┘                            │
└──────────┬────────────────┬─────────────────────────────────┘
           │                │
    ┌──────┘                └──────┐
    │                              │
    ▼                              ▼
┌──────────────────┐    ┌──────────────────┐
│ CONTROL PLANE    │    │ HYPERVISOR       │
│                  │    │                  │
│ Prometheus       │    │ Prometheus       │
│  └─ Service-     │    │  └─ node-        │
│     Monitor CRs  │    │     exporter     │
│                  │    │  └─ libvirt-     │
│ Targets:         │    │     exporter     │
│ • Service Ops    │    │  └─ OVS Stats    │
│ • MariaDB Exp.   │    │                  │
│ • RabbitMQ Exp.  │    │ Targets:         │
│ • Valkey Exp.    │    │ • Hypervisor Op. │
│ • Memcached Exp. │    │ • Hyp. Agents    │
│ • OVN Northd     │    │ • OVS Agents     │
│ • OS DB Exp. *   │    │                  │
│                  │    │                  │
└──────────────────┘    └──────────────────┘
```

## Control Plane Metrics

### OpenStack Service Operators

Each Service Operator exports Prometheus metrics via a `/metrics` endpoint. Metrics include reconcile duration, error counters, queue depth, and OpenStack API latency.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keystone-operator
  namespace: openstack
  labels:
    app.kubernetes.io/component: operator
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: keystone-operator
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Infrastructure Exporters

| Component | Exporter                   | Metrics                                         |
| --------- | -------------------------- | ----------------------------------------------- |
| MariaDB   | MariaDB Operator built-in  | Queries/s, Connections, Galera Replication Lag  |
| RabbitMQ  | RabbitMQ Operator built-in | Queue Depth, Message Rate, Consumer Count       |
| Valkey    | Valkey Exporter            | Memory Usage, Connected Clients, Keyspace Stats |
| Memcached | memcached-exporter         | Hit Rate, Evictions, Current Items              |
| OVN       | ovn-operator metrics       | Northbound DB Size, Southbound Connections      |

### OpenStack Resource Metrics

The Service Operator metrics above cover controller-level concerns (reconcile loops, error counters). To gain visibility into the actual state of OpenStack resources — instances, networks, quotas, service agents — the [OpenStack Database Exporter](https://github.com/vexxhost/openstack_database_exporter) queries the OpenStack databases directly instead of calling the OpenStack APIs.

**Why direct database access?** At scale, the OpenStack APIs become sluggish under high-frequency metric scraping. Direct SQL queries are far more efficient for operator-facing monitoring and avoid adding API load.

**Per-Service Architecture:** Each OpenStack service gets its own dedicated Database Exporter instance. This ensures least-privilege access (each exporter only holds credentials for a single database) and provides isolation — a failing exporter does not affect metrics collection for other services.

| Service   | Exporter Deployment                     | Example Metrics                                                               |
| --------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| Nova      | `openstack-database-exporter-nova`      | Instances by state/project/host, service status, compute node utilization     |
| Neutron   | `openstack-database-exporter-neutron`   | Agent status, networks, subnets, ports, floating IPs, quota usage per project |
| Cinder    | `openstack-database-exporter-cinder`    | Volume counts, snapshot status                                                |
| Glance    | `openstack-database-exporter-glance`    | Image counts and sizes                                                        |
| Keystone  | `openstack-database-exporter-keystone`  | Project and user counts                                                       |
| Heat      | `openstack-database-exporter-heat`      | Stack counts by status                                                        |
| Ironic    | `openstack-database-exporter-ironic`    | Node provisioning state                                                       |
| Octavia   | `openstack-database-exporter-octavia`   | Load balancer status                                                          |
| Placement | `openstack-database-exporter-placement` | Resource provider inventory and usage                                         |

**Deployment:** Each exporter runs as its own Deployment in the Control Plane Cluster. Database credentials are dynamic read-only credentials generated by the OpenBao Database Secret Engine (see [Secret Management](../../05-deployment/02-secret-management.md#database-secret-engine)). A dedicated read-only MariaDB user per service ensures that exporters cannot modify data.

```yaml
# Example: Nova Database Exporter ServiceMonitor
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: openstack-database-exporter-nova
  namespace: openstack
  labels:
    app.kubernetes.io/component: exporter
    app.kubernetes.io/part-of: openstack-database-exporter
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: openstack-database-exporter
      app.kubernetes.io/instance: nova
  endpoints:
    - port: metrics
      interval: 60s
      path: /metrics
```

Each exporter receives only the connection URL for its own database (e.g. `--nova.database-url` for the Nova exporter). The credential is mounted as a Kubernetes Secret created by ESO from the OpenBao Database Secret Engine path `database/mariadb/creds/<service>-ro`.

## Hypervisor Metrics

### node-exporter

Standard Prometheus node-exporter as DaemonSet on all Hypervisor nodes. Provides hardware and OS-level metrics.

**Important Metrics:**

* CPU utilization and saturation
* Memory utilization and huge pages
* Disk I/O and latency
* Network bandwidth and errors

### libvirt-exporter

Exports per-VM metrics directly from LibVirt. See [LibVirt Telemetry](./04-libvirt-telemetry.md) for details.

### OVS Flow Statistics

OVS metrics are collected by the OVS Agent and provided as Prometheus metrics:

* Flow count per bridge
* Packet/byte counters per port
* Datapath statistics

## Prometheus Federation

The Federation configuration in the Management Cluster scrapes selected metrics from the cluster-local Prometheus instances. The service addresses shown below are examples and must be adapted to the actual deployment topology.

```yaml
# Prometheus Federation Config (Management Cluster)
scrape_configs:
  - job_name: federation-control-plane
    honor_labels: true
    metrics_path: /federate
    params:
      match[]:
        - '{job=~"openstack-.+"}'
        - '{job=~"mariadb|rabbitmq|valkey"}'
        - '{job=~"openstack-database-exporter-.+"}'
    static_configs:
      - targets:
          - prometheus.control-plane.svc:9090
        labels:
          cluster: control-plane

  - job_name: federation-hypervisor
    honor_labels: true
    metrics_path: /federate
    params:
      match[]:
        - '{job="node-exporter"}'
        - '{job="libvirt-exporter"}'
        - '{job=~"ovs-.+"}'
    static_configs:
      - targets:
          - prometheus.hypervisor.svc:9090
        labels:
          cluster: hypervisor
```

## Greenhouse Integration

Greenhouse in the Management Cluster aggregates the federated metrics and provides them via Grafana dashboards:

* **Cluster Overview:** Health of all clusters at a glance
* **OpenStack Service Dashboards:** API latency, error rates, request volume per service
* **OpenStack Resource Dashboards:** Instance counts by state, quota utilization, agent health, network resource inventory
* **Hypervisor Dashboards:** Node utilization, VM density, overcommit ratio
* **Infrastructure Dashboards:** MariaDB Galera status, RabbitMQ queue health, Valkey memory

## Alerting

Alerting is handled via PrometheusRule resources and Alertmanager.

### PrometheusRule

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: openstack-alerts
  namespace: openstack
spec:
  groups:
    - name: openstack-service-health
      rules:
        - alert: KeystoneAPIHighLatency
          expr: |
            histogram_quantile(0.99, rate(openstack_api_request_duration_seconds_bucket{service="keystone"}[5m])) > 2
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Keystone API p99 latency over 2s"

        - alert: NovaComputeDown
          expr: |
            up{job="nova-compute"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Nova Compute Agent unreachable"

    - name: hypervisor-health
      rules:
        - alert: HypervisorHighMemoryUsage
          expr: |
            (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) > 0.9
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Hypervisor memory utilization over 90%"

        - alert: LibvirtDomainCPUSaturation
          expr: |
            rate(libvirt_domain_vcpu_time_seconds_total[5m]) > 0.95
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "VM vCPU near saturation"
```

### Alertmanager

Alertmanager is operated centrally in the Management Cluster and receives alerts from all Prometheus instances. Routing rules distribute alerts based on labels (`severity`, `cluster`, `service`) to corresponding channels (Slack, PagerDuty, email).
