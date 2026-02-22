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
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────────┐                                                       │
│  │ reconcileSecrets │  Check ESO-provided K8s Secrets exist                 │
│  │                  │  (keystone-db-credentials,                            │
│  │                  │   keystone-admin-credentials)                         │
│  └────────┬─────────┘                                                       │
│           │ SecretsReady=True                                               │
│           ▼                                                                 │
│  ┌───────────────────┐                                                      │
│  │ reconcileDatabase │  Ensure MariaDB Database + User CRs                  │
│  │                   │  Run db_sync Job (keystone-manage db_sync)           │
│  └────────┬──────────┘                                                      │
│           │ DatabaseReady=True                                              │
│           ▼                                                                 │
│  ┌─────────────────────┐                                                    │
│  │ reconcileFernetKeys │  Generate Fernet keys (fernet_setup)               │
│  │                     │  Create rotation CronJob (fernet_rotate)           │
│  │                     │  Optional: PushSecret for OpenBao backup           │
│  └────────┬────────────┘                                                    │
│           │ FernetKeysReady=True                                            │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ reconcileConfig  │  Read CRD → Resolve secrets → Apply defaults          │
│  │                  │  → Render keystone.conf + api-paste.ini               │
│  │                  │  → Create immutable ConfigMap (content-hash)          │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────────┐                                                   │
│  │ reconcileDeployment  │  Create/update Deployment (WSGI server)           │
│  │                      │  Create/update Service (port 5000)                │
│  │                      │  Volume mounts: config, fernet-keys, credentials  │
│  └────────┬─────────────┘                                                   │
│           │ DeploymentReady=True                                            │
│           ▼                                                                 │
│  ┌─────────────────────┐                                                    │
│  │ reconcileBootstrap  │  Run bootstrap Job (keystone-manage bootstrap)     │
│  │                     │  Admin password from ESO Secret                    │
│  └────────┬────────────┘                                                    │
│           │ BootstrapReady=True                                             │
│           ▼                                                                 │
│  Ready=True (all conditions met)                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Controller Setup

The controller is registered with the manager in `main.go`:

```go
func main() {
    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
    })

    if err := (&controller.KeystoneReconciler{
        Client:   mgr.GetClient(),
        Scheme:   mgr.GetScheme(),
        Recorder: mgr.GetEventRecorderFor("keystone-controller"),
    }).SetupWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create controller", "controller", "Keystone")
        os.Exit(1)
    }

    // Register webhooks
    if err := (&keystonev1alpha1.Keystone{}).SetupWebhookWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create webhook", "webhook", "Keystone")
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
// +kubebuilder:rbac:groups=core,resources=services;configmaps;secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=batch,resources=jobs;cronjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=k8s.mariadb.com,resources=databases;users;grants,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=external-secrets.io,resources=externalsecrets;pushsecrets,verbs=get;list;watch;create;update;patch
```

**Watches** — the controller watches the Keystone CR and all owned resources:

```go
func (r *KeystoneReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&keystonev1alpha1.Keystone{}).
        Owns(&appsv1.Deployment{}).
        Owns(&corev1.Service{}).
        Owns(&corev1.ConfigMap{}).
        Owns(&batchv1.Job{}).
        Owns(&batchv1.CronJob{}).
        Watches(&corev1.Secret{},
            handler.EnqueueRequestForOwner(mgr.GetScheme(), mgr.GetRESTMapper(),
                &keystonev1alpha1.Keystone{})).
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
│  ├── /etc/keystone/keystone.conf        ← ConfigMap                         │
│  ├── /etc/keystone/fernet-keys/         ← Secret (Fernet keys)              │
│  ├── /etc/keystone/credential-keys/     ← Secret (credential keys)          │
│  └── /etc/keystone/domains/             ← ConfigMap (domain-specific conf)  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

For image build details and tag schema, see [Build Pipeline](../08-container-images/01-build-pipeline.md) and [Versioning](../08-container-images/02-versioning.md).

## Sub-Reconciler Pattern

The main `Reconcile` function calls sub-reconcilers sequentially. Each sub-reconciler handles one responsibility and returns early (requeue) if its precondition is not met.

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
        keystone.Namespace, keystone.Spec.Database.SecretRef.Name)
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
        keystone.Namespace, keystone.Spec.Bootstrap.AdminPasswordSecretRef.Name)
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

### reconcileDatabase()

Creates MariaDB Database and User CRs (watched by the MariaDB Operator) and runs the `db_sync` Job using the Keystone image. Supports both managed (ClusterRef) and brownfield (explicit host/port) modes:

- **Managed mode** (`spec.database.clusterRef` set): The reconciler creates MariaDB `Database` and `User` CRs within the referenced MariaDB cluster. Endpoints are resolved dynamically from the MariaDB CR status.
- **Brownfield mode** (`spec.database.host` set): The reconciler uses the explicit host/port directly. No MariaDB `Database` or `User` CRs are created — the external database must be provisioned separately.

```go
func (r *KeystoneReconciler) reconcileDatabase(ctx context.Context,
    keystone *keystonev1alpha1.Keystone) (ctrl.Result, error) {

    dbSpec := keystone.Spec.Database

    if dbSpec.ClusterRef != nil {
        // Managed mode: create MariaDB Database + User CRs, resolve endpoint from CR status
        dbReady, err := database.EnsureDatabase(ctx, r.Client, keystone, dbSpec)
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

### reconcileFernetKeys()

Generates the initial Fernet key set and configures periodic rotation:

1. **Initial generation** — Runs a Job with `keystone-manage fernet_setup` (or generates keys directly in the operator) and stores them in a Kubernetes Secret.
2. **Rotation CronJob** — Creates a CronJob that runs `keystone-manage fernet_rotate` on the configured schedule, updates the Secret, and triggers a rolling restart via annotation change.
3. **OpenBao backup** (optional) — Creates a PushSecret CR to back up Fernet keys to `kv-v2/openstack/keystone/fernet-keys` in OpenBao. See [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md) for the PushSecret pattern.

### reconcileConfig()

Implements the config generation pipeline from [Config Generation](../05-deployment/03-service-configuration/01-config-generation.md):

1. **Read CRD spec** — Extract database, cache, fernet, bootstrap, middleware, plugins, and extraConfig fields.
2. **Resolve secrets** — Read Kubernetes Secrets (ESO-provided) and extract credential values.
3. **Apply defaults** — Merge CRD values with Keystone-specific defaults for the target OpenStack release.
4. **Render INI** — Generate `keystone.conf` from the merged config map. Plugin config sections from `spec.plugins` and `spec.extraConfig` are merged into the output.
5. **Render api-paste.ini** — Generate the WSGI pipeline configuration. The base Keystone pipeline is extended with middleware filters from `spec.middleware[]`.
6. **Create immutable ConfigMap** — Hash the rendered config content and create a ConfigMap with the hash in its name (e.g., `keystone-config-a3f8b2c1`).

If the config content changes, a new ConfigMap is created and the Deployment is updated to reference it, triggering a rolling restart. See [Validation](../05-deployment/03-service-configuration/02-validation.md) for how validation operates across the pipeline.

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

    ready, err := deployment.EnsureDeployment(ctx, r.Client, keystone, dep)
    if !ready {
        conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
            Type:   "DeploymentReady",
            Status: metav1.ConditionFalse,
            Reason: "DeploymentProgressing",
        })
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    }

    // Set endpoint in status
    keystone.Status.Endpoint = fmt.Sprintf(
        "https://keystone.%s.svc.cluster.local:5000", keystone.Namespace)

    conditions.SetCondition(&keystone.Status.Conditions, metav1.Condition{
        Type:   "DeploymentReady",
        Status: metav1.ConditionTrue,
        Reason: "DeploymentAvailable",
    })
    return ctrl.Result{}, nil
}
```

### reconcileBootstrap()

Runs the Keystone bootstrap Job using the same service image:

```go
// Bootstrap job command:
// keystone-manage bootstrap \
//   --bootstrap-password <from ESO Secret> \
//   --bootstrap-admin-url https://keystone.openstack.svc:5000 \
//   --bootstrap-internal-url https://keystone.openstack.svc:5000 \
//   --bootstrap-public-url https://keystone.openstack.svc:5000 \
//   --bootstrap-region-id RegionOne
```

The admin password is injected from the `keystone-admin-credentials` Secret (provisioned by ESO from `kv-v2/bootstrap/keystone-admin`). The bootstrap Job is idempotent — it can be run multiple times without side effects.

## Error Handling

| Scenario | Action | Requeue Delay | Condition |
| --- | --- | --- | --- |
| ESO Secret not yet synced | Requeue, wait for ESO | 15s | `SecretsReady=False` |
| MariaDB not ready | Requeue, wait for MariaDB Operator | 30s | `DatabaseReady=False` |
| db_sync Job failed | Requeue, Job will be retried | 60s | `DatabaseReady=False` |
| Fernet key generation failed | Requeue with backoff | 30s | `FernetKeysReady=False` |
| Deployment not available | Requeue, wait for rollout | 10s | `DeploymentReady=False` |
| Bootstrap Job failed | Requeue, Job will be retried | 60s | `BootstrapReady=False` |
| Unrecoverable API error | Return error (controller-runtime handles backoff) | Exponential | — |

All transient errors result in a requeue with appropriate delay. Permanent errors (e.g., invalid CRD spec) are surfaced via conditions and events.

## Owner References

All resources created by the reconciler have an owner reference pointing to the Keystone CR:

```go
ctrl.SetControllerReference(keystone, resource, r.Scheme)
```

This enables:

* **Automatic garbage collection** — When the Keystone CR is deleted, all owned resources (Deployments, Services, ConfigMaps, Jobs, CronJobs) are automatically cleaned up by the Kubernetes garbage collector.
* **Watch triggers** — Changes to owned resources trigger reconciliation of the owning Keystone CR.

**Finalizers** are used when external cleanup is required (e.g., removing MariaDB Database CRs that are not owned by the Keystone CR). The finalizer ensures the reconciler has an opportunity to clean up before the Keystone CR is deleted.
