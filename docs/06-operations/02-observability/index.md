# Observability

This chapter describes the observability architecture of CobaltCore: Metrics, Logging, Tracing, and LibVirt telemetry.

**Scope:** Control Plane Cluster, Hypervisor Cluster, and Management Cluster. Storage Cluster telemetry (Prysm) is not covered in this chapter — see [Prysm](../../03-components/04-storage.md) for Storage observability. For the overall four-cluster topology, see [Architecture Overview](../../02-architecture-overview.md).

## Architecture Overview

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           MANAGEMENT CLUSTER (Hub)                               │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                          Greenhouse                                        │  │
│  │                                                                            │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │  │
│  │  │   Grafana    │  │ Alertmanager │  │   Loki /     │  │  Jaeger /    │    │  │
│  │  │  Dashboards  │  │              │  │  OpenSearch  │  │  Tempo       │    │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │  │
│  │         │                 │                 │                 │            │  │
│  │         └────────┬────────┴──────────┬──────┴──────────┬──────┘            │  │
│  │                  │                   │                 │                   │  │
│  │           Prometheus          Log Aggregation    Trace Collection          │  │
│  │          (Federation)          (central)          (central)                │  │
│  └──────────┬───────────────────┬───────────────────┬─────────────────────────┘  │
│             │                   │                   │                            │
│  ┌──────────┴───────────────────┴───────────────────┴─────────────────────────┐  │
│  │                     Prometheus (local)                                     │  │
│  │                     Fluent Bit / Vector                                    │  │
│  │                     OTEL Collector                                         │  │
│  └──────────┬─────────────────────────────────────────────────────────────────┘  │
└─────────────┼────────────────────────────────────────────────────────────────────┘
              │ Federation / Shipping / Export
              │
     ┌────────┴────────┬──────────────────┐
     │                 │                  │
     ▼                 ▼                  ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ CONTROL      │ │ HYPERVISOR   │ │ STORAGE      │
│ PLANE        │ │ CLUSTER      │ │ CLUSTER      │
│ CLUSTER      │ │              │ │              │
├──────────────┤ ├──────────────┤ │ (out of      │
│ Prometheus   │ │ Prometheus   │ │  scope,      │
│ Fluent Bit   │ │ Fluent Bit   │ │  see         │
│ OTEL Coll.   │ │ OTEL Coll.   │ │  Prysm)      │
│              │ │              │ │              │
│ Metrics:     │ │ Metrics:     │ └──────────────┘
│  Service Op. │ │  node-export │
│  MariaDB     │ │  libvirt-exp │
│  RabbitMQ    │ │  OVS Stats   │
│  Valkey      │ │              │
│              │ │ Logs:        │
│ Logs:        │ │  Agent Logs  │
│  OS Services │ │  LibVirt     │
│  Infra       │ │              │
│              │ │ Traces:      │
│ Traces:      │ │  Agent Spans │
│  API Spans   │ │              │
└──────────────┘ └──────────────┘
```

## Signal-Cluster Matrix

| Signal  | Control Plane Cluster                        | Hypervisor Cluster                              | Management Cluster                 |
| ------- | -------------------------------------------- | ----------------------------------------------- | ---------------------------------- |
| Metrics | Service Operators, MariaDB, RabbitMQ, Valkey | node-exporter, libvirt-exporter, OVS statistics | Greenhouse aggregation, federation |
| Logs    | OpenStack Services, Infrastructure logs      | Agent logs, LibVirt logs                        | Central log store                  |
| Traces  | API request traces (oslo.metrics, OTEL)      | Agent spans                                     | Trace backend (Jaeger / Tempo)     |

## Principles

* **Per-Signal Architecture:** Metrics, logs, and traces are treated as independent signals with dedicated pipelines per cluster.
* **Local Collection, Central Aggregation:** Each cluster collects telemetry locally. The Management Cluster aggregates across all clusters.
* **Greenhouse as Hub:** Greenhouse in the Management Cluster provides the central interface for dashboards, alerting, and correlation.

## Subchapters

| Document                                       | Description                                  |
| ---------------------------------------------- | -------------------------------------------- |
| [Metrics](./01-metrics.md)                     | Prometheus, Federation, Greenhouse, Alerting |
| [Logging](./02-logging.md)                     | OpenStack logs, centralization, audit        |
| [Tracing](./03-tracing.md)                     | OpenTelemetry, distributed tracing           |
| [LibVirt Telemetry](./04-libvirt-telemetry.md) | LibVirt metrics, logs, events                |
