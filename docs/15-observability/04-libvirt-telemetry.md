# LibVirt Telemetry

This document describes the telemetry signals originating directly from LibVirt/QEMU on the Hypervisor nodes: Metrics, logs, and events.

> **Note:** LibVirt exists in two operating models — see [Hypervisor](../03-components/02-hypervisor.md) for details. The telemetry integration differs depending on the model.

## Operating Model Differences

| Aspect             | GardenLinux-provided                       | c5c3-managed (containerized)                       |
| ------------------ | ------------------------------------------ | -------------------------------------------------- |
| LibVirt Logs       | Systemd Journal on the host (`journalctl`) | Container stdout/stderr (standard log pipeline)    |
| QEMU Logs          | `/var/log/libvirt/qemu/` on the host       | Volume mount or container stdout                   |
| Metrics Access     | libvirt-exporter connects to host daemon   | libvirt-exporter in the same pod or as sidecar     |
| Event Subscription | HA Agent connects via TCP to host          | HA Agent connects via TCP to container             |
| Log Collection     | Fluent Bit reads host paths + journal      | Fluent Bit collects container logs (standard path) |

## libvirt-exporter

The libvirt-exporter exports per-VM metrics as Prometheus metrics. It connects to the local `libvirtd` and queries domain statistics.

### Metrics

| Metric                                      | Description                         | Labels                  |
| ------------------------------------------- | ----------------------------------- | ----------------------- |
| `libvirt_domain_info_vcpus`                 | Number of assigned vCPUs            | domain, uuid            |
| `libvirt_domain_info_memory_bytes`          | Assigned memory                     | domain, uuid            |
| `libvirt_domain_vcpu_time_seconds_total`    | CPU time per vCPU                   | domain, uuid, vcpu      |
| `libvirt_domain_memory_usage_bytes`         | Actual memory usage                 | domain, uuid            |
| `libvirt_domain_block_read_bytes_total`     | Disk read bytes                     | domain, uuid, device    |
| `libvirt_domain_block_write_bytes_total`    | Disk write bytes                    | domain, uuid, device    |
| `libvirt_domain_block_read_requests_total`  | Disk read IOPS                      | domain, uuid, device    |
| `libvirt_domain_block_write_requests_total` | Disk write IOPS                     | domain, uuid, device    |
| `libvirt_domain_net_receive_bytes_total`    | Network receive bytes               | domain, uuid, interface |
| `libvirt_domain_net_transmit_bytes_total`   | Network transmit bytes              | domain, uuid, interface |
| `libvirt_domain_net_receive_packets_total`  | Network receive packets             | domain, uuid, interface |
| `libvirt_domain_net_transmit_packets_total` | Network transmit packets            | domain, uuid, interface |
| `libvirt_domain_net_receive_errors_total`   | Network receive errors              | domain, uuid, interface |
| `libvirt_domain_net_transmit_drops_total`   | Network transmit drops              | domain, uuid, interface |
| `libvirt_up`                                | Reachability of the libvirtd daemon |                         |

### DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: libvirt-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: libvirt-exporter
  template:
    metadata:
      labels:
        app: libvirt-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9177"
    spec:
      nodeSelector:
        node-role.kubernetes.io/hypervisor: ""
      containers:
        - name: libvirt-exporter
          image: ghcr.io/c5c3/libvirt-exporter:latest
          args:
            - --libvirt.uri=qemu+tcp://$(NODE_IP):16509/system
          env:
            - name: NODE_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP
          ports:
            - containerPort: 9177
              name: metrics
          resources:
            requests:
              memory: 64Mi
              cpu: 25m
            limits:
              memory: 128Mi
              cpu: 100m
```

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: libvirt-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: libvirt-exporter
  endpoints:
    - port: metrics
      interval: 30s
```

## LibVirt Logging

### GardenLinux-provided

When LibVirt is provided by the host OS, logs end up in the following locations:

| Log Source    | Path                                 | Description                         |
| ------------- | ------------------------------------ | ----------------------------------- |
| libvirtd      | Systemd Journal (`libvirtd.service`) | Daemon events, connection lifecycle |
| QEMU (per VM) | `/var/log/libvirt/qemu/<domain>.log` | Emulator startup, errors, chardev   |

Fluent Bit must be configured for this model to read both the systemd journal and host paths:

```text
[INPUT]
    Name            systemd
    Tag             host.libvirtd
    Systemd_Filter  _SYSTEMD_UNIT=libvirtd.service

[INPUT]
    Name            tail
    Tag             host.qemu.*
    Path            /var/log/libvirt/qemu/*.log
    Parser          syslog
```

### c5c3-managed (containerized)

When LibVirt runs as a container, logging follows the standard container model:

* `libvirtd` logs to container stdout/stderr
* QEMU logs are redirected to container stdout or provided via a volume
* Fluent Bit collects logs via the standard container log pipeline (`/var/log/containers/`)

No additional Fluent Bit configuration required.

## LibVirt Events

The HA Agent subscribes to LibVirt domain events via the libvirt Event API. These events are a telemetry source for failure detection.

**Monitored Event Types:**

| Event Type          | Description                   | Action                          |
| ------------------- | ----------------------------- | ------------------------------- |
| Lifecycle (Stopped) | VM unexpectedly stopped       | Create Eviction CRD             |
| Lifecycle (Crashed) | VM crashed                    | Create Eviction CRD             |
| Watchdog            | QEMU watchdog timer triggered | Create Eviction CRD             |
| I/O Error           | Disk I/O error in VM          | Log event, possibly Eviction    |
| Reboot              | VM reboot requested           | Status update in Hypervisor CRD |

See [High Availability](../07-high-availability.md) for the complete failure detection and evacuation architecture.

### Event Flow

```text
libvirtd ──▶ HA Agent ──▶ Kubernetes API ──▶ Hypervisor Operator
             (Event       (Eviction CRD)     (Evacuation Logic)
              Listener)
```

The HA Agent connects via TCP to the LibVirt daemon (`qemu+tcp://<host>:16509/system`) and registers event callbacks. On relevant events, it creates `Eviction` CRDs that are processed by the Hypervisor Operator.

***
