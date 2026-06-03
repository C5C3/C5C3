# C5C3 Operator

The c5c3-operator is the central orchestration operator in CobaltCore. It reads a single `ControlPlane` CR and from it creates, configures, and monitors the infrastructure and OpenStack service CRs of a control plane. This page documents the ControlPlane CRD, the orchestration reconciler, the infrastructure lifecycle, service CR projection, K-ORC integration, and the rollout strategy.

For the high-level architecture, see [Control Plane — C5C3 Operator](../03-components/01-control-plane/01-c5c3-operator.md). For CRD definitions, see [CRDs](../04-architecture/01-crds.md).

::: info Status: first slice implemented (CC-0110)
The **Keystone-first vertical slice is built** in `operators/c5c3/`. `main.go` (leader-election ID `c5c3.openstack.c5c3.io`) registers the `ControlPlaneReconciler`, the `CredentialRotationReconciler`, and the `ControlPlane` validating/defaulting webhook. What is implemented today:

- **Infrastructure**: `infrastructure.{database,cache}` → MariaDB + Memcached CRs (RabbitMQ/Valkey and other backing services arrive with later service operators).
- **Services**: `services.keystone` → an owned `Keystone` CR; K-ORC is brought up self-credentialed via its own restricted admin Application Credential.
- **Status conditions**: `InfrastructureReady`, `KeystoneReady`, `KORCReady`, `AdminCredentialReady`, `CatalogReady`, aggregated into `Ready`.
- **CRDs**: `ControlPlane` and `CredentialRotation` (both with reconcilers); `SecretAggregate` ships as **types + CRD YAML only** (no controller; reconciler deferred to CC-0023, read-only RBAC).

Capabilities that fall **outside this slice** are flagged inline where they appear and remain planned: RabbitMQ/Valkey projection, multi-service orchestration (Glance/Placement/Nova/Neutron/Cinder), per-pod/per-replica service users (`ServiceUserSpec`, `maxAge`, Ephemeral mode — roadmap P2-P4), the scheduled admin App-Cred re-mint loop, and the full update-phase/rollback state machine (the `UpdatingServices`/`Verifying`/`RollingBack` phases are reserved enum values but not yet active).
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

The types below are reproduced from `operators/c5c3/api/v1alpha1/controlplane_types.go` (abridged with `// ...` where comments are trimmed).

```go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    commonv1 "github.com/c5c3/forge/internal/common/types"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Release",type="string",JSONPath=".spec.openStackRelease"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// ControlPlane is the Schema for the controlplanes API (CC-0110).
type ControlPlane struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   ControlPlaneSpec   `json:"spec,omitempty"`
    Status ControlPlaneStatus `json:"status,omitempty"`
}

// ControlPlaneSpec defines the desired state of a ControlPlane.
type ControlPlaneSpec struct {
    // OpenStackRelease is the release the control plane targets, e.g. "2025.2".
    // The reconciler projects this into each service CR's image tag.
    // +kubebuilder:validation:Pattern=`^\d{4}\.\d$`
    OpenStackRelease string `json:"openStackRelease"`

    // Region is the OpenStack region name applied across the control plane.
    // +kubebuilder:default="RegionOne"
    // +optional
    Region string `json:"region,omitempty"`

    // Infrastructure declares the shared backing services (database, cache).
    Infrastructure InfrastructureSpec `json:"infrastructure"`

    // Services declares the per-service configuration projected into service CRs.
    Services ServicesSpec `json:"services"`

    // Global defines oslo.policy overrides applied across every service.
    // Per-service overrides take precedence over these global rules.
    // +optional
    Global *commonv1.PolicySpec `json:"global,omitempty"`

    // KORC configures the K-ORC integration (admin application credential +
    // bootstrap resources). Required.
    KORC KORCSpec `json:"korc"`
}

// InfrastructureSpec declares the shared backing services. Both fields reuse the
// canonical commonv1 shapes so the ControlPlane and the per-service CRs validate
// database/cache the same way.
type InfrastructureSpec struct {
    // Database — managed (clusterRef) XOR brownfield (host). Enforced by webhook.
    Database commonv1.DatabaseSpec `json:"database"`
    // Cache — managed (clusterRef) XOR brownfield (servers). Enforced by webhook.
    Cache commonv1.CacheSpec `json:"cache"`
}

// ServicesSpec declares the per-service configuration. Today only Keystone is
// modeled; additional services are added as optional pointer fields as the
// operator grows.
type ServicesSpec struct {
    Keystone ServiceKeystoneSpec `json:"keystone"`
}

// ServiceKeystoneSpec is a CURATED LOCAL subset of the knobs the ControlPlane
// exposes for Keystone — intentionally NOT an import of keystonev1alpha1.KeystoneSpec.
// The reconciler PROJECTS this into a Keystone CR; the database, cache, and Fernet
// rotation schedule are DERIVED from the ControlPlane rather than set here.
type ServiceKeystoneSpec struct {
    // +optional
    // +kubebuilder:validation:Minimum=1
    Replicas *int32 `json:"replicas,omitempty"`
    // +optional
    Image *commonv1.ImageSpec `json:"image,omitempty"`
    // +optional
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`
    // +optional
    RotationInterval *metav1.Duration `json:"rotationInterval,omitempty"`
}

// KORCSpec configures the K-ORC integration.
type KORCSpec struct {
    AdminCredential AdminCredentialSpec `json:"adminCredential"`
}

// AdminCredentialSpec declares the admin OpenStack credential and the
// application-credential rotation policy.
type AdminCredentialSpec struct {
    // CloudCredentialsRef references the clouds.yaml Secret + cloud entry K-ORC
    // authenticates as.
    CloudCredentialsRef CloudCredentialsRef `json:"cloudCredentialsRef"`
    // PasswordSecretRef references the admin password used to (re-)mint the AC.
    PasswordSecretRef commonv1.SecretRefSpec `json:"passwordSecretRef"`
    // ApplicationCredential declares the admin application-credential policy.
    ApplicationCredential ApplicationCredentialSpec `json:"applicationCredential"`
    // BootstrapResources declares OpenStack resources K-ORC bootstraps alongside
    // the admin credential. Minimal {Kind, Name} shape at L1.
    // +optional
    BootstrapResources []BootstrapResourceSpec `json:"bootstrapResources,omitempty"`
}

type CloudCredentialsRef struct {
    CloudName string `json:"cloudName"`
    // +kubebuilder:default="k-orc-clouds-yaml"
    // +optional
    SecretName string `json:"secretName,omitempty"`
}

// ApplicationCredentialSpec declares the K-ORC admin application-credential policy.
type ApplicationCredentialSpec struct {
    // Restricted defaults to true (least-privilege baseline). NOTE the reconciler
    // INVERTS this into K-ORC's Unrestricted field (restricted=true => Unrestricted=false).
    // +kubebuilder:default=true
    // +optional
    Restricted *bool `json:"restricted,omitempty"`
    // +optional
    AccessRules []AccessRule `json:"accessRules,omitempty"`
    Rotation RotationSpec `json:"rotation"`
}

type AccessRule struct {
    Service string `json:"service"`
    Method  string `json:"method"`
    Path    string `json:"path"`
}

// RotationMode selects how the admin application credential is rotated.
// +kubebuilder:validation:Enum=PasswordDriven;Scheduled;Manual
type RotationMode string

const (
    // RotationModePasswordDriven re-mints the AC whenever the admin password
    // changes. This is the default and the only mode active at L1.
    RotationModePasswordDriven RotationMode = "PasswordDriven"
    // RotationModeScheduled — surfaced for schema stability; logic deferred.
    RotationModeScheduled RotationMode = "Scheduled"
    // RotationModeManual rotates only when a CredentialRotation CR requests it.
    RotationModeManual RotationMode = "Manual"
)

type RotationSpec struct {
    // +kubebuilder:default=PasswordDriven
    // +optional
    Mode RotationMode `json:"mode,omitempty"`
}

type BootstrapResourceSpec struct {
    Kind string `json:"kind"`
    Name string `json:"name"`
}

// UpdatePhase represents the current phase of a control-plane update. The enum
// surfaces FUTURE phases alongside the active ones so the schema is stable; the
// reserved phases are never set by the current reconciler.
// +kubebuilder:validation:Enum=Idle;Updating;UpdatingServices;Verifying;RollingBack
type UpdatePhase string

const (
    UpdatePhaseIdle             UpdatePhase = "Idle"
    UpdatePhaseUpdating         UpdatePhase = "Updating"
    UpdatePhaseUpdatingServices UpdatePhase = "UpdatingServices" // reserved; not yet implemented
    UpdatePhaseVerifying        UpdatePhase = "Verifying"        // reserved; not yet implemented
    UpdatePhaseRollingBack      UpdatePhase = "RollingBack"      // reserved; not yet implemented
)

// ControlPlaneStatus defines the observed state of a ControlPlane.
type ControlPlaneStatus struct {
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`
    // +optional
    UpdatePhase UpdatePhase `json:"updatePhase,omitempty"`
    // Services reports per-service readiness, keyed by service name (e.g. "keystone").
    // +optional
    Services map[string]ServiceStatus `json:"services,omitempty"`
    // +optional
    AdminApplicationCredential *AdminApplicationCredentialStatus `json:"adminApplicationCredential,omitempty"`
    // +optional
    CatalogReady bool `json:"catalogReady,omitempty"`
}

type ServiceStatus struct {
    Ready bool `json:"ready"`
    // +optional
    Release string `json:"release,omitempty"`
}

type AdminApplicationCredentialStatus struct {
    // +optional
    ID string `json:"id,omitempty"`
    // +optional
    Restricted bool `json:"restricted,omitempty"`
    // +optional
    LastRotation *metav1.Time `json:"lastRotation,omitempty"`
}
```

### Spec Fields

| Field | Type | Description |
| --- | --- | --- |
| `openStackRelease` | `string` | Target OpenStack release, e.g. `2025.2` (pattern `^\d{4}\.\d$`). Projected verbatim into the Keystone image tag. |
| `region` | `string` | OpenStack region name (default `RegionOne`) |
| `infrastructure.database` | `commonv1.DatabaseSpec` | Shared MariaDB — managed (`clusterRef`) XOR brownfield (`host`) |
| `infrastructure.cache` | `commonv1.CacheSpec` | Shared Memcached — managed (`clusterRef`) XOR brownfield (`servers`) |
| `services.keystone` | `ServiceKeystoneSpec` | Curated Keystone knobs (`replicas`, `image`, `policyOverrides`, `rotationInterval`) — required |
| `global` | `*commonv1.PolicySpec` | Global oslo.policy rules applied to all services (per-service overrides win on name collision) |
| `services.keystone.policyOverrides` | `*commonv1.PolicySpec` | Per-service oslo.policy rules (override global rules on collision) |
| `korc` | `KORCSpec` | **Required.** K-ORC admin credential + bootstrap resources |
| `korc.adminCredential.passwordSecretRef.name` | `string` | **Required by the webhook.** The admin password the AC is minted from |

> **Planned (later slices):** `infrastructure.messaging` / `infrastructure.valkey`, additional `services.*` (Nova/Neutron/Glance/Cinder/Placement), and cluster-wide `global.tls` are not part of the current CRD. They are documented as the target end-state in [CRDs](../04-architecture/01-crds.md) and arrive with the corresponding service operators.

### Status Conditions

| Condition | Description |
| --- | --- |
| **Ready** | Aggregate — True only when all sub-conditions below are True |
| **InfrastructureReady** | All managed infrastructure CRs (MariaDB, Memcached) report Ready; True immediately when only brownfield infra is used |
| **KeystoneReady** | The projected Keystone CR reports Ready |
| **KORCReady** | The admin Application Credential is minted and reports `Available` |
| **AdminCredentialReady** | The minted credential is committed to the operator-owned Secret and mirrored to OpenBao |
| **CatalogReady** | The Keystone identity `Service` + public `Endpoint` K-ORC CRs are registered |

The aggregate `Ready` is recomputed on **every** status write (including in-progress requeues), so `status.ready` reflects the current convergence state rather than staying absent until the whole chain passes. Each condition carries an `observedGeneration`.

> **Planned:** `ServicesReady` (meaningful only once a second service operator exists) and `ServiceUsersReady` (per-pod service users, roadmap P2) are documented as the target end-state but are **not** set by the current reconciler.

## Orchestration Reconciler

`Reconcile` fetches the ControlPlane CR and runs five sub-reconcilers **in dependency order**. Each call is routed through `instrumentSubReconciler` (emitting duration + error metrics under a `sub_reconciler` label) and sets its own status condition; a sub-reconciler that requeues or errors short-circuits the chain and writes status immediately.

```text
ControlPlane CR changed (or requeue timer fires)
   │
   ▼
reconcileInfrastructure   → MariaDB + Memcached CRs (managed mode); nothing in brownfield
   │                        Sets: InfrastructureReady
   ▼  (gate: InfrastructureReady)
reconcileKeystone         → projects services.keystone into an owned Keystone CR
   │                        Sets: KeystoneReady
   ▼  (gate: none — mints unconditionally; defers if admin password absent)
reconcileKORC             → mints the admin K-ORC ApplicationCredential, stamps the
   │                        admin-password-hash annotation, re-mints on change
   │                        Sets: KORCReady
   ▼  (gate: KORCReady + clouds.yaml ExternalSecret Ready)
reconcileAdminCredential  → commits the minted AC to an operator-owned Secret and
   │                        PushSecret-mirrors it to OpenBao
   │                        Sets: AdminCredentialReady
   ▼  (gate: AdminCredentialReady)
reconcileCatalog          → registers the identity Service + public Endpoint (K-ORC)
   │                        Sets: CatalogReady, status.catalogReady
   ▼
Ready = AllTrue(InfrastructureReady, KeystoneReady, KORCReady,
                AdminCredentialReady, CatalogReady)
```

### reconcileInfrastructure

Reconciles the shared backing services. In **managed mode** (`clusterRef` set) it create-or-updates an owned child per service in a single pass before gating on readiness:

- **MariaDB** (`k8s.mariadb.com`): a minimal but admissible spec — `replicas: 3`, Galera enabled, `storage.size: 100Gi` (TLS/issuerRefs are a platform concern, deliberately left to the deploy stack).
- **Memcached** (`memcached.c5c3.io/v1beta1`): handled as an `unstructured.Unstructured` because `memcached.c5c3.io` ships no Go module; `spec.replicas` is set from `infrastructure.cache.replicas`.

`InfrastructureReady` flips True once every managed child reports Ready. In **brownfield mode** (`host`/`servers` set) nothing is provisioned and `InfrastructureReady` is True immediately. All children are created in the ControlPlane's **own namespace** (`childNamespace(cp) == cp.Namespace`) so owner references stay valid (cross-namespace owner refs are rejected and never GC'd).

### reconcileKeystone

Gated on `InfrastructureReady`. Projects `services.keystone` into an owned Keystone CR named **`<cp.Name>-keystone`** in the ControlPlane's namespace:

- **Image**: `ghcr.io/c5c3/keystone:<openStackRelease>` (e.g. tag `2025.2`), unless `services.keystone.image` overrides the whole reference. There is no release→upstream-version tag resolution.
- **Database / Cache**: the `infrastructure.{database,cache}` specs are reused **verbatim**, so the Keystone CR points at the same backing services.
- **Bootstrap**: `bootstrap.adminPasswordSecretRef` is set to `korc.adminCredential.passwordSecretRef` (Keystone and K-ORC share the admin-password source); `bootstrap.region` from `spec.region`.
- **Replicas**: from `services.keystone.replicas` when set (else the Keystone operator's own default).
- **Policy**: `projectPolicyOverrides(spec.global, services.keystone.policyOverrides)` (per-service wins).
- **Rotation**: `services.keystone.rotationInterval` is converted by `intervalToCron` and applied to **both** `fernet.rotationSchedule` and `credentialKeys.rotationSchedule`. Only daily (`0 0 * * *`) and weekly (`0 0 * * 0`) schedules are representable; the webhook rejects any other interval.

`KeystoneReady` mirrors the child Keystone CR's `Ready` condition.

### reconcileKORC, reconcileAdminCredential, reconcileCatalog

See [K-ORC Integration](#k-orc-integration) below for the full credential and catalog flow.

### Field indexer and Secret watch

`SetupWithManager` registers a field indexer under:

```go
const ControlPlaneSecretNameIndexKey = "spec.korc.adminCredential.passwordSecretRef.name"
```

The extractor returns the (deduplicated, non-empty) set of Secret names a ControlPlane references — today just the admin-password Secret. The controller `Watches(&corev1.Secret{})` and `secretToControlPlaneMapper` uses the index for an O(1) reverse lookup from a Secret event to the referencing ControlPlane(s). Because the admin-password Secret is ESO-managed (not owned by the ControlPlane), an owner-ref watch would never fire — the index-backed watch is what wakes the ControlPlane when its admin password rotates. This mirrors the keystone operator's `KeystoneSecretNameIndexKey`.

## Infrastructure Lifecycle and Dynamic Endpoint Discovery

The c5c3-operator creates infrastructure clusters at runtime. Endpoints are **not** known at CR creation time — they are discovered dynamically from infrastructure CR status fields.

### Endpoint Resolution

When the c5c3-operator creates a service CR (e.g. Keystone), it reuses the ControlPlane's infrastructure spec, which carries `clusterRef` in managed mode:

```yaml
# c5c3-operator projects this onto the Keystone CR
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
│ Memcached CR     │  (shared, no      │   Vhost / User / Perm    │
│ (Pods)           │   per-service     │   (RabbitMQ, future)     │
└──────────────────┘   resources)      └──────────────────────────┘
```

> **Planned:** RabbitMQ (`messaging`) and Valkey are not yet projected by the c5c3-operator — only the MariaDB and Memcached cluster-level CRs are created today. In managed mode each future messaging-backed service operator will use the shared `messaging/` library (see [Shared Library](./02-shared-library.md#messaging)) to create RabbitMQ Topology Operator CRs (`Vhost`, `User`, `Permission`), analogous to the `database/` library for MariaDB. In brownfield mode no Topology CRs are created.

## ControlPlane-to-Service CR Projection

The c5c3-operator translates the ControlPlane CR into per-service CRs. This section shows a concrete example of the projection that runs today.

### Input: ControlPlane CR

```yaml
apiVersion: c5c3.io/v1alpha1
kind: ControlPlane
metadata:
  name: production
  namespace: openstack
spec:
  openStackRelease: "2025.2"
  region: RegionOne
  infrastructure:
    database:
      clusterRef:
        name: mariadb
    cache:
      clusterRef:
        name: memcached
      replicas: 3
  services:
    keystone:
      replicas: 3
      rotationInterval: 24h
  korc:
    adminCredential:
      cloudCredentialsRef:
        cloudName: admin
        secretName: k-orc-clouds-yaml
      passwordSecretRef:
        name: keystone-admin-credentials
      applicationCredential:
        restricted: true
        rotation:
          mode: PasswordDriven
```

### Output: Keystone CR (Managed Mode)

The c5c3-operator translates `services.keystone.rotationInterval: 24h` into the daily cron expression `"0 0 * * *"` for the Keystone CR's `fernet.rotationSchedule` and `credentialKeys.rotationSchedule`. The projected child is named `<cp.Name>-keystone` and lives in the ControlPlane's own namespace.

```yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: production-keystone        # <cp.Name>-keystone
  namespace: openstack             # = ControlPlane namespace (childNamespace)
  ownerReferences:
    - kind: ControlPlane
      name: production
spec:
  image:
    repository: ghcr.io/c5c3/keystone
    tag: "2025.2"                  # = spec.openStackRelease (verbatim)
  replicas: 3                       # from services.keystone.replicas
  database:
    clusterRef:
      name: mariadb                # reused verbatim from infrastructure.database
  cache:
    clusterRef:
      name: memcached              # reused verbatim from infrastructure.cache
  fernet:
    rotationSchedule: "0 0 * * *"  # derived from rotationInterval: 24h
  credentialKeys:
    rotationSchedule: "0 0 * * *"  # same schedule applied to credential keys
  bootstrap:
    adminPasswordSecretRef:
      name: keystone-admin-credentials  # = korc.adminCredential.passwordSecretRef
    region: RegionOne              # from ControlPlane.spec.region
```

> **Planned (multi-service projection):** the example above is the Keystone-only slice. Projecting Nova/Neutron/Glance/Cinder/Placement CRs (each with their own `clusterRef` to the shared infra) is a later slice; the multi-service ControlPlane shape and the per-service projection are documented as the target end-state.

### Policy Projection

When the c5c3-operator creates a service CR, it merges global and per-service policy overrides via `projectPolicyOverrides` (`internal/controller/helpers.go`):

- **Global rules** (`spec.global`) are the base layer for all services
- **Per-service rules** (`services.<name>.policyOverrides`) override global rules when rule names collide
- **Per-service `configMapRef`** takes precedence over the global `configMapRef`

```go
// projectPolicyOverrides merges a global policy (base) with a per-service policy
// (overrides) into a single freshly allocated *commonv1.PolicySpec. Per-service
// values win on conflict; inputs are never mutated or aliased.
func projectPolicyOverrides(global, perService *commonv1.PolicySpec) *commonv1.PolicySpec {
    if global == nil && perService == nil {
        return nil
    }
    if global == nil {
        return copyPolicySpec(perService)
    }
    if perService == nil {
        return copyPolicySpec(global)
    }

    merged := &commonv1.PolicySpec{}
    // Rules: global is the base, per-service overrides on key conflict.
    if global.Rules != nil || perService.Rules != nil {
        rules := make(map[string]string, len(global.Rules)+len(perService.Rules))
        for k, v := range global.Rules {
            rules[k] = v
        }
        for k, v := range perService.Rules {
            rules[k] = v
        }
        merged.Rules = rules
    }
    // ConfigMapRef: per-service wins when set, else fall back to global.
    switch {
    case perService.ConfigMapRef != nil:
        merged.ConfigMapRef = perService.ConfigMapRef.DeepCopy()
    case global.ConfigMapRef != nil:
        merged.ConfigMapRef = global.ConfigMapRef.DeepCopy()
    }
    return merged
}
```

Note `spec.global` **is** the `*commonv1.PolicySpec` directly — the policy rules sit under `spec.global`, not under a nested `spec.global.policyOverrides`.

```yaml
apiVersion: c5c3.io/v1alpha1
kind: ControlPlane
metadata:
  name: production
spec:
  global:
    rules:
      "admin_required": "role:admin"     # base rule for all services
      "service_role": "role:service"
  services:
    keystone:
      policyOverrides:
        rules:
          "identity:create_user": "role:admin"
```

### Alternative: Keystone CR (Brownfield Mode)

When infrastructure is managed externally (see [Brownfield Integration](../06-operations/03-brownfield-integration.md)), the ControlPlane's `infrastructure.{database,cache}` use explicit endpoints instead of `clusterRef`, and the projected Keystone CR inherits them verbatim:

```yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: production-keystone
  namespace: openstack
spec:
  image:
    repository: ghcr.io/c5c3/keystone
    tag: "2025.2"
  replicas: 3
  database:
    host: external-db.customer.com     # brownfield: explicit host
    port: 3306
    database: keystone
    secretRef:
      name: keystone-db-credentials
  cache:
    servers:                            # brownfield: explicit server list
      - external-mc-1.customer.com:11211
      - external-mc-2.customer.com:11211
  bootstrap:
    adminPasswordSecretRef:
      name: keystone-admin-credentials
    region: RegionOne
```

**Hybrid design principle** (enforced today by the `ControlPlane` validating webhook):
- **Managed (default):** `clusterRef` → operator provisions the cluster CR; service operator resolves endpoints dynamically
- **Brownfield:** `host`/`servers` → operator provisions nothing; external infrastructure used directly
- Mutual exclusivity: the webhook requires **exactly one** of `database.clusterRef`/`database.host` and **exactly one** of `cache.clusterRef`/`cache.servers`

## K-ORC Integration

After Keystone is Ready, the c5c3-operator drives [K-ORC](../03-components/01-control-plane/05-korc.md) to manage the Keystone identity lifecycle. The model (issue [#30](https://github.com/C5C3/C5C3/issues/30)) has K-ORC authenticate with a **single restricted, project-scoped admin Application Credential** — the design's *only* App Cred.

What is **built today** (CC-0110) is the admin credential plus the Keystone catalog entry:

1. **`reconcileKORC` — mint the admin Application Credential.** It computes the SHA-256 of the admin password, then create-or-updates an owned K-ORC `ApplicationCredential` named `<cp.Name>-admin-app-credential` in the ControlPlane namespace. The spec's `restricted` is **inverted** into K-ORC's `Unrestricted` field (`restricted: true` → `Unrestricted: false`). The password hash is stamped onto the AC via the `forge.c5c3.io/admin-password-hash` annotation; a later pass that computes a different hash re-mints. `KORCReady` flips True once the AC reports `Available`. A missing K-ORC CRD surfaces `KORCCRDNotInstalled` rather than crash-looping.
2. **`reconcileAdminCredential` — commit and mirror.** Gated on `KORCReady` **and** the K-ORC `clouds.yaml` ExternalSecret being Ready in the ControlPlane namespace. It ensures the operator-owned Secret K-ORC writes the minted credential into (clobber-safe: the operator owns only metadata/owner-ref, never `.data`), then ensures a **PushSecret** (`DeletionPolicy: None`) mirroring it to OpenBao at `openstack/keystone/admin/app-credential` via the `openbao-cluster-store`. Sets `AdminCredentialReady`. See [admin credential flow](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#k-orc-admin-credential-flow).
3. **`reconcileCatalog` — register the identity catalog entry.** Gated on `AdminCredentialReady`. It create-or-updates two owned K-ORC CRs (both `managementPolicy: managed`): an identity `Service` `<cp.Name>-identity-service` (`type: identity`, name `keystone`) and a public `Endpoint` `<cp.Name>-identity-endpoint` (`interface: public`, URL `http://keystone.<namespace>.svc:5000/v3`). Sets `CatalogReady` and `status.catalogReady`.

The admin credential is also reflected into `status.adminApplicationCredential` (`id`, `restricted`, `lastRotation`) on every pass.

> **Planned (roadmap P2-P4):** bootstrap resource imports beyond the admin credential, a Service + Endpoint pair **per** OpenStack service, and **per-pod service users** (one real Keystone user per workload replica slot, with no per-service Application Credentials) are not part of the current slice — only the single admin AC and the single identity Service/Endpoint are built. The per-pod design is documented next.

For K-ORC details, see [Control Plane — K-ORC](../03-components/01-control-plane/05-korc.md); for the full credential lifecycle, [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md).

## Per-pod service user reconciler

::: warning Roadmap (P2-P4) — outside the first CC-0110 slice
Per-pod / per-replica workload service users are **not** part of the current c5c3 slice. The `ServiceUserSpec`, `maxAge`, the Ephemeral mode, and the `ServiceUsersReady` condition are **not** introduced by the current CRD and arrive in later roadmap phases. The admin Application Credential portion (`AdminCredentialSpec` / `ApplicationCredentialSpec` / `RotationSpec`) **is** built and is documented under [ControlPlane CRD](#controlplane-crd) above. The design below is settled but future.
:::

This sub-reconciler will implement the per-pod credential model. CobaltCore goes **straight to per-pod** (no interim shared-service-user phase); see the [Implementation Roadmap](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#implementation-roadmap).

### ControlPlane spec additions (planned)

Each service spec would carry an optional `serviceUser`. Passwords never appear in the spec — they are generated by the operator.

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
    // PerReplica (default): one stable user per replica slot, pre-provisioned.
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
```

### Reconciliation logic (planned)

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

* **PerReplica** derives `desired` from the service's configured replica count (StatefulSet ordinals) or the node set (per-node DaemonSet). Users are **pre-provisioned**, so credentials exist before pods start.
* **Ephemeral** runs a **pod-watch**: a `User` CR is created per pod (owner-referenced to the pod) and deleted when the pod terminates.
* **`maxAge`** marks a slot's `User` CR for recreation once its credential exceeds `maxAge`, triggering a rolling pod recreation rather than an in-place password change.

### Garbage collection (finalizer + sweeper)

* **Finalizer (primary):** each per-pod `User`/grant CR carries a finalizer; K-ORC's own finalizer deletes the Keystone user before the CR is removed, revoking tokens and grants immediately.
* **Sweeper (backstop):** a periodic reconcile lists Keystone users carrying the `svc-<service>-…` naming prefix / c5c3-managed tag and deletes any with no live pod-identity or owner — covering force-deleted pods or lost nodes.

## SecretAggregate CRD

The `SecretAggregate` CRD ships today as **types + CRD YAML only** — there is **no controller**. The reconciler is deferred to CC-0023, and the operator RBAC for this kind is **read-only** (`get`/`list`/`watch`) until that reconciler lands, so the operator can observe `SecretAggregate` CRs without write access to a kind it does not yet manage. The L1 spec is a minimal placeholder:

```go
// SecretAggregate aggregates the Secrets produced by a control plane into a
// single materialized Secret (CC-0110). TYPES ONLY at L1 — reconciler deferred
// to CC-0023.
type SecretAggregateSpec struct {
    // TargetSecretName is the name of the materialized aggregate Secret the
    // (deferred, CC-0023) reconciler will produce.
    // +optional
    TargetSecretName string `json:"targetSecretName,omitempty"`
}
```

> **Planned (CC-0023):** the richer source/target shape — selecting specific keys from multiple source Secrets and merging them into one mounted Secret (DB, RabbitMQ, Ceph credentials) — is the target design. The per-pod Keystone credential is **not** aggregated here: it is mounted into exactly one pod and injected via env (`OS_KEYSTONE_AUTHTOKEN__{USERNAME,PASSWORD}`), see the [per-pod service user reconciler](#per-pod-service-user-reconciler).

## CredentialRotation CRD

The `CredentialRotation` CRD requests a one-shot rotation of a control-plane credential. Today the only supported target is the **K-ORC admin Application Credential**. It is **not** used for workload service users — those rotate by **pod recreation** (D4), not an in-place credential swap.

> **Not to be confused with the keystone-operator key rotation.** Keystone rotates **cryptographic keys** — Fernet token keys and credential *encryption* keys (`reconcile_fernet.go`, `reconcile_credential.go`; see [Keystone Dependencies](./05-keystone-dependencies.md#fernet-key-lifecycle)). The admin **password** itself rotates via the [admin credential rotation](./05-keystone-dependencies.md#admin-credential-rotation) design. This `CredentialRotation` CRD rotates only the admin *Application Credential* derived from that password.

```go
// CredentialRotation requests a one-shot rotation of a control-plane credential.
type CredentialRotationSpec struct {
    // Target — only "adminApplicationCredential" is supported at L1.
    // +kubebuilder:validation:Enum=adminApplicationCredential
    Target RotationTarget `json:"target"`

    // Bootstrap requests an idempotent initial mint rather than a rotation.
    // +optional
    Bootstrap bool `json:"bootstrap,omitempty"`

    // ReMint forces a fresh mint even if the current credential is still valid.
    // +optional
    ReMint bool `json:"reMint,omitempty"`

    // DEFERRED (read-but-ignored at L1; setting any emits a
    // "ScheduledRotationDeferred" event): scheduled-rotation cadence fields.
    // +optional
    IntervalDays *int32 `json:"intervalDays,omitempty"`
    // +optional
    PreRotationDays *int32 `json:"preRotationDays,omitempty"`
    // +optional
    GracePeriodDays *int32 `json:"gracePeriodDays,omitempty"`
}
```

### How it works (the "nudge")

The `CredentialRotationReconciler` **never mints the credential itself** — it nudges the ControlPlane reconciler:

1. It locates the target ControlPlane in the CredentialRotation's **own namespace** (the L1 contract is one ControlPlane per namespace): zero → `Ready=False` reason `NoControlPlane` (requeue); more than one → `Ready=False` reason `AmbiguousControlPlane` (no requeue).
2. For a **`bootstrap`** request it is a no-op if the admin AC already exists, otherwise it waits for `reconcileKORC` to mint it.
3. For a **rotation**, it nudges when `reMint: true` or the admin password hash differs from the AC's `forge.c5c3.io/admin-password-hash` annotation. The nudge simply **clears** that annotation on the AC CR; on its next pass `reconcileKORC` sees the mismatch and re-mints, re-stamping the fresh hash. Clearing (rather than deleting the AC) avoids any window where the admin credential is absent.

> **Planned:** the scheduled-rotation fields (`intervalDays`, `preRotationDays`, `gracePeriodDays`) and the two-credential pre-rotation/grace overlap are accepted by the schema but **deferred** — the reconciler reads-and-ignores them and emits a `ScheduledRotationDeferred` event so an operator knows the loop is not yet active.

```text
Day 0:  Restricted admin App Cred active (minted from the admin password)
       │
Day 83: Pre-rotation (intervalDays=90, preRotationDays=7)   ← PLANNED
       ├── operator re-mints a fresh RESTRICTED admin App Cred from the admin password
       ├── new credential written to K8s Secret → PushSecret → OpenBao
       ├── ESO updates k-orc-clouds-yaml; K-ORC picks up the new clouds.yaml
       └── old App Cred still valid (grace window)
       │
Day 84: Grace period ends (gracePeriodDays=1)               ← PLANNED
       └── old admin App Cred deleted from Keystone
```

For the full credential lifecycle, see [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md). For brownfield rotation, see [Brownfield Integration](../06-operations/03-brownfield-integration.md#step-5-credential-rotation).

## Rollout Strategy

::: warning Planned — phased update/rollback state machine
The `updatePhase` field exists today, but only `Idle` and `Updating` are active. The `UpdatingServices`, `Verifying`, and `RollingBack` phases are **reserved** enum values the current reconciler never sets, and there is no rollback logic yet. The phased-update model below is the target design.
:::

When the ControlPlane CR changes, the operator is designed to track progress through well-defined phases, inspired by ConfigHub's ChangeSets concept.

### Update Phases (target design)

| Phase | Status | Description | Rollback Trigger |
| --- | --- | --- | --- |
| `Idle` | **active** | No update in progress | — |
| `Updating` | **active** | A release update has started | — |
| `UpdatingServices` | reserved | Per-service CRs are being updated | Any service fails health checks |
| `Verifying` | reserved | Post-update verification (Tempest if enabled) | Verification failure |
| `RollingBack` | reserved | Reverting to the previous known-good state | — |

### Phase Tracking

```yaml
status:
  updatePhase: Updating
  observedGeneration: 7
  conditions:
    - type: Ready
      status: "False"
      reason: NotAllReady
      message: "One or more sub-conditions are not ready"
    - type: InfrastructureReady
      status: "True"
    - type: KeystoneReady
      status: "False"
      reason: WaitingForKeystone
  services:
    keystone:
      ready: false
      release: "2025.2"
  adminApplicationCredential:
    id: "a1b2c3..."
    restricted: true
  catalogReady: false
```

### Rollback (planned)

On failure in any phase, the c5c3-operator is designed to revert to the previous known-good state by reverting infrastructure/service CR specs to their previous values; FluxCD keeps the reverted state aligned with the previous Git commit. `updatePhase` would transition to `RollingBack` and then back to `Idle` once the rollback succeeds.

## Validation and Defaulting Webhook

`operators/c5c3/api/v1alpha1/controlplane_webhook.go` registers a `ControlPlaneWebhook` (a typed `admission.Defaulter`/`Validator`). It **defaults** `region` (`RegionOne`), `korc.adminCredential.cloudCredentialsRef.secretName` (`k-orc-clouds-yaml`), `applicationCredential.restricted` (`true`), and `rotation.mode` (`PasswordDriven`) for callers that bypass the CRD schema defaults. It **validates**:

- `openStackRelease` matches `^\d{4}\.\d$`;
- exactly one of `database.clusterRef` / `database.host`;
- exactly one of `cache.clusterRef` / `cache.servers`;
- `korc.adminCredential.passwordSecretRef.name` is set;
- `services.keystone.rotationInterval` (when set) is a positive whole number of days (only daily/weekly schedules are representable — mirrors `intervalToCron`).

## Controller Setup

`SetupWithManager` registers the field indexer (before the watches), then `Owns` every child CR the sub-reconcilers project and `Watches` Secrets so an admin-password rotation wakes the owning ControlPlane via the indexer.

```go
func (r *ControlPlaneReconciler) SetupWithManager(mgr ctrl.Manager) error {
    if err := registerControlPlaneSecretNameIndex(context.Background(), mgr.GetFieldIndexer()); err != nil {
        return err
    }

    // memcached.c5c3.io ships no Go module: owned as unstructured carrying memcachedGVK.
    memcached := &unstructured.Unstructured{}
    memcached.SetGroupVersionKind(memcachedGVK)

    return ctrl.NewControllerManagedBy(mgr).
        For(&c5c3v1alpha1.ControlPlane{}).
        Owns(&mariadbv1alpha1.MariaDB{}).
        Owns(&keystonev1alpha1.Keystone{}).
        Owns(&orcv1alpha1.ApplicationCredential{}).
        Owns(&orcv1alpha1.Service{}).
        Owns(&orcv1alpha1.Endpoint{}).
        Owns(memcached).
        Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(
            secretToControlPlaneMapper(mgr.GetClient()),
        )).
        Complete(r)
}
```

**RBAC markers** (as coded on `ControlPlaneReconciler` — note `secretaggregates` is **read-only** and there are no service-operator groups beyond keystone yet):

```go
// +kubebuilder:rbac:groups=c5c3.io,resources=controlplanes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=c5c3.io,resources=controlplanes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=c5c3.io,resources=controlplanes/finalizers,verbs=update
// +kubebuilder:rbac:groups=c5c3.io,resources=credentialrotations,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=c5c3.io,resources=credentialrotations/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=c5c3.io,resources=secretaggregates,verbs=get;list;watch
// +kubebuilder:rbac:groups=k8s.mariadb.com,resources=mariadbs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=memcached.c5c3.io,resources=memcacheds,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=keystone.openstack.c5c3.io,resources=keystones,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=openstack.k-orc.cloud,resources=applicationcredentials;services;endpoints,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=external-secrets.io,resources=externalsecrets;pushsecrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=external-secrets.io,resources=clustersecretstores,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
```

> **Planned:** RBAC for the additional service-operator groups (`nova.openstack.c5c3.io`, `neutron.…`, `glance.…`, `cinder.…`, `placement.…`), RabbitMQ/Valkey, and K-ORC `users`/`roles`/`projects`/`domains` is added as those projections and the per-pod service-user reconciler land.
