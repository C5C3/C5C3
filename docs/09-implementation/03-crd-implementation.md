# CRD Implementation

This page documents how CobaltCore CRDs are implemented in Go using Kubebuilder markers, how status conditions are managed, and how validation webhooks enforce constraints. The Keystone CRD serves as the reference implementation — subsequent operators follow the same patterns.

For the high-level CRD design, see [Control Plane — Keystone Operator](../03-components/01-control-plane/02-service-operators.md#keystone-operator) and [CRDs](../04-architecture/01-crds.md).

## Keystone API Types

The Keystone CRD is defined in `operators/keystone/api/v1alpha1/keystone_types.go`:

```go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    commonv1 "github.com/c5c3/c5c3/internal/common/types"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Endpoint",type="string",JSONPath=".status.endpoint"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// Keystone is the Schema for the keystones API.
type Keystone struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   KeystoneSpec   `json:"spec,omitempty"`
    Status KeystoneStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// KeystoneList contains a list of Keystone.
type KeystoneList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []Keystone `json:"items"`
}

// KeystoneSpec defines the desired state of Keystone.
type KeystoneSpec struct {
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:default=3
    Replicas int32 `json:"replicas,omitempty"`

    // Image defines the Keystone container image reference.
    Image commonv1.ImageSpec `json:"image"`

    // Database defines the MariaDB connection parameters.
    // Supports managed (clusterRef) and brownfield (host/port) modes.
    // +kubebuilder:validation:XValidation:rule="has(self.clusterRef) != has(self.host)",message="exactly one of clusterRef or host must be set"
    Database commonv1.DatabaseSpec `json:"database"`

    // Cache defines the Memcached cache configuration.
    // Supports managed (clusterRef) and brownfield (servers) modes.
    Cache commonv1.CacheSpec `json:"cache"`

    // Fernet configures Fernet key rotation.
    Fernet FernetSpec `json:"fernet,omitempty"`

    // Federation configures Keystone federation (optional).
    // +optional
    Federation *FederationSpec `json:"federation,omitempty"`

    // Bootstrap configures the initial Keystone bootstrap.
    Bootstrap BootstrapSpec `json:"bootstrap"`

    // Middleware defines WSGI middleware filters for the api-paste.ini pipeline.
    // +optional
    Middleware []commonv1.MiddlewareSpec `json:"middleware,omitempty"`

    // Plugins defines service plugins/drivers to configure.
    // +optional
    Plugins []commonv1.PluginSpec `json:"plugins,omitempty"`

    // PolicyOverrides defines custom oslo.policy rules for the service.
    // When set, the operator renders a policy.yaml and configures
    // oslo_policy.policy_file automatically.
    // +optional
    // +kubebuilder:validation:XValidation:rule="self.rules != null || self.configMapRef != null",message="at least one of rules or configMapRef must be set"
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`

    // ExtraConfig provides free-form INI sections for configuration
    // not covered by explicit CRD fields.
    // +optional
    ExtraConfig map[string]map[string]string `json:"extraConfig,omitempty"`
}

// FernetSpec defines Fernet key rotation configuration.
type FernetSpec struct {
    // RotationSchedule is a cron expression for key rotation.
    // +kubebuilder:default="0 0 * * 0"
    RotationSchedule string `json:"rotationSchedule,omitempty"`

    // MaxActiveKeys is the maximum number of active Fernet keys.
    // +kubebuilder:validation:Minimum=3
    // +kubebuilder:default=3
    MaxActiveKeys int32 `json:"maxActiveKeys,omitempty"`
}

// FederationSpec defines Keystone federation configuration.
type FederationSpec struct {
    // Enabled activates federation support.
    Enabled bool `json:"enabled"`
}

// BootstrapSpec defines Keystone bootstrap parameters.
type BootstrapSpec struct {
    // AdminUser is the admin username for the bootstrap.
    // +kubebuilder:default="admin"
    AdminUser string `json:"adminUser,omitempty"`

    // AdminPasswordSecretRef references the Secret containing the admin password.
    AdminPasswordSecretRef commonv1.SecretRefSpec `json:"adminPasswordSecretRef"`

    // Region is the Keystone region name.
    // +kubebuilder:default="RegionOne"
    Region string `json:"region,omitempty"`
}

// KeystoneStatus defines the observed state of Keystone.
type KeystoneStatus struct {
    // Conditions represent the latest available observations of the Keystone state.
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // Endpoint is the Keystone API endpoint URL.
    Endpoint string `json:"endpoint,omitempty"`
}

func init() {
    SchemeBuilder.Register(&Keystone{}, &KeystoneList{})
}
```

## Plugin and Middleware Spec

The `Middleware` and `Plugins` fields are generic and reusable across all CobaltCore operators. The shared types are defined in `internal/common/types/` (see [Shared Library](./02-shared-library.md#plugins)).

**`spec.middleware[]`** — WSGI middleware filters inserted into the `api-paste.ini` pipeline. Each entry specifies a filter name, its Python factory entry point, its position in the pipeline, and optional configuration. This is generic for all OpenStack services since they all use PasteDeploy.

**`spec.plugins[]`** — Service-specific plugins or drivers. For Keystone, this includes identity drivers like `keystone-keycloak-backend`. For other services, this covers volume drivers (Cinder), ML2 mechanism drivers (Neutron), etc. Each entry specifies a plugin name, the INI section it configures, and key-value configuration.

**`spec.policyOverrides`** — Custom oslo.policy rules for the service. Supports both inline rules (`rules` map) and external ConfigMap references (`configMapRef`). Inline rules take precedence over ConfigMap rules. When set, the operator automatically renders a `policy.yaml` file and configures `[oslo_policy] policy_file` in the service config. See [Customization — Policy Override Support](../05-deployment/03-service-configuration/03-customization.md#policy-override-support).

**`spec.extraConfig`** — Free-form `map[string]map[string]string` for INI sections the operator does not explicitly model. This is the escape hatch described in [Customization](../05-deployment/03-service-configuration/03-customization.md) — it allows configuring any oslo.config option without requiring a CRD change.

**Example — Keystone with audit middleware and Keycloak backend:**

```yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: keystone
  namespace: openstack
spec:
  replicas: 3
  image:
    repository: ghcr.io/c5c3/keystone
    tag: "28.0.0"
  database:
    clusterRef:
      name: mariadb                # Managed mode: references MariaDB CR
    database: keystone
    secretRef:
      name: keystone-db-credentials
      key: password
  cache:
    clusterRef:
      name: memcached              # Managed mode: references Memcached CR
    backend: dogpile.cache.pymemcache
  fernet:
    rotationSchedule: "0 0 * * 0"
    maxActiveKeys: 3
  bootstrap:
    adminUser: admin
    adminPasswordSecretRef:
      name: keystone-admin-credentials
      key: password
    region: RegionOne

  # WSGI middleware — inserted into api-paste.ini pipeline
  middleware:
    - name: audit
      filterFactory: "audit_middleware:filter_factory"
      position:
        after: authtoken
      config:
        audit_map_file: /etc/keystone/audit_map.yaml

  # Service plugins — generate INI config sections
  plugins:
    - name: keystone-keycloak-backend
      configSection: keycloak
      config:
        server_url: https://keycloak.example.com
        realm_name: openstack
        client_id: keystone

  # Extra config — free-form INI override
  extraConfig:
    identity:
      domain_specific_drivers_enabled: "true"
      domain_config_dir: /etc/keystone/domains
```

**Example — Keystone with policy overrides:**

```yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: keystone
  namespace: openstack
spec:
  replicas: 3
  image:
    repository: ghcr.io/c5c3/keystone
    tag: "28.0.0"
  database:
    clusterRef:
      name: mariadb
    database: keystone
    secretRef:
      name: keystone-db-credentials
      key: password
  cache:
    clusterRef:
      name: memcached
    backend: dogpile.cache.pymemcache

  # Policy overrides — inline rules
  policyOverrides:
    rules:
      "identity:create_project": "role:admin"
      "identity:list_users": "role:admin or role:reader"
      "identity:get_user": "role:admin or role:reader"

  # Policy overrides — combined with external ConfigMap
  # policyOverrides:
  #   configMapRef:
  #     name: keystone-custom-policies
  #   rules:
  #     "identity:create_project": "role:admin"  # inline overrides ConfigMap
```

## Status Conditions

Each condition type reflects a discrete reconciliation phase. The `Ready` condition is True only when all other conditions are True. See [Keystone Reconciler](./04-keystone-reconciler.md) for the sub-reconciler implementation that drives these conditions.

| Condition | Description |
| --- | --- |
| **Ready** | Aggregate — True when all sub-conditions are True |
| **SecretsReady** | ESO-provided Kubernetes Secrets exist and contain expected keys |
| **DatabaseReady** | MariaDB Database and User CRs are ready, db_sync Job completed |
| **FernetKeysReady** | Fernet key Secret exists, rotation CronJob is configured |
| **BootstrapReady** | Bootstrap Job completed successfully |
| **DeploymentReady** | Keystone Deployment has all replicas available |

**Condition progression during initial deployment:**

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CONDITION PROGRESSION                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  t=0   SecretsReady=False     (waiting for ESO sync)                        │
│  t=15s SecretsReady=True      (ESO secrets available)                       │
│         DatabaseReady=False   (creating MariaDB CRs)                        │
│  t=45s DatabaseReady=True     (db_sync completed)                           │
│         FernetKeysReady=False (generating Fernet keys)                      │
│  t=50s FernetKeysReady=True   (keys generated, CronJob created)             │
│         DeploymentReady=False (pods starting)                               │
│  t=80s DeploymentReady=True   (all replicas ready)                          │
│         BootstrapReady=False  (running bootstrap job)                       │
│  t=90s BootstrapReady=True    (bootstrap completed)                         │
│         Ready=True            (all conditions met)                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## DeepCopy Generation

Kubebuilder requires all CRD types to implement the `runtime.Object` interface via DeepCopy methods. These are auto-generated:

```bash
controller-gen object paths="./api/..."
```

This generates `zz_generated.deepcopy.go` in the `api/v1alpha1/` directory. Regenerate whenever CRD types change.

## CRD Manifest Generation

CRD YAML manifests are generated from the Go types and Kubebuilder markers:

```bash
controller-gen crd paths="./api/..." output:crd:artifacts:config=config/crd/bases
```

This produces `config/crd/bases/keystone.openstack.c5c3.io_keystones.yaml` containing the full OpenAPI v3.0 schema, validation rules, printer columns, and subresource definitions.

## Validation and Defaulting Webhooks

Webhooks provide runtime validation beyond what OpenAPI schemas can express, plus defaulting for optional fields.

**Defaulting webhook (`keystone_webhook.go`):**

```go
func (r *Keystone) Default() {
    if r.Spec.Replicas == 0 {
        r.Spec.Replicas = 3
    }
    if r.Spec.Fernet.MaxActiveKeys == 0 {
        r.Spec.Fernet.MaxActiveKeys = 3
    }
    if r.Spec.Cache.Backend == "" {
        r.Spec.Cache.Backend = "dogpile.cache.pymemcache"
    }
    if r.Spec.Bootstrap.AdminUser == "" {
        r.Spec.Bootstrap.AdminUser = "admin"
    }
    if r.Spec.Bootstrap.Region == "" {
        r.Spec.Bootstrap.Region = "RegionOne"
    }
}
```

**Validation webhook:**

```go
func (r *Keystone) ValidateCreate() (admission.Warnings, error) {
    return r.validate()
}

func (r *Keystone) ValidateUpdate(old runtime.Object) (admission.Warnings, error) {
    return r.validate()
}

func (r *Keystone) validate() (admission.Warnings, error) {
    var allErrs field.ErrorList

    if r.Spec.Replicas < 1 {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec", "replicas"),
            r.Spec.Replicas,
            "must be at least 1"))
    }

    // Validate cron expression
    if _, err := cron.ParseStandard(r.Spec.Fernet.RotationSchedule); err != nil {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec", "fernet", "rotationSchedule"),
            r.Spec.Fernet.RotationSchedule,
            fmt.Sprintf("invalid cron expression: %v", err)))
    }

    // Validate plugin config — ensure no duplicate section names
    sections := map[string]bool{}
    for i, p := range r.Spec.Plugins {
        if sections[p.ConfigSection] {
            allErrs = append(allErrs, field.Duplicate(
                field.NewPath("spec", "plugins").Index(i).Child("configSection"),
                p.ConfigSection))
        }
        sections[p.ConfigSection] = true
    }

    // Validate policyOverrides — at least one source, no empty rule names
    if r.Spec.PolicyOverrides != nil {
        po := r.Spec.PolicyOverrides
        if po.Rules == nil && po.ConfigMapRef == nil {
            allErrs = append(allErrs, field.Required(
                field.NewPath("spec", "policyOverrides"),
                "at least one of rules or configMapRef must be set"))
        }
        for ruleName := range po.Rules {
            if ruleName == "" {
                allErrs = append(allErrs, field.Invalid(
                    field.NewPath("spec", "policyOverrides", "rules"),
                    ruleName, "rule name must not be empty"))
            }
        }
    }

    if len(allErrs) > 0 {
        return nil, apierrors.NewInvalid(
            schema.GroupKind{Group: GroupVersion.Group, Kind: "Keystone"},
            r.Name, allErrs)
    }
    return nil, nil
}
```

These validations complement the three-layer validation architecture described in [Validation](../05-deployment/03-service-configuration/02-validation.md) — Layer 1 (API Server schema) and Layer 2 (operator webhook + reconciler checks) are implemented here.

## Versioning Strategy

The initial CRD version is `v1alpha1`, indicating active development:

| Version | Stability | Conversion |
| --- | --- | --- |
| `v1alpha1` | Breaking changes possible between releases | N/A (single version) |
| `v1beta1` | API shape stabilized, no breaking changes | Conversion webhook from v1alpha1 |
| `v1` | Stable, production-grade | Conversion webhooks from v1alpha1 + v1beta1 |

The transition to `v1beta1` happens after the Keystone Operator has been validated in production environments. Conversion webhooks handle schema migration for existing CRs.
