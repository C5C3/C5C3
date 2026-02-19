# Cortex Scheduling

**Repository:** `github.com/cobaltcore-dev/cortex`

Cortex is a **Kubernetes-native, modular scheduler** for multi-domain resource placement. It implements the **External Scheduler Delegation Pattern** for OpenStack and other platforms.

## Supported Scheduling Domains

| Domain                | Description                                    | API Endpoint                      |
| --------------------- | ---------------------------------------------- | --------------------------------- |
| **Nova**              | VM placement (KVM, Cloud Hypervisor & VMware)  | `POST /scheduler/nova/external`   |
| **Cinder**            | Block storage volumes                          | `POST /scheduler/cinder/external` |
| **Manila**            | Shared filesystems                             | `POST /scheduler/manila/external` |
| **IronCore Machines** | Bare-metal machines                            | K8s CRD-based                     |
| **Kubernetes Pods**   | Native pod scheduling                          | K8s CRD-based                     |

## Scheduler Delegation with Nova

```text
┌───────────────────────────────────────────────────────────────────┐
│                        Nova Scheduler                             │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. FILTERING PHASE                                               │
│     ┌───────────────────────────────────────────────────────┐     │
│     │ Retrieve all compute hosts                            │     │
│     │ Filter: RAM, CPU, Disk, Traits, Availability Zones    │     │
│     │ Result: List of possible hosts                        │     │
│     └───────────────────────────────────────────────────────┘     │
│                               │                                   │
│                               ▼                                   │
│  2. WEIGHING PHASE                                                │
│     ┌───────────────────────────────────────────────────────┐     │
│     │ Ranking based on:                                     │     │
│     │ - Resource Utilization                                │     │
│     │ - Configured Weights                                  │     │
│     │ Result: Weighted host list                            │     │
│     └───────────────────────────────────────────────────────┘     │
│                               │                                   │
│                               ▼                                   │
│  3. CORTEX DELEGATION (CobaltCore Extension)                      │
│     ┌───────────────────────────────────────────────────────┐     │
│     │         ┌──────────────────────────┐                  │     │
│     │         │        CORTEX            │                  │     │
│     │         │                          │                  │     │
│     │         │  Knowledge Database      │                  │     │
│     │ Hosts ─▶│  - Topology              │─▶ Optimized      │     │
│     │ Weights │  - Thermal Data          │   Host List      │     │
│     │         │  - Network Proximity     │                  │     │
│     │         │  - Failure Domains       │                  │     │
│     │         │  - Custom Constraints    │                  │     │
│     │         └──────────────────────────┘                  │     │
│     └───────────────────────────────────────────────────────┘     │
│                               │                                   │
│                               ▼                                   │
│  4. SCHEDULING PHASE                                              │
│     ┌───────────────────────────────────────────────────────┐     │
│     │ Place VM on highest ranked host                       │     │
│     │ On failure: Try next host                             │     │
│     └───────────────────────────────────────────────────────┘     │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## Cortex Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                       CORTEX (Control Plane Cluster)                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                     DATA ARCHITECTURE (3-Tier)                    │  │
│  │                                                                   │  │
│  │  DATASOURCES           KNOWLEDGES           KPIs                  │  │
│  │  (Raw Data Sync)       (Feature Extract)    (Prometheus)          │  │
│  │                                                                   │  │
│  │  ┌────────────┐       ┌────────────┐       ┌────────────┐         │  │
│  │  │ OpenStack  │──────▶│ Extracted  │──────▶│ Prometheus │         │  │
│  │  │ - Nova     │       │ Features   │       │ Metrics    │         │  │
│  │  │ - Placement│       │            │       │            │         │  │
│  │  │ - Cinder   │       │ Stored in  │       │ Dynamically│         │  │
│  │  │ - Manila   │       │ CRD Status │       │ generated  │         │  │
│  │  │ - Identity │       └────────────┘       └────────────┘         │  │
│  │  ├────────────┤                                                   │  │
│  │  │ Prometheus │       ┌────────────┐                              │  │
│  │  │ (Metrics)  │──────▶│ PostgreSQL │ ◀── Persistent Storage       │  │
│  │  └────────────┘       └────────────┘                              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                    │                                    │
│                                    ▼                                    │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                        PIPELINE ENGINE                            │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────┐  ┌─────────────────────────┐         │  │
│  │  │ FILTER-WEIGHER PIPELINE │  │ DETECTOR PIPELINE       │         │  │
│  │  │ (Initial Placement)     │  │ (Descheduling)          │         │  │
│  │  │                         │  │                         │         │  │
│  │  │ 1. Filters → Remove     │  │ 1. Detects problem      │         │  │
│  │  │ 2. Weighers → Score     │  │ 2. Creates Descheduling │         │  │
│  │  │ 3. Activation → Combine │  │ 3. Triggers Migration   │         │  │
│  │  │ 4. → Decision CRD       │  │                         │         │  │
│  │  └─────────────────────────┘  └─────────────────────────┘         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Cortex Custom Resource Definitions (CRDs)

Cortex defines **7 CRD types** in API group `cortex.c5c3.io/v1alpha1`:

### Data Collection

| CRD            | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| **Datasource** | Configuration of external data sources (OpenStack APIs, Prometheus) |
| **Knowledge**  | Extracted features from Datasources (stored in CRD status)          |
| **KPI**        | Prometheus metrics generated from Knowledge data                    |

### Scheduling

| CRD              | Description                                        |
| ---------------- | -------------------------------------------------- |
| **Pipeline**     | Definition of Filter-Weigher or Detector pipelines |
| **Decision**     | Scheduling decision with history and explanation   |
| **Descheduling** | Migration instruction for problematic VMs          |
| **Reservation**  | Capacity reservation for future workloads          |

### Example: Pipeline CRD

```yaml
apiVersion: cortex.c5c3.io/v1alpha1
kind: Pipeline
metadata:
  name: nova-kvm-pipeline
spec:
  type: filter-weigher
  schedulingDomain: nova
  createDecisions: true
  filters:
    - name: filter_has_enough_capacity
      params: {}
    - name: filter_correct_az
      params: {}
    - name: filter_instance_group_affinity
      params: {}
  weighers:
    - name: weigher_general_purpose_balancing
      multiplier: 1.0
    - name: weigher_avoid_long_term_contended_hosts
      multiplier: 1.5
status:
  conditions:
    - type: Ready
      status: "True"
    - type: AllStepsReady
      status: "True"
```

### Example: Datasource CRD (OpenStack)

```yaml
apiVersion: cortex.c5c3.io/v1alpha1
kind: Datasource
metadata:
  name: nova-hypervisors
spec:
  type: openstack
  schedulingDomain: nova
  openstack:
    type: nova
    syncInterval: "60s"
status:
  lastSynced: "2024-01-15T10:30:00Z"
  conditions:
    - type: Ready
      status: "True"
```

## Available Filter Plugins (Nova)

| Plugin                           | Description                    |
| -------------------------------- | ------------------------------ |
| `filter_allowed_projects`        | Enforces project quotas        |
| `filter_capabilities`            | Matches image properties       |
| `filter_correct_az`              | Zone/Aggregate constraints     |
| `filter_external_customer`       | External customer restrictions |
| `filter_has_accelerators`        | GPU/Accelerator requirements   |
| `filter_has_enough_capacity`     | Resource availability          |
| `filter_has_requested_traits`    | Placement traits               |
| `filter_host_instructions`       | Force/Ignore host lists        |
| `filter_instance_group_affinity` | VM affinity rules              |

## Available Weigher Plugins (VMware)

| Plugin                                    | Description                |
| ----------------------------------------- | -------------------------- |
| `vmware_hana_binpacking`                  | Tight packing for SAP HANA |
| `vmware_general_purpose_balancing`        | Load balancing             |
| `vmware_avoid_long_term_contended_hosts`  | Avoid chronic contention   |
| `vmware_avoid_short_term_contended_hosts` | Avoid temporary contention |
| `vmware_anti_affinity_noisy_projects`     | Noisy neighbor isolation   |

## CRD Relationships

```text
┌───────────────────────────────────────────────────────────────────────┐
│                        Cortex CRD Relationships                       │
│                                                                       │
│   Datasource ────▶ Knowledge ────▶ KPI ────▶ Prometheus Metrics       │
│       │               │                                               │
│       │               │                                               │
│       ▼               ▼                                               │
│   PostgreSQL     CRD Status                                           │
│   (Raw Data)     (Features)                                           │
│                                                                       │
│                                                                       │
│   Pipeline ─────────────────────────▶ Decision                        │
│       │                                   │                           │
│       │ (type: filter-weigher)            ├── orderedHosts            │
│       │                                   ├── stepResults             │
│       │                                   ├── history                 │
│       │                                   └── explanation             │
│       │                                                               │
│       │ (type: detector)                                              │
│       │                                                               │
│       └─────────────────────────────▶ Descheduling                    │
│                                           │                           │
│                                           ├── prevHost                │
│                                           ├── newHost                 │
│                                           └── reason                  │
│                                                                       │
│   Reservation                                                         │
│       │                                                               │
│       ├── requests (memory, cpu)                                      │
│       ├── host (reserved)                                             │
│       └── phase (active/failed)                                       │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

***
