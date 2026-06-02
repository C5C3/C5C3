# CRD Implementation

This page documents how CobaltCore CRDs are implemented in Go using Kubebuilder markers, how status conditions are managed, and how validation webhooks enforce constraints. The Keystone CRD serves as the reference implementation — subsequent operators follow the same patterns.

For the high-level CRD design, see [Control Plane — Keystone Operator](../03-components/01-control-plane/02-service-operators.md#keystone-operator) and [CRDs](../04-architecture/01-crds.md).

## Keystone API Types

The Keystone CRD is defined in `operators/keystone/api/v1alpha1/keystone_types.go`:

```go
package v1alpha1

import (
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    networkingv1 "k8s.io/api/networking/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    commonv1 "github.com/c5c3/forge/internal/common/types"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Endpoint",type="string",JSONPath=".status.endpoint"
// +kubebuilder:printcolumn:name="Release",type="string",JSONPath=".status.installedRelease"
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
    // TLS/mTLS is opt-in via database.tls (CC-0106).
    // +kubebuilder:validation:XValidation:rule="has(self.clusterRef) != has(self.host)",message="exactly one of clusterRef or host must be set"
    // +kubebuilder:validation:XValidation:rule="!has(self.tls) || !self.tls.enabled || (self.tls.caBundleSecretRef.name != '' && self.tls.clientCertSecretRef.name != '')",message="when database.tls.enabled is true, both caBundleSecretRef.name and clientCertSecretRef.name must be set"
    Database commonv1.DatabaseSpec `json:"database"`

    // Cache defines the Memcached cache configuration.
    // Supports managed (clusterRef) and brownfield (servers) modes.
    // +kubebuilder:validation:XValidation:rule="has(self.clusterRef) != (has(self.servers) && size(self.servers) > 0)",message="exactly one of clusterRef or servers must be set"
    Cache commonv1.CacheSpec `json:"cache"`

    // Fernet configures Fernet key rotation.
    Fernet FernetSpec `json:"fernet,omitempty"`

    // CredentialKeys configures credential key rotation.
    CredentialKeys CredentialKeysSpec `json:"credentialKeys,omitempty"`

    // TrustFlush configures periodic purging of expired trust delegations
    // (CC-0057, CC-0096). The defaulting webhook materializes a populated
    // TrustFlushSpec when unset, so keystone-manage trust_flush runs hourly
    // by default. Set suspend: true to pause without removing the CronJob.
    // +optional
    TrustFlush *TrustFlushSpec `json:"trustFlush,omitempty"`

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
    // +kubebuilder:validation:XValidation:rule="(has(self.rules) && size(self.rules) > 0) || self.configMapRef != null",message="at least one of rules or configMapRef must be set"
    // +kubebuilder:validation:XValidation:rule="!has(self.rules) || self.rules.all(k, k != '')",message="policy rule name must not be empty"
    PolicyOverrides *commonv1.PolicySpec `json:"policyOverrides,omitempty"`

    // Autoscaling configures horizontal pod autoscaling for the Keystone API deployment.
    // When set, a HorizontalPodAutoscaler is created targeting the deployment.
    // When removed, the HPA is deleted.
    // +optional
    Autoscaling *AutoscalingSpec `json:"autoscaling,omitempty"`

    // NetworkPolicy configures network isolation for Keystone API pods.
    // When set, a NetworkPolicy is created restricting ingress and egress traffic.
    // When removed (nil), the NetworkPolicy is deleted and traffic flows unrestricted.
    // +optional
    NetworkPolicy *NetworkPolicySpec `json:"networkPolicy,omitempty"`

    // Gateway configures external exposure of the Keystone API via a Gateway API
    // HTTPRoute (CC-0065). The Gateway/GatewayClass themselves are infrastructure
    // managed outside this operator; the operator only manages the HTTPRoute.
    // +optional
    Gateway *GatewaySpec `json:"gateway,omitempty"`

    // Resources defines the CPU and memory requests and limits for the Keystone API
    // container. When unset, the defaulting webhook injects sensible defaults
    // (256Mi/512Mi memory, 100m/500m CPU) to ensure Burstable QoS class and
    // enable HPA utilization calculations (CC-0042).
    // +optional
    Resources *corev1.ResourceRequirements `json:"resources,omitempty"`

    // UWSGI tunes the uWSGI server running the Keystone API (CC-0084).
    // When unset, the defaulting webhook materializes sensible defaults.
    // +optional
    UWSGI *UWSGISpec `json:"uwsgi,omitempty"`

    // Logging configures oslo.log output for the Keystone API container (CC-0098).
    // When unset, the defaulting webhook materializes a baseline LoggingSpec.
    // +optional
    Logging *LoggingSpec `json:"logging,omitempty"`

    // TerminationGracePeriodSeconds bounds the graceful-shutdown window for
    // Keystone API pods (CC-0084). When nil, Kubernetes' 30s default applies.
    // +optional
    // +kubebuilder:validation:Minimum=10
    TerminationGracePeriodSeconds *int64 `json:"terminationGracePeriodSeconds,omitempty"`

    // PreStopSleepSeconds inserts a preStop sleep so in-flight requests drain
    // before SIGTERM reaches uWSGI (CC-0084).
    // +optional
    // +kubebuilder:validation:Minimum=0
    PreStopSleepSeconds *int64 `json:"preStopSleepSeconds,omitempty"`

    // Strategy overrides the Deployment rollout strategy (CC-0084).
    // When nil, the reconciler applies a RollingUpdate default.
    // +optional
    Strategy *appsv1.DeploymentStrategy `json:"strategy,omitempty"`

    // TopologySpreadConstraints controls pod spreading (CC-0075). When nil, the
    // operator injects two default constraints; an explicit (even empty) slice
    // is honored verbatim.
    // +optional
    TopologySpreadConstraints []corev1.TopologySpreadConstraint `json:"topologySpreadConstraints,omitempty"`

    // PriorityClassName sets the pod PriorityClass. The validating webhook
    // verifies the named PriorityClass exists. When unset, the cluster default applies.
    // +optional
    PriorityClassName *string `json:"priorityClassName,omitempty"`

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

// CredentialKeysSpec defines credential key rotation configuration.
type CredentialKeysSpec struct {
    // RotationSchedule is a cron expression for credential key rotation.
    // +kubebuilder:default="0 0 * * 0"
    RotationSchedule string `json:"rotationSchedule,omitempty"`

    // MaxActiveKeys is the maximum number of active credential keys.
    // +kubebuilder:validation:Minimum=3
    // +kubebuilder:default=3
    MaxActiveKeys int32 `json:"maxActiveKeys,omitempty"`
}

// TrustFlushSpec configures periodic purging of expired trust delegations (CC-0057).
type TrustFlushSpec struct {
    // Schedule is a cron expression controlling when keystone-manage trust_flush runs.
    // +kubebuilder:default="0 * * * *"
    Schedule string `json:"schedule,omitempty"`

    // Suspend pauses the CronJob without deleting it.
    // +kubebuilder:default=false
    Suspend bool `json:"suspend,omitempty"`

    // Args provides additional CLI flags passed to keystone-manage trust_flush.
    // +optional
    Args []string `json:"args,omitempty"`
}

// UWSGISpec tunes the uWSGI server running the Keystone API (CC-0084).
type UWSGISpec struct {
    // Processes is the number of uWSGI worker processes.
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:default=2
    Processes int32 `json:"processes,omitempty"`

    // Threads is the number of threads per uWSGI worker process.
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:default=1
    Threads int32 `json:"threads,omitempty"`

    // HTTPKeepAlive enables the --http-keepalive flag.
    // +kubebuilder:default=true
    HTTPKeepAlive bool `json:"httpKeepAlive,omitempty"`

    // Harakiri caps per-request worker lifetime (seconds). When nil, the flag is
    // omitted. The webhook requires harakiri < terminationGrace - preStopSleep.
    // +optional
    // +kubebuilder:validation:Minimum=1
    Harakiri *int32 `json:"harakiri,omitempty"`

    // HTTPKeepAliveTimeout bounds the idle keep-alive timeout (seconds).
    // +optional
    // +kubebuilder:validation:Minimum=1
    HTTPKeepAliveTimeout *int32 `json:"httpKeepAliveTimeout,omitempty"`
}

// GatewaySpec configures the Gateway API HTTPRoute the operator manages (CC-0065).
type GatewaySpec struct {
    // ParentRef identifies the Gateway that the HTTPRoute attaches to.
    ParentRef GatewayParentRefSpec `json:"parentRef"`

    // Hostname is the externally reachable host matched by the HTTPRoute and
    // used to derive status.endpoint as https://{hostname}/v3.
    // +kubebuilder:validation:MinLength=1
    Hostname string `json:"hostname"`

    // Path is the URL path prefix matched by the HTTPRoute. Defaults to "/".
    // +optional
    Path string `json:"path,omitempty"`

    // Annotations are passed through to the HTTPRoute metadata verbatim.
    // +optional
    Annotations map[string]string `json:"annotations,omitempty"`
}

// GatewayParentRefSpec references a pre-existing Gateway (CC-0065).
type GatewayParentRefSpec struct {
    // +kubebuilder:validation:MinLength=1
    Name string `json:"name"`
    // Namespace defaults to the Keystone CR's namespace when empty.
    // +optional
    Namespace string `json:"namespace,omitempty"`
    // SectionName targets a specific Gateway listener (e.g. "https").
    // +optional
    SectionName string `json:"sectionName,omitempty"`
}

// LoggingSpec configures oslo.log output for the Keystone API container (CC-0098).
type LoggingSpec struct {
    // Format selects "text" (oslo.log line format) or "json" (one object per record).
    // +kubebuilder:validation:Enum=text;json
    // +kubebuilder:default=text
    Format string `json:"format,omitempty"`

    // Level is the root logger level.
    // +kubebuilder:validation:Enum=DEBUG;INFO;WARNING;ERROR;CRITICAL
    // +kubebuilder:default=INFO
    Level string `json:"level,omitempty"`

    // Debug toggles oslo.log [DEFAULT] debug=true (gates extra-verbose code paths).
    // +kubebuilder:default=false
    Debug bool `json:"debug,omitempty"`

    // PerLoggerLevels overrides named-logger levels (validated by the webhook).
    // +optional
    PerLoggerLevels map[string]string `json:"perLoggerLevels,omitempty"`
}

// AutoscalingSpec defines the parameters for horizontal pod autoscaling (CC-0038).
// +kubebuilder:validation:XValidation:rule="has(self.targetCPUUtilization) || has(self.targetMemoryUtilization)",message="at least one of targetCPUUtilization or targetMemoryUtilization must be set"
type AutoscalingSpec struct {
    // MinReplicas is the lower bound for the number of replicas.
    // Defaults to the current spec.replicas value if unset.
    // +optional
    // +kubebuilder:validation:Minimum=1
    MinReplicas *int32 `json:"minReplicas,omitempty"`

    // MaxReplicas is the upper bound for the number of replicas.
    // +kubebuilder:validation:Minimum=1
    MaxReplicas int32 `json:"maxReplicas"`

    // TargetCPUUtilization is the target average CPU utilization (percentage).
    // +optional
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=100
    TargetCPUUtilization *int32 `json:"targetCPUUtilization,omitempty"`

    // TargetMemoryUtilization is the target average memory utilization (percentage).
    // +optional
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=100
    TargetMemoryUtilization *int32 `json:"targetMemoryUtilization,omitempty"`
}

// NetworkPolicySpec defines network isolation for Keystone API pods (CC-0039).
// When applied, the operator creates a NetworkPolicy that restricts ingress
// to TCP 5000 from the specified sources and auto-derives egress rules for
// DNS, MariaDB (from database.ClusterRef), and Memcached (from cache.ClusterRef).
// +kubebuilder:validation:XValidation:rule="size(self.ingress) > 0",message="at least one ingress source must be specified"
type NetworkPolicySpec struct {
    // Ingress defines the sources allowed to reach Keystone API on TCP 5000.
    Ingress []NetworkPolicyIngressSource `json:"ingress"`

    // AdditionalEgress defines extra egress rules appended after auto-derived
    // rules (DNS, MariaDB, Memcached).
    // +optional
    AdditionalEgress []networkingv1.NetworkPolicyEgressRule `json:"additionalEgress,omitempty"`
}

// NetworkPolicyIngressSource defines a source from which traffic is allowed
// to reach the Keystone API pods on TCP 5000 (CC-0039).
type NetworkPolicyIngressSource struct {
    // NamespaceSelector selects namespaces from which traffic is allowed.
    NamespaceSelector map[string]string `json:"namespaceSelector"`

    // PodSelector optionally restricts allowed traffic to pods matching
    // these labels within the selected namespaces.
    // +optional
    PodSelector map[string]string `json:"podSelector,omitempty"`
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

    // PublicEndpoint is the externally routable Keystone endpoint URL used for
    // --bootstrap-public-url. When unset, the cluster-local service DNS is used
    // as a fallback. External clients (CLI users, Horizon, federation partners)
    // require a routable address here (CC-0013).
    // +optional
    PublicEndpoint string `json:"publicEndpoint,omitempty"`

    // PasswordRotation optionally enables scheduled rotation of the admin
    // password ("Model B", CC-0109). Nil (the default) leaves the feature off
    // and the sub-reconciler is a clean no-op.
    // +optional
    PasswordRotation *PasswordRotationSpec `json:"passwordRotation,omitempty"`
}

// PasswordRotationSpec configures scheduled admin-password rotation (CC-0109).
// Opt-in and, by design, single-CR-per-cluster: the push path is the single
// flat OpenBao key bootstrap/keystone-admin shared with the keystone-admin
// ExternalSecret.
type PasswordRotationSpec struct {
    // Enabled turns on scheduled admin-password rotation. Disabling it tears
    // down every Model B resource.
    // +kubebuilder:default=false
    Enabled bool `json:"enabled,omitempty"`

    // Schedule is a cron expression controlling when a new admin password is
    // generated. Defaults to monthly at midnight on the 1st.
    // +kubebuilder:default="0 0 1 * *"
    Schedule string `json:"schedule,omitempty"`

    // Suspend pauses the CronJob without deleting it or any sibling resource,
    // matching TrustFlushSpec.Suspend semantics.
    // +kubebuilder:default=false
    Suspend bool `json:"suspend,omitempty"`

    // PasswordLength is the length of the generated password.
    // +kubebuilder:validation:Minimum=24
    // +kubebuilder:default=32
    PasswordLength int32 `json:"passwordLength,omitempty"`
}

// UpgradePhase represents the current phase of a database upgrade (CC-0056).
// +kubebuilder:validation:Enum=Expanding;Migrating;RollingUpdate;Contracting
type UpgradePhase string

const (
    UpgradePhaseExpanding     UpgradePhase = "Expanding"
    UpgradePhaseMigrating     UpgradePhase = "Migrating"
    UpgradePhaseRollingUpdate UpgradePhase = "RollingUpdate"
    UpgradePhaseContracting   UpgradePhase = "Contracting"
)

// KeystoneStatus defines the observed state of Keystone.
type KeystoneStatus struct {
    // Conditions represent the latest available observations of the Keystone state.
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // Endpoint is the Keystone API endpoint URL.
    Endpoint string `json:"endpoint,omitempty"`

    // InstalledRelease is the OpenStack release version currently deployed (CC-0056).
    InstalledRelease string `json:"installedRelease,omitempty"`

    // TargetRelease is the upgrade target release during an active upgrade (CC-0056).
    TargetRelease string `json:"targetRelease,omitempty"`

    // UpgradePhase is the current phase of a database upgrade (CC-0056).
    UpgradePhase UpgradePhase `json:"upgradePhase,omitempty"`
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
      position: after
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
| **DatabaseTLSReady** | DB client certificate provisioned (or not required) (CC-0106) |
| **FernetKeysReady** | Fernet key Secret exists, rotation CronJob is configured |
| **CredentialKeysReady** | Credential key Secret exists, rotation CronJob is configured |
| **DatabaseReady** | MariaDB Database and User CRs are ready, db_sync Job completed |
| **PolicyValidReady** | `oslopolicy-validator` accepted the rendered policy.yaml (CC-0058) |
| **DeploymentReady** | Keystone Deployment has all replicas available |
| **KeystoneAPIReady** | Active HTTP health check against the API endpoint succeeded (CC-0067) |
| **HPAReady** | HorizontalPodAutoscaler is configured (or skipped when autoscaling is nil) |
| **NetworkPolicyReady** | NetworkPolicy is configured (or skipped when networkPolicy is nil) |
| **HTTPRouteReady** | Gateway API HTTPRoute reconciled (or skipped when gateway is nil) (CC-0065) |
| **BootstrapReady** | Bootstrap Job completed successfully |
| **TrustFlushReady** | Trust-flush CronJob reconciled (CC-0057) |
| **PasswordRotationReady** | Admin-password rotation reconciled, or disabled/torn down (CC-0109) |

> A separate informational condition **LoggingHealthy** is set by `reconcileConfig` (stderr-disabled detection) but is **not** part of the aggregate set above — it does not gate `Ready`.

**Condition progression during initial deployment:**

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CONDITION PROGRESSION                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  t=0   SecretsReady=False          (waiting for ESO sync)                   │
│  t=15s SecretsReady=True           (ESO secrets available)                  │
│         DatabaseTLSReady=True      (client cert issued or not required)     │
│         (Fernet | Credential | NetworkPolicy reconcile in parallel)        │
│  t=25s FernetKeysReady=True        CredentialKeysReady=True                 │
│         NetworkPolicyReady=True    (policy applied)                         │
│         DatabaseReady=False        (creating MariaDB CRs)                   │
│  t=55s DatabaseReady=True          (db_sync completed)                      │
│         PolicyValidReady=True      (oslopolicy-validator passed)            │
│         DeploymentReady=False      (pods starting)                          │
│  t=85s DeploymentReady=True        (all replicas ready)                     │
│         HTTPRouteReady=True        KeystoneAPIReady=True                    │
│         HPAReady=True              (HPA configured or skipped)              │
│         BootstrapReady=False       (running bootstrap job)                  │
│  t=95s BootstrapReady=True   TrustFlushReady=True                          │
│         PasswordRotationReady=True (rotation reconciled or disabled)         │
│         Ready=True                 (all conditions met)                     │
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

Webhooks provide runtime validation beyond what OpenAPI schemas can express, plus defaulting for optional fields. Forge uses the controller-runtime **generic typed webhook** pattern: a standalone `KeystoneWebhook` struct (not methods on the CR type) implementing `admission.Defaulter[*Keystone]` and `admission.Validator[*Keystone]`, wired via `builder.WebhookManagedBy`. The struct carries a `client.Reader` for cluster-scoped lookups (e.g. verifying a referenced `PriorityClass` exists, CC-0075).

```go
// KeystoneWebhook implements defaulting and validation for the Keystone CRD.
// +kubebuilder:object:generate=false
type KeystoneWebhook struct {
    Client client.Reader
}

var (
    _ admission.Defaulter[*Keystone] = &KeystoneWebhook{}
    _ admission.Validator[*Keystone] = &KeystoneWebhook{}
)

func (w *KeystoneWebhook) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return builder.WebhookManagedBy[*Keystone](mgr, &Keystone{}).
        WithDefaulter(w).
        WithValidator(w).
        Complete()
}
```

**Defaulting webhook** — abridged; the real `Default` also materializes `CredentialKeys.MaxActiveKeys`, a populated `TrustFlush` (hourly schedule), `UWSGI` sub-fields, a baseline `Logging`, the `Resources` requests/limits (CC-0042), `Database.TLS.Mode` (`require`, CC-0106), the `Bootstrap.AdminUser` (`admin`) / `Bootstrap.Region` (`RegionOne`) defaults, and — only when `Bootstrap.PasswordRotation.Enabled` — its `Schedule` (`0 0 1 * *`) and `PasswordLength` (32) leaf defaults (CC-0109):

```go
func (w *KeystoneWebhook) Default(_ context.Context, obj *Keystone) error {
    if obj.Spec.Replicas == 0 {
        obj.Spec.Replicas = 3
    }
    if obj.Spec.Fernet.MaxActiveKeys == 0 {
        obj.Spec.Fernet.MaxActiveKeys = 3
    }
    if obj.Spec.Cache.Backend == "" {
        obj.Spec.Cache.Backend = "dogpile.cache.pymemcache"
    }
    if obj.Spec.TrustFlush == nil {
        obj.Spec.TrustFlush = &TrustFlushSpec{Schedule: DefaultTrustFlushSchedule}
    }
    // ... UWSGI, Logging, Resources, Database.TLS.Mode, Bootstrap defaults ...
    return nil
}
```

**Validation webhook** — abridged; the real `validate` is extensive, covering replicas, credential/fernet cron schedules, cache & database mutual-exclusivity, database TLS, trust-flush cron, uWSGI bounds + cross-field harakiri/keep-alive rules, logging enums + per-logger levels, termination-grace/preStop arithmetic, rollout strategy, autoscaling bounds, networkPolicy ingress, gateway + publicEndpoint host matching, resource requests≤limits, `priorityClassName` existence (via the injected client), topology-spread selectors, and — when `bootstrap.passwordRotation.enabled` — the rotation cron `schedule`, a required `bootstrap.adminPasswordSecretRef.name`, and `passwordLength` ≥ 24 (CC-0109):

```go
func (w *KeystoneWebhook) ValidateCreate(ctx context.Context, obj *Keystone) (admission.Warnings, error) {
    return nil, w.validate(ctx, obj)
}

func (w *KeystoneWebhook) ValidateUpdate(ctx context.Context, _, newObj *Keystone) (admission.Warnings, error) {
    return nil, w.validate(ctx, newObj)
}

func (w *KeystoneWebhook) ValidateDelete(_ context.Context, _ *Keystone) (admission.Warnings, error) {
    return nil, nil
}

func (w *KeystoneWebhook) validate(ctx context.Context, k *Keystone) error {
    var allErrs field.ErrorList

    if k.Spec.Replicas < 1 {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec", "replicas"), k.Spec.Replicas, "must be at least 1"))
    }

    // Validate cron expressions (fernet + credential rotation, trust flush)
    if _, err := cron.ParseStandard(k.Spec.Fernet.RotationSchedule); err != nil {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec", "fernet", "rotationSchedule"),
            k.Spec.Fernet.RotationSchedule, fmt.Sprintf("invalid cron expression: %v", err)))
    }

    // ... plugin section uniqueness, policyOverrides, uWSGI/logging,
    //     graceful-shutdown arithmetic, priorityClassName existence lookup ...

    if len(allErrs) > 0 {
        return apierrors.NewInvalid(
            schema.GroupKind{Group: GroupVersion.Group, Kind: "Keystone"}, k.Name, allErrs)
    }
    return nil
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
