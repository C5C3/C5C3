# OpenBao Deployment

This page documents the deployment, initialization, and configuration of OpenBao as the central secret store for CobaltCore. For the architectural overview of secret management, see [Secret Management](../05-deployment/02-secret-management.md). For the credential lifecycle, see [Credential Lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md).

## Deployment via FluxCD

OpenBao is deployed in the Management Cluster using a FluxCD HelmRelease:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: openbao
  namespace: flux-system
spec:
  interval: 1h
  url: https://openbao.github.io/openbao-helm

---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: openbao
  namespace: openbao-system
spec:
  interval: 30m
  dependsOn:
    - name: cert-manager
      namespace: cert-manager
  chart:
    spec:
      chart: openbao
      version: ">=0.5.0 <1.0.0"
      sourceRef:
        kind: HelmRepository
        name: openbao
        namespace: flux-system
  install:
    crds: CreateReplace
    createNamespace: true
  upgrade:
    crds: CreateReplace
    remediation:
      retries: 3
  values:
    global:
      tlsDisable: false
    server:
      authDelegator:
        enabled: true
      # CC-0107: the listener requires & verifies client certs, so the
      # in-pod `bao` CLI must present its own client cert. VAULT_CLIENT_*
      # point at the mounted client keypair.
      extraEnvironmentVars:
        VAULT_CLIENT_CERT: /openbao/client-tls/tls.crt
        VAULT_CLIENT_KEY: /openbao/client-tls/tls.key
        VAULT_CACERT: /openbao/tls/ca.crt
      ha:
        enabled: true
        replicas: 3
        raft:
          enabled: true
          config: |
            ui = false

            listener "tcp" {
              tls_disable     = 0
              address         = "[::]:8200"
              cluster_address = "[::]:8201"
              tls_cert_file   = "/openbao/tls/tls.crt"
              tls_key_file    = "/openbao/tls/tls.key"
              # CC-0107: mutual TLS — only clients presenting a cert signed
              # by the dedicated OpenBao CA may connect.
              tls_client_ca_file                 = "/openbao/tls/ca.crt"
              tls_require_and_verify_client_cert = true
            }

            storage "raft" {
              path = "/openbao/data"
              retry_join {
                leader_api_addr         = "https://openbao-0.openbao-internal:8200"
                leader_ca_cert_file     = "/openbao/tls/ca.crt"
                leader_client_cert_file = "/openbao/client-tls/tls.crt"
                leader_client_key_file  = "/openbao/client-tls/tls.key"
              }
              # ... retry_join for openbao-1, openbao-2 (same mTLS fields) ...
            }

            service_registration "kubernetes" {}

      dataStorage:
        enabled: true
        size: 10Gi
        storageClass: local-path

      # TLS via cert-manager: server cert (openbao-tls) + client cert
      # (openbao-client-tls), both issued by the dedicated openbao-ca-issuer.
      volumes:
        - name: tls
          secret: { secretName: openbao-tls }
        - name: client-tls
          secret: { secretName: openbao-client-tls }
      volumeMounts:
        - name: tls
          mountPath: /openbao/tls
          readOnly: true
        - name: client-tls
          mountPath: /openbao/client-tls
          readOnly: true

    injector:
      enabled: false  # ESO handles secret distribution, not the injector
```

::: info CC-0107 — mTLS admission gate
The listener does not just terminate server TLS; it **requires and verifies a client certificate** (`tls_require_and_verify_client_cert = true`). Server and client certs share a dedicated CA trust domain provisioned by `deploy/flux-system/infrastructure/openbao-ca-issuer.yaml` (a cert-manager `ClusterIssuer`) and `openbao-client-tls-cert.yaml` (the `openbao-client-tls` and `eso-openbao-client-tls` client certs). ESO authenticates with `eso-openbao-client-tls` **on top of** Kubernetes auth — so a leaked Kubernetes SA token alone cannot reach the OpenBao API without also presenting a CA-signed client cert. The ESO `ClusterSecretStore` (named `openbao-cluster-store`, `deploy/eso/clustersecretstore.yaml`, `path: kv-v2`, Kubernetes auth `kubernetes/management` role `eso-management`) references the client keypair via `tls.certSecretRef` / `keySecretRef`. The keystone-operator gates `SecretsReady` on this store reporting Ready before reading any ESO Secret (CC-0047).
:::

## Initialization and Unseal

After deployment, OpenBao must be initialized and unsealed. In forge the init/unseal logic exists in two forms: `deploy/openbao/bootstrap/init-unseal.sh` targets the HA, 3-replica production cluster, while `hack/deploy-infra.sh` re-implements an equivalent inline (`openbao_init_unseal`) for the single-replica kind cluster (the production script hardcodes 3 replicas). Both initialize with 5 key shares / threshold 3 and **persist the init output (unseal keys + root token) base64-encoded into a Kubernetes Secret `openbao-init-keys` in `openbao-system`** so pods can be re-unsealed on restart. After unsealing, `deploy-infra.sh` drives only the four configuration scripts — `setup-secret-engines.sh`, `setup-auth.sh`, `setup-policies.sh`, and `write-bootstrap-secrets.sh` (it does **not** invoke `init-unseal.sh` itself). The `kubectl exec` commands below are the conceptual equivalent.

> **Security posture.** Storing the unseal material in a cluster Secret is a deliberate bootstrap/dev convenience (a known interim posture, `TODO(CC-0009)`). The production hardening target is offline / HSM custody or auto-unseal (see below).

### Phase 0: Initialize

```bash
# Initialize with 5 key shares, 3 required for unseal
kubectl exec -n openbao-system openbao-0 -- bao operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > init-keys.json

# In forge, init-unseal.sh stores this output in the openbao-init-keys Secret.
# Production hardening: keep it offline / in an HSM, or use auto-unseal instead.
```

### Phase 0: Unseal

Each OpenBao pod must be unsealed with 3 of the 5 key shares:

```bash
# Unseal each pod (repeat for openbao-0, openbao-1, openbao-2)
for i in 0 1 2; do
  kubectl exec -n openbao-system openbao-$i -- bao operator unseal <key-share-1>
  kubectl exec -n openbao-system openbao-$i -- bao operator unseal <key-share-2>
  kubectl exec -n openbao-system openbao-$i -- bao operator unseal <key-share-3>
done
```

### Auto-Unseal (Production)

For production environments, configure auto-unseal using a Transit secret engine from another OpenBao instance or a cloud KMS. Add the following `seal` stanza to the Raft config in the HelmRelease values:

```hcl
seal "transit" {
  address         = "https://transit-openbao.example.com:8200"
  token           = "<transit-token>"
  disable_renewal = false
  key_name        = "autounseal"
  mount_path      = "transit/"
}
```

## Secret Engines

Configure the secret engines used by CobaltCore:

### KV v2 Secret Engine

```bash
# Enable KV v2 at the standard mount path
bao secrets enable -path=kv-v2 -version=2 kv

# Verify
bao secrets list
```

### PKI Secret Engine

> **Current vs planned:** forge enables the PKI engine and tunes `max-lease-ttl` in `setup-secret-engines.sh`, but does **not** yet run `pki/root/generate/internal`, `pki/config/urls`, or create PKI roles. Those steps below are production guidance / planned.

```bash
# Enable PKI for internal TLS certificates
bao secrets enable -path=pki pki

# Configure maximum TTL (10 years for root CA)
bao secrets tune -max-lease-ttl=87600h pki

# Generate internal root CA
bao write pki/root/generate/internal \
  common_name="CobaltCore Internal CA" \
  ttl=87600h

# Configure CA and CRL URLs
bao write pki/config/urls \
  issuing_certificates="https://openbao.openbao-system.svc:8200/v1/pki/ca" \
  crl_distribution_points="https://openbao.openbao-system.svc:8200/v1/pki/crl"

# Create a role for OpenStack internal certificates
bao write pki/roles/openstack-internal \
  allowed_domains="openstack.svc.cluster.local,openstack.svc" \
  allow_subdomains=true \
  max_ttl=720h
```

### Database Secret Engine (planned / optional)

> **Status: not implemented.** Forge enables only the KV-v2 and PKI engines (`deploy/openbao/bootstrap/setup-secret-engines.sh`); credentials are static KV-v2 entries. The dynamic-credential design below is retained as a future option.

For dynamic database credentials (alternative to static KV v2 credentials):

```bash
# Enable database engine
bao secrets enable -path=database/mariadb database

# Configure MariaDB connection
bao write database/mariadb/config/openstack-db \
  plugin_name=mysql-database-plugin \
  connection_url="{{username}}:{{password}}@tcp(maxscale.mariadb-system.svc:3306)/" \
  allowed_roles="nova-rw,neutron-rw,keystone-rw,glance-rw,cinder-rw" \
  username="root" \
  password="<root-password>"

# Create a role for dynamic Nova DB credentials
bao write database/mariadb/roles/nova-rw \
  db_name=openstack-db \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT ALL PRIVILEGES ON nova.* TO '{{name}}'@'%';" \
  default_ttl=1h \
  max_ttl=24h
```

## Auth Methods

### Kubernetes Auth (Per Cluster)

Each cluster in the 4-cluster topology gets its own Kubernetes auth mount.

> **Current state (single-cluster kind deploy):** `deploy/openbao/bootstrap/setup-auth.sh` fully configures only the `kubernetes/management` mount (`kubernetes_host="https://kubernetes.default.svc"`, role `eso-management`). The `control-plane`, `hypervisor`, and `storage` roles are pre-created but their `config` is deferred until those clusters exist. The multi-cluster example below is the planned target.

```bash
# Enable Kubernetes auth for each cluster
for cluster in management control-plane hypervisor storage; do
  bao auth enable -path=kubernetes/$cluster kubernetes
done

# Configure each mount with the cluster's API server and CA
# Example: Control Plane cluster
bao write auth/kubernetes/control-plane/config \
  kubernetes_host="https://api.control-plane.example.com:6443" \
  kubernetes_ca_cert=@/tmp/control-plane-ca.pem

# Create a role for ESO in the Control Plane cluster
bao write auth/kubernetes/control-plane/role/eso-control-plane \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=eso-control-plane \
  ttl=1h
```

### AppRole Auth (CI/CD)

```bash
# Enable AppRole for CI/CD pipelines
bao auth enable -path=approle approle

# Create a role for the provisioner pipeline
bao write auth/approle/role/provisioner \
  token_policies=ci-cd-provisioner \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=8760h
```

## Policies

### ESO Control Plane Policy

```hcl
# eso-control-plane.hcl
# ESO in the Control Plane cluster can read all OpenStack and infrastructure secrets

path "kv-v2/data/bootstrap/*" {
  capabilities = ["read"]
}

path "kv-v2/data/openstack/*" {
  capabilities = ["read"]
}

path "kv-v2/data/infrastructure/*" {
  capabilities = ["read"]
}

path "kv-v2/data/ceph/*" {
  capabilities = ["read"]
}
```

### ESO Hypervisor Policy

```hcl
# eso-hypervisor.hcl
# ESO in the Hypervisor cluster can only read Ceph keys and Nova compute config

path "kv-v2/data/ceph/client-nova" {
  capabilities = ["read"]
}

path "kv-v2/data/openstack/nova/compute-*" {
  capabilities = ["read"]
}
```

### ESO Storage Policy

```hcl
# eso-storage.hcl
# ESO in the Storage cluster can read and write Ceph keys

path "kv-v2/data/ceph/*" {
  capabilities = ["read", "create", "update"]
}
```

### ESO Management Policy

```hcl
# eso-management.hcl
# ESO in the Management cluster reads bootstrap and infrastructure secrets.
# Stays READ-ONLY by design; write access for key backups is a separate
# policy (push-keystone-keys.hcl) bound alongside this one (CC-0083).

path "kv-v2/data/bootstrap/*" {
  capabilities = ["read"]
}

path "kv-v2/data/infrastructure/*" {
  capabilities = ["read"]
}

# Required so the keystone-db ExternalSecret can read kv-v2/openstack/keystone/db.
# Scoped to keystone/* (not openstack/*) for least privilege (CC-0009).
path "kv-v2/data/openstack/keystone/*" {
  capabilities = ["read"]
}
```

### PushSecret Policies

```hcl
# push-ceph-keys.hcl
# Allows PushSecret CRs to write Ceph keys back to OpenBao

path "kv-v2/data/ceph/*" {
  capabilities = ["create", "update", "read"]
}

# push-app-credentials.hcl
# Allows PushSecret CRs to write per-service Application Credentials back to OpenBao.
# The <service> segment is operator-generated.

path "kv-v2/data/openstack/*/app-credential" {
  capabilities = ["create", "update", "read"]
}
```

::: info Planned: per-pod service-user policy
A `push-pod-users.hcl` granting writes to `kv-v2/data/openstack/+/pods/+/user` (per-pod service-user passwords) is part of the planned per-pod service-user model (per-pod Keystone service users via K-ORC, issue [#30](https://github.com/C5C3/C5C3/issues/30)) and is **not yet present** in the deployed policy set.
:::

### Push Keystone Keys Policy

The keystone-operator backs up rotated Fernet and credential keys via PushSecret. A separate, narrowly-scoped policy (kept distinct from the read-only `eso-management`) grants this — over **per-CR** paths (`{name}` segment, CC-0093) and over both the `data` and `metadata` KV-v2 endpoints (ESO stamps ownership metadata and hard-deletes on cleanup, so `delete` is required for the OpenBao finalizer, CC-0079):

```hcl
# push-keystone-keys.hcl  (bound alongside eso-management on the management role)
path "kv-v2/data/openstack/keystone/+/fernet-keys" {
  capabilities = ["create", "update", "read", "delete"]
}
path "kv-v2/metadata/openstack/keystone/+/fernet-keys" {
  capabilities = ["create", "update", "read", "delete"]
}
path "kv-v2/data/openstack/keystone/+/credential-keys" {
  capabilities = ["create", "update", "read", "delete"]
}
path "kv-v2/metadata/openstack/keystone/+/credential-keys" {
  capabilities = ["create", "update", "read", "delete"]
}
```

The `+` single-segment glob matches the CR-name position only; it deliberately does **not** use a trailing `*`, so the read-only `kv-v2/openstack/keystone/db` MariaDB credentials remain unwritable.

### Push Keystone Admin Policy

Scheduled admin-password rotation ("Model B", CC-0109) pushes new admin passwords back to OpenBao via a PushSecret. A dedicated `push-keystone-admin.hcl` policy (bound alongside `eso-management` on the management role) grants write to the single shared bootstrap path:

```hcl
# push-keystone-admin.hcl
path "kv-v2/data/bootstrap/keystone-admin" {
  capabilities = ["create", "update", "read", "delete"]
}
path "kv-v2/metadata/bootstrap/keystone-admin" {
  capabilities = ["create", "update", "read", "delete"]
}
```

This is the same key the `keystone-admin` ExternalSecret reads; the PushSecret uses `DeletionPolicy=None` so disabling rotation never clears the live credential (see [Keystone Dependencies → Admin Credential Rotation](./05-keystone-dependencies.md#admin-credential-rotation)).

### CI/CD Provisioner Policy

```hcl
# ci-cd-provisioner.hcl
# Full read/write access for initial secret provisioning

path "kv-v2/data/*" {
  capabilities = ["create", "update", "read"]
}

path "kv-v2/metadata/*" {
  capabilities = ["read", "list"]
}
```

### PKI Issuer Policy

```hcl
# pki-issuer.hcl
# cert-manager can issue certificates via the PKI engine

path "pki/issue/*" {
  capabilities = ["create", "update"]
}

path "pki/sign/*" {
  capabilities = ["create", "update"]
}
```

### Apply Policies

```bash
# Apply all policies (deploy/openbao/policies/*.hcl, applied by setup-policies.sh
# where the policy name is derived from the filename). The script globs the .hcl
# files and pipes each one to `bao policy write <name> -` via stdin.
for policy in ci-cd-provisioner eso-control-plane eso-hypervisor eso-management eso-storage \
              pki-issuer push-app-credentials push-ceph-keys push-keystone-admin push-keystone-keys; do
  bao policy write $policy - < /path/to/policies/$policy.hcl
done
```

## Bootstrap Sequence

The following steps must be executed in order after OpenBao is initialized and unsealed. This corresponds to Phases 0-1 of the [bootstrap sequence](../05-deployment/02-secret-management.md#bootstrap-sequence).

### Phase 0: Secret Engine and Auth Setup

```bash
# 1. Enable secret engines
bao secrets enable -path=kv-v2 -version=2 kv
bao secrets enable -path=pki pki

# 2. Enable auth methods
for cluster in management control-plane hypervisor storage; do
  bao auth enable -path=kubernetes/$cluster kubernetes
done
bao auth enable -path=approle approle

# 3. Apply policies
# (see above)

# 4. Configure Kubernetes auth for each cluster
# (see above)

# 5. Configure AppRole for CI/CD
# (see above)
```

### Phase 1: Write Bootstrap Secrets

> **Implemented vs planned.** `deploy/openbao/bootstrap/write-bootstrap-secrets.sh` currently writes the Keystone-first set — `bootstrap/keystone-admin`, `infrastructure/mariadb`, and `openstack/keystone/db` — and additionally seeds `openstack/keystone/admin/app-credential` with a password-based bootstrap `clouds.yaml` for K-ORC (CC-0110), breaking the chicken-and-egg of the admin application credential. It generates random values **in-pod** via OpenBao's `sys/tools/random` (an `@generate` marker), so cleartext never appears in process arguments, and runs `mark_eso_managed` to stamp `custom_metadata: managed-by=external-secrets` on the ESO-owned paths so the c5c3-operator / Model-B PushSecrets can later overwrite the seeded values. The fuller multi-service secret set below is planned and uses host-side `openssl` only for illustration.

```bash
# Keystone admin password
bao kv put kv-v2/bootstrap/keystone-admin \
  password="$(openssl rand -base64 32)"

# Service passwords (for initial MariaDB user creation)
bao kv put kv-v2/bootstrap/service-passwords \
  keystone="$(openssl rand -base64 32)" \
  nova="$(openssl rand -base64 32)" \
  neutron="$(openssl rand -base64 32)" \
  glance="$(openssl rand -base64 32)" \
  cinder="$(openssl rand -base64 32)" \
  placement="$(openssl rand -base64 32)"

# Infrastructure credentials
bao kv put kv-v2/infrastructure/mariadb \
  root-password="$(openssl rand -base64 32)"

bao kv put kv-v2/infrastructure/rabbitmq \
  username=openstack \
  password="$(openssl rand -base64 32)"

bao kv put kv-v2/infrastructure/valkey \
  password="$(openssl rand -base64 32)"

# Per-service DB credentials
for svc in keystone nova neutron glance cinder placement; do
  bao kv put kv-v2/openstack/$svc/db \
    username=$svc \
    password="$(openssl rand -base64 32)"
done
```

After Phase 1, ESO can begin syncing secrets to Kubernetes clusters (Phase 2+). See [Secret Management — Bootstrap Sequence](../05-deployment/02-secret-management.md#bootstrap-sequence) for the complete flow.

## Operations

### Backup

OpenBao Raft snapshots can be taken for disaster recovery:

```bash
# Take a Raft snapshot
kubectl exec -n openbao-system openbao-0 -- \
  bao operator raft snapshot save /tmp/raft-snapshot.snap

# Copy snapshot out of the pod
kubectl cp openbao-system/openbao-0:/tmp/raft-snapshot.snap ./raft-snapshot.snap
```

### Monitoring

OpenBao exposes Prometheus metrics. For the general monitoring architecture, see [Observability — Metrics](../06-operations/02-observability/01-metrics.md).

> **Note:** OpenBao, as a fork of HashiCorp Vault, retains the `vault_` metric name prefix for compatibility with existing dashboards and alerting rules.

::: info Planned
A dedicated OpenBao `ServiceMonitor` (and its `openbao-metrics-token` Secret) is **not yet part of `deploy/`** — only the keystone-operator and infrastructure ServiceMonitors are deployed today. The manifest below is illustrative of the intended scrape configuration.
:::

```yaml
# ServiceMonitor for Prometheus Operator (planned)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: openbao
  namespace: openbao-system
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: openbao
  endpoints:
    - port: http
      path: /v1/sys/metrics
      params:
        format: ["prometheus"]
      bearerTokenSecret:
        name: openbao-metrics-token
        key: token
```

Key metrics to monitor:

| Metric | Description | Alert Threshold |
| --- | --- | --- |
| `vault_core_unsealed` | Seal status (1 = unsealed) | Alert if 0 |
| `vault_raft_leader` | Raft leader status | Alert if no leader |
| `vault_raft_peers` | Number of Raft peers | Alert if < 3 |
| `vault_secret_kv_count` | Number of KV secrets | Informational |
| `vault_token_count` | Active token count | Alert if abnormally high |

### Secret Rotation

KV v2 secrets support versioning. When a secret is updated, the old version is retained:

```bash
# Write a new version of a secret
bao kv put kv-v2/openstack/nova/db \
  username=nova \
  password="$(openssl rand -base64 32)"

# View version history
bao kv metadata get kv-v2/openstack/nova/db

# Roll back to a previous version
bao kv rollback -version=1 kv-v2/openstack/nova/db
```

ESO detects the version change on its next `refreshInterval` and updates the target Kubernetes Secret.
