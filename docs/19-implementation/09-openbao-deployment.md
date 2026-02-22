# OpenBao Deployment

This page documents the deployment, initialization, and configuration of OpenBao as the central secret store for CobaltCore. For the architectural overview of secret management, see [Secret Management](../13-secret-management.md). For the credential lifecycle, see [Credential Lifecycle](../11-gitops-fluxcd/01-credential-lifecycle.md).

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
  chart:
    spec:
      chart: openbao
      version: ">=0.5.0"
      sourceRef:
        kind: HelmRepository
        name: openbao
        namespace: flux-system
  values:
    server:
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
            }

            storage "raft" {
              path = "/openbao/data"
              retry_join {
                leader_api_addr = "https://openbao-0.openbao-internal:8200"
              }
              retry_join {
                leader_api_addr = "https://openbao-1.openbao-internal:8200"
              }
              retry_join {
                leader_api_addr = "https://openbao-2.openbao-internal:8200"
              }
            }

            service_registration "kubernetes" {}

      dataStorage:
        enabled: true
        size: 10Gi
        storageClass: local-path

      resources:
        requests:
          memory: 256Mi
          cpu: 250m
        limits:
          memory: 512Mi

      # TLS via cert-manager
      volumes:
        - name: tls
          secret:
            secretName: openbao-tls
      volumeMounts:
        - name: tls
          mountPath: /openbao/tls
          readOnly: true

    injector:
      enabled: false  # ESO handles secret distribution, not the injector
```

## Initialization and Unseal

After deployment, OpenBao must be initialized and unsealed. This is a one-time operation.

### Phase 0: Initialize

```bash
# Initialize with 5 key shares, 3 required for unseal
kubectl exec -n openbao-system openbao-0 -- bao operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > init-keys.json

# CRITICAL: Store init-keys.json securely (offline, HSM, or split across operators)
# It contains the unseal keys and the initial root token
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

### Database Secret Engine (Optional)

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

Each cluster in the 4-cluster topology gets its own Kubernetes auth mount:

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
bao auth enable -path=approle/ci-cd approle

# Create a role for the provisioner pipeline
bao write auth/approle/ci-cd/role/provisioner \
  token_policies=ci-cd-provisioner \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=0
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
# ESO in the Management cluster reads bootstrap and infrastructure secrets

path "kv-v2/data/bootstrap/*" {
  capabilities = ["read"]
}

path "kv-v2/data/infrastructure/*" {
  capabilities = ["read"]
}
```

### PushSecret Policies

```hcl
# push-ceph-keys.hcl
# Allows PushSecret CRs to write Ceph keys back to OpenBao

path "kv-v2/data/ceph/*" {
  capabilities = ["create", "update"]
}

# push-app-credentials.hcl
# Allows PushSecret CRs to write Application Credentials back to OpenBao

path "kv-v2/data/openstack/*/app-credential" {
  capabilities = ["create", "update"]
}
```

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
# Apply all policies
for policy in eso-control-plane eso-hypervisor eso-storage eso-management \
              push-ceph-keys push-app-credentials ci-cd-provisioner pki-issuer; do
  bao policy write $policy /path/to/policies/$policy.hcl
done
```

## Bootstrap Sequence

The following steps must be executed in order after OpenBao is initialized and unsealed. This corresponds to Phases 0-1 of the [bootstrap sequence](../13-secret-management.md#bootstrap-sequence).

### Phase 0: Secret Engine and Auth Setup

```bash
# 1. Enable secret engines
bao secrets enable -path=kv-v2 -version=2 kv
bao secrets enable -path=pki pki

# 2. Enable auth methods
for cluster in management control-plane hypervisor storage; do
  bao auth enable -path=kubernetes/$cluster kubernetes
done
bao auth enable -path=approle/ci-cd approle

# 3. Apply policies
# (see above)

# 4. Configure Kubernetes auth for each cluster
# (see above)

# 5. Configure AppRole for CI/CD
# (see above)
```

### Phase 1: Write Bootstrap Secrets

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

After Phase 1, ESO can begin syncing secrets to Kubernetes clusters (Phase 2+). See [Secret Management — Bootstrap Sequence](../13-secret-management.md#bootstrap-sequence) for the complete flow.

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

OpenBao exposes Prometheus metrics. For the general monitoring architecture, see [Observability — Metrics](../15-observability/01-metrics.md).

> **Note:** OpenBao, as a fork of HashiCorp Vault, retains the `vault_` metric name prefix for compatibility with existing dashboards and alerting rules.

```yaml
# ServiceMonitor for Prometheus Operator
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
