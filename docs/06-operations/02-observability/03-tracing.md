# Tracing

## OpenTelemetry Architecture

Distributed tracing enables the tracking of requests across service and cluster boundaries. CobaltCore uses OpenTelemetry (OTEL) as the instrumentation and collection standard.

```text
┌─────────────────────────────────────────────────────────────────┐
│                      MANAGEMENT CLUSTER                         │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Tracing Backend                              │  │
│  │           (Jaeger / Grafana Tempo)                        │  │
│  │                                                           │  │
│  │  Trace Storage ◄── OTEL Collector (central)               │  │
│  │       │                    ▲                              │  │
│  │       ▼                    │                              │  │
│  │  Grafana / Jaeger UI       │                              │  │
│  └────────────────────────────┼──────────────────────────────┘  │
│                               │                                 │
└───────────────────────────────┼─────────────────────────────────┘
                                │  OTLP/gRPC
                   ┌────────────┴────────────┐
                   │                         │
┌──────────────────┴──┐  ┌───────────────────┴─┐
│ CONTROL PLANE       │  │ HYPERVISOR          │
│                     │  │                     │
│ OTEL Collector      │  │ OTEL Collector      │
│ (Gateway)           │  │ (Gateway)           │
│      ▲              │  │      ▲              │
│      │              │  │      │              │
│ ┌────┴────┐         │  │ ┌────┴────┐         │
│ │ Service │         │  │ │ Agent   │         │
│ │ Spans   │         │  │ │ Spans   │         │
│ └─────────┘         │  │ └─────────┘         │
│                     │  │                     │
│ Keystone API        │  │ Nova Compute        │
│ Nova API            │  │ OVS Agent           │
│ Neutron API         │  │ HA Agent            │
│ Glance API          │  │                     │
│ Cinder API          │  │                     │
└─────────────────────┘  └─────────────────────┘
```

## OTEL Collector Deployment

The OTEL Collector is operated as a gateway deployment in each cluster. It receives spans from local services, processes them, and exports them to the central collector in the Management Cluster.

### Collector Pipeline

| Stage      | Component                   | Description                               |
| ---------- | --------------------------- | ----------------------------------------- |
| Receivers  | OTLP (gRPC + HTTP)          | Receives spans from instrumented services |
| Processors | Batch, Resource, Attributes | Batching, add cluster labels, sampling    |
| Exporters  | OTLP (gRPC)                 | Forward to central collector              |

### OTEL Collector Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      batch:
        timeout: 5s
        send_batch_size: 1024

      resource:
        attributes:
          - key: cluster
            value: control-plane
            action: upsert

      tail_sampling:
        policies:
          - name: error-traces
            type: status_code
            status_code:
              status_codes:
                - ERROR
          - name: slow-traces
            type: latency
            latency:
              threshold_ms: 1000
          - name: probabilistic
            type: probabilistic
            probabilistic:
              sampling_percentage: 10  # Keep 10% of remaining traces

    exporters:
      otlp:
        endpoint: otel-collector.management.svc:4317
        tls:
          insecure: false

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [resource, tail_sampling, batch]
          exporters: [otlp]
```

### Kubernetes Deployment Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: observability
spec:
  replicas: 2
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
    spec:
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.115.0  # Pin to a specific version in production
          args:
            - --config=/etc/otel/config.yaml
          ports:
            - containerPort: 4317  # OTLP gRPC
            - containerPort: 4318  # OTLP HTTP
          volumeMounts:
            - name: config
              mountPath: /etc/otel
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
```

## OpenStack Service Instrumentation

OpenStack services can be instrumented via `oslo.metrics` and OTEL exporters:

| Instrumentation Method | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| oslo.metrics           | Built-in metrics framework, can generate OTEL spans           |
| WSGI Middleware        | OTEL middleware for API endpoints (automatic span generation) |
| oslo.messaging Tracing | Trace context propagation over RabbitMQ messages              |

<!-- TODO: Verify that oslo.metrics is the correct project name; may be oslo_metrics or a different upstream package -->

### Trace Context Propagation

OpenStack services propagate trace context via:

1. **HTTP Headers:** `traceparent` / `tracestate` (W3C Trace Context) between API calls
2. **RabbitMQ Message Headers:** Trace context in oslo.messaging message properties
3. **Global Request ID:** OpenStack-native `X-OpenStack-Request-Id` as correlation ID

## Tracing Backend

| Option        | Description                               | Integration                  |
| ------------- | ----------------------------------------- | ---------------------------- |
| Jaeger        | Dedicated tracing backend with its own UI | OTLP-native, standalone UI   |
| Grafana Tempo | Trace storage optimized for Grafana       | Seamless Grafana integration |

The choice of backend is deployment-specific. Both options support OTLP as the ingest protocol. See [Metrics](./01-metrics.md) for the related Prometheus and Greenhouse setup that complements tracing data.

## Cross-Cluster Trace Propagation

Traces can be correlated across cluster boundaries:

1. **Control Plane → Hypervisor:** Nova API → RabbitMQ → Nova Compute Agent. Trace context is propagated via oslo.messaging.
2. **Management → Control Plane:** Greenhouse API calls to OpenStack endpoints carry trace context via HTTP headers.

The central trace store in the Management Cluster collects spans from all clusters and enables visualization of complete request paths.
