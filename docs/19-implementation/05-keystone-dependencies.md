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
│  ┌───────┴────────┐         │                   │                          │
│  │ cert-manager   │         │                   │                          │
│  │ (TLS certs)    │         │                   │                          │
│  └───────┬────────┘         │                   │                          │
│          │                   │                   │                          │
│          └───────────────────┼───────────────────┘                          │
│                              │                                              │
│                              ▼                                              │
│  Phase 1: Keystone Operator                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    keystone-operator                                 │    │
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

See [Control Plane — Service Dependencies](../03-components/01-control-plane.md#openstack-service-dependencies) for the full dependency matrix across all services.

***

## OpenBao / ESO Secret Flow

### Design Principle

**All secrets originate from OpenBao.** Operators read exclusively Kubernetes Secrets that are created by the External Secrets Operator (ESO). Operators never access OpenBao directly. This design is documented in [Secret Management](../13-secret-management.md) and [Credential Lifecycle](../11-gitops-fluxcd/01-credential-lifecycle.md).

**Prerequisite:** ESO and a `ClusterSecretStore` must be deployed and operational before any service operator starts. This is part of Phase 0 in the bootstrap sequence (see [Credential Lifecycle — Bootstrap Problem](../11-gitops-fluxcd/01-credential-lifecycle.md#bootstrap-problem-and-solution-architecture)).

### Keystone Secret Inventory

| OpenBao Path | ExternalSecret → K8s Secret | Contents | Consumer |
| --- | --- | --- | --- |
| `kv-v2/bootstrap/keystone-admin` | `keystone-admin-credentials` | Admin password | Bootstrap Job |
| `kv-v2/openstack/keystone/db` | `keystone-db-credentials` | MariaDB username, password | DB connection, db_sync |
| (operator-generated) | `keystone-fernet-keys` → PushSecret → `kv-v2/openstack/keystone/fernet-keys` | Fernet key material | API Deployment, rotation backup |

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
    name: openbao
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
    name: openbao
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
      name: openbao
  selector:
    secret:
      name: keystone-fernet-keys
  data:
    - match:
        remoteRef:
          remoteKey: kv-v2/data/openstack/keystone/fernet-keys
```

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
│  │  reconcileSecrets()   → Checks secret existence                     │    │
│  │  reconcileConfig()    → Injects DB credentials into keystone.conf   │    │
│  │  reconcileBootstrap() → Injects admin password into bootstrap Job   │    │
│  └──────────────┬──────────────────────────────────────────────────────┘    │
│                 │ Mounts                                                    │
│                 ▼                                                           │
│  Keystone Pod                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  /etc/keystone/keystone.conf     (DB connection string with creds)  │    │
│  │  /etc/keystone/fernet-keys/      (Fernet key files)                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

***

## MariaDB Interaction

The Keystone Operator interacts with MariaDB through the MariaDB Operator's CRDs (see [Control Plane — Infrastructure Service Operators](../03-components/01-control-plane.md#infrastructure-service-operators)).

**Resources created by the Keystone reconciler:**

| MariaDB CR | Purpose |
| --- | --- |
| `Database` (name: `keystone`) | Creates the `keystone` database |
| `User` (name: `keystone`) | Creates the database user with credentials from `keystone-db-credentials` |
| `Grant` (name: `keystone`) | Grants ALL PRIVILEGES on the `keystone` database to the `keystone` user |

**Connection string assembly:**

The reconciler reads the `keystone-db-credentials` Secret (provided by ESO) and assembles the SQLAlchemy connection string in the format `mysql+pymysql://USERNAME:PASSWORD@HOST:PORT/keystone`. The placeholders are replaced with actual values from the Secret and CRD spec at reconciliation time.

This string is rendered into `keystone.conf` under `[database] connection =`.

**Readiness:** The reconciler waits for the MariaDB `Database` CR status to become `Ready` before proceeding to db_sync. If the MariaDB Operator or Galera cluster is not ready, reconciliation requeues with a 30-second delay.

***

## Memcached Interaction

Keystone uses Memcached for token caching and general-purpose caching. The Memcached cluster is managed by the [memcached-operator](../03-components/01-control-plane.md#memcached-operator).

**Discovery:** Memcached pods are accessed via a headless Service, enabling DNS-based discovery. Each pod gets a stable DNS name (e.g., `memcached-0.memcached:11211`).

**keystone.conf cache configuration:**

```ini
[cache]
enabled = true
backend = dogpile.cache.pymemcache
memcache_servers = memcached-0.memcached:11211,memcached-1.memcached:11211,memcached-2.memcached:11211

[memcache]
servers = memcached-0.memcached:11211,memcached-1.memcached:11211,memcached-2.memcached:11211
```

The server list is populated from the CRD's `spec.cache.servers` field.

***

## Fernet Key Lifecycle

Keystone uses Fernet tokens, which require symmetric encryption keys that must be synchronized across all Keystone instances and rotated periodically.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       FERNET KEY ROTATION LIFECYCLE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Key States:                                                                │
│                                                                             │
│  ┌──────────┐  rotate   ┌──────────┐  rotate   ┌──────────┐  rotate       │
│  │ Staging  │ ────────▶ │ Primary  │ ────────▶ │Secondary │ ────────▶ ×   │
│  │ (key N)  │           │ (key N)  │           │ (key N)  │  (removed)    │
│  └──────────┘           └──────────┘           └──────────┘               │
│                                                                             │
│  Index 0: Staging key   — used for validation only, will become Primary     │
│  Index 1: Primary key   — used for signing new tokens                       │
│  Index 2+: Secondary    — used for validation of existing tokens            │
│                                                                             │
│  Rotation Flow:                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  1. CronJob runs: keystone-manage fernet_rotate                     │    │
│  │  2. New staging key generated, old staging → primary,               │    │
│  │     old primary → secondary, oldest secondary removed               │    │
│  │     (maxActiveKeys controls how many secondaries are retained)      │    │
│  │  3. Updated keys written to keystone-fernet-keys Secret             │    │
│  │  4. Deployment annotation updated → triggers rolling restart        │    │
│  │  5. PushSecret syncs new keys to OpenBao (backup)                   │    │
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

The `maxActiveKeys` CRD field (default: 3) controls how many keys are retained. With weekly rotation and `maxActiveKeys=3`, tokens remain valid for up to 2 weeks after issuance.

***

## Bootstrap Process

The Keystone bootstrap creates the initial admin user, project, role, and service catalog entry. It is implemented as a Kubernetes Job running `keystone-manage bootstrap`:

```text
keystone-manage bootstrap \
  --bootstrap-password <from keystone-admin-credentials Secret> \
  --bootstrap-admin-url https://keystone.openstack.svc:5000 \
  --bootstrap-internal-url https://keystone.openstack.svc:5000 \
  --bootstrap-public-url https://keystone.openstack.svc:5000 \
  --bootstrap-region-id RegionOne
```

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

**Chicken-and-egg with K-ORC:** The bootstrap Job creates foundational resources (domain, roles, service catalog) that [K-ORC](../03-components/01-control-plane.md#openstack-resource-controller-k-orc) later imports as unmanaged resources.
Subsequent Keystone resources (service users, application credentials, additional endpoints) are then managed by K-ORC.
This two-phase approach resolves the circular dependency: Keystone must exist before K-ORC can talk to it, but K-ORC needs the bootstrap resources to operate.

***

## Keystone Container Image Contract

The Keystone Operator expects the following from the Keystone service image (`ghcr.io/c5c3/keystone:<tag>`):

| Aspect | Requirement |
| --- | --- |
| **Base path** | Python virtualenv at `/var/lib/openstack/` |
| **Config directory** | `/etc/keystone/` (mounted by operator) |
| **Domain config** | `/etc/keystone/domains/` (for domain-specific configs) |
| **Service user** | UID 42424 (non-root) |
| **`keystone-manage` CLI** | Available in `$PATH` — `db_sync`, `bootstrap`, `fernet_setup`, `fernet_rotate` |
| **WSGI entrypoint** | `uwsgi` or `gunicorn` serving the Keystone WSGI application |
| **Plugins** | Installed at build time via `extra-packages.yaml` (see [Shared Library](./02-shared-library.md#extra-packages--plugin-installation-build-time)) |

For image build details, see [Build Pipeline](../17-container-images/01-build-pipeline.md). For tag schema, see [Versioning](../17-container-images/02-versioning.md). For patching and extra-packages integration, see [Patching](../17-container-images/03-patching.md).

***

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
    database: keystone
    secretRef:
      name: keystone-db-credentials
      key: password
  cache:
    backend: dogpile.cache.pymemcache
    servers:
      - memcached-0.memcached:11211
      - memcached-1.memcached:11211
      - memcached-2.memcached:11211
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

***

## Config File Generation

### keystone.conf Mapping

The reconciler generates `keystone.conf` by mapping CRD spec fields to INI sections. Credentials are injected at runtime from Kubernetes Secrets (never stored in CRDs or ConfigMaps).

| CRD Spec Field | INI Section | INI Key | Source |
| --- | --- | --- | --- |
| `spec.database.secretRef` | `[database]` | `connection` | Connection string assembled from Secret |
| `spec.cache.backend` | `[cache]` | `backend` | CRD field |
| `spec.cache.servers` | `[cache]` | `memcache_servers` | CRD field (comma-joined) |
| `spec.cache.servers` | `[memcache]` | `servers` | CRD field (comma-joined) |
| `spec.fernet.maxActiveKeys` | `[fernet_tokens]` | `max_active_keys` | CRD field |
| `spec.bootstrap.region` | `[identity]` | `default_domain_id` | Operator default |
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

The config generation pipeline is documented in [Config Generation](../18-service-configuration/01-config-generation.md). Secret injection and immutable ConfigMap patterns are described in [Shared Library — config/](./02-shared-library.md#config).
