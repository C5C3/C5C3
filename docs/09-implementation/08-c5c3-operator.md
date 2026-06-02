# C5C3 Operator

The c5c3-operator is the planned central orchestration operator in CobaltCore. It will read a single `ControlPlane` CR and from it create, configure, and monitor all infrastructure and OpenStack service CRs. This page documents the ControlPlane CRD, the orchestration reconciler, infrastructure lifecycle, service CR projection, K-ORC integration, and rollout strategy.

For the high-level architecture, see [Control Plane — C5C3 Operator](../03-components/01-control-plane/01-c5c3-operator.md). For CRD definitions, see [CRDs](../04-architecture/01-crds.md).

::: warning Status: planned — not yet implemented
The c5c3-operator currently exists as a **stub**. `operators/c5c3/` contains only a `main.go` that starts a controller-runtime manager via the shared [`bootstrap`](./02-shared-library.md#bootstrap) package (leader-election ID `c5c3.openstack.c5c3.io`); its `SetupFunc` registers **no controllers** yet (`// +kubebuilder:scaffold:builder`). There is no `api/`, no `ControlPlane`/`SecretAggregate`/`CredentialRotation` Go types, and no orchestration reconciler in forge.

Everything below describes the **intended design**, consistent with the Keystone-first strategy: Keystone is the concrete reference implementation today; the c5c3-operator and the remaining service operators follow it. Present-tense descriptions of c5c3-operator behavior are aspirational.
:::

::: info First implemented slice (CC-0110)
The prepared plan for turning the stub into a working operator scopes the **first vertical slice to Keystone only**:

- **Infrastructure**: `infrastructure.{database,cache}` → MariaDB + Memcached CRs (RabbitMQ/Valkey and other services arrive with later operators).
- **Services**: `services.keystone`; `K-ORC` brought up self-credentialed via its own restricted admin Application Credential.
- **Status conditions implemented first**: `InfrastructureReady`, `KeystoneReady`, `KORCReady`, `AdminCredentialReady`, `CatalogReady`. `ServicesReady` and `ServiceUsersReady` are deferred.
- **CRDs**: `ControlPlane` and `CredentialRotation` (with a reconciler); `SecretAggregate` lands as **types + CRD YAML only** (no controller) until a follow-up.

Capabilities described below that fall outside this slice — RabbitMQ/Valkey projection, per-pod/per-replica service users (`ServiceUserSpec`, `maxAge`, Ephemeral mode — roadmap P2-P4), the scheduled admin App-Cred re-mint loop, and the full update-phase/rollback state machine — are later slices and are flagged inline where they appear.
:::

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
    commonv1 "github.com/c5c3/forge/internal/common/types"
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

    // Global defines cluster-wide settings (TLS, monitoring, policy).
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
    Valkey      InfraValkeySpec      `json:"valkey"`
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

// InfraValkeySpec defines the Valkey cluster.
type InfraValkeySpec struct {
    Replicas int32 `json:"replicas"`
}

// GlobalSpec defines cluster-wide settings applied to all services.
type GlobalSpec struct {
    // TLS configures cluster-wide TLS.
    // +optional
    TLS *TLSSpec `json:"tls,omitempty"`

    // PolicyOverrides defines global oslo.policy rules applied to all services.
    // Per-service policyOverrides take precedence over global rules.
    // +optional
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`
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

// KeystoneServiceSpec defines Keystone-specific settings in the ControlPlane.
type KeystoneServiceSpec struct {
    Enabled         bool                 `json:"enabled"`
    Replicas        int32                `json:"replicas"`
    Fernet          *FernetServiceSpec   `json:"fernet,omitempty"`
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`
}

// NovaServiceSpec defines Nova-specific settings in the ControlPlane.
type NovaServiceSpec struct {
    Enabled         bool                 `json:"enabled"`
    Replicas        NovaReplicasSpec     `json:"replicas"`
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`
}

// NeutronServiceSpec defines Neutron-specific settings in the ControlPlane.
type NeutronServiceSpec struct {
    Enabled         bool                 `json:"enabled"`
    Replicas        int32                `json:"replicas"`
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`
}

// GlanceServiceSpec defines Glance-specific settings in the ControlPlane.
type GlanceServiceSpec struct {
    Enabled         bool                 `json:"enabled"`
    Replicas        int32                `json:"replicas"`
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`
}

// CinderServiceSpec defines Cinder-specific settings in the ControlPlane.
type CinderServiceSpec struct {
    Enabled         bool                 `json:"enabled"`
    Replicas        CinderReplicasSpec   `json:"replicas"`
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`
}

// PlacementServiceSpec defines Placement-specific settings in the ControlPlane.
type PlacementServiceSpec struct {
    Enabled         bool                 `json:"enabled"`
    Replicas        int32                `json:"replicas"`
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`
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
| `infrastructure.valkey` | `InfraValkeySpec` | Valkey cluster size |
| `services.<name>` | `*ServiceSpec` | Per-service settings (enabled, replicas, service-specific options) |
| `global.tls` | `TLSSpec` | Cluster-wide TLS configuration |
| `global.policyOverrides` | `*PolicySpec` | Global oslo.policy rules applied to all services (per-service overrides take precedence) |
| `services.<name>.policyOverrides` | `*PolicySpec` | Per-service oslo.policy rules (overrides global rules on name collision) |
| `korc` | `*KORCSpec` | K-ORC integration (bootstrap resource imports) |

### Status Conditions

| Condition | Description |
| --- | --- |
| **Ready** | Aggregate — True when all infrastructure and services are ready |
| **InfrastructureReady** | All infrastructure CRs (MariaDB, Memcached; RabbitMQ once messaging-backed services land) report Ready |
| **KeystoneReady** | Keystone CR is Ready |
| **ServicesReady** | All enabled service CRs are Ready _(meaningful only once a second service operator exists — deferred)_ |
| **KORCReady** | K-ORC bootstrap imports and managed resources are available |
| **AdminCredentialReady** | The restricted admin Application Credential is minted and synced to `orc-system` |
| **CatalogReady** | All Keystone Service + Endpoint CRs are reconciled |
| **ServiceUsersReady** | All per-pod service users (per replica slot) are provisioned _(roadmap P2 — deferred, not in the first slice)_ |

> The first CC-0110 slice implements `InfrastructureReady`, `KeystoneReady`, `KORCReady`, `AdminCredentialReady`, and `CatalogReady`. `ServicesReady` and `ServiceUsersReady` are documented as the target end-state but are deferred.

## Orchestration Reconciler

The c5c3-operator reconciler will read the ControlPlane CR and execute a phased deployment:

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
│  │ Wait: all infra CRs Ready   │                                            │
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
│  │ Mint admin App Cred         │  (restricted, from admin password —        │
│  │ → k-orc-clouds-yaml         │   K-ORC's only credential)                 │
│  │                             │                                            │
│  │ Import bootstrap resources: │                                            │
│  │ ├── Domain (unmanaged)      │                                            │
│  │ ├── Project (unmanaged)     │                                            │
│  │ └── Roles (unmanaged)       │                                            │
│  │                             │                                            │
│  │ Create managed resources:   │                                            │
│  │ ├── Services + Endpoints    │                                            │
│  │ └── Per-pod Users + grants  │  (one real user per replica slot;          │
│  │                             │   NO per-service Application Credentials)  │
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
│             │ ServicesReady=True                                            │
│             ▼                                                               │
│  Ready=True (all conditions met)                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Infrastructure Lifecycle and Dynamic Endpoint Discovery

The c5c3-operator will create infrastructure clusters at runtime. Endpoints are **not** known at CR creation time — they are to be discovered dynamically from infrastructure CR status fields.

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
│ MariaDB CR       │                   │ MariaDB Database CRs:    │
│ (Galera cluster) │ ◀───────────────  │   keystone, nova,        │
│                  │   clusterRef      │   nova_api, neutron,     │
└──────────────────┘                   │   glance, cinder         │
                                       ├──────────────────────────┤
┌──────────────────┐                   │ Topology Operator CRs:   │
│ RabbitMQ CR      │                   │   Vhost: nova            │
│ (Cluster)        │ ◀───────────────  │   User:  nova            │
│                  │   clusterRef      │   Permission: nova (rw)  │
└──────────────────┘                   │   Vhost: neutron         │
                                       │   User:  neutron         │
┌──────────────────┐                   │   Permission: neutron    │
│ Memcached CR     │  (shared, no      │   Vhost: cinder          │
│ (Pods)           │   per-service     │   User:  cinder          │
└──────────────────┘   resources)      │   Permission: cinder     │
                                       └──────────────────────────┘
```

In managed mode, each service operator uses the shared `messaging/` library (see [Shared Library](./02-shared-library.md#messaging)) to create RabbitMQ Topology Operator CRs (`Vhost`, `User`, `Permission`) — analogous to how they use the `database/` library for MariaDB CRs. In brownfield mode, no Topology CRs are created; the operator uses explicit hosts directly.

## ControlPlane-to-Service CR Projection

The c5c3-operator will translate the ControlPlane CR into per-service CRs. This section shows a concrete example of the intended projection.

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

### Policy Projection

When the c5c3-operator creates service CRs, it merges global and per-service policy overrides:

- **Global rules** (`global.policyOverrides`) serve as the base layer for all services
- **Per-service rules** (`services.<name>.policyOverrides`) override global rules when rule names collide
- **Per-service `configMapRef`** takes precedence over the global `configMapRef`

**Projection logic:**

```go
func projectPolicyOverrides(global, perService *commonv1.PolicySpec) *commonv1.PolicySpec {
    if global == nil && perService == nil {
        return nil
    }
    result := &commonv1.PolicySpec{}

    // ConfigMapRef: per-service wins over global
    if perService != nil && perService.ConfigMapRef != nil {
        result.ConfigMapRef = perService.ConfigMapRef
    } else if global != nil && global.ConfigMapRef != nil {
        result.ConfigMapRef = global.ConfigMapRef
    }

    // Rules: merge global as base, per-service overrides
    result.Rules = map[string]string{}
    if global != nil {
        for k, v := range global.Rules {
            result.Rules[k] = v
        }
    }
    if perService != nil {
        for k, v := range perService.Rules {
            result.Rules[k] = v // per-service wins
        }
    }
    if len(result.Rules) == 0 {
        result.Rules = nil
    }
    return result
}
```

**Example — ControlPlane with global and per-service policies:**

```yaml
apiVersion: c5c3.io/v1alpha1
kind: ControlPlane
metadata:
  name: production
spec:
  global:
    policyOverrides:
      rules:
        "admin_required": "role:admin"         # Base rule for all services
        "service_role": "role:service"
  services:
    nova:
      enabled: true
      replicas:
        api: 3
        scheduler: 2
        conductor: 2
      policyOverrides:
        rules:
          "compute:create": "role:member"
          "compute:delete": "role:admin"
```

**Projected Nova CR:**

```yaml
apiVersion: nova.openstack.c5c3.io/v1alpha1
kind: Nova
spec:
  policyOverrides:
    rules:
      # From global
      "admin_required": "role:admin"
      "service_role": "role:service"
      # From per-service
      "compute:create": "role:member"
      "compute:delete": "role:admin"
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

After Keystone is Ready, the c5c3-operator drives K-ORC to manage the Keystone identity
lifecycle. The model (issue [#30](https://github.com/C5C3/C5C3/issues/30)) has K-ORC authenticate
with a **single restricted, project-scoped admin Application Credential** — the design's *only*
App Cred — and provision **one real Keystone service user + password per workload pod**. There are
**no per-service Application Credentials for workloads**.

1. **Mint the admin Application Credential** from the admin password, push it to OpenBao, and let
   ESO materialize `k-orc-clouds-yaml` in `orc-system` (K-ORC's `clouds.yaml`). This is the only
   App Cred created. See [admin credential flow](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#k-orc-admin-credential-flow).
2. **Import bootstrap resources** (`managementPolicy: unmanaged`): Domain, Service Project, Roles —
   created by the Keystone Bootstrap Job.
3. **Create Services and Endpoints** (`managementPolicy: managed`): one Service + Endpoint pair per
   OpenStack service (reachable at project scope — verified, no system-scoped admin needed).
4. **Create per-pod Users + role grants** (`managementPolicy: managed`): for each credentialed
   service, one `User` CR per replica slot (`svc-<service>-<ordinal>`) with an operator-generated
   password supplied via `User.passwordRef`, plus `Role`/grant CRs into the stable service project.

The per-pod provisioning, garbage collection, and rotation logic is the
[Per-pod service user reconciler](#per-pod-service-user-reconciler) below. For the full credential
lifecycle, see [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md);
for K-ORC details, [Control Plane — K-ORC](../03-components/01-control-plane/05-korc.md).

## Per-pod service user reconciler

::: warning Roadmap (P2-P4) — outside the first CC-0110 slice
Per-pod / per-replica workload service users are **not** part of the first c5c3 slice. The initial `ControlPlane` CRD manages only K-ORC's own admin Application Credential; `ServiceUserSpec`, `maxAge`, the Ephemeral mode, and the `ServiceUsersReady` condition are **not introduced** by the initial CRD and arrive in later roadmap phases. The design below is settled but future.
:::

This sub-reconciler will implement the per-pod credential model. CobaltCore goes **straight to
per-pod** (no interim shared-service-user phase); see the
[Implementation Roadmap](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#implementation-roadmap).

### ControlPlane spec additions

Each service spec carries an optional `serviceUser`, and `KORCSpec` carries the admin credential
configuration. Passwords never appear in the spec — they are generated by the operator.

```go
// ServiceUserSpec declares the per-pod Keystone service user for a service's pods.
type ServiceUserSpec struct {
    // Project is the stable service project all per-pod users of this service join (D5).
    // +kubebuilder:default="service"
    Project string `json:"project,omitempty"`

    // Roles are granted to every per-pod user in the service project.
    // +kubebuilder:default={"service"}
    Roles []string `json:"roles,omitempty"`

    // Mode selects the credential granularity.
    // PerReplica (default): one stable user per replica slot, pre-provisioned from the
    //   replica count; rotation on intentional recreation.
    // Ephemeral: one user per pod instance via pod-watch; rotation on every restart.
    // None: this service's pods need no OpenStack credential.
    // +kubebuilder:validation:Enum=PerReplica;Ephemeral;None
    // +kubebuilder:default=PerReplica
    Mode string `json:"mode,omitempty"`

    // MaxAge triggers rolling recreation of long-lived pods to refresh the credential.
    // Zero disables age-based rotation. (D4: rotation = recreation, never in place.)
    // +optional
    MaxAge *metav1.Duration `json:"maxAge,omitempty"`
}

// AdminCredentialSpec configures K-ORC's single admin Application Credential.
type AdminCredentialSpec struct {
    // PasswordSecretRef is the admin password (root of trust) used only to bootstrap/rotate
    // the admin App Cred. Never rendered into a workload pod.
    PasswordSecretRef commonv1.SecretRefSpec `json:"passwordSecretRef"`

    // ApplicationCredential configures the minted admin App Cred.
    ApplicationCredential AdminAppCredSpec `json:"applicationCredential"`
}

type AdminAppCredSpec struct {
    // Restricted (default true) prevents the App Cred from minting further app creds or trusts.
    // +kubebuilder:default=true
    Restricted bool `json:"restricted,omitempty"`
    // AccessRules optionally narrows the App Cred to the identity/catalog endpoints.
    // +optional
    AccessRules []AccessRule `json:"accessRules,omitempty"`
    // Rotation configures password-driven re-mint (the only supported mode).
    // +optional
    Rotation *AdminAppCredRotation `json:"rotation,omitempty"`
}

type AdminAppCredRotation struct {
    // +kubebuilder:validation:Enum=PasswordDriven
    // +kubebuilder:default=PasswordDriven
    Mode         string `json:"mode,omitempty"`
    IntervalDays int32  `json:"intervalDays,omitempty"`
}
```

### Reconciliation logic

```text
reconcileServiceUsers(ctx, cp):
  for each enabled service s with s.serviceUser.mode != None:
      desired = enumerateReplicaSlots(s)          # ordinals from replica count, or nodes (DaemonSet)
      for slot in desired:
          user = "svc-<s>-<slot>"
          ensurePassword(user)                    # generate once → password Secret + OpenBao path
          ensureKORCUser(user, passwordRef)       # K-ORC User CR (auth: admin App Cred)
          ensureKORCGrants(user, project, roles)  # K-ORC Role/grant CRs into the service project
          ensureESOExternalSecret(user, pod)      # one pod's Secret; env-injected (CC-0080)
      # garbage-collect slots no longer desired (scale-down):
      for user in existingUsers(s) not in desired:
          deleteKORCUser(user)                    # finalizer → Keystone user deleted → tokens revoked
  setCondition(ServiceUsersReady, allSlotsReady)
```

* **PerReplica** derives `desired` from the service's configured replica count (StatefulSet
  ordinals) or the node set (per-node DaemonSet, `svc-<service>-<node>`). Users are
  **pre-provisioned**, so credentials exist before pods start.
* **Ephemeral** instead runs a **pod-watch**: a `User` CR is created per pod (owner-referenced to
  the pod) and deleted when the pod terminates. A start-time guard requeues the pod's credential
  until the `User`/Secret is Ready.
* **`maxAge`** marks a slot's `User` CR for recreation once its credential exceeds `maxAge`,
  triggering a rolling pod recreation rather than an in-place password change.

### Garbage collection (finalizer + sweeper)

* **Finalizer (primary):** each per-pod `User`/grant CR carries a finalizer; K-ORC's own finalizer
  deletes the Keystone user before the CR is removed, revoking tokens and grants immediately.
* **Sweeper (backstop):** a periodic reconcile lists Keystone users carrying the `svc-<service>-…`
  naming prefix / c5c3-managed tag and deletes any with no live pod-identity or owner — covering
  force-deleted pods or lost nodes where a finalizer was skipped. Orphan deletions are logged.

### RBAC additions

```go
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch          // Ephemeral pod-watch
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=external-secrets.io,resources=externalsecrets;pushsecrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=openstack.k-orc.cloud,resources=users;roles;applicationcredentials;services;endpoints;projects;domains,verbs=get;list;watch;create;update;patch;delete
```

## SecretAggregate CRD

The `SecretAggregate` CRD (planned) will merge multiple Kubernetes Secrets into a single aggregated Secret. This is useful when a service needs credentials from multiple sources in a single mount.

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
        name: ceph-client-nova
      keys:
        - key
  target:
    name: nova-aggregated-credentials
```

> `SecretAggregate` merges **infrastructure** secrets (DB, RabbitMQ, Ceph). The per-pod Keystone
> credential is **not** aggregated here — it is mounted into exactly one pod and injected via env
> (`OS_KEYSTONE_AUTHTOKEN__{USERNAME,PASSWORD}`), see the
> [per-pod service user reconciler](#per-pod-service-user-reconciler).

## CredentialRotation CRD

The `CredentialRotation` CRD (planned) automates rotation of the **single admin Application
Credential** — K-ORC's only credential. It is **not** used for workload service users: those
rotate by **pod recreation** (D4), not by an in-place credential swap, so they need no
`CredentialRotation` object (see [Credential Lifecycle — Credential Rotation](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#credential-rotation)).

> **Not to be confused with the already-built keystone-operator key rotation.** Keystone today
> rotates **cryptographic keys** — Fernet token keys and credential *encryption* keys
> (`reconcile_fernet.go`, `reconcile_credential.go`, `rotation_staging.go`,
> `rotation_validation.go`; see [Keystone Dependencies](./05-keystone-dependencies.md#fernet-key-lifecycle)).
> That is a distinct mechanism in the keystone-operator. The admin **password** itself rotates via
> the [admin credential rotation](./05-keystone-dependencies.md#admin-credential-rotation) design
> (re-run of the idempotent bootstrap Job). This `CredentialRotation` CRD rotates only the admin
> *Application Credential* derived from that password, and does not yet exist in forge.

```go
// CredentialRotation rotates the admin Application Credential (the only supported target).
type CredentialRotationSpec struct {
    // Target is the credential to rotate. The only supported value is adminApplicationCredential;
    // workload service users rotate by pod recreation and are not targets here.
    // +kubebuilder:validation:Enum=adminApplicationCredential
    // +kubebuilder:default=adminApplicationCredential
    Target string `json:"target"`
    // Schedule defines the rotation timing.
    Schedule RotationSchedule `json:"schedule"`
    // GracePeriodDays is the overlap where both the old and new admin App Cred are valid.
    // +kubebuilder:default=1
    GracePeriodDays int32 `json:"gracePeriodDays,omitempty"`
}

type RotationSchedule struct {
    // IntervalDays is the rotation interval in days.
    IntervalDays int32 `json:"intervalDays"`
    // PreRotationDays is how many days before expiry to mint the successor.
    PreRotationDays int32 `json:"preRotationDays"`
}
```

**Rotation flow (restricted + password-driven re-mint, D2):**

```text
Day 0:  Restricted admin App Cred active (minted from the admin password)
       │
Day 83: Pre-rotation (intervalDays=90, preRotationDays=7)
       │
       ├── operator re-mints a fresh RESTRICTED admin App Cred from the admin password
       ├── new credential written to K8s Secret → PushSecret → OpenBao
       ├── ESO updates k-orc-clouds-yaml (orc-system); K-ORC picks up the new clouds.yaml
       └── old App Cred still valid (grace window)
       │
Day 84: Grace period ends (gracePeriodDays=1)
       │
       └── old admin App Cred deleted from Keystone
```

For the full credential lifecycle, see [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md). For brownfield rotation, see [Brownfield Integration](../06-operations/03-brownfield-integration.md#step-5-credential-rotation).

## Rollout Strategy

The c5c3-operator will implement phased updates inspired by ConfigHub's ChangeSets concept. When the ControlPlane CR changes, the operator is designed to track progress through well-defined phases:

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

> **Planned wiring.** The current stub registers no controllers — `operators/c5c3/main.go`'s `SetupFunc` is empty (`// +kubebuilder:scaffold:builder — register controllers here`). The `ControlPlaneReconciler`, its `Owns(...)` set, and the RBAC markers below are the target wiring once the CRD and reconciler are implemented.

```go
func (r *ControlPlaneReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&c5c3v1alpha1.ControlPlane{}).
        Owns(&mariadbv1alpha1.MariaDB{}).
        Owns(&rabbitmqv1beta1.RabbitmqCluster{}).
        Owns(&memcachedv1alpha1.Memcached{}).
        Owns(&valkeyv1alpha1.Valkey{}).
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
// +kubebuilder:rbac:groups=rabbitmq.com,resources=vhosts;users;permissions;queues;exchanges;bindings;policies,verbs=get;list;watch
// +kubebuilder:rbac:groups=memcached.c5c3.io,resources=memcacheds,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=valkey.c5c3.io,resources=valkeys,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=openstack.k-orc.cloud,resources=services;endpoints;users;applicationcredentials;domains;projects;roles,verbs=get;list;watch;create;update;patch;delete
```
