# Keystone Dependencies

This page documents all external dependencies of the Keystone Operator: the secret flow from OpenBao through ESO, MariaDB and Memcached interaction, the Fernet key lifecycle, the bootstrap process, and config file generation. It also defines the contract between the operator and the Keystone container image.

## Dependency Graph

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       KEYSTONE DEPENDENCY GRAPH                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 0: Prerequisites (deployed before Keystone Operator)                 │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                 │
│  │ OpenBao + ESO  │  │ mariadb-       │  │ memcached-     │                 │
│  │ (Secret Mgmt)  │  │ operator       │  │ operator       │                 │
│  │ ClusterSecret  │  │ MariaDB CR     │  │ Memcached CR   │                 │
│  │ Store ready    │  │ (Galera ready) │  │ (Pods ready)   │                 │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘                 │
│          │                   │                   │                          │
│  ┌───────┴────────┐         │                   │                           │
│  │ cert-manager   │         │                   │                           │
│  │ (TLS certs)    │         │                   │                           │
│  └───────┬────────┘         │                   │                           │
│          │                   │                   │                          │
│          └───────────────────┼───────────────────┘                          │
│                              │                                              │
│                              ▼                                              │
│  Phase 1: Keystone Operator                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    keystone-operator                                │    │
│  │  Reconciles: Keystone CR → Deployment, Service, Jobs, CronJobs      │    │
│  └────────────────────────────┬────────────────────────────────────────┘    │
│                               │                                             │
│                               ▼                                             │
│  Phase 2: Downstream Consumers                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                 │
│  │ K-ORC          │  │ glance-        │  │ All other      │                 │
│  │ (Keystone      │  │ operator       │  │ service        │                 │
│  │  Resources)    │  │                │  │ operators      │                 │
│  └────────────────┘  └────────────────┘  └────────────────┘                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

See [Control Plane — Service Dependencies](../03-components/01-control-plane/) for the full dependency matrix across all services.

## OpenBao / ESO Secret Flow

### Design Principle

**All secrets originate from OpenBao.** Operators read exclusively Kubernetes Secrets that are created by the External Secrets Operator (ESO). Operators never access OpenBao directly.
This design is documented in [Secret Management](../05-deployment/02-secret-management.md) and [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md).
For the concrete OpenBao deployment and policy configuration, see [OpenBao Deployment](./09-openbao-deployment.md).

**Prerequisite:** ESO and a `ClusterSecretStore` must be deployed and operational before any service operator starts. This is part of Phase 0 in the bootstrap sequence (see [Credential Lifecycle — Bootstrap Problem](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#bootstrap-problem-and-solution-architecture)).

### Keystone Secret Inventory

| OpenBao Path | ExternalSecret → K8s Secret | Contents | Consumer |
| --- | --- | --- | --- |
| `kv-v2/bootstrap/keystone-admin` | `keystone-admin-credentials` | Admin password | Bootstrap Job |
| `kv-v2/openstack/keystone/db` | `keystone-db-credentials` | MariaDB password (and, brownfield only, username) | DB-connection Secret, db_sync |
| (operator-generated) | `<name>-fernet-keys` → PushSecret → `openstack/keystone/{name}/fernet-keys` | Fernet key material | API Deployment, rotation backup |
| (operator-generated) | `<name>-credential-keys` → PushSecret → `openstack/keystone/{name}/credential-keys` | Credential encryption keys | API Deployment, rotation backup |
| (operator-derived) | `<name>-db-connection` | Full pymysql connection URL | injected to all workloads via `OS_DATABASE__CONNECTION` |

> OpenBao backup paths embed the **Keystone CR name** (`{name}`) so two Keystone CRs never collide (CC-0093). The ESO `ClusterSecretStore` is named **`openbao-cluster-store`**; the operator re-checks its Ready condition on every reconcile before reading from it (CC-0047).

### ExternalSecret CR Examples

These ExternalSecret CRs must exist in the `openstack` namespace before the Keystone Operator can proceed:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: keystone-db-credentials
  namespace: openstack
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: openbao-cluster-store
  target:
    name: keystone-db-credentials
    creationPolicy: Owner
  data:
    - secretKey: username
      remoteRef:
        key: kv-v2/data/openstack/keystone/db
        property: username
    - secretKey: password
      remoteRef:
        key: kv-v2/data/openstack/keystone/db
        property: password
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: keystone-admin-credentials
  namespace: openstack
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: openbao-cluster-store
  target:
    name: keystone-admin-credentials
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: kv-v2/data/bootstrap/keystone-admin
        property: password
```

### PushSecret CR Example

Fernet keys generated by the operator are backed up to OpenBao via a PushSecret:

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: keystone-fernet-keys-backup
  namespace: openstack
spec:
  secretStoreRefs:
    - kind: ClusterSecretStore
      name: openbao-cluster-store
  selector:
    secret:
      name: keystone-fernet-keys
  data:
    - match:
        remoteRef:
          # Backup path embeds the Keystone CR name (CC-0093).
          remoteKey: openstack/keystone/keystone/fernet-keys
```

> **OpenBao finalizer cleanup (CC-0079).** The operator adds a `keystone.openstack.c5c3.io/openbao-finalizer`. On CR deletion it removes the `fernet-keys-backup` and `credential-keys-backup` PushSecrets (with `DeletionPolicy=Delete`) through a multi-pass ESO adoption-wait so ESO purges the remote KV-v2 paths before the CR is released — otherwise the OpenBao paths would orphan.

### Secret Flow Diagram

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       KEYSTONE SECRET FLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  OpenBao                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  kv-v2/bootstrap/keystone-admin         (admin password)            │    │
│  │  kv-v2/openstack/keystone/db            (DB credentials)            │    │
│  │  kv-v2/openstack/keystone/fernet-keys   (backup, written by ESO)    │    │
│  └──────────────┬─────────────────────────────────▲────────────────────┘    │
│                 │ ExternalSecret                   │ PushSecret             │
│                 ▼                                  │                        │
│  K8s Secrets (namespace: openstack)                │                        │
│  ┌─────────────────────────────────────────────────┼───────────────────┐    │
│  │  keystone-admin-credentials  (password)         │                   │    │
│  │  keystone-db-credentials     (username, pwd)    │                   │    │
│  │  keystone-fernet-keys        (key material) ────┘                   │    │
│  └──────────────┬──────────────────────────────────────────────────────┘    │
│                 │ Reconciler reads                                          │
│                 ▼                                                           │
│  Keystone Operator                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  reconcileSecrets()          → Checks secret existence              │    │
│  │  reconcileDBConnectionSecret → Builds <name>-db-connection Secret   │    │
│  │                                (pymysql URL incl. password)         │    │
│  │  reconcileConfig()           → Renders keystone.conf.d/ (NO creds)  │    │
│  │  reconcileBootstrap()        → Injects admin password into Job      │    │
│  └──────────────┬──────────────────────────────────────────────────────┘    │
│                 │ Mounts + env                                              │
│                 ▼                                                           │
│  Keystone Pod                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  OS_DATABASE__CONNECTION   ← env from <name>-db-connection Secret   │    │
│  │  /etc/keystone/keystone.conf.d/  (config, NO DB password)           │    │
│  │  /etc/keystone/fernet-keys/      (Fernet key files, mode 0400)      │    │
│  │  /etc/keystone/db-tls/           (DB client cert, when TLS enabled) │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## MariaDB Interaction

The Keystone Operator interacts with MariaDB through the MariaDB Operator's CRDs (see [Control Plane — Infrastructure Service Operators](../03-components/01-control-plane/06-infrastructure-operators.md)).

**Resources created by the Keystone reconciler:**

| MariaDB CR | Purpose |
| --- | --- |
| `Database` (name: `keystone`) | Creates the `keystone` database |
| `User` (name = the Keystone CR name) | Creates the database user. In **managed mode** the username is the Keystone CR name and only the *password* is read from `keystone-db-credentials`; only **brownfield mode** reads `username` from the Secret. |
| `Grant` | Grants ALL PRIVILEGES on the `keystone` database to the user |

### Database connection Secret (CC-0080)

The DB password is **deliberately kept out of `keystone.conf`** — the earlier design that embedded it in the ConfigMap exposed credentials at rest in a non-Secret object. Instead, `reconcileDBConnectionSecret()` reads `keystone-db-credentials`, assembles the SQLAlchemy URL `mysql+pymysql://USERNAME:PASSWORD@HOST:PORT/keystone` (appending `ssl_*` parameters when TLS is enabled), and writes it to a derived `<name>-db-connection` Secret. Every workload — API Deployment, `db_sync`, bootstrap, key-rotation, and trust-flush — receives it at runtime via the `OS_DATABASE__CONNECTION` environment variable rather than from the config file.

### Database TLS / mutual TLS (CC-0106)

`spec.database.tls` opts the connection into TLS. `reconcileDatabaseTLS()` resolves one of three modes:

- **Managed** — issues a `<name>-db-client` cert-manager `Certificate` from the shared `openstack-db-ca-issuer` ClusterIssuer and mounts it at `/etc/keystone/db-tls/`.
- **ExternallyManaged** — uses the user-supplied `caBundleSecretRef`/`clientCertSecretRef` (brownfield); no Certificate is issued.
- **NotRequired** — plaintext TCP (nil/disabled).

`spec.database.tls.mode` (`prefer` / `require` / `verify-ca` / `verify-full`) maps to pymysql `ssl_ca` / `ssl_cert` / `ssl_key` / `ssl_verify_*` DSN parameters, merged into the connection URL above. The `DatabaseTLSReady` condition gates the rest of the flow.

**Readiness:** In managed mode the reconciler gates db_sync on a chain of conditions — MariaDB **cluster** health (`isMariaDBClusterReady`), then the `Database`, `User`, and `Grant` CRs each reporting `Ready` — before proceeding. While any of these is not ready, reconciliation requeues at `RequeueDatabaseWait` (30s).

## Memcached Interaction

Keystone uses Memcached for token caching and general-purpose caching. The Memcached cluster is managed by the [memcached-operator](../03-components/01-control-plane/06-infrastructure-operators.md#memcached-operator).

**Discovery:** In **managed mode** (`spec.cache.clusterRef`), the operator targets the Memcached cluster Service (e.g. `<clusterRef>:11211`); `spec.cache.replicas` is used to size endpoints where needed. In **brownfield mode**, the comma-joined `spec.cache.servers` list is used directly.

**keystone.conf cache configuration** (the operator populates both `[cache] memcache_servers` and `[memcache] servers`):

```ini
[cache]
enabled = true
backend = dogpile.cache.pymemcache
memcache_servers = memcached:11211          # managed: cluster Service

[memcache]
servers = memcached:11211
```

## Fernet Key Lifecycle

Keystone uses Fernet tokens, which require symmetric encryption keys that must be synchronized across all Keystone instances and rotated periodically.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       FERNET KEY ROTATION LIFECYCLE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Key States:                                                                │
│                                                                             │
│  ┌──────────┐  rotate   ┌──────────┐  rotate   ┌──────────┐  rotate         │
│  │ Staging  │ ────────▶ │ Primary  │ ────────▶ │Secondary │ ────────▶ ×     │
│  │ (key N)  │           │ (key N)  │           │ (key N)  │  (removed)      │
│  └──────────┘           └──────────┘           └──────────┘                 │
│                                                                             │
│  Index 0: Staging key   — used for validation only, will become Primary     │
│  Index 1: Primary key   — used for signing new tokens                       │
│  Index 2+: Secondary    — used for validation of existing tokens            │
│                                                                             │
│  Rotation Flow (split-compute-write, CC-0081):                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  1. CronJob runs: keystone-manage fernet_rotate                     │    │
│  │  2. CronJob PATCHes the <name>-fernet-keys-rotation STAGING Secret  │    │
│  │     (narrow get+patch RBAC — cannot touch the production Secret)    │    │
│  │  3. Operator validates staged keys (44-byte base64url → 32 bytes,   │    │
│  │     no duplicates, count within range)                              │    │
│  │  4. Operator (privileged SA) APPLIES them to keystone-fernet-keys   │    │
│  │  5. Keys are projected into pods and rotate IN PLACE — NO rolling   │    │
│  │     restart (CC-0074)                                               │    │
│  │  6. PushSecret syncs new keys to OpenBao (backup, per-CR path)      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  K8s Secret structure (keystone-fernet-keys):                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  data:                                                              │    │
│  │    "0": <base64 staging key>                                        │    │
│  │    "1": <base64 primary key>                                        │    │
│  │    "2": <base64 secondary key>                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

The `maxActiveKeys` CRD field (default: 3, floored at 3) controls how many keys are retained. With weekly rotation and `maxActiveKeys=3`, tokens remain valid for up to 2 weeks after issuance.

## Credential Key Lifecycle

Keystone also encrypts stored credentials (e.g. application-credential secrets, TOTP keys) with a separate **credential key** set, managed by `reconcileCredentialKeys()` in a near-mirror of the Fernet flow (CC-0036):

- **Initial generation** — `<name>-credential-keys` Secret.
- **Rotation** — a `<name>-credential-rotate` CronJob runs on `spec.credentialKeys.rotationSchedule`, writing to the `<name>-credential-keys-rotation` **staging Secret**; the operator validates and applies it to production (same split-compute-write boundary as Fernet).
- **Re-encryption** — critically, the rotate script also runs `keystone-manage credential_migrate` to re-encrypt stored credentials under the new primary key.
- **Backup** — PushSecret to `openstack/keystone/{name}/credential-keys`.

## Trust Flush

A `<name>-trust-flush` CronJob runs `keystone-manage trust_flush` to purge expired trust delegations from the database (CC-0057, CC-0096), reconciled by `reconcileTrustFlush()`. The schedule defaults to hourly (`0 * * * *`); `spec.trustFlush.suspend` pauses it without deleting the CronJob.

## Bootstrap Process

The Keystone bootstrap creates the initial admin user, project, role, and service catalog entry. It is implemented as a Kubernetes Job. A small embedded Python pre-seed script (`bootstrap_db_seed.py`) inserts the admin region row first, then `exec`s `keystone-manage bootstrap`:

```text
keystone-manage --config-dir=/etc/keystone/keystone.conf.d/ bootstrap \
  --bootstrap-password <from keystone-admin-credentials Secret> \
  --bootstrap-admin-url    http://keystone.openstack.svc.cluster.local:5000/v3 \
  --bootstrap-internal-url http://keystone.openstack.svc.cluster.local:5000/v3 \
  --bootstrap-public-url   <spec.bootstrap.publicEndpoint, else cluster-local>/v3 \
  --bootstrap-region-id RegionOne
```

URLs use `http` (TLS is terminated upstream by the Gateway) and carry the `/v3` path. The public URL comes from `spec.bootstrap.publicEndpoint` when set, otherwise falls back to the cluster-local Service DNS.

**Resources created by bootstrap:**

| Resource | Name | Description |
| --- | --- | --- |
| Domain | `default` | Default Keystone domain |
| Project | `admin` | Admin project |
| User | `admin` | Admin user (password from ESO Secret) |
| Role | `admin` | Admin role |
| Role | `member` | Member role |
| Role | `reader` | Reader role |
| Service | `keystone` | Identity service in service catalog |
| Endpoints | `public`, `internal`, `admin` | Keystone API endpoints |

**Chicken-and-egg with K-ORC:** The bootstrap Job creates foundational resources (domain, roles, service catalog) that [K-ORC](../03-components/01-control-plane/05-korc.md) later imports as unmanaged resources.
Subsequent Keystone resources (the single admin Application Credential, per-pod service users, services, additional endpoints) are then managed by K-ORC.
This two-phase approach resolves the circular dependency: Keystone must exist before K-ORC can talk to it, but K-ORC needs the bootstrap resources to operate.

## Admin Credential Rotation

The admin password (`spec.bootstrap.adminPasswordSecretRef`) is the credential `keystone-manage bootstrap` assigns to the `admin` user. Like the Fernet token keys and credential *encryption* keys, the admin password is rotated end-to-end by the operator. Rotation has two halves, both implemented in forge: an **apply side** that writes a changed password into the live Keystone database (CC-0108), and an opt-in **generate side** that produces new passwords on a schedule ("Model B", CC-0109).

### Why a naive secret update is not enough

`keystone-manage bootstrap` is idempotent: re-running it with a new `--bootstrap-password` updates the `admin` user's password in the Keystone database. ESO re-syncs the password from OpenBao (`kv-v2/bootstrap/keystone-admin`) into the admin Secret on its `refreshInterval`, and the operator watches that Secret and re-reconciles when it changes (the same `secretToKeystoneMapper` watch used for the DB Secret).

The remaining gap is in the **apply step**. The bootstrap Job injects the password by reference (`valueFrom.secretKeyRef`), so the Job's PodSpec is byte-for-byte identical before and after a password change. `RunJob` (CC-0005) keys its "should I re-run a completed Job?" decision on a SHA-256 hash of the PodSpec; because that hash does not change, the completed bootstrap Job would be treated as still-current and never re-run. The apply side (below) closes this gap so the rotated password actually reaches Keystone.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  Admin Credential Rotation                                                   │
│                                                                              │
│  OpenBao  kv-v2/bootstrap/keystone-admin   (source of truth)                 │
│     ▲  Model A: external rotation   │   Model B: operator PushSecret (CC-0109)│
│     │                               │                                        │
│     │   reconcilePasswordRotation():                                         │
│     │     CronJob → staging Secret → validate → push-source Secret           │
│     │     ──PushSecret (DeletionPolicy=None)──▶ bootstrap/keystone-admin      │
│     ▼                                                                        │
│  ESO  ──sync──▶  Secret  keystone-admin-credentials  (key: password)         │
│     │                                                                        │
│     │  Secret watch enqueues reconcile (secretToKeystoneMapper)              │
│     ▼                                                                        │
│  reconcileBootstrap()  (apply side, CC-0108)                                 │
│     │  stamps forge.c5c3.io/admin-password-hash onto the bootstrap pod tmpl  │
│     ▼                                                                        │
│  RunJob: PodSpec hash changed ──▶ delete stale Job ──▶ re-run (CC-0005)      │
│     ▼                                                                        │
│  keystone-manage bootstrap --bootstrap-password <new>                        │
│     ▼                                                                        │
│  admin user password updated in the Keystone database                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Apply side (keystone-operator, CC-0108)

`reconcileBootstrap()` makes the bootstrap Job's identity depend on the password *content*, reusing the hash pattern that rolls the API Deployment on key rotation (`fernetKeysHash`/`credentialKeysHash`):

1. It computes a SHA-256 digest of the `password` value in the admin Secret.
2. The digest is stamped onto the bootstrap pod template as the `forge.c5c3.io/admin-password-hash` annotation, so it becomes part of the PodSpec hash.
3. When ESO updates the Secret, the Secret watch enqueues a reconcile; the new digest changes the PodSpec hash; `RunJob` deletes the stale completed Job and recreates it.
4. The new bootstrap Job runs `keystone-manage bootstrap --bootstrap-password <new>` and updates the live admin password. `BootstrapReady` flips to `False`/`BootstrapInProgress` during the cutover and back to `True` once complete.

This needs no new CRD fields and reuses the existing Secret watch, the `RunJob` re-run path, and the idempotency of `keystone-manage bootstrap`. It is the foundation both generate-side models build on.

### Generate side — where the new password comes from

Two models, both compatible with the apply side above:

**Model A — external / OpenBao-driven (default).** The new password is produced outside the operator — OpenBao's own rotation, a CI/CD job, or a manual write — and stored at `kv-v2/bootstrap/keystone-admin`. ESO propagates it and the apply side re-bootstraps. No operator machinery beyond the apply side; OpenBao stays the single source of truth.

**Model B — operator-scheduled, split-compute-write (opt-in, CC-0109).** Implemented by `reconcilePasswordRotation()` (the final sub-reconciler), gated by `spec.bootstrap.passwordRotation.{enabled,schedule,suspend,passwordLength}` (default `enabled: false`; when enabled, `schedule` defaults to monthly `0 0 1 * *` and `passwordLength` to 32 with a floor of 24). It mirrors the Fernet/credential-key boundary (CC-0081):

1. A `<name>-admin-password-rotate` **CronJob** runs `scripts/admin_password_rotate.sh`, which mints a strong password and `PATCH`es it onto a narrow-RBAC **staging** Secret `<name>-admin-password-rotation` via the pod's ServiceAccount token. The CronJob has no access to OpenBao or the production credential.
2. The operator **validates** the staged password (length ≥ `passwordLength`/floor 24) and copies it into an operator-owned **push-source** Secret `<name>-admin-password-next`.
3. A **PushSecret** — created only once the push-source holds a valid password, with `DeletionPolicy=None` so disabling rotation never clobbers the live credential — mirrors it to OpenBao at `bootstrap/keystone-admin`. ESO syncs it down and the apply side re-bootstraps.

Keeping the privileged write (OpenBao plus the production Secret) in the operator — not the CronJob — keeps token-forgery primitives out of the narrow-RBAC CronJob, matching the existing rotation security model. Disabling the feature (or setting `passwordRotation: nil`) tears down every Model B resource and sets `PasswordRotationReady=True`/`RotationDisabled`. Because the push path is the single flat OpenBao key `bootstrap/keystone-admin`, Model B assumes a single Model-B-enabled Keystone CR per cluster.

### Design considerations

- **Single-valued credential, hard cutover.** A Keystone user has exactly one password; there is no native dual-validity grace window as there is for application credentials. There is therefore an unavoidable short skew between the moment Keystone's stored password changes and the moment every consumer has re-read the new value from ESO.
- **Low blast radius.** Running OpenStack services authenticate with their own per-pod service users (real user + password, issue [#30](https://github.com/C5C3/C5C3/issues/30)), not the admin password. The admin password's only consumers are the bootstrap Job and administrative tooling (operators, the K-ORC admin App Cred bootstrap/rotation, CI). Those consumers must read the password from ESO/OpenBao at use time and retry on auth failure rather than caching it indefinitely.
- **OpenBao is authoritative.** The rotated password must be written to OpenBao first and flow down through ESO. The operator must not write it only into the ESO-owned admin Secret (`creationPolicy: Owner`), because ESO would overwrite it on the next refresh.
- **Existing tokens survive.** Changing the admin password does not revoke already-issued Fernet tokens; they remain valid until expiry. If immediate invalidation is required, pair rotation with explicit token revocation.
- **Recoverability.** As with key rotation, the password in OpenBao is the recovery point: re-running bootstrap re-converges Keystone to whatever OpenBao currently holds.

For where the admin password sits in the broader credential flow, see [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md) and the rotation overview in [Secret Management](../05-deployment/02-secret-management.md#credential-rotation).

## Keystone Container Image Contract

The Keystone Operator expects the following from the Keystone service image (`ghcr.io/c5c3/keystone:<tag>`):

| Aspect | Requirement |
| --- | --- |
| **Base path** | Python virtualenv at `/var/lib/openstack/` |
| **Config directory** | `/etc/keystone/keystone.conf.d/` (mounted by operator; consumed via `--config-dir`) |
| **Domain config** | `/etc/keystone/domains/` (for domain-specific configs) |
| **DB TLS material** | `/etc/keystone/db-tls/` (mounted when `spec.database.tls` is enabled) |
| **Service user** | UID 42424 (non-root) |
| **`keystone-manage` CLI** | Available in `$PATH` — `db_sync`, `bootstrap`, `fernet_setup`, `fernet_rotate`, `credential_setup`, `credential_rotate`, `credential_migrate`, `trust_flush` |
| **WSGI entrypoint** | `uwsgi` or `gunicorn` serving the Keystone WSGI application |
| **Plugins** | Installed at build time via `extra-packages.yaml` (see [Shared Library](./02-shared-library.md#extra-packages--plugin-installation-build-time)) |

For image build details, see [Build Pipeline](../08-container-images/01-build-pipeline.md). For tag schema, see [Versioning](../08-container-images/02-versioning.md). For patching and extra-packages integration, see [Patching](../08-container-images/03-patching.md).

## Plugin Configuration Examples

### Audit Middleware (openstack-audit-middleware)

Audit middleware is a WSGI filter that logs all API requests to a CADF-compliant audit log. It is generic — all OpenStack services use the same middleware.

The operator inserts the audit filter into the `api-paste.ini` pipeline after the `authtoken` filter:

```ini
# Generated api-paste.ini (relevant section)
[filter:audit]
paste.filter_factory = audit_middleware:filter_factory
audit_map_file = /etc/keystone/audit_map.yaml

[pipeline:public_api]
pipeline = cors sizelimit http_proxy_to_wsgi osprofiler url_normalize request_id authtoken audit admin_service
```

### Keycloak Backend (keystone-keycloak-backend)

The Keycloak backend is Keystone-specific — it provides a federated identity driver that authenticates against a Keycloak realm.

Domain-specific config (`/etc/keystone/domains/keystone.corporate.conf`):

```ini
[identity]
driver = keycloak

[keycloak]
server_url = https://keycloak.example.com
realm_name = openstack
client_id = keystone
```

### CRD Example

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

  # Audit middleware for all API requests
  middleware:
    - name: audit
      filterFactory: "audit_middleware:filter_factory"
      position:
        after: authtoken
      config:
        audit_map_file: /etc/keystone/audit_map.yaml

  # Keycloak federation for "corporate" domain
  plugins:
    - name: keystone-keycloak-backend
      configSection: keycloak
      config:
        server_url: https://keycloak.example.com
        realm_name: openstack
        client_id: keystone

  # Domain-specific driver config
  extraConfig:
    identity:
      domain_specific_drivers_enabled: "true"
      domain_config_dir: /etc/keystone/domains
```

The general pattern — `spec.middleware[]` for PasteDeploy filters, `spec.plugins[]` for service drivers, `spec.extraConfig` for free-form INI sections — is implemented in the shared library (`internal/common/plugins/`) and reusable by all operators.

## Config File Generation

### keystone.conf Mapping

The reconciler renders the `keystone.conf.d/` files by mapping CRD spec fields to INI sections. Credentials are injected at runtime from Kubernetes Secrets — and the DB password specifically is **not** written into any ConfigMap.

| CRD Spec Field | INI Section | INI Key | Source |
| --- | --- | --- | --- |
| `spec.database` | — | `OS_DATABASE__CONNECTION` env | Connection URL from the derived `<name>-db-connection` Secret (CC-0080) — **not** rendered into `[database] connection` |
| `spec.cache.backend` | `[cache]` | `backend` | CRD field |
| `spec.cache.servers` | `[cache]` | `memcache_servers` | CRD field (comma-joined) |
| `spec.cache.servers` | `[memcache]` | `servers` | CRD field (comma-joined) |
| `spec.fernet.maxActiveKeys` | `[fernet_tokens]` | `max_active_keys` | CRD field |
| (operator default) | `[identity]` | `default_domain_id` | Operator default (`"default"`) |
| `spec.plugins[].config` | `[<configSection>]` | Per plugin | CRD field |
| `spec.extraConfig` | `[<section>]` | Per key | CRD field (escape hatch) |
| (operator default) | `[token]` | `provider` | `fernet` |
| (operator default) | `[DEFAULT]` | `log_config_append` | `/etc/keystone/logging.conf` |

### api-paste.ini Pipeline

The base Keystone WSGI pipeline is:

```ini
[pipeline:public_api]
pipeline = cors sizelimit http_proxy_to_wsgi osprofiler url_normalize request_id authtoken admin_service
```

Middleware filters from `spec.middleware[]` are inserted at their specified positions. For example, the `audit` filter with `position.after: authtoken` produces:

```ini
[pipeline:public_api]
pipeline = cors sizelimit http_proxy_to_wsgi osprofiler url_normalize request_id authtoken audit admin_service
```

The config generation pipeline is documented in [Config Generation](../05-deployment/03-service-configuration/01-config-generation.md). Secret injection and immutable ConfigMap patterns are described in [Shared Library — config/](./02-shared-library.md#config).
