# C5C3 Operator

The c5c3-operator is the central orchestration operator in CobaltCore. It reads a single `ControlPlane` CR and from it creates, configures, and monitors all infrastructure and OpenStack service CRs. This page documents the ControlPlane CRD, the orchestration reconciler, infrastructure lifecycle, service CR projection, K-ORC integration, and rollout strategy.

For the high-level architecture, see [Control Plane — C5C3 Operator](../03-components/01-control-plane.md#c5c3-operator). For CRD definitions, see [CRDs](../04-architecture/01-crds.md).

## Design Principle: Configuration Control Plane

The c5c3-operator serves as the **Configuration Control Plane** for CobaltCore — the single point that translates a high-level desired state (ControlPlane CR) into concrete infrastructure and service resources.
This is conceptually similar to what platforms like [ConfigHub](https://www.confighub.com/) provide as a centralized configuration management system, but implemented entirely with Kubernetes-native primitives:

| ConfigHub Concept | c5c3-operator Equivalent |
| --- | --- |
| Centralized data store | ControlPlane CR in etcd |
| Change Sets | Git commits in FluxCD repo + `ControlPlane.status.updatePhase` |
| Workers | Kubernetes Operators (reconciliation loops) |
| Spaces / Targets | K8s Namespaces + 4-Cluster topology |
| Impact Analysis | Dry-run mode (future) |

For a detailed ConfigHub concept mapping, see [Configuration Landscape](../05-deployment/03-service-configuration/04-landscape.md#confighub).

## ControlPlane CRD

The ControlPlane CRD is the top-level API for an entire OpenStack deployment. Users or GitOps apply a single CR, and the c5c3-operator handles everything downstream. The ControlPlane CRD uses the `c5c3.io` API group (distinct from the `*.openstack.c5c3.io` groups used by individual service operator CRDs).

### Go Type Definition

```go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.updatePhase"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// ControlPlane is the Schema for the controlplanes API.
type ControlPlane struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   ControlPlaneSpec   `json:"spec,omitempty"`
    Status ControlPlaneStatus `json:"status,omitempty"`
}

// ControlPlaneSpec defines the desired state of the entire OpenStack deployment.
type ControlPlaneSpec struct {
    // OpenStackRelease is the target OpenStack release (e.g. "2025.2").
    // The c5c3-operator resolves this to concrete image tags.
    // +kubebuilder:validation:Pattern=`^\d{4}\.\d$`
    OpenStackRelease string `json:"openStackRelease"`

    // Region is the OpenStack region name.
    // +kubebuilder:default="RegionOne"
    Region string `json:"region,omitempty"`

    // Infrastructure defines shared infrastructure clusters.
    Infrastructure InfrastructureSpec `json:"infrastructure"`

    // Services defines per-service configuration.
    Services ServicesSpec `json:"services"`

    // Global defines cluster-wide settings (TLS, monitoring).
    // +optional
    Global *GlobalSpec `json:"global,omitempty"`

    // KORC configures K-ORC integration.
    // +optional
    KORC *KORCSpec `json:"korc,omitempty"`
}

// InfrastructureSpec defines shared infrastructure clusters.
type InfrastructureSpec struct {
    Database    InfraDatabaseSpec    `json:"database"`
    Messaging   InfraMessagingSpec   `json:"messaging"`
    Cache       InfraCacheSpec       `json:"cache"`
}

// InfraDatabaseSpec defines the MariaDB Galera cluster.
type InfraDatabaseSpec struct {
    Replicas     int32  `json:"replicas"`
    StorageClass string `json:"storageClass,omitempty"`
    StorageSize  string `json:"storageSize,omitempty"`
}

// InfraMessagingSpec defines the RabbitMQ cluster.
type InfraMessagingSpec struct {
    Replicas int32 `json:"replicas"`
}

// InfraCacheSpec defines the Memcached deployment.
type InfraCacheSpec struct {
    Replicas int32 `json:"replicas"`
}

// ServicesSpec defines per-service configuration.
type ServicesSpec struct {
    Keystone  *KeystoneServiceSpec  `json:"keystone,omitempty"`
    Nova      *NovaServiceSpec      `json:"nova,omitempty"`
    Neutron   *NeutronServiceSpec   `json:"neutron,omitempty"`
    Glance    *GlanceServiceSpec    `json:"glance,omitempty"`
    Cinder    *CinderServiceSpec    `json:"cinder,omitempty"`
    Placement *PlacementServiceSpec `json:"placement,omitempty"`
}

// ControlPlaneStatus defines the observed state of the ControlPlane.
type ControlPlaneStatus struct {
    // Conditions represent the latest available observations.
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // UpdatePhase tracks the current rollout phase.
    // +kubebuilder:validation:Enum=Idle;Validating;UpdatingInfra;UpdatingKeystone;UpdatingServices;Verifying;Complete;RollingBack
    UpdatePhase string `json:"updatePhase,omitempty"`

    // Services contains per-service status.
    Services map[string]ServiceStatus `json:"services,omitempty"`
}

// ServiceStatus reports the status of a single service.
type ServiceStatus struct {
    Ready   bool   `json:"ready"`
    Version string `json:"version,omitempty"`
    Message string `json:"message,omitempty"`
}
```

### Spec Fields

| Field | Type | Description |
| --- | --- | --- |
| `openStackRelease` | `string` | Target OpenStack release (e.g. `2025.2`). Resolved to image tags by the operator. |
| `region` | `string` | OpenStack region name (default: `RegionOne`) |
| `infrastructure.database` | `InfraDatabaseSpec` | MariaDB Galera cluster size and storage |
| `infrastructure.messaging` | `InfraMessagingSpec` | RabbitMQ cluster size |
| `infrastructure.cache` | `InfraCacheSpec` | Memcached replica count |
| `services.<name>` | `*ServiceSpec` | Per-service settings (enabled, replicas, service-specific options) |
| `global.tls` | `TLSSpec` | Cluster-wide TLS configuration |
| `korc` | `*KORCSpec` | K-ORC integration (bootstrap resource imports) |

### Status Conditions

| Condition | Description |
| --- | --- |
| **Ready** | Aggregate — True when all infrastructure and services are ready |
| **InfrastructureReady** | All infrastructure CRs (MariaDB, RabbitMQ, Memcached) report Ready |
| **KeystoneReady** | Keystone CR is Ready |
| **ServicesReady** | All enabled service CRs are Ready |
| **KORCReady** | K-ORC bootstrap imports and managed resources are available |

## Orchestration Reconciler

The c5c3-operator reconciler reads the ControlPlane CR and executes a phased deployment:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    c5c3-operator RECONCILIATION FLOW                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ControlPlane CR changed (or requeue timer fires)                           │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────────────────────┐                                            │
│  │ Phase 1: Infrastructure     │                                            │
│  │                             │                                            │
│  │ Create/update:              │                                            │
│  │ ├── MariaDB CR              │  → MariaDB Operator provisions cluster     │
│  │ ├── RabbitMQ CR             │  → RabbitMQ Operator provisions cluster    │
│  │ ├── Memcached CR            │  → Memcached Operator provisions pods      │
│  │ └── Valkey CR               │  → Valkey Operator provisions cluster      │
│  │                             │                                            │
│  │ Wait: all infra CRs Ready  │                                            │
│  └──────────┬──────────────────┘                                            │
│             │ InfrastructureReady=True                                      │
│             ▼                                                               │
│  ┌─────────────────────────────┐                                            │
│  │ Phase 2: Keystone           │                                            │
│  │                             │                                            │
│  │ Create Keystone CR with:    │                                            │
│  │ ├── clusterRef → mariadb    │  (infrastructure reference)                │
│  │ ├── clusterRef → memcached  │  (infrastructure reference)                │
│  │ └── image tag from release  │  (resolved from openStackRelease)          │
│  │                             │                                            │
│  │ Wait: Keystone CR Ready     │                                            │
│  └──────────┬──────────────────┘                                            │
│             │ KeystoneReady=True                                            │
│             ▼                                                               │
│  ┌─────────────────────────────┐                                            │
│  │ Phase 3: K-ORC Setup        │                                            │
│  │                             │                                            │
│  │ Import bootstrap resources: │                                            │
│  │ ├── Domain (unmanaged)      │                                            │
│  │ ├── Project (unmanaged)     │                                            │
│  │ └── Roles (unmanaged)       │                                            │
│  │                             │                                            │
│  │ Create managed resources:   │                                            │
│  │ ├── Services + Endpoints    │                                            │
│  │ ├── Service Users           │                                            │
│  │ └── Application Credentials │                                            │
│  └──────────┬──────────────────┘                                            │
│             │ KORCReady=True                                                │
│             ▼                                                               │
│  ┌─────────────────────────────┐                                            │
│  │ Phase 4: Remaining Services │                                            │
│  │                             │                                            │
│  │ Create service CRs:         │                                            │
│  │ ├── Glance CR               │                                            │
│  │ ├── Placement CR            │                                            │
│  │ ├── Nova CR                 │                                            │
│  │ ├── Neutron CR              │                                            │
│  │ └── Cinder CR               │                                            │
│  │                             │                                            │
│  │ All with clusterRef to      │                                            │
│  │ shared infra CRs            │                                            │
│  └──────────┬──────────────────┘                                            │
│             │ ServicesReady=True                                             │
│             ▼                                                               │
│  Ready=True (all conditions met)                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

<!-- TODO: Add Valkey to InfrastructureSpec Go type definition for consistency with the reconciliation flow diagram above -->

## Infrastructure Lifecycle and Dynamic Endpoint Discovery

The c5c3-operator creates infrastructure clusters at runtime. Endpoints are **not** known at CR creation time — they are discovered dynamically from infrastructure CR status fields.

### Endpoint Resolution

When the c5c3-operator creates a service CR (e.g. Keystone), it sets `clusterRef` fields pointing to the infrastructure CRs:

```yaml
# c5c3-operator creates this Keystone CR
spec:
  database:
    clusterRef:
      name: mariadb          # → MariaDB CR in the same namespace
    database: keystone
    secretRef:
      name: keystone-db-credentials
```

The keystone-operator then resolves the actual endpoint by reading the MariaDB CR's status:

```go
// In the service operator's reconcileDatabase():
if dbSpec.ClusterRef != nil {
    mariadb := &mariadbv1alpha1.MariaDB{}
    err := r.Get(ctx, types.NamespacedName{
        Name:      dbSpec.ClusterRef.Name,
        Namespace: keystone.Namespace,
    }, mariadb)
    // Resolve endpoint from MariaDB CR status
    dbHost = mariadb.Status.CurrentPrimary // e.g. "maxscale.mariadb-system.svc"
    dbPort = mariadb.Status.Port           // e.g. 3306
}
```

This design ensures that:
- Infrastructure endpoints are never hardcoded
- Service CRs are portable between environments
- The c5c3-operator does not need to know infrastructure implementation details

### Per-Service Resources

Each service operator creates its **own** database, RabbitMQ vhost, etc. within the shared infrastructure clusters. The c5c3-operator only creates the cluster-level instances:

```text
c5c3-operator creates:                Service operators create:
┌──────────────────┐                   ┌──────────────────────────┐
│ MariaDB CR       │                   │ Database: keystone       │
│ (Galera cluster) │ ◀───────────────  │ Database: nova           │
│                  │    clusterRef      │ Database: nova_api       │
└──────────────────┘                   │ Database: neutron        │
                                       │ Database: glance         │
┌──────────────────┐                   │ Database: cinder         │
│ RabbitMQ CR      │                   ├──────────────────────────┤
│ (Cluster)        │ ◀───────────────  │ vhost: nova              │
│                  │    clusterRef      │ vhost: neutron           │
└──────────────────┘                   │ vhost: cinder            │
                                       └──────────────────────────┘
┌──────────────────┐
│ Memcached CR     │  (shared, no per-service resources)
│ (Pods)           │
└──────────────────┘
```

## ControlPlane-to-Service CR Projection

The c5c3-operator translates the ControlPlane CR into per-service CRs. This section shows a concrete example.

### Input: ControlPlane CR

```yaml
apiVersion: c5c3.io/v1alpha1
kind: ControlPlane
metadata:
  name: production
spec:
  openStackRelease: "2025.2"
  region: RegionOne
  infrastructure:
    database:
      replicas: 3
      storageClass: fast-ssd
    messaging:
      replicas: 3
    cache:
      replicas: 3
  services:
    keystone:
      enabled: true
      replicas: 3
      fernet:
        maxActiveKeys: 3
        rotationInterval: 24h
    nova:
      enabled: true
      replicas:
        api: 3
        scheduler: 2
        conductor: 2
```

### Output: Keystone CR (Managed Mode)

The c5c3-operator translates `services.keystone.fernet.rotationInterval: 24h` into a cron expression for the Keystone CRD's `rotationSchedule` field (e.g., `"0 0 * * *"` for daily rotation).

```yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: keystone
  namespace: openstack
  ownerReferences:
    - kind: ControlPlane
      name: production
spec:
  image:
    repository: ghcr.io/c5c3/keystone
    tag: "28.0.0"               # resolved from openStackRelease: 2025.2
  replicas: 3                    # from services.keystone.replicas
  database:
    clusterRef:
      name: mariadb              # references MariaDB CR created by c5c3-operator
    database: keystone
    secretRef:
      name: keystone-db-credentials
  cache:
    clusterRef:
      name: memcached            # references Memcached CR created by c5c3-operator
    backend: dogpile.cache.pymemcache
  fernet:
    maxActiveKeys: 3             # from services.keystone.fernet
    rotationSchedule: "0 0 * * *"  # derived from rotationInterval: 24h
  bootstrap:
    adminPasswordSecretRef:
      name: keystone-admin-credentials
    region: RegionOne            # from ControlPlane.spec.region
```

### Alternative: Keystone CR (Brownfield Mode)

When infrastructure is managed externally (see [Brownfield Integration](../06-operations/03-brownfield-integration.md)), service CRs use explicit endpoints instead of `clusterRef`:

```yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: keystone
  namespace: openstack
spec:
  image:
    repository: ghcr.io/c5c3/keystone
    tag: "28.0.0"
  replicas: 3
  database:
    host: external-db.customer.com     # Brownfield: explicit host
    port: 3306
    database: keystone
    secretRef:
      name: keystone-db-credentials
  cache:
    servers:                            # Brownfield: explicit server list
      - external-mc-1.customer.com:11211
      - external-mc-2.customer.com:11211
    backend: dogpile.cache.pymemcache
  fernet:
    maxActiveKeys: 3
    rotationSchedule: "0 0 * * 0"
  bootstrap:
    adminPasswordSecretRef:
      name: keystone-admin-credentials
    region: RegionOne
```

**Hybrid design principle:**
- **Managed (default):** `clusterRef` → Operator resolves endpoint dynamically, creates per-service DB/User/vhost
- **Brownfield:** `host`/`port` → Operator uses external infrastructure directly, creates NO MariaDB Database CRs
- Mutual exclusivity: `clusterRef` XOR `host` — validation error if both are set

## K-ORC Integration

After Keystone is Ready, the c5c3-operator creates K-ORC CRs for service catalog management:

1. **Import bootstrap resources** (`managementPolicy: unmanaged`): Domain, Service Project, Roles — created by the Keystone Bootstrap Job
2. **Create Services and Endpoints** (`managementPolicy: managed`): One Service + Endpoint pair per OpenStack service
3. **Create Service Users** (`managementPolicy: managed`): One User per service
4. **Create Application Credentials** (`managementPolicy: managed`): One ApplicationCredential per service, pushed to OpenBao via PushSecret

For the full K-ORC flow, see [Control Plane — K-ORC](../03-components/01-control-plane.md#openstack-resource-controller-k-orc). For the credential lifecycle, see [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md).

## SecretAggregate CRD

The `SecretAggregate` CRD merges multiple Kubernetes Secrets into a single aggregated Secret. This is useful when a service needs credentials from multiple sources in a single mount.

```go
// SecretAggregate aggregates multiple K8s Secrets into one.
type SecretAggregateSpec struct {
    // Sources lists the Secrets to aggregate.
    Sources []SecretSource `json:"sources"`
    // Target defines the output Secret.
    Target SecretTarget `json:"target"`
}

type SecretSource struct {
    // SecretRef references a source Secret.
    SecretRef corev1.LocalObjectReference `json:"secretRef"`
    // Keys selects specific keys from the source (empty = all keys).
    // +optional
    Keys []string `json:"keys,omitempty"`
}

type SecretTarget struct {
    // Name of the aggregated output Secret.
    Name string `json:"name"`
}
```

**Example:**

```yaml
apiVersion: c5c3.io/v1alpha1
kind: SecretAggregate
metadata:
  name: nova-all-credentials
  namespace: openstack
spec:
  sources:
    - secretRef:
        name: nova-db-credentials
    - secretRef:
        name: nova-rabbitmq-credentials
    - secretRef:
        name: nova-app-credential
      keys:
        - application_credential_id
        - application_credential_secret
  target:
    name: nova-aggregated-credentials
```

## CredentialRotation CRD

The `CredentialRotation` CRD automates Application Credential rotation for OpenStack services. It works in coordination with K-ORC and the OpenBao/ESO pipeline.

```go
// CredentialRotation defines an automatic rotation schedule.
type CredentialRotationSpec struct {
    // TargetServiceUser references the K-ORC User CR.
    TargetServiceUser string `json:"targetServiceUser"`
    // RotationType is the credential type to rotate.
    // +kubebuilder:validation:Enum=applicationCredential
    RotationType string `json:"rotationType"`
    // Schedule defines the rotation timing.
    Schedule RotationSchedule `json:"schedule"`
    // GracePeriodDays is the overlap period where both old and new credentials are valid.
    // +kubebuilder:default=1
    GracePeriodDays int32 `json:"gracePeriodDays,omitempty"`
}

type RotationSchedule struct {
    // IntervalDays is the rotation interval in days.
    IntervalDays int32 `json:"intervalDays"`
    // PreRotationDays is how many days before expiry to create the new credential.
    PreRotationDays int32 `json:"preRotationDays"`
}
```

**Rotation flow:**

```text
Day 0: New Application Credential created
       │
       ├── K-ORC creates new AppCred in Keystone
       ├── New credential written to K8s Secret
       ├── PushSecret syncs to OpenBao
       └── ESO distributes to all consumers
       │
Day 83: Pre-rotation (intervalDays=90, preRotationDays=7)
       │
       ├── New Application Credential created (same flow)
       └── Old credential still valid
       │
Day 90: Grace period starts (gracePeriodDays=1)
       │
       └── Old Application Credential deleted from Keystone
```

For the full credential lifecycle, see [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md). For brownfield rotation, see [Brownfield Integration](../06-operations/03-brownfield-integration.md#step-5-credential-rotation).

## Rollout Strategy

The c5c3-operator implements phased updates inspired by ConfigHub's ChangeSets concept. When the ControlPlane CR changes, the operator tracks progress through well-defined phases:

### Update Phases

| Phase | Description | Rollback Trigger |
| --- | --- | --- |
| `Validating` | Validate new spec against current state (dry-run) | Validation failure |
| `UpdatingInfra` | Update infrastructure CRs (MariaDB, RabbitMQ, Memcached) | Infrastructure CR fails to reconcile |
| `UpdatingKeystone` | Update Keystone CR | Keystone fails health checks |
| `UpdatingServices` | Update remaining service CRs | Any service fails health checks |
| `Verifying` | Run post-update verification (Tempest if enabled) | Verification failure |
| `Complete` | All updates applied and verified | — |
| `RollingBack` | Reverting to previous known-good state | — |

### Phase Tracking

```yaml
status:
  updatePhase: UpdatingServices
  conditions:
    - type: Ready
      status: "False"
      reason: UpdateInProgress
      message: "Updating Nova and Neutron CRs"
    - type: InfrastructureReady
      status: "True"
    - type: KeystoneReady
      status: "True"
    - type: ServicesReady
      status: "False"
      reason: "NovaUpdating"
  services:
    keystone:
      ready: true
      version: "28.0.0"
    nova:
      ready: false
      version: "32.1.0"
      message: "Rolling update in progress"
    neutron:
      ready: true
      version: "27.0.1"
```

### Rollback

On failure in any phase, the c5c3-operator reverts to the previous known-good state:

1. **Infrastructure rollback**: Revert infrastructure CR specs to previous values
2. **Service rollback**: Revert service CR specs (image tags, replica counts)
3. **GitOps alignment**: The reverted state matches the previous Git commit — FluxCD ensures consistency

The `updatePhase` transitions to `RollingBack` and then to `Complete` once the rollback succeeds.

## Controller Setup

```go
func (r *ControlPlaneReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&c5c3v1alpha1.ControlPlane{}).
        Owns(&mariadbv1alpha1.MariaDB{}).
        Owns(&rabbitmqv1beta1.RabbitmqCluster{}).
        Owns(&memcachedv1alpha1.Memcached{}).
        Owns(&keystonev1alpha1.Keystone{}).
        Owns(&novav1alpha1.Nova{}).
        Owns(&neutronv1alpha1.Neutron{}).
        Owns(&glancev1alpha1.Glance{}).
        Owns(&cinderv1alpha1.Cinder{}).
        Owns(&placementv1alpha1.Placement{}).
        Complete(r)
}
```

**RBAC markers:**

```go
// +kubebuilder:rbac:groups=c5c3.io,resources=controlplanes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=c5c3.io,resources=controlplanes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=c5c3.io,resources=controlplanes/finalizers,verbs=update
// +kubebuilder:rbac:groups=c5c3.io,resources=secretaggregates;credentialrotations,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=keystone.openstack.c5c3.io,resources=keystones,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=nova.openstack.c5c3.io,resources=novas,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=neutron.openstack.c5c3.io,resources=neutrons,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=glance.openstack.c5c3.io,resources=glances,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=cinder.openstack.c5c3.io,resources=cinders,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=placement.openstack.c5c3.io,resources=placements,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=k8s.mariadb.com,resources=mariadbs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rabbitmq.com,resources=rabbitmqclusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=memcached.c5c3.io,resources=memcacheds,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=openstack.k-orc.cloud,resources=services;endpoints;users;applicationcredentials;domains;projects;roles,verbs=get;list;watch;create;update;patch;delete
```
