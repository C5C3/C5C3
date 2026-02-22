# Shared Library

The shared library at `internal/common/` provides reusable building blocks for all CobaltCore operators. It encapsulates patterns for database interaction, config rendering, secret handling, deployment management, and plugin configuration — ensuring consistent behavior and reducing duplication across operators.

## Design Rationale

Without a shared library, each operator would independently implement the same patterns: waiting for MariaDB readiness, rendering INI config files, checking ESO secret availability, managing Kubernetes Jobs. This leads to divergence, duplicated bugs, and inconsistent user experience. The shared library centralizes these concerns.

## Comparison with openstack-k8s-operators/lib-common

Red Hat's [openstack-k8s-operators](https://github.com/openstack-k8s-operators) project uses a separate `lib-common` repository. CobaltCore takes a different approach:

| Aspect | Red Hat (lib-common) | CobaltCore (internal/common) |
| --- | --- | --- |
| **Repository** | Separate repo (`openstack-k8s-operators/lib-common`) | Monorepo subdirectory |
| **Versioning** | Tagged releases, operators pin specific versions | Go Workspace — all operators always use HEAD |
| **Dependency Management** | `go.mod` `require` with exact version | `go.work` `use` directive (local resolution) |
| **Breaking Changes** | Requires coordinated version bumps across repos | Single commit updates library + all consumers |
| **CI** | Separate CI per repo, cross-repo integration testing | Single CI pipeline tests everything together |
| **Discovery** | Separate docs/godoc | Colocated in the same codebase |

The monorepo approach trades release independence for development velocity — a breaking change in the shared library is immediately visible in all operator builds within the same CI run.

## Package Structure

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       internal/common/ PACKAGES                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  conditions/    Condition management for Status.Conditions                  │
│  config/        INI config rendering pipeline                               │
│  database/      MariaDB CR interaction and db_sync jobs                     │
│  deployment/    Deployment and Service creation                             │
│  job/           Kubernetes Job and CronJob management                       │
│  secrets/       ESO secret readiness and PushSecret helpers                 │
│  plugins/       Plugin and middleware config rendering                      │
│  tls/           cert-manager Certificate CR handling                        │
│  types/         Shared Go struct definitions                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### conditions/

Manages `metav1.Condition` entries on operator status objects.

| Function | Description |
| --- | --- |
| `SetCondition(conditions *[]metav1.Condition, condition metav1.Condition)` | Set or update a condition by type |
| `IsReady(conditions []metav1.Condition) bool` | Check if the `Ready` condition is True |
| `GetCondition(conditions []metav1.Condition, conditionType string) *metav1.Condition` | Retrieve a specific condition |
| `AllTrue(conditions []metav1.Condition, types ...string) bool` | Check if all specified conditions are True |

### database/

Encapsulates interaction with the [MariaDB Operator's](../03-components/01-control-plane.md#infrastructure-service-operators) CRDs.

| Function | Description |
| --- | --- |
| `EnsureDatabase(ctx, client, owner, spec) (bool, error)` | Create or verify a MariaDB `Database` CR. Returns true when ready. |
| `EnsureDatabaseUser(ctx, client, owner, spec) (bool, error)` | Create or verify a MariaDB `User` CR with `Grant` CR for privileges. |
| `RunDBSyncJob(ctx, client, owner, image, command, env) (bool, error)` | Run a `db_sync` Kubernetes Job using the service image. Returns true when completed. |

### config/

Implements the config generation pipeline documented in [Config Generation](../05-deployment/03-service-configuration/01-config-generation.md). This package renders INI configuration files from Go structs — no template language is used.

| Function | Description |
| --- | --- |
| `RenderINI(sections map[string]map[string]string) string` | Render a map of sections/keys into INI format |
| `MergeDefaults(userConfig, defaults map[string]map[string]string) map[string]map[string]string` | Merge user-provided config with operator defaults (user values take precedence) |
| `CreateImmutableConfigMap(ctx, client, owner, name, data) (*corev1.ConfigMap, error)` | Create an immutable ConfigMap with a content-hash suffix in its name |
| `InjectSecrets(config map[string]map[string]string, secrets map[string]string) map[string]map[string]string` | Assemble connection strings from resolved secret values (e.g., `mysql+pymysql://USERNAME:PASSWORD@HOST:PORT/DB`) |

The config package directly implements the pipeline from [Config Generation](../05-deployment/03-service-configuration/01-config-generation.md): CRD spec → resolve secrets → apply defaults → render INI → immutable ConfigMap.
Override mechanisms described in [Customization](../05-deployment/03-service-configuration/03-customization.md) (configOverrides, conf.d pattern) are supported via `MergeDefaults` with user-provided overrides taking precedence.

### deployment/

Creates and manages Kubernetes Deployments and Services.

| Function | Description |
| --- | --- |
| `EnsureDeployment(ctx, client, owner, spec) (bool, error)` | Create or update a Deployment. Returns true when available. |
| `EnsureService(ctx, client, owner, spec) error` | Create or update a ClusterIP Service. |
| `IsDeploymentReady(deployment *appsv1.Deployment) bool` | Check if all replicas are available. |

### job/

Manages one-shot Jobs and recurring CronJobs.

| Function | Description |
| --- | --- |
| `RunJob(ctx, client, owner, spec) (bool, error)` | Create a Job and wait for completion. Returns true when succeeded. |
| `EnsureCronJob(ctx, client, owner, spec) error` | Create or update a CronJob. |
| `IsJobComplete(job *batchv1.Job) bool` | Check if a Job has completed successfully. |

### secrets/

Provides helpers for ESO-based secret workflows. Operators never interact with OpenBao directly — they work exclusively with Kubernetes Secrets that ESO creates from OpenBao (see [Secret Management](../05-deployment/02-secret-management.md)).

| Function | Description |
| --- | --- |
| `WaitForExternalSecret(ctx, client, namespace, name) (bool, error)` | Check if an ExternalSecret has synced and the target K8s Secret exists. Returns true when ready. |
| `IsSecretReady(ctx, client, namespace, name) (bool, error)` | Verify that a K8s Secret exists and contains expected keys. |
| `EnsurePushSecret(ctx, client, owner, spec) error` | Create or update a PushSecret CR to write operator-generated secrets back to OpenBao. |
| `GetSecretValue(ctx, client, namespace, name, key) (string, error)` | Read a specific key from a K8s Secret. |

**PushSecret pattern:** Some secrets are generated by operators at runtime (e.g., Fernet keys). These are written to a Kubernetes Secret and then pushed to OpenBao via a PushSecret CR for backup and cross-cluster distribution. See [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md) for the full ESO/PushSecret flow.

### plugins/

Provides a generic plugin and middleware configuration framework usable by all OpenStack service operators. All OpenStack services use PasteDeploy for WSGI pipeline configuration, making this framework universally applicable.

| Function | Description |
| --- | --- |
| `RenderPastePipeline(pipelineSpec PipelineSpec) string` | Generate `api-paste.ini` from a declarative pipeline specification. Operators define a base pipeline and add middleware filters (e.g., audit, CORS, rate limiting) from the CRD. |
| `RenderPluginConfig(plugins []PluginSpec) map[string]map[string]string` | Generate INI config sections for service plugins (e.g., `[keycloak]` for keystone-keycloak-backend, `[filter:audit]` for openstack-audit-middleware). |

**Shared types:**

```go
// PluginSpec defines a service plugin/driver configuration.
type PluginSpec struct {
    // Name of the plugin (e.g., "keystone-keycloak-backend")
    Name string `json:"name"`
    // ConfigSection is the INI section name (e.g., "keycloak")
    ConfigSection string `json:"configSection"`
    // Config contains key-value pairs for the plugin's INI section
    Config map[string]string `json:"config"`
}

// MiddlewareSpec defines a WSGI middleware filter for api-paste.ini.
type MiddlewareSpec struct {
    // Name of the filter (e.g., "audit")
    Name string `json:"name"`
    // FilterFactory is the Python entry point (e.g., "audit_middleware:filter_factory")
    FilterFactory string `json:"filterFactory"`
    // Position defines where in the pipeline this filter is inserted
    Position PipelinePosition `json:"position"`
    // Config contains key-value pairs for the filter section
    Config map[string]string `json:"config,omitempty"`
}
```

### tls/

Integrates with cert-manager for TLS certificate provisioning.

| Function | Description |
| --- | --- |
| `EnsureCertificate(ctx, client, owner, spec) error` | Create or update a cert-manager `Certificate` CR. |
| `GetTLSSecret(ctx, client, namespace, name) (*corev1.Secret, error)` | Retrieve the TLS Secret created by cert-manager. |

### types/

Shared Go struct definitions used across operator CRDs:

```go
// ImageSpec defines a container image reference.
type ImageSpec struct {
    Repository string `json:"repository"`
    Tag        string `json:"tag"`
}

// DatabaseSpec supports managed (ClusterRef) and brownfield (explicit) modes.
// Exactly one of ClusterRef or Host must be set.
type DatabaseSpec struct {
    // ClusterRef references a MariaDB CR in the cluster (managed mode).
    // +optional
    ClusterRef *corev1.LocalObjectReference `json:"clusterRef,omitempty"`
    // Host is the database hostname (brownfield mode).
    // +optional
    Host string `json:"host,omitempty"`
    // Port is the database port (brownfield mode, default 3306).
    // +optional
    Port int32 `json:"port,omitempty"`
    // Database is the database name within the cluster.
    Database string `json:"database"`
    // SecretRef references the K8s Secret with credentials.
    SecretRef SecretRefSpec `json:"secretRef"`
}

// MessagingSpec supports managed (ClusterRef) and brownfield (explicit) modes.
// Exactly one of ClusterRef or Hosts must be set.
type MessagingSpec struct {
    // ClusterRef references a RabbitMQ CR in the cluster (managed mode).
    // +optional
    ClusterRef *corev1.LocalObjectReference `json:"clusterRef,omitempty"`
    // Hosts is the list of RabbitMQ endpoints (brownfield mode).
    // +optional
    Hosts []string `json:"hosts,omitempty"`
    // SecretRef references the K8s Secret with credentials.
    SecretRef SecretRefSpec `json:"secretRef"`
}

// CacheSpec supports managed (ClusterRef) and brownfield (explicit) modes.
// Exactly one of ClusterRef or Servers must be set.
type CacheSpec struct {
    // ClusterRef references a Memcached CR in the cluster (managed mode).
    // +optional
    ClusterRef *corev1.LocalObjectReference `json:"clusterRef,omitempty"`
    // Backend is the cache backend (e.g. dogpile.cache.pymemcache).
    Backend string `json:"backend"`
    // Servers is the list of cache server endpoints (brownfield mode).
    // +optional
    Servers []string `json:"servers,omitempty"`
}

// SecretRefSpec references a Kubernetes Secret.
type SecretRefSpec struct {
    Name string `json:"name"`
    Key  string `json:"key,omitempty"`
}
```

## Secret Flow Design Principle

Operators interact exclusively with Kubernetes Secrets. The full secret lifecycle flows through OpenBao and ESO, but operators are unaware of this — they only see standard Kubernetes Secrets.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SECRET FLOW                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐    ExternalSecret    ┌─────────────┐    Operator reads        │
│  │ OpenBao  │ ──────────────────▶  │ K8s Secret  │ ──────────────────▶      │
│  │          │    (ESO syncs)       │             │    secret values         │
│  └──────────┘                      └─────────────┘                          │
│       ▲                                                                     │
│       │            PushSecret      ┌─────────────┐    Operator writes       │
│       └─────────────────────────── │ K8s Secret  │ ◀──────────────────      │
│              (ESO pushes)          │ (generated) │    generated secrets     │
│                                    └─────────────┘                          │
│                                                                             │
│  Direction 1 (read):                                                        │
│  OpenBao → ESO ExternalSecret → K8s Secret → Operator reads → Config        │
│                                                                             │
│  Direction 2 (write-back):                                                  │
│  Operator generates secret → K8s Secret → ESO PushSecret → OpenBao          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

See [Secret Management](../05-deployment/02-secret-management.md) for OpenBao architecture and policies. See [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md) for the bootstrap flow and PushSecret patterns.

## Extra Packages / Plugin Installation (Build-Time)

Plugins and middleware (e.g., `openstack-audit-middleware`, `keystone-keycloak-backend`) are Python packages that must be installed in the service container image at build time. The operator only configures them at runtime via the CRD.

A new file `releases/<release>/extra-packages.yaml` defines additional Python packages per service, analogous to the existing `source-refs.yaml`:

```yaml
# releases/2025.2/extra-packages.yaml
keystone:
  - openstack-audit-middleware
  - keystone-keycloak-backend
nova:
  - openstack-audit-middleware
neutron:
  - openstack-audit-middleware
glance:
  - openstack-audit-middleware
cinder:
  - openstack-audit-middleware
placement:
  - openstack-audit-middleware
```

During the container image build (see [Build Pipeline](../08-container-images/01-build-pipeline.md)), the `uv pip install` step is extended to include extra packages:

```dockerfile
# In the venv-builder stage
RUN uv pip install \
    --constraint /upper-constraints.txt \
    /src/${SERVICE} \
    ${EXTRA_PACKAGES}
```

The `EXTRA_PACKAGES` build argument is populated from `extra-packages.yaml` by the CI pipeline. This pattern is generic — any additional Python package (middleware, driver, backend plugin) can be added to `extra-packages.yaml` without modifying the Dockerfile.

## Usage Example

A simplified example showing how the Keystone reconciler uses shared library packages:

```go
import (
    "github.com/c5c3/c5c3/internal/common/conditions"
    "github.com/c5c3/c5c3/internal/common/config"
    "github.com/c5c3/c5c3/internal/common/database"
    "github.com/c5c3/c5c3/internal/common/deployment"
    "github.com/c5c3/c5c3/internal/common/job"
    "github.com/c5c3/c5c3/internal/common/secrets"
    "github.com/c5c3/c5c3/internal/common/plugins"
)

func (r *KeystoneReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    keystone := &keystonev1alpha1.Keystone{}
    if err := r.Get(ctx, req.NamespacedName, keystone); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Check ESO-provided secrets
    ready, err := secrets.WaitForExternalSecret(ctx, r.Client,
        keystone.Namespace, keystone.Spec.Database.SecretRef.Name)
    if !ready {
        conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
            Type:   "SecretsReady",
            Status: metav1.ConditionFalse,
            Reason: "WaitingForESO",
        })
        return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
    }

    // Ensure database
    dbReady, err := database.EnsureDatabase(ctx, r.Client, keystone,
        keystone.Spec.Database)
    if !dbReady {
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    // Render config with plugin support
    iniConfig := config.MergeDefaults(buildKeystoneConfig(keystone), keystoneDefaults)
    pluginConfig := plugins.RenderPluginConfig(keystone.Spec.Plugins)
    // ... merge pluginConfig into iniConfig ...

    configMap, err := config.CreateImmutableConfigMap(ctx, r.Client, keystone,
        "keystone-config", map[string]string{"keystone.conf": config.RenderINI(iniConfig)})

    // Create deployment
    _, err = deployment.EnsureDeployment(ctx, r.Client, keystone, deploymentSpec)

    return ctrl.Result{}, nil
}
```
