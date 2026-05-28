# Keystone Reconciler

The Keystone Reconciler implements the core control loop that drives the Keystone Identity Service from a desired state (CRD spec) to an observed state (running pods, synced database, rotated keys). This page documents the reconciler architecture, sub-reconciler pattern, error handling, and controller setup.

For the CRD type definitions and webhooks, see [CRD Implementation](./03-crd-implementation.md).

## Reconciler Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       KEYSTONE RECONCILIATION FLOW                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Keystone CR changed (or requeue timer fires)                               │
│  (finalizers handled first: MariaDB + OpenBao backup cleanup on delete)     │
│         │                                                                   │
│         ▼                                                                   │
│  reconcileSecrets          Check ESO K8s Secrets exist  → SecretsReady      │
│         ▼                                                                   │
│  reconcileDatabaseTLS      Issue DB client cert (cert-manager) → DatabaseTLSReady │
│         ▼                                                                   │
│  reconcileDBConnectionSecret  Build <name>-db-connection Secret (pymysql URL)│
│         ▼                       (reuses SecretsReady; creds NOT in conf)     │
│  reconcileConfig           Render keystone.conf.d/ → immutable ConfigMap     │
│         │                  (returns configMapName; sets LoggingHealthy)      │
│         ▼                                                                   │
│  ┌──────── parallel group (no cross-dependency) ────────┐                   │
│  │ reconcileFernetKeys      → FernetKeysReady            │                   │
│  │ reconcileCredentialKeys  → CredentialKeysReady        │                   │
│  │ reconcileNetworkPolicy   → NetworkPolicyReady         │                   │
│  └───────────────────────────┬───────────────────────────┘                  │
│         ▼                                                                   │
│  reconcileDatabase         MariaDB CRs + db_sync Job → DatabaseReady         │
│         ▼                                                                   │
│  reconcilePolicyValidation oslopolicy-validator Job → PolicyValidReady       │
│         ▼                                                                   │
│  reconcileDeployment       Deployment + Service (5000) → DeploymentReady     │
│         ▼   (then pruneStaleConfigMaps)                                      │
│  reconcileHTTPRoute        Gateway API HTTPRoute → HTTPRouteReady            │
│         ▼                                                                   │
│  reconcileHealthCheck      Active HTTP probe of endpoint → KeystoneAPIReady  │
│         ▼                                                                   │
│  reconcileHPA              HPA create/update/delete → HPAReady               │
│         ▼                                                                   │
│  reconcileBootstrap        keystone-manage bootstrap → BootstrapReady        │
│         ▼                                                                   │
│  reconcileTrustFlush       trust_flush CronJob → TrustFlushReady             │
│         ▼                                                                   │
│  setReadyCondition → Ready=True (all aggregated sub-conditions met)          │
│                                                                             │
│  Every sub-reconciler is wrapped by instrumentSubReconciler (CC-0089),      │
│  emitting per-step duration + error metrics under a `sub_reconciler` label. │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Controller Setup

The controller is registered through the shared [`bootstrap`](./02-shared-library.md#bootstrap) manager, whose `SetupFunc` wires the reconciler and (when enabled) the webhook:

```go
func main() {
    if err := bootstrap.Run(bootstrap.ManagerConfig{
        Scheme:           scheme,
        LeaderElectionID: "keystone.openstack.c5c3.io",
        SetupFunc: func(mgr ctrl.Manager, enableWebhooks bool) error {
            if err := (&controller.KeystoneReconciler{
                Client:   mgr.GetClient(),
                Scheme:   mgr.GetScheme(),
                Recorder: mgr.GetEventRecorderFor("keystone-controller"),
            }).SetupWithManager(mgr); err != nil {
                return err
            }
            if enableWebhooks {
                return (&keystonev1alpha1.KeystoneWebhook{
                    Client: mgr.GetClient(),
                }).SetupWebhookWithManager(mgr)
            }
            return nil
        },
    }); err != nil {
        ctrl.Log.WithName("setup").Error(err, "unable to run manager")
        os.Exit(1)
    }
}
```

**RBAC markers** on the reconciler define the required ClusterRole permissions:

```go
// +kubebuilder:rbac:groups=keystone.openstack.c5c3.io,resources=keystones,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=keystone.openstack.c5c3.io,resources=keystones/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=keystone.openstack.c5c3.io,resources=keystones/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services;configmaps;secrets;serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list
// +kubebuilder:rbac:groups=batch,resources=jobs;cronjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=k8s.mariadb.com,resources=databases;users;grants,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=k8s.mariadb.com,resources=mariadbs,verbs=get;list;watch
// +kubebuilder:rbac:groups=cert-manager.io,resources=certificates,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=external-secrets.io,resources=externalsecrets,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=external-secrets.io,resources=pushsecrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=external-secrets.io,resources=clustersecretstores,verbs=get;list;watch
// +kubebuilder:rbac:groups=policy,resources=poddisruptionbudgets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=autoscaling,resources=horizontalpodautoscalers,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes/status,verbs=get
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=scheduling.k8s.io,resources=priorityclasses,verbs=get;list;watch
```

> **Note:** Service operators that depend on RabbitMQ (Nova, Neutron, Cinder) require additional RBAC for the Messaging Topology Operator CRDs:
>
> ```go
> // +kubebuilder:rbac:groups=rabbitmq.com,resources=rabbitmqclusters,verbs=get;list;watch
> // +kubebuilder:rbac:groups=rabbitmq.com,resources=vhosts;users;permissions,verbs=get;list;watch;create;update;patch;delete
> ```

**Watches** — the controller watches the Keystone CR, all owned resources, and several externally-owned dependencies. `Owns(HTTPRoute)` is registered **conditionally** — only when the Gateway API CRD is present (probed via the RESTMapper at startup), so the operator still runs on clusters without Gateway API. A **field indexer** (`KeystoneSecretNameIndexKey`, CC-0087) lets the Secret mapper do an O(1) reverse lookup rather than listing every CR:

```go
func (r *KeystoneReconciler) SetupWithManager(mgr ctrl.Manager) error {
    // spec.gateway is optional; only watch HTTPRoute when the CRD exists.
    r.gatewayAPIAvailable = isGatewayAPIAvailable(mgr.GetRESTMapper())

    // Register the Secret-name field indexer before Watches (CC-0087).
    if err := registerSecretNameIndex(context.Background(), mgr.GetFieldIndexer()); err != nil {
        return err
    }

    b := ctrl.NewControllerManagedBy(mgr).
        For(&keystonev1alpha1.Keystone{}).
        Owns(&appsv1.Deployment{}).
        Owns(&corev1.Service{}).
        Owns(&corev1.ConfigMap{}).
        Owns(&batchv1.Job{}).
        Owns(&policyv1.PodDisruptionBudget{}).
        Owns(&autoscalingv2.HorizontalPodAutoscaler{}).
        Owns(&networkingv1.NetworkPolicy{}).
        Owns(&batchv1.CronJob{})

    if r.gatewayAPIAvailable {
        b = b.Owns(&gatewayv1.HTTPRoute{})
    }

    return b.
        // ESO-managed Secrets are owned by the ExternalSecret controller, not
        // the Keystone CR — map them via the field indexer instead (CC-0013).
        Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(
            secretToKeystoneMapper(mgr.GetClient()),
        )).
        // Reflect upstream MariaDB outages in DatabaseReady without waiting for
        // the next periodic requeue (CC-0047).
        Watches(&mariadbv1alpha1.MariaDB{}, handler.EnqueueRequestsFromMapFunc(
            mariaDBToKeystoneMapper(mgr.GetClient()),
        )).
        // Reflect OpenBao-backend outages in SecretsReady as soon as ESO flips
        // the ClusterSecretStore Ready condition (CC-0047).
        Watches(&esov1.ClusterSecretStore{}, handler.EnqueueRequestsFromMapFunc(
            clusterSecretStoreToKeystoneMapper(mgr.GetClient()),
        )).
        // Watch backup PushSecrets via a name mapper + predicate (not Owns) so
        // the OpenBao-finalizer adoption-wait reacts to finalizer/deletion
        // transitions while suppressing ESO's status-only ticks (CC-0092).
        Watches(&esov1alpha1.PushSecret{},
            handler.EnqueueRequestsFromMapFunc(pushSecretToKeystoneMapper(mgr.GetClient())),
            builder.WithPredicates(pushSecretRelevantChangePredicate),
        ).
        Complete(r)
}
```

## Keystone Container Image

The reconciler uses the Keystone service image (`ghcr.io/c5c3/keystone:<tag>`) specified in `spec.image` for all workloads. The same image serves different purposes based on the command:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       KEYSTONE IMAGE USAGE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ghcr.io/c5c3/keystone:28.0.0                                               │
│  ├─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  Jobs (one-shot):                                                   │    │
│  │  ├── keystone-manage db_sync          → Database migration          │    │
│  │  ├── keystone-manage bootstrap        → Initial admin setup         │    │
│  │  └── keystone-manage fernet_setup     → Initial key generation      │    │
│  │                                                                     │    │
│  │  CronJob (recurring):                                               │    │
│  │  └── keystone-manage fernet_rotate    → Periodic key rotation       │    │
│  │                                                                     │    │
│  │  Deployment (long-running):                                         │    │
│  │  └── uwsgi / gunicorn                → WSGI API server              │    │
│  │      (serves Keystone API on port 5000)                             │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Volume Mounts:                                                             │
│  ├── /etc/keystone/keystone.conf.d/     ← ConfigMap (--config-dir)          │
│  ├── /etc/keystone/fernet-keys/         ← Secret (Fernet keys, mode 0400)   │
│  ├── /etc/keystone/credential-keys/     ← Secret (credential keys)          │
│  ├── /etc/keystone/db-tls/              ← Secret (DB client cert, when TLS)  │
│  └── /etc/keystone/domains/             ← ConfigMap (domain-specific conf)  │
│                                                                             │
│  DB password is NOT in the ConfigMap — it is injected via the              │
│  OS_DATABASE__CONNECTION env var from the derived <name>-db-connection      │
│  Secret (CC-0080).                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

For image build details and tag schema, see [Build Pipeline](../08-container-images/01-build-pipeline.md) and [Versioning](../08-container-images/02-versioning.md).

## Sub-Reconciler Pattern

The main `Reconcile` function calls sub-reconcilers in order. Each sub-reconciler handles one responsibility, sets its own status condition, and returns early (requeue) if its precondition is not met. Every call is wrapped by `instrumentSubReconciler` (CC-0089), which records per-step duration and error metrics. Three sub-reconcilers with no cross-dependency — `reconcileFernetKeys`, `reconcileCredentialKeys`, `reconcileNetworkPolicy` — run concurrently in a `reconcileParallelGroup`.

> **Note:** `reconcileConfig()` runs early (after secrets and the DB-connection Secret) because the rendered `keystone.conf.d/` ConfigMap is required by the parallel key group, the `db_sync` Job, and the Deployment.
>
> **Note:** Keystone does not use RabbitMQ. For services that depend on messaging (Nova, Neutron, Cinder), the
> sub-reconciler chain will be extended with a `reconcileMessaging()` step (planned, via the shared `messaging/`
> library) that creates RabbitMQ Topology Operator CRs (`Vhost`, `User`, `Permission`) and sets a `MessagingReady`
> condition.

### reconcileSecrets()

Verifies that ESO-provided Kubernetes Secrets exist before proceeding. These Secrets are created by ESO from OpenBao paths (see [Secret Management](../05-deployment/02-secret-management.md)):

| Secret Name | OpenBao Path | Contents |
| --- | --- | --- |
| `keystone-db-credentials` | `kv-v2/openstack/keystone/db` | MariaDB username and password |
| `keystone-admin-credentials` | `kv-v2/bootstrap/keystone-admin` | Admin password for bootstrap |

```go
func (r *KeystoneReconciler) reconcileSecrets(ctx context.Context,
    keystone *keystonev1alpha1.Keystone) (ctrl.Result, error) {

    // Check DB credentials
    ready, err := secrets.WaitForExternalSecret(ctx, r.Client,
        client.ObjectKey{Namespace: keystone.Namespace, Name: keystone.Spec.Database.SecretRef.Name})
    if err != nil {
        return ctrl.Result{}, err
    }
    if !ready {
        conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
            Type:    "SecretsReady",
            Status:  metav1.ConditionFalse,
            Reason:  "WaitingForDBCredentials",
            Message: "Waiting for ESO to sync database credentials from OpenBao",
        })
        return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
    }

    // Check admin credentials
    ready, err = secrets.WaitForExternalSecret(ctx, r.Client,
        client.ObjectKey{Namespace: keystone.Namespace, Name: keystone.Spec.Bootstrap.AdminPasswordSecretRef.Name})
    if err != nil {
        return ctrl.Result{}, err
    }
    if !ready {
        conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
            Type:    "SecretsReady",
            Status:  metav1.ConditionFalse,
            Reason:  "WaitingForAdminCredentials",
            Message: "Waiting for ESO to sync admin credentials from OpenBao",
        })
        return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
    }

    conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
        Type:   "SecretsReady",
        Status: metav1.ConditionTrue,
        Reason: "SecretsAvailable",
    })
    return ctrl.Result{}, nil
}
```

### reconcileDatabaseTLS()

Provisions the client certificate Keystone presents to MariaDB/MaxScale for mutual TLS (CC-0106). Driven by `spec.database.tls`, it resolves to one of three modes (`dbtls_mode.go`):

- **NotRequired** — `spec.database.tls` is nil or disabled. No certificate is issued; the connection is plaintext TCP. `DatabaseTLSReady=True` (trivially satisfied).
- **ExternallyManaged** — the user supplies their own `caBundleSecretRef`/`clientCertSecretRef` (brownfield). The operator validates the referenced Secrets exist but issues no Certificate.
- **Managed** — the operator issues a `<name>-db-client` cert-manager `Certificate` from the shared `openstack-db-ca-issuer` ClusterIssuer, waits for it to become ready, then sets `DatabaseTLSReady=True`.

The verification strength (`prefer` / `require` / `verify-ca` / `verify-full`) maps to pymysql `ssl_*` DSN parameters that the next sub-reconciler folds into the connection URL.

### reconcileDBConnectionSecret()

Materializes the database connection URL into a **derived Secret** rather than the config file (CC-0080). The previous design embedded the DB password into the `keystone.conf` ConfigMap, exposing credentials at rest in an object that is not treated as a Secret. Instead, this sub-reconciler:

1. Reads the synced DB credentials Secret (and, in managed mode, derives the username from the Keystone CR name — only brownfield mode reads `username` from the Secret).
2. Assembles the full `mysql+pymysql://…` URL, appending the `ssl_*` parameters from `reconcileDatabaseTLS` when TLS is enabled.
3. Writes it to a `<name>-db-connection` Secret.

Every workload (API Deployment, `db_sync`, bootstrap, key-rotation, trust-flush) consumes it at runtime via the `OS_DATABASE__CONNECTION` environment variable. This step reuses the `SecretsReady` condition (no separate condition type).

### reconcileConfig()

Implements the config generation pipeline from [Config Generation](../05-deployment/03-service-configuration/01-config-generation.md). This runs after the DB-connection Secret because the rendered ConfigMap is required by subsequent sub-reconcilers (parallel key group, db_sync Job, Deployment).

1. **Read CRD spec** — Extract database, cache, fernet, bootstrap, middleware, plugins, logging, and extraConfig fields.
2. **Apply defaults** — Merge CRD values with Keystone-specific defaults for the target OpenStack release. The DB password is **not** resolved here — it is injected at runtime from the `<name>-db-connection` Secret via `OS_DATABASE__CONNECTION`.
3. **Render INI** — Generate the `keystone.conf.d/` files from the merged config map. Plugin config sections from `spec.plugins` and `spec.extraConfig` are merged into the output. (The container runs `keystone-manage --config-dir=/etc/keystone/keystone.conf.d/`.)
4. **Render api-paste.ini** — Generate the WSGI pipeline configuration, extended with middleware filters from `spec.middleware[]`.
5. **Create immutable ConfigMap** — Hash the rendered config content and create a ConfigMap with the hash in its name (e.g., `keystone-config-a3f8b2c1`); returns the generated name.
6. **LoggingHealthy** — set as an informational (non-aggregating) condition based on stderr-disabled detection.

If the config content changes, a new ConfigMap is created and the Deployment is updated to reference it, triggering a rolling restart; `pruneStaleConfigMaps` later garbage-collects superseded ConfigMaps. See [Validation](../05-deployment/03-service-configuration/02-validation.md) for how validation operates across the pipeline.

### reconcileFernetKeys()

Generates the initial Fernet key set and configures periodic rotation using a **split-compute-write** design (CC-0081) that keeps token-forgery primitives out of the CronJob's RBAC:

1. **Initial generation** — Generates `maxActiveKeys` keys (indices `0..n-1`) and stores them in the `<name>-fernet-keys` Secret.
2. **Rotation CronJob** — Creates a CronJob that runs `keystone-manage fernet_rotate` on the configured schedule. The CronJob does **not** write the production Secret; it PATCHes a dedicated `<name>-fernet-keys-rotation` **staging Secret** with narrow get+patch RBAC.
3. **Validate + apply** — The operator (`rotation_staging.go` / `rotation_validation.go`) validates the staged material (44-byte base64url → 32 bytes, no duplicates, key count within range) and, using its own privileged ServiceAccount, applies it to the production Secret.
4. **OpenBao backup** — Creates a PushSecret CR backing up the keys to `openstack/keystone/{name}/fernet-keys` in OpenBao. See [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md).

Keys are projected into running pods and rotate **in place** — no pod-template hash change and no rolling restart on rotation (CC-0074).

### reconcileCredentialKeys()

Mirrors the Fernet flow for Keystone's credential **encryption** keys (CC-0036), with the same staging-Secret rotation boundary:

1. **Initial generation** — Generates the `<name>-credential-keys` Secret.
2. **Rotation CronJob** — Runs `keystone-manage credential_rotate` on `spec.credentialKeys.rotationSchedule`, writing to the `<name>-credential-keys-rotation` staging Secret; the operator validates and applies. The rotate script additionally runs `keystone-manage credential_migrate` to re-encrypt stored credentials under the new primary key.
3. **Backup** — PushSecret to `openstack/keystone/{name}/credential-keys`; retention controlled by `spec.credentialKeys.maxActiveKeys` (minimum 3).

### reconcileDatabase()

Creates MariaDB Database and User CRs (watched by the MariaDB Operator) and runs the `db_sync` Job using the Keystone image. Supports both managed (ClusterRef) and brownfield (explicit host/port) modes:

- **Managed mode** (`spec.database.clusterRef` set): The reconciler creates MariaDB `Database` and `User` CRs within the referenced MariaDB cluster. Endpoints are resolved dynamically from the MariaDB CR status.
- **Brownfield mode** (`spec.database.host` set): The reconciler uses the explicit host/port directly. No MariaDB `Database` or `User` CRs are created — the external database must be provisioned separately.

```go
func (r *KeystoneReconciler) reconcileDatabase(ctx context.Context,
    keystone *keystonev1alpha1.Keystone,
    configMapName string) (ctrl.Result, error) {

    dbSpec := keystone.Spec.Database

    if dbSpec.ClusterRef != nil {
        // Managed mode: create MariaDB Database + User CRs, resolve endpoint from CR status
        dbReady, err := database.EnsureDatabase(ctx, r.Client, r.Scheme, keystone, dbSpec)
        if err != nil {
            return ctrl.Result{}, err
        }
        if !dbReady {
            conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
                Type:   "DatabaseReady",
                Status: metav1.ConditionFalse,
                Reason: "WaitingForDatabase",
            })
            return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
        }
    }
    // Brownfield mode: skip MariaDB CR creation, use host/port directly

    // Run db_sync job using the Keystone service image
    synced, err := database.RunDBSyncJob(ctx, r.Client, keystone,
        keystone.Spec.Image,
        []string{"keystone-manage", "db_sync"},
        r.buildDBSyncEnv(keystone))
    if err != nil {
        return ctrl.Result{}, err
    }
    if !synced {
        conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
            Type:   "DatabaseReady",
            Status: metav1.ConditionFalse,
            Reason: "DBSyncInProgress",
        })
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
        Type:   "DatabaseReady",
        Status: metav1.ConditionTrue,
        Reason: "DatabaseSynced",
    })
    return ctrl.Result{}, nil
}
```

For database migration patterns during upgrades, see [Upgrades](../06-operations/01-upgrades.md).

### reconcilePolicyValidation()

Validates the rendered oslo.policy overrides **before** the Deployment is updated (CC-0058). When `spec.policyOverrides` is set, it runs an `oslopolicy-validator` Job against the generated `policy.yaml`; `PolicyValidReady` gates the Deployment so an invalid policy never reaches running pods. When no overrides are configured, the condition is trivially satisfied.

### reconcileNetworkPolicy()

Creates or updates a Kubernetes `NetworkPolicy` restricting ingress and egress traffic for Keystone API pods (CC-0039). It runs in the parallel group alongside the key reconcilers (it has no data dependency on the Deployment):

- When `spec.networkPolicy` is set: creates a NetworkPolicy allowing ingress on TCP 5000 from specified sources and auto-deriving egress rules for DNS, MariaDB, and Memcached.
- When `spec.networkPolicy` is nil: deletes any existing NetworkPolicy, allowing unrestricted traffic.

### reconcileDeployment()

Creates the Keystone Deployment and Service:

```go
func (r *KeystoneReconciler) reconcileDeployment(ctx context.Context,
    keystone *keystonev1alpha1.Keystone,
    configMapName string) (ctrl.Result, error) {

    dep := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "keystone-api",
            Namespace: keystone.Namespace,
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: &keystone.Spec.Replicas,
            Template: corev1.PodTemplateSpec{
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{{
                        Name:  "keystone-api",
                        Image: fmt.Sprintf("%s:%s",
                            keystone.Spec.Image.Repository,
                            keystone.Spec.Image.Tag),
                        Ports: []corev1.ContainerPort{{
                            ContainerPort: 5000,
                        }},
                        ReadinessProbe: &corev1.Probe{
                            ProbeHandler: corev1.ProbeHandler{
                                HTTPGet: &corev1.HTTPGetAction{
                                    Path: "/v3",
                                    Port: intstr.FromInt(5000),
                                },
                            },
                        },
                        VolumeMounts: []corev1.VolumeMount{
                            {Name: "config", MountPath: "/etc/keystone",
                                ReadOnly: true},
                            {Name: "fernet-keys",
                                MountPath: "/etc/keystone/fernet-keys",
                                ReadOnly: true},
                            {Name: "credential-keys",
                                MountPath: "/etc/keystone/credential-keys",
                                ReadOnly: true},
                        },
                    }},
                    Volumes: []corev1.Volume{
                        {Name: "config", VolumeSource: corev1.VolumeSource{
                            ConfigMap: &corev1.ConfigMapVolumeSource{
                                LocalObjectReference: corev1.LocalObjectReference{
                                    Name: configMapName,
                                }}}},
                        {Name: "fernet-keys", VolumeSource: corev1.VolumeSource{
                            Secret: &corev1.SecretVolumeSource{
                                SecretName: "keystone-fernet-keys",
                            }}},
                        {Name: "credential-keys", VolumeSource: corev1.VolumeSource{
                            Secret: &corev1.SecretVolumeSource{
                                SecretName: "keystone-credential-keys",
                            }}},
                    },
                },
            },
        },
    }

    // Set owner reference for garbage collection
    ctrl.SetControllerReference(keystone, dep, r.Scheme)

    // The DB password is injected via OS_DATABASE__CONNECTION from the derived
    // <name>-db-connection Secret (CC-0080), not rendered into the ConfigMap.
    // reconcileDeployment also builds the PodDisruptionBudget (EnsurePDB) and,
    // when database.tls is enabled, mounts the client cert at /etc/keystone/db-tls.
    ready, err := deployment.EnsureDeployment(ctx, r.Client, r.Scheme, keystone, dep)
    if !ready {
        conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
            Type:   "DeploymentReady",
            Status: metav1.ConditionFalse,
            Reason: "DeploymentProgressing",
        })
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    }

    // Set endpoint in status (cluster-local Service DNS by default;
    // overridden to https://{spec.gateway.hostname}/v3 when a gateway is set).
    keystone.Status.Endpoint = fmt.Sprintf(
        "http://%s.%s.svc.cluster.local:5000/v3", "keystone", keystone.Namespace)

    conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
        Type:   "DeploymentReady",
        Status: metav1.ConditionTrue,
        Reason: "DeploymentAvailable",
    })
    return ctrl.Result{}, nil
}
```

### reconcileHTTPRoute()

When `spec.gateway` is set and the Gateway API CRD is installed, reconciles a `gateway.networking.k8s.io/HTTPRoute` attaching the Keystone API Service to the referenced Gateway (CC-0065), and derives `status.endpoint` as `https://{hostname}/v3`. When `spec.gateway` is nil, the condition is trivially satisfied; when `spec.gateway` is set but Gateway API is absent (`isGatewayAPIAvailable` returned false at startup), `HTTPRouteReady` is set False with an explanatory message rather than crashing the controller.

### reconcileHealthCheck()

Performs an **active** HTTP health check against `status.endpoint` (CC-0067) via an injectable `HTTPClient` (an `HTTPDoer` interface, so tests can stub it). A passing probe sets `KeystoneAPIReady=True`; a failing probe requeues at `RequeueHealthCheck` (10s). This complements the pod-level ReadinessProbe by verifying the API is reachable end-to-end through the Service.

### reconcileHPA()

Creates, updates, or deletes a `HorizontalPodAutoscaler` for the Keystone API deployment (CC-0038):

- When `spec.autoscaling` is set: creates an HPA targeting the Keystone deployment with the specified min/max replicas and CPU/memory utilization targets. At least one of `targetCPUUtilization` or `targetMemoryUtilization` must be set (enforced by CEL validation).
- When `spec.autoscaling` is nil: deletes any existing HPA, restoring static replica count from `spec.replicas`.
- `spec.resources` must be set for HPA utilization calculations to work (the defaulting webhook injects sensible defaults when unset).

### reconcileBootstrap()

Runs the Keystone bootstrap Job using the same service image:

```go
// Bootstrap job: a small Python pre-seed script inserts the admin region row,
// then exec's keystone-manage bootstrap:
// keystone-manage --config-dir=/etc/keystone/keystone.conf.d/ bootstrap \
//   --bootstrap-password <from ESO Secret> \
//   --bootstrap-admin-url    http://keystone.openstack.svc.cluster.local:5000/v3 \
//   --bootstrap-internal-url http://keystone.openstack.svc.cluster.local:5000/v3 \
//   --bootstrap-public-url   <spec.bootstrap.publicEndpoint, else cluster-local>/v3 \
//   --bootstrap-region-id RegionOne
```

The admin password is injected from the `keystone-admin-credentials` Secret (provisioned by ESO from `kv-v2/bootstrap/keystone-admin`). URLs use `http` (TLS is terminated upstream by the Gateway) and include the `/v3` path. The public URL is taken from `spec.bootstrap.publicEndpoint` when set. The bootstrap Job is idempotent — it can be run multiple times without side effects.

### reconcileTrustFlush()

Reconciles a `<name>-trust-flush` CronJob that runs `keystone-manage trust_flush` to purge expired trust delegations (CC-0057, CC-0096). The schedule defaults to hourly (`0 * * * *`, materialized by the defaulting webhook); `spec.trustFlush.suspend` pauses it without deleting the CronJob. Sets `TrustFlushReady`.

## Error Handling

| Scenario | Action | Requeue Delay | Condition |
| --- | --- | --- | --- |
| ESO Secret not yet synced | Requeue, wait for ESO | 15s | `SecretsReady=False` |
| DB client cert not ready | Requeue, wait for cert-manager | 15s | `DatabaseTLSReady=False` |
| MariaDB not ready | Requeue, wait for MariaDB Operator | 30s | `DatabaseReady=False` |
| db_sync Job failed | Requeue, Job will be retried | 60s | `DatabaseReady=False` |
| Fernet/credential key generation failed | Requeue with backoff | 30s | `FernetKeysReady` / `CredentialKeysReady=False` |
| Policy validation Job failed | Requeue, do not roll out Deployment | 30s | `PolicyValidReady=False` |
| NetworkPolicy creation failed | Return error, controller-runtime retries | Exponential | `NetworkPolicyReady=False` |
| Deployment not available | Requeue, wait for rollout | 10s | `DeploymentReady=False` |
| HTTPRoute reconcile failed / Gateway API absent | Requeue or surface in condition | varies | `HTTPRouteReady=False` |
| API health check failed | Requeue, re-probe endpoint | 10s | `KeystoneAPIReady=False` |
| HPA creation/update failed | Return error, controller-runtime retries | Exponential | `HPAReady=False` |
| Bootstrap Job failed | Requeue, Job will be retried | 60s | `BootstrapReady=False` |
| Trust-flush CronJob reconcile failed | Return error, controller-runtime retries | Exponential | `TrustFlushReady=False` |
| Unrecoverable API error | Return error (controller-runtime handles backoff) | Exponential | — |

Requeue intervals are centralized in `requeue_intervals.go` (e.g. `RequeueSecretPolling=15s`, `RequeueDatabaseWait=30s`, `RequeueBootstrap=60s`, `RequeueDeployment=10s`, `RequeueHealthCheck=10s`).

All transient errors result in a requeue with appropriate delay. Permanent errors (e.g., invalid CRD spec) are surfaced via conditions and events.

## Owner References

All resources created by the reconciler have an owner reference pointing to the Keystone CR:

```go
ctrl.SetControllerReference(keystone, resource, r.Scheme)
```

This enables:

* **Automatic garbage collection** — When the Keystone CR is deleted, all owned resources (Deployments, Services, ConfigMaps, Jobs, CronJobs, PodDisruptionBudgets, HorizontalPodAutoscalers, NetworkPolicies) are automatically cleaned up by the Kubernetes garbage collector.
* **Watch triggers** — Changes to owned resources trigger reconciliation of the owning Keystone CR.

**Finalizers** — the reconciler registers **two** finalizers, both handled before the main reconcile flow on deletion:

- `keystone.openstack.c5c3.io/finalizer` — cleans up MariaDB `Database`/`User`/`Grant` CRs that are not garbage-collected via owner references.
- `keystoneOpenBaoFinalizer` (CC-0079) — blocks deletion until the `fernet-keys-backup` and `credential-keys-backup` PushSecrets are purged from OpenBao. `reconcileDeleteOpenBao` drives a multi-pass ESO adoption-wait (CC-0091/CC-0092) so ESO deletes the remote KV-v2 paths (`DeletionPolicy=Delete`) before the CR is released; without it, OpenBao paths would orphan. Events are emitted exactly once per transition.
