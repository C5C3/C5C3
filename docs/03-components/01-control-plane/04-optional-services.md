# Optional Services

These operators provide optional capabilities that extend the core OpenStack deployment. They must be explicitly enabled in the [ControlPlane CR](./01-c5c3-operator.md).

## Cortex Operator (Optional)

**Repository:** `github.com/c5c3/c5c3/operators/cortex`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **cortex-operator** manages the optional Cortex Intelligent Scheduler for multi-domain resource placement.

**Provided CRDs:**

| CRD      | API Group                 | Description                 |
| -------- | ------------------------- | --------------------------- |
| `Cortex` | `cortex.c5c3.io/v1alpha1` | Cortex Scheduler Deployment |

**Cortex CRD:**

```yaml
apiVersion: cortex.c5c3.io/v1alpha1
kind: Cortex
metadata:
  name: cortex
  namespace: openstack
spec:
  replicas: 2

  image:
    repository: ghcr.io/c5c3/cortex
    tag: "0.5.0"

  # PostgreSQL for Datasource Storage
  database:
    clusterRef:
      name: postgresql             # Managed: references PostgreSQL CR
    # host: external-db.example.com  # Brownfield alternative
    database: cortex
    secretRef:
      name: cortex-db-credentials

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    appCredentialRef:
      name: cortex-app-credential-secret

  # Enabled Pipelines
  pipelines:
    nova:
      enabled: true
      # Filter and Weigher Configuration
      filters:
        - name: AvailabilityZoneFilter
        - name: ComputeCapabilitiesFilter
      weighers:
        - name: RAMWeigher
          weight: 1.0
        - name: CPUWeigher
          weight: 1.0
    cinder:
      enabled: true

  # Datasources
  datasources:
    prometheus:
      enabled: true
      endpoint: http://prometheus.monitoring:9090
    nova:
      enabled: true
      endpoint: https://nova.openstack.svc.cluster.local:8774

  dependsOn:
    - kind: Nova
      name: nova
      condition: Ready
    - kind: Cinder
      name: cinder
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: PipelinesReady
      status: "True"
  endpoint: https://cortex.openstack.svc.cluster.local:8080
  activePipelines:
    - nova
    - cinder
```

**Integration with Nova (External Scheduler Delegation):**

```text
┌─────────────────────────────────────────────────────────────────┐
│                Nova External Scheduler Flow                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Filtering Phase (Nova)                                      │
│     Nova filters possible compute hosts                         │
│                     │                                           │
│                     ▼                                           │
│  2. Weighing Phase (Nova)                                       │
│     Nova ranks remaining hosts                                  │
│                     │                                           │
│                     ▼                                           │
│  3. External Scheduler (Cortex)                                 │
│     POST /scheduler/nova/external                               │
│     Cortex re-ranks with Pipeline logic (KPIs, Knowledges)      │
│                     │                                           │
│                     ▼                                           │
│  4. Scheduling Phase (Nova)                                     │
│     Nova places VM on highest ranked host                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

> **Note:** Cortex is optional and must be explicitly enabled. Detailed Cortex documentation see section [Cortex Scheduling](../../04-architecture/05-cortex-scheduling.md).


## Tempest Operator (Optional)

**Repository:** `github.com/c5c3/c5c3/operators/tempest`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **tempest-operator** enables recurring OpenStack integration tests with [Tempest](https://github.com/openstack/tempest). It creates CronJobs that automatically execute Tempest test runs against the deployed OpenStack services and provides the results as status in the CR.

**Provided CRDs:**

| CRD       | API Group                            | Description                 |
| --------- | ------------------------------------ | --------------------------- |
| `Tempest` | `tempest.openstack.c5c3.io/v1alpha1` | Tempest Integration Testing |

**Tempest CRD:**

```yaml
apiVersion: tempest.openstack.c5c3.io/v1alpha1
kind: Tempest
metadata:
  name: tempest
  namespace: openstack
spec:
  # CronJob schedule for recurring test runs
  schedule: "0 2 * * *"  # Nightly at 02:00

  image:
    repository: ghcr.io/c5c3/tempest
    tag: "41.0.0"

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    appCredentialRef:
      name: tempest-app-credential-secret

  # Test run configuration
  tests:
    # Services to test
    services:
      - compute
      - network
      - volume
      - image
      - identity
    # Parallel test execution
    concurrency: 4
    # Regex filter for tests
    includeRegex: "tempest\\.(api|scenario)"
    excludeRegex: "tempest\\.api\\..*\\btest_.*slow"

  dependsOn:
    - kind: Nova
      name: nova
      condition: Ready
    - kind: Neutron
      name: neutron
      condition: Ready
    - kind: Cinder
      name: cinder
      condition: Ready
    - kind: Glance
      name: glance
      condition: Ready
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: TestsPassed
      status: "True"
  lastRun: "2024-01-16T02:00:00Z"
  lastDuration: "45m12s"
  results:
    passedTests: 1247
    failedTests: 0
    skippedTests: 23
    totalTests: 1270
```

**Tempest Test Flow:**

```text
┌─────────────────────────────────────────────────────────────────┐
│                    Tempest Test Flow                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Schedule (CronJob)                                          │
│     CronJob triggers test run on schedule                       │
│                     │                                           │
│                     ▼                                           │
│  2. Job (Kubernetes Job)                                        │
│     Tempest container is started                                │
│                     │                                           │
│                     ▼                                           │
│  3. Tests (Tempest Runner)                                      │
│     API and scenario tests against OpenStack services           │
│     ├── Identity (Keystone)                                     │
│     ├── Compute (Nova)                                          │
│     ├── Network (Neutron)                                       │
│     ├── Block Storage (Cinder)                                  │
│     └── Image (Glance)                                          │
│                     │                                           │
│                     ▼                                           │
│  4. Report (Status Update)                                      │
│     Results are stored in Tempest CR status                     │
│     └── passedTests, failedTests, skippedTests, lastRun         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

> **Note:** Tempest is optional and must be explicitly enabled. It requires that all tested OpenStack services are already successfully deployed and Ready.



## Labels Injector

**Repository:** `github.com/cobaltcore-dev/labels-injector`
**Runs in:** Hypervisor Cluster (Deployment)

A lightweight Kubernetes controller that **automatically synchronizes labels from Nodes to Pods**. This enables pods to access important infrastructure metadata.

**Synchronized Labels:**

```text
kubernetes.metal.cloud.sap/name      # Node identifier
kubernetes.metal.cloud.sap/cluster   # Cluster affiliation
kubernetes.metal.cloud.sap/bb        # Baremetal block/group
topology.kubernetes.io/region        # Regional topology
topology.kubernetes.io/zone          # Zone topology
```

**Architecture:**

```text
┌───────────────────────────────────────────────────────────────────┐
│                       Labels Injector                             │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌────────────────────────┐    ┌────────────────────────┐         │
│  │  ValidatingWebhook     │    │  Pod Reconciler        │         │
│  │  (Real-time)           │    │  (Background)          │         │
│  │                        │    │                        │         │
│  │  Intercepts:           │    │  Watches: Pods         │         │
│  │  pods/binding          │    │  Reconciles: All Pods  │         │
│  │                        │    │  on Startup            │         │
│  └───────────┬────────────┘    └───────────┬────────────┘         │
│              │                             │                      │
│              └─────────────┬───────────────┘                      │
│                            │                                      │
│                            ▼                                      │
│               ┌─────────────────────────┐                         │
│               │    Label Transfer       │                         │
│               │                         │                         │
│               │  Node Labels ────▶ Pod Labels                     │
│               │  (Strategic Merge Patch)│                         │
│               └─────────────────────────┘                         │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Dual-Injection Mechanism:**

1. **Webhook-based (Real-time)**: ValidatingWebhook on `pods/binding` - injects labels during scheduling
2. **Controller-based (Reconciliation)**: Background synchronization for existing pods

**Configuration:**

* No CRDs required (works with native K8s resources)
* Webhook: `failurePolicy: Ignore` (non-blocking)
* Minimal RBAC: `nodes [get,list,watch]`, `pods [get,list,watch,patch]`

**Use Cases in CobaltCore:**

* Automatic pod metadata propagation without manual configuration
* Topology-aware scheduling (Region/Zone)
* Operational traceability (which pod runs on which physical node)
* Integration with metal cloud management systems

## Further Reading

* [Cortex Scheduling](../../04-architecture/05-cortex-scheduling.md) — Detailed Cortex architecture and pipeline design
* [Service Operators](./02-service-operators.md) — Core services that Cortex and Tempest depend on
* [Hypervisor](../02-hypervisor.md) — Hypervisor cluster where Labels Injector runs
