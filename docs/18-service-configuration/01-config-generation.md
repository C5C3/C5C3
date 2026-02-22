# Config Generation

Each Service Operator in CobaltCore follows a deterministic pipeline to translate CRD fields into OpenStack INI configuration files. This page documents that pipeline, shows worked examples, and explains how secrets, defaults, and updates are handled.

## Pipeline Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CONFIG GENERATION PIPELINE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Step 1: READ CRD SPEC                                                      │
│  ─────────────────────                                                      │
│  Operator watches its Service CR (e.g. Nova CR) and reads spec fields:      │
│  database, messaging, keystoneAuth, cache, storage, network, image, ...     │
│  Infrastructure dependencies use either clusterRef (managed) or             │
│  explicit host/port (brownfield) — see Step 2.                              │
│                                                                             │
│  Step 2: RESOLVE INFRASTRUCTURE ENDPOINTS + SECRETS                         │
│  ──────────────────────────────────────────────────                         │
│  For each infrastructure dependency (database, messaging, cache):           │
│  • Managed mode (clusterRef set): Operator reads the referenced             │
│    infrastructure CR (e.g. MariaDB CR) and resolves endpoints from          │
│    its status fields. Creates per-service resources (Database, User CRs).   │
│  • Brownfield mode (host/port set): Operator uses explicit endpoints.       │
│    No infrastructure CRs are created.                                       │
│  Then reads K8s Secrets referenced in secretRef fields (from ESO/OpenBao).  │
│  Example: database password, RabbitMQ credentials, Ceph keys.               │
│                                                                             │
│  Step 3: APPLY DEFAULTS                                                     │
│  ─────────────────────                                                      │
│  Operator merges CRD values with built-in defaults for the target           │
│  OpenStack release. Defaults cover oslo.log, oslo.policy, API workers,      │
│  transport settings, etc.                                                   │
│                                                                             │
│  Step 4: RENDER INI                                                         │
│  ─────────────────                                                          │
│  Structured data is rendered into INI format. Each [section]/key=value      │
│  is written from Go structs. Connection strings are assembled from          │
│  host + port + credentials + database name.                                 │
│                                                                             │
│  Step 5: CREATE / UPDATE CONFIGMAP                                          │
│  ────────────────────────────────                                           │
│  The rendered INI content is placed into a ConfigMap. The ConfigMap name    │
│  includes a content hash (e.g. nova-config-abc12def). If content changed,   │
│  a new ConfigMap is created and the Deployment is updated to reference it.  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

For validation checks that occur during reconciliation (between Steps 2-5), see [Validation](./02-validation.md). For brownfield integration details, see [Brownfield Integration](../16-brownfield-integration.md).

## CRD-to-INI Mapping

### Nova: CRD to nova.conf

Nova is the most complex service — multiple databases, messaging, Keystone auth, Ceph storage, and cell architecture.

**CRD fields (simplified):**

```yaml
apiVersion: openstack.c5c3.io/v1alpha1
kind: Nova
metadata:
  name: nova
  namespace: openstack
spec:
  image:
    repository: ghcr.io/c5c3/nova
    tag: "32.1.0"
  replicas:
    api: 3
    scheduler: 2
    conductor: 2
  database:
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    # host: external-db.example.com  # Brownfield alternative
    # port: 3306
    name: nova
    secretRef:
      name: nova-db-credentials
      key: password
  apiDatabase:
    clusterRef:
      name: mariadb
    name: nova_api
    secretRef:
      name: nova-api-db-credentials
      key: password
  messaging:
    clusterRef:
      name: rabbitmq               # Managed: references RabbitMQ CR
    # hosts:                        # Brownfield alternative
    #   - external-rmq.example.com:5672
    secretRef:
      name: nova-rabbitmq-credentials
  keystoneAuth:
    authUrl: http://keystone-api.openstack.svc:5000
    region: RegionOne
    applicationCredentialRef:
      name: nova-app-credential
  cache:
    clusterRef:
      name: memcached              # Managed: references Memcached CR
    # servers:                      # Brownfield alternative
    #   - external-mc:11211
    backend: dogpile.cache.memcached
  storage:
    backend: rbd
    rbdPool: vms
    rbdUser: nova
    cephSecretRef:
      name: ceph-client-nova
```

**Generated nova.conf (relevant sections).** Credentials are shown as `****` — they are read from K8s Secrets at reconciliation time and assembled into connection strings:

```ini
[DEFAULT]
transport_url = rabbit://nova:****@rabbitmq.rabbitmq-system.svc:5672/nova
log_config_append = /etc/nova/logging.conf
state_path = /var/lib/nova

[api_database]
connection = mysql+pymysql://nova_api:****@maxscale.mariadb-system.svc:3306/nova_api
max_retries = -1
connection_recycle_time = 600

[database]
connection = mysql+pymysql://nova:****@maxscale.mariadb-system.svc:3306/nova
max_retries = -1
connection_recycle_time = 600

[keystone_authtoken]
auth_type = v3applicationcredential
auth_url = http://keystone-api.openstack.svc:5000
application_credential_id = <from-secret>
application_credential_secret = <from-secret>

[service_user]
auth_type = v3applicationcredential
auth_url = http://keystone-api.openstack.svc:5000
send_service_user_token = true

[cache]
enabled = true
backend = dogpile.cache.memcached
memcache_servers = memcached.memcached-system.svc:11211

[libvirt]
rbd_user = nova
rbd_secret_uuid = <generated-uuid>
images_rbd_pool = vms
images_type = rbd

[oslo_concurrency]
lock_path = /var/lib/nova/tmp
```

**Key observations:**

- Connection strings (`transport_url`, `connection`) are assembled by the operator from CRD fields + secret values
- The `****` placeholders represent credential values read from K8s Secrets — they are never stored in the CRD
- Operator defaults supply `max_retries`, `connection_recycle_time`, `lock_path`, and other operational settings
- The `rbd_secret_uuid` is generated or read from the Ceph secret

### Keystone: CRD to keystone.conf

```yaml
apiVersion: openstack.c5c3.io/v1alpha1
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
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    name: keystone
    secretRef:
      name: keystone-db-credentials
  cache:
    clusterRef:
      name: memcached              # Managed: references Memcached CR
    backend: dogpile.cache.memcached
  fernet:
    maxActiveKeys: 3
    rotationInterval: 24h
```

**Generated keystone.conf (relevant sections):**

```ini
[DEFAULT]
log_config_append = /etc/keystone/logging.conf

[database]
connection = mysql+pymysql://keystone:****@maxscale.mariadb-system.svc:3306/keystone
max_retries = -1
connection_recycle_time = 600

[cache]
enabled = true
backend = dogpile.cache.memcached
memcache_servers = memcached.memcached-system.svc:11211

[token]
provider = fernet

[fernet_tokens]
key_repository = /etc/keystone/fernet-keys
max_active_keys = 3

[oslo_middleware]
enable_proxy_headers_parsing = true
```

### Neutron: CRD to neutron.conf + ml2_conf.ini

Neutron is notable because a single CRD produces **multiple configuration files**.

```yaml
apiVersion: openstack.c5c3.io/v1alpha1
kind: Neutron
metadata:
  name: neutron
  namespace: openstack
spec:
  image:
    repository: ghcr.io/c5c3/neutron
    tag: "27.0.1"
  replicas: 3
  database:
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    name: neutron
    secretRef:
      name: neutron-db-credentials
  messaging:
    clusterRef:
      name: rabbitmq               # Managed: references RabbitMQ CR
    secretRef:
      name: neutron-rabbitmq-credentials
  keystoneAuth:
    authUrl: http://keystone-api.openstack.svc:5000
    applicationCredentialRef:
      name: neutron-app-credential
  ml2:
    typeDrivers:
      - geneve
      - flat
    mechanismDrivers:
      - ovn
    tenantNetworkTypes:
      - geneve
    ovn:
      ovnNbConnection: tcp:ovn-nb.ovn-system.svc:6641
      ovnSbConnection: tcp:ovn-sb.ovn-system.svc:6642
```

**Generated neutron.conf:**

```ini
[DEFAULT]
core_plugin = ml2
service_plugins = ovn-router
transport_url = rabbit://neutron:****@rabbitmq.rabbitmq-system.svc:5672/neutron

[database]
connection = mysql+pymysql://neutron:****@maxscale.mariadb-system.svc:3306/neutron

[keystone_authtoken]
auth_type = v3applicationcredential
auth_url = http://keystone-api.openstack.svc:5000
application_credential_id = <from-secret>
application_credential_secret = <from-secret>
```

**Generated ml2_conf.ini:**

```ini
[ml2]
type_drivers = geneve,flat
mechanism_drivers = ovn
tenant_network_types = geneve

[ml2_type_geneve]
vni_ranges = 1:65536
max_header_size = 38

[ovn]
ovn_nb_connection = tcp:ovn-nb.ovn-system.svc:6641
ovn_sb_connection = tcp:ovn-sb.ovn-system.svc:6642
ovn_l3_scheduler = leastloaded
ovn_metadata_enabled = true
```

The operator writes both files into the same ConfigMap under different keys (`neutron.conf` and `ml2_conf.ini`), and the pod mounts them at their respective paths.

## ConfigMap Structure

A generated ConfigMap uses a content-hash suffix to ensure immutability:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nova-config-a1b2c3d4
  namespace: openstack
  labels:
    app.kubernetes.io/name: nova
    app.kubernetes.io/managed-by: nova-operator
  ownerReferences:
    - apiVersion: openstack.c5c3.io/v1alpha1
      kind: Nova
      name: nova
data:
  nova.conf: |
    [DEFAULT]
    transport_url = rabbit://nova:****@rabbitmq.rabbitmq-system.svc:5672/nova
    ...
  logging.conf: |
    [loggers]
    keys = root, nova
    ...
```

**Key properties:**

- The hash suffix (`a1b2c3d4`) is computed from the config content — identical content produces the same name
- `ownerReferences` ensure the ConfigMap is garbage-collected when the Service CR is deleted
- Old ConfigMaps are retained briefly for rollback, then garbage-collected by the operator

## Secret Injection

Credentials flow from OpenBao through ESO into K8s Secrets, which operators read during config generation:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SECRET INJECTION FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  OpenBao                                                                    │
│  ├── kv-v2/openstack/nova/db          → {"username": "nova", "password": …} │
│  ├── kv-v2/infrastructure/rabbitmq    → {"username": "nova", "password": …} │
│  └── kv-v2/openstack/nova/app-credential → {"id": …, "secret": …}           │
│         │                                                                   │
│         ▼                                                                   │
│  ESO (ExternalSecret CRs)                                                   │
│  ├── nova-db-credentials              → K8s Secret                          │
│  ├── nova-rabbitmq-credentials        → K8s Secret                          │
│  └── nova-app-credential              → K8s Secret                          │
│         │                                                                   │
│         ▼                                                                   │
│  nova-operator (reconciliation)                                             │
│  ├── Reads K8s Secret values                                                │
│  ├── Assembles connection strings:                                          │
│  │   DB:    <scheme>://<user>:<pass>@<host>:<port>/<db>                     │
│  │   AMQP:  <scheme>://<user>:<pass>@<host>:<port>/<vhost>                  │
│  └── Embeds into ConfigMap                                                  │
│         │                                                                   │
│         ▼                                                                   │
│  Pod mounts ConfigMap as /etc/nova/nova.conf                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Important:** Credentials appear in the rendered ConfigMap (as connection strings) but **never** in the CRD spec. The CRD only contains `secretRef` pointers. For the full secret management architecture, see [Secret Management](../13-secret-management.md).

## Operator Defaults

Each operator embeds sensible defaults for every supported OpenStack release. These defaults cover settings that:

- Are required but rarely customized (e.g., `max_retries = -1`, `connection_recycle_time = 600`)
- Depend on the deployment model (e.g., `oslo_concurrency.lock_path`, `state_path`)
- Are best practices for Kubernetes deployments (e.g., `enable_proxy_headers_parsing = true`)

**Default precedence:**

```text
Lowest priority                                        Highest priority
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  OpenStack   │    │   Operator   │    │   CRD Spec   │
│  upstream    │───▶│   embedded   │───▶│   fields     │
│  defaults    │    │   defaults   │    │              │
└──────────────┘    └──────────────┘    └──────────────┘
```

CRD spec fields always take precedence. Operator defaults fill in everything else. OpenStack's own defaults apply for any setting not covered by either layer.

For override mechanisms beyond CRD fields, see [Customization](./03-customization.md).

## Config Updates and Rolling Restarts

When a CRD field changes, the operator re-renders the config and creates a new ConfigMap:

```text
CRD change (e.g. cache.host updated)
       │
       ▼
Operator reconciles
       │
       ├── Renders new INI content
       ├── Computes new content hash
       ├── hash differs? ──▶ Creates new ConfigMap (nova-config-e5f6g7h8)
       │                     Updates Deployment pod template annotation
       │                     (configmap-hash: e5f6g7h8)
       │
       ▼
Kubernetes detects pod template change
       │
       ▼
Rolling restart (maxUnavailable: 1)
       │
       ▼
New pods mount updated ConfigMap
```

This mechanism ensures:

- **No in-place mutation** — old pods continue with the old config until replaced
- **Automatic rollout** — Kubernetes handles the rolling restart
- **Rollback possible** — reverting the CRD produces the previous ConfigMap hash, and Kubernetes rolls back

For the full upgrade lifecycle, see [Upgrades](../14-upgrades.md).

## Per-Node Configuration

DaemonSet components (nova-compute agent, ovn-controller) running on hypervisor nodes may require per-node configuration:

| Component | Per-Node Config | Source |
| --- | --- | --- |
| nova-compute | `my_ip`, `host` | Downward API (node name, pod IP) |
| ovn-controller | `ovn-encap-ip`, `ovn-bridge` | OVSNode CRD status, node annotations |
| libvirt | connection URI, hypervisor type | Hypervisor CRD (`domainCapabilities.hypervisorType`), see [Hypervisor Lifecycle](../06-hypervisor-lifecycle.md) |

**Approach:** Per-node values are injected via environment variables (Downward API) or init containers that read node-specific CRD status. The base ConfigMap remains shared across all nodes — only the node-specific values differ.

```text
┌──────────────────────────────────┐
│  Shared ConfigMap                │
│  (nova-compute.conf)             │
│  [DEFAULT]                       │
│  transport_url = rabbit://...    │
│  ...                             │
└──────────────┬───────────────────┘
               │
               ├──────────────────────────────────┐
               ▼                                  ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│  Node A                  │    │  Node B                  │
│  ENV: MY_IP=10.0.1.10    │    │  ENV: MY_IP=10.0.1.11    │
│  ENV: HOST=hv-node-a     │    │  ENV: HOST=hv-node-b     │
│  nova-compute reads both │    │  nova-compute reads both │
│  ConfigMap + env vars    │    │  ConfigMap + env vars    │
└──────────────────────────┘    └──────────────────────────┘
```

oslo.config supports environment variable overrides (e.g., `NOVA_DEFAULT__MY_IP` maps to `[DEFAULT] my_ip`), which the operator leverages to avoid per-node ConfigMap proliferation. <!-- TODO: Verify exact oslo.config env var format and whether config_source driver is required -->
