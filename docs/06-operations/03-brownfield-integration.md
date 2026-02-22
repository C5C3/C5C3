# Brownfield Integration

## Overview

A **brownfield** environment in the C5C3 context is an existing OpenStack deployment that was not provisioned by CobaltCore — it has its own Keystone, service users, endpoints, and possibly a full set of running OpenStack services (Nova, Neutron, Glance, Cinder, Placement).
Brownfield integration allows you to connect CobaltCore's credential management infrastructure (K-ORC + OpenBao + ESO) to such an environment. For details on the underlying secret management architecture, see [Secret Management](../05-deployment/02-secret-management.md).

> **Scope:** This document currently covers brownfield integration of Keystone and K-ORC only. Additional topics (e.g. networking, storage, monitoring) will be added in future revisions.

Two scenarios are supported:

| Scenario | Goal | Deploys CobaltCore Services? |
| --- | --- | --- |
| **A: Credential Bridge** | Provision and rotate Application Credentials for an existing brownfield OpenStack | No — only credential management |
| **B: Full Migration** | Gradually migrate from brownfield to a fully CobaltCore-managed OpenStack | Yes — phased per-service migration |

**Prerequisites:**

* A Kubernetes cluster with the c5c3-operator, K-ORC, OpenBao, and ESO deployed
* Network connectivity from the Kubernetes cluster to the brownfield Keystone endpoint
* Admin credentials (username + password) for the brownfield Keystone
* Brownfield OpenStack services use standard Keystone authentication (`[keystone_authtoken]`)

## Architecture

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    BROWNFIELD INTEGRATION ARCHITECTURE                        │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  KUBERNETES CLUSTER                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                         │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │  │
│  │  │  c5c3-       │  │    K-ORC     │  │   OpenBao    │                   │  │
│  │  │  operator    │  │  (orc-system)│  │ (openbao-    │                   │  │
│  │  │              │  │              │  │  system)     │                   │  │
│  │  │ Creates CRs  │──▶ Reconciles   │  │              │                   │  │
│  │  │ for K-ORC    │  │ against      │  │ Stores       │                   │  │
│  │  │              │  │ Keystone     │  │ credentials  │                   │  │
│  │  └──────────────┘  └──────┬───────┘  └──────▲───────┘                   │  │
│  │                           │                 │                           │  │
│  │                           │ Gophercloud     │ PushSecret                │  │
│  │                           │ SDK             │                           │  │
│  │  ┌──────────────┐         │          ┌──────┴───────┐                   │  │
│  │  │     ESO      │         │          │  PushSecret  │                   │  │
│  │  │              │◀────────┼──────────│  (per svc)   │                   │  │
│  │  │ Creates K8s  │  ExternalSecret    └──────────────┘                   │  │
│  │  │ Secrets from │         │                                             │  │
│  │  │ OpenBao      │         │                                             │  │
│  │  └──────────────┘         │                                             │  │
│  │                           │                                             │  │
│  └───────────────────────────┼─────────────────────────────────────────────┘  │
│                              │                                                │
│                              │ HTTPS (Keystone API)                           │
│                              ▼                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                    BROWNFIELD OPENSTACK                                 │  │
│  │                                                                         │  │
│  │  Keystone ─── Nova ─── Neutron ─── Glance ─── Cinder ─── Placement      │  │
│  │                                                                         │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Greenfield vs. Brownfield:**

| Aspect | Greenfield (CobaltCore) | Brownfield Integration |
| --- | --- | --- |
| Keystone | Deployed by CobaltCore | Pre-existing, external |
| Service Users | Created by c5c3-operator via K-ORC | Imported via `managementPolicy: unmanaged` |
| Application Credentials | Created by K-ORC (managed) | Created by K-ORC (managed), referencing imported users |
| OpenBao Path | `kv-v2/openstack/<service>/` | `kv-v2/brownfield/<service>/` |
| Bootstrap | Keystone Bootstrap Job | Not needed — Keystone already running |
| Infrastructure (DB, MQ) | MariaDB, RabbitMQ, Valkey Operators | Not needed (Scenario A) / deployed later (Scenario B) |

## Scenario A: Credential Bridge

The Credential Bridge connects K-ORC to an existing brownfield Keystone to create and manage Application Credentials — without deploying any OpenStack services. This is useful for:

* Replacing static password-based `[keystone_authtoken]` with rotatable Application Credentials
* Centralizing credential management in OpenBao for an existing deployment
* Preparing for a future full migration (Scenario B)

### Step 1: K-ORC clouds.yaml for Brownfield Keystone

First, store the brownfield admin credentials in OpenBao and distribute them to K-ORC via ESO. This follows the same pattern as the [greenfield bootstrap](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#bootstrap-problem-and-solution-architecture), but points at the external Keystone.

**Store initial credentials in OpenBao:**

```yaml
# OpenBao path: kv-v2/brownfield/k-orc/credentials
# Store via CLI or CI/CD pipeline:
# bao kv put kv-v2/brownfield/k-orc/credentials clouds.yaml=@clouds.yaml
#
# clouds.yaml content:
clouds:
  brownfield:
    auth_type: password
    auth:
      auth_url: https://keystone.brownfield.example.com:5000/v3
      username: admin
      password: "<admin-password>"
      project_name: admin
      user_domain_name: Default
      project_domain_name: Default
    region_name: RegionOne
```

> **Note:** The plaintext password in `clouds.yaml` is only required during the initial bootstrap. After Step 3, K-ORC transitions to Application Credential authentication, and the password-based `clouds.yaml` can be replaced.

**ExternalSecret to provide clouds.yaml to K-ORC:**

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: brownfield-k-orc-clouds-yaml
  namespace: orc-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-cluster-store
    kind: ClusterSecretStore
  target:
    name: brownfield-k-orc-clouds-yaml
    creationPolicy: Owner  # ESO owns the lifecycle of this Secret
  data:
    - secretKey: clouds.yaml
      remoteRef:
        key: kv-v2/data/brownfield/k-orc/credentials
        property: clouds.yaml
```

> **Note:** The initial `clouds.yaml` uses password authentication. After Step 3, you can transition K-ORC itself to Application Credential auth — the same chicken-and-egg pattern used in the [greenfield bootstrap](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#k-orc-credential-flow).

### Step 2: Import Existing Keystone Resources (unmanaged)

K-ORC's `managementPolicy: unmanaged` imports existing OpenStack resources as **read-only**. K-ORC does not modify or delete these resources — it only reads their current state via Keystone API filters (name, tags, ID).
This is the same mechanism used in the [greenfield bootstrap](../03-components/01-control-plane.md#openstack-resource-controller-k-orc) to import resources created by the Keystone Bootstrap Job.

Import the brownfield Keystone resources that K-ORC needs to reference when creating Application Credentials:

**Import Domain:**

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Domain
metadata:
  name: brownfield-default-domain
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: Default
```

**Import Service Project:**

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Project
metadata:
  name: brownfield-service-project
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: service
```

**Import Roles:**

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Role
metadata:
  name: brownfield-admin-role
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: admin

---
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Role
metadata:
  name: brownfield-service-role
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: service
```

**Import Service Users:**

Import each existing service user that should receive an Application Credential:

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: brownfield-nova-user
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: nova

---
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: brownfield-glance-user
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: glance

---
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: brownfield-neutron-user
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: neutron

---
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: brownfield-cinder-user
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: cinder

---
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: brownfield-placement-user
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: placement
```

**Verify imports:**

```bash
kubectl get domains,projects,roles,users -n openstack -l app.kubernetes.io/part-of=brownfield
```

All imported resources should show `status.conditions` with `type: Available, status: "True"` once K-ORC has confirmed their existence in the brownfield Keystone.

### Step 3: Create Application Credentials

With the brownfield resources imported, K-ORC can create **managed** Application Credentials that reference the **unmanaged** (imported) users. This is the same pattern used in the [greenfield credential lifecycle](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#application-credential-distribution-to-service-operators), but referencing `brownfield-*` user CRs.

```yaml
# Nova Application Credential
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: ApplicationCredential
metadata:
  name: brownfield-nova-app-credential
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  resource:
    name: brownfield-nova-app-credential
    description: "Nova service authentication (brownfield)"
    userRef:
      name: brownfield-nova-user  # References imported (unmanaged) user
    roles:
      - name: admin
      - name: service

---
# Glance Application Credential
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: ApplicationCredential
metadata:
  name: brownfield-glance-app-credential
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  resource:
    name: brownfield-glance-app-credential
    description: "Glance service authentication (brownfield)"
    userRef:
      name: brownfield-glance-user
    roles:
      - name: admin
      - name: service

---
# Neutron Application Credential
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: ApplicationCredential
metadata:
  name: brownfield-neutron-app-credential
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  resource:
    name: brownfield-neutron-app-credential
    description: "Neutron service authentication (brownfield)"
    userRef:
      name: brownfield-neutron-user
    roles:
      - name: admin
      - name: service

---
# Cinder Application Credential
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: ApplicationCredential
metadata:
  name: brownfield-cinder-app-credential
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  resource:
    name: brownfield-cinder-app-credential
    description: "Cinder service authentication (brownfield)"
    userRef:
      name: brownfield-cinder-user
    roles:
      - name: admin
      - name: service

---
# Placement Application Credential
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: ApplicationCredential
metadata:
  name: brownfield-placement-app-credential
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  resource:
    name: brownfield-placement-app-credential
    description: "Placement service authentication (brownfield)"
    userRef:
      name: brownfield-placement-user
    roles:
      - name: admin
      - name: service
```

K-ORC reconciles each `ApplicationCredential` CR against the brownfield Keystone, creates the credential, and writes the result (credential ID + secret) to a Kubernetes Secret in the `openstack` namespace.

### Step 4: Distribute via OpenBao + ESO

The generated Application Credentials are pushed to OpenBao via PushSecrets and then distributed via ExternalSecrets — using a dedicated `kv-v2/brownfield/` path namespace to separate brownfield credentials from greenfield CobaltCore credentials.

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│        BROWNFIELD CREDENTIAL DISTRIBUTION (K-ORC → OpenBao → Consumer)       │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  K-ORC writes K8s Secrets:                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  brownfield-nova-app-credential      (namespace: openstack)             │  │
│  │  brownfield-glance-app-credential    (namespace: openstack)             │  │
│  │  brownfield-neutron-app-credential   (namespace: openstack)             │  │
│  │  brownfield-cinder-app-credential    (namespace: openstack)             │  │
│  │  brownfield-placement-app-credential (namespace: openstack)             │  │
│  └──────────────────────────────────────────┬──────────────────────────────┘  │
│                                             │                                 │
│                                             │ PushSecret                      │
│                                             ▼                                 │
│  OpenBao:                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  kv-v2/brownfield/nova/app-credential                                   │  │
│  │  kv-v2/brownfield/glance/app-credential                                 │  │
│  │  kv-v2/brownfield/neutron/app-credential                                │  │
│  │  kv-v2/brownfield/cinder/app-credential                                 │  │
│  │  kv-v2/brownfield/placement/app-credential                              │  │
│  └──────────────────────────────────────────┬──────────────────────────────┘  │
│                                             │                                 │
│                                             │ ExternalSecret                  │
│                                             ▼                                 │
│  K8s Secrets (for brownfield consumers):                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  brownfield-nova-keystone-credentials      (namespace: openstack)       │  │
│  │  brownfield-glance-keystone-credentials    (namespace: openstack)       │  │
│  │  brownfield-neutron-keystone-credentials   (namespace: openstack)       │  │
│  │  brownfield-cinder-keystone-credentials    (namespace: openstack)       │  │
│  │  brownfield-placement-keystone-credentials (namespace: openstack)       │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

**PushSecret (example: Nova):**

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: brownfield-nova-app-credential
  namespace: openstack
spec:
  secretStoreRefs:
    - name: openbao-cluster-store
      kind: ClusterSecretStore
  selector:
    secret:
      name: brownfield-nova-app-credential  # Written by K-ORC
  data:
    - match:
        secretKey: clouds.yaml
        remoteRef:
          remoteKey: kv-v2/data/brownfield/nova/app-credential
          property: clouds.yaml
```

**ExternalSecret (example: Nova):**

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: brownfield-nova-keystone-credentials
  namespace: openstack
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-cluster-store
    kind: ClusterSecretStore
  target:
    name: brownfield-nova-keystone-credentials
    creationPolicy: Owner
  data:
    - secretKey: application_credential_id
      remoteRef:
        key: kv-v2/data/brownfield/nova/app-credential
        property: application_credential_id
    - secretKey: application_credential_secret
      remoteRef:
        key: kv-v2/data/brownfield/nova/app-credential
        property: application_credential_secret
```

Repeat the PushSecret + ExternalSecret pair for each service (Glance, Neutron, Cinder, Placement), adjusting the names and OpenBao paths accordingly.

The resulting Kubernetes Secrets can then be consumed by the brownfield services — for example, by mounting them into the service configuration or by using them in a configuration management tool that updates the brownfield `[keystone_authtoken]` sections.

### Step 5: Credential Rotation

Application Credentials created via K-ORC can be automatically rotated using the `CredentialRotation` CRD. This works identically to the [greenfield rotation](../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#credential-rotation):

```yaml
apiVersion: c5c3.io/v1alpha1
kind: CredentialRotation
metadata:
  name: brownfield-nova-rotation
  namespace: openstack
spec:
  targetServiceUser: brownfield-nova-user
  rotationType: applicationCredential
  schedule:
    intervalDays: 90
    preRotationDays: 7
  gracePeriodDays: 1
```

The rotation creates a new Application Credential before the old one expires, pushes it through the OpenBao + ESO pipeline, and deletes the old credential after the grace period. Brownfield services consuming the ExternalSecret-backed Kubernetes Secrets receive updated credentials automatically via ESO's `refreshInterval`.

### Step 6: Consuming Credentials in Non-Kubernetes Brownfield Deployments

If the brownfield OpenStack runs outside of Kubernetes (e.g. deployed via Kolla-Ansible or OpenStack-Ansible), the credentials stored in OpenBao need to be delivered directly to the hosts. The following examples show two approaches.

#### Option A: OpenBao Agent on Kolla Hosts

An OpenBao Agent runs as a systemd service on each Kolla host, authenticates against OpenBao via AppRole, and renders credential templates directly on the host. When credentials are rotated, the agent detects the change and restarts the affected Kolla container.

**AppRole authentication (one-time setup per host):**

```bash
# On the OpenBao server: create a role for the host
bao write auth/approle/role/kolla-nova \
  token_policies="brownfield-nova-read" \
  token_ttl=1h \
  token_max_ttl=4h

# Retrieve role_id and secret_id for the host
bao read auth/approle/role/kolla-nova/role-id
bao write -f auth/approle/role/kolla-nova/secret-id
```

**OpenBao Agent configuration (`/etc/openbao/agent.hcl`):**

```hcl
vault {
  address = "https://openbao.example.com:8200"
}

auto_auth {
  method "approle" {
    config = {
      role_id_file_path   = "/etc/openbao/role-id"
      secret_id_file_path = "/etc/openbao/secret-id"
    }
  }

  sink "file" {
    config = {
      path = "/etc/openbao/token"
    }
  }
}

template {
  source      = "/etc/openbao/templates/nova-credentials.ctmpl"
  destination = "/etc/openbao/data/nova-credentials.env"
  command     = "/usr/local/bin/apply-nova-credentials.sh"
}
```

The agent renders the credentials to a simple env file. A separate script then applies them to the existing Kolla-managed `nova.conf` using `crudini`.

**Template (`/etc/openbao/templates/nova-credentials.ctmpl`):**

```text
{{ with secret "kv-v2/data/brownfield/nova/app-credential" }}
APPLICATION_CREDENTIAL_ID={{ .Data.data.application_credential_id }}
APPLICATION_CREDENTIAL_SECRET={{ .Data.data.application_credential_secret }}
{{ end }}
```

**Apply script (`/usr/local/bin/apply-nova-credentials.sh`):**

```bash
#!/usr/bin/env bash
set -euo pipefail

source /etc/openbao/data/nova-credentials.env

NOVA_CONF="/etc/kolla/nova-api/nova.conf"

crudini --set "$NOVA_CONF" keystone_authtoken auth_type v3applicationcredential
crudini --set "$NOVA_CONF" keystone_authtoken application_credential_id "$APPLICATION_CREDENTIAL_ID"
crudini --set "$NOVA_CONF" keystone_authtoken application_credential_secret "$APPLICATION_CREDENTIAL_SECRET"

docker restart nova_api
```

**systemd unit (`/etc/systemd/system/openbao-agent.service`):**

```ini
[Unit]
Description=OpenBao Agent
After=network-online.target

[Service]
ExecStart=/usr/local/bin/bao agent -config=/etc/openbao/agent.hcl
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

When K-ORC rotates the Application Credential, the new value propagates through OpenBao. The agent detects the change, re-renders the env file, and executes the apply script which updates the existing `nova.conf` in place and restarts the container.

#### Option B: Pull-based Script with systemd Timer

A lightweight alternative without the OpenBao Agent: a shell script fetches credentials from the OpenBao API on a schedule and restarts affected containers if the credentials have changed.

**Fetch script (`/usr/local/bin/update-nova-credentials.sh`):**

```bash
#!/usr/bin/env bash
set -euo pipefail

OPENBAO_ADDR="https://openbao.example.com:8200"
OPENBAO_TOKEN_FILE="/etc/openbao/token"
SECRET_PATH="kv-v2/data/brownfield/nova/app-credential"
NOVA_CONF="/etc/kolla/nova-api/nova.conf"

TOKEN=$(cat "$OPENBAO_TOKEN_FILE")

RESPONSE=$(curl -sf \
  -H "X-Vault-Token: ${TOKEN}" \
  "${OPENBAO_ADDR}/v1/${SECRET_PATH}")

APP_CRED_ID=$(echo "$RESPONSE" | jq -r '.data.data.application_credential_id')
APP_CRED_SECRET=$(echo "$RESPONSE" | jq -r '.data.data.application_credential_secret')

# Only update and restart if credentials changed
CURRENT_ID=$(crudini --get "$NOVA_CONF" keystone_authtoken application_credential_id 2>/dev/null || true)
if [ "$CURRENT_ID" = "$APP_CRED_ID" ]; then
  exit 0
fi

crudini --set "$NOVA_CONF" keystone_authtoken auth_type v3applicationcredential
crudini --set "$NOVA_CONF" keystone_authtoken application_credential_id "$APP_CRED_ID"
crudini --set "$NOVA_CONF" keystone_authtoken application_credential_secret "$APP_CRED_SECRET"

docker restart nova_api
```

**systemd timer (`/etc/systemd/system/update-nova-credentials.timer`):**

```ini
[Unit]
Description=Periodically update Nova credentials from OpenBao

[Timer]
OnBootSec=1min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
```

**systemd service (`/etc/systemd/system/update-nova-credentials.service`):**

```ini
[Unit]
Description=Update Nova credentials from OpenBao

[Service]
Type=oneshot
ExecStart=/usr/local/bin/update-nova-credentials.sh
```

Repeat the script, service, and timer for each OpenStack service on the respective hosts, adjusting the secret path and container name.

> **Recommendation:** Option A (OpenBao Agent) is preferred for production use — it reacts to credential changes immediately, handles token renewal automatically, and avoids storing long-lived tokens on disk. Option B is suitable for simpler environments or as an interim solution.

## Scenario B: Full Migration (Brownfield → CobaltCore)

A full migration gradually transitions from a brownfield OpenStack to a fully CobaltCore-managed deployment. Scenario A (Credential Bridge) serves as Phase 1.

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    MIGRATION PHASES                                           │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Phase 1              Phase 2              Phase 3              Phase 4       │
│  Credential Bridge    CobaltCore Infra     Per-Service          Decommission  │
│  (= Scenario A)       Deployment           Transition           Brownfield    │
│                                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │              │    │              │    │              │    │              │ │
│  │ Import       │    │ Deploy       │    │ Switch from  │    │ Remove       │ │
│  │ brownfield   │    │ MariaDB      │    │ unmanaged    │    │ brownfield   │ │
│  │ resources    │    │ RabbitMQ     │    │ → managed    │    │ services     │ │
│  │ into K-ORC   │───▶│ Valkey       │───▶│ per service  │───▶│              │ │
│  │              │    │ Operators    │    │              │    │ Verify       │ │
│  │ Create       │    │              │    │ Migrate data │    │ CobaltCore   │ │
│  │ AppCreds     │    │ Deploy       │    │ per service  │    │ is fully     │ │
│  │              │    │ CobaltCore   │    │              │    │ operational  │ │
│  │              │    │ Operators    │    │              │    │              │ │
│  └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘ │
│                                                                               │
│  Duration: hours      Duration: hours      Duration: days/weeks  Duration: hours│
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Credential Bridge

Complete [Scenario A](#scenario-a-credential-bridge) in full. At the end of this phase:

* All brownfield Keystone resources are imported into K-ORC (unmanaged)
* Application Credentials are created, stored in OpenBao, and distributed via ESO
* Credential rotation is configured

### Phase 2: Deploy CobaltCore Infrastructure

Deploy the CobaltCore infrastructure services alongside the brownfield environment:

* **MariaDB Operator** + MariaDB Galera Cluster
* **RabbitMQ Cluster Operator** + RabbitMQ Cluster
* **Valkey Operator** + Valkey Sentinel Cluster
* **Memcached Operator** + Memcached CR
* **CobaltCore Service Operators** (keystone-operator, nova-operator, glance-operator, neutron-operator, cinder-operator)

> **See also:** [Infrastructure Service Operators](../03-components/01-control-plane.md#infrastructure-service-operators) for deployment details and HelmRelease examples.

At this point, CobaltCore infrastructure is running but no OpenStack services are deployed through it yet.

### Phase 3: Per-Service Transition (unmanaged → managed)

Migrate services one at a time from brownfield to CobaltCore. For each service:

1. **Migrate data** (database, object storage) to CobaltCore infrastructure
2. **Switch K-ORC CRs** from `unmanaged` to `managed` for the service's Keystone resources
3. **Deploy the service** via CobaltCore service operator
4. **Update endpoints** to point at the CobaltCore-managed service
5. **Verify** service functionality
6. **Shut down** the brownfield instance of that service

**Recommended migration order:**

| Order | Service | Reason |
| --- | --- | --- |
| 1 | Keystone | Identity is the foundation — all other services depend on it |
| 2 | Glance | Image service has minimal dependencies |
| 3 | Placement | Required by Nova, no external dependencies |
| 4 | Nova | Compute service, depends on Keystone + Glance + Placement (uses brownfield Neutron until Phase 5) |
| 5 | Neutron | Network service, can coexist during transition |
| 6 | Cinder | Block storage, migrate last due to data migration complexity |

> **Note:** CobaltCore's [multi-release container image builds](../08-container-images/02-versioning.md) simplify the transition: a single C5C3 branch can produce images for both the brownfield's current OpenStack release and the target release.
> Combined with the [patching mechanism](../08-container-images/03-patching.md), this allows applying critical fixes to the brownfield release images during migration without waiting for the full transition to complete.

**Example: Transitioning a User from unmanaged → managed**

Before (imported from brownfield):

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: brownfield-glance-user
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: brownfield
    secretName: brownfield-k-orc-clouds-yaml
  managementPolicy: unmanaged
  import:
    filter:
      name: glance
```

After (fully managed by CobaltCore):

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: glance
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml  # Now uses CobaltCore's own Keystone
  managementPolicy: managed
  resource:
    name: glance
    description: "Glance service user"
    domainRef:
      name: default-domain
    defaultProjectRef:
      name: service-project
```

> **Note:** When transitioning from `unmanaged` to `managed`, delete the old `brownfield-*` CR and create a new CR with the CobaltCore naming convention. K-ORC will adopt the existing Keystone resource if the name matches. Update the corresponding Application Credential, PushSecret, and ExternalSecret to use the new CR name and the `kv-v2/openstack/` path namespace instead of `kv-v2/brownfield/`.

### Phase 4: Decommission Brownfield

After all services are running on CobaltCore:

1. Verify all CobaltCore services are healthy and functional
2. Remove the `brownfield-*` K-ORC CRs (unmanaged CRs have no finalizers — they are deleted immediately without affecting the brownfield resources)
3. Remove the `brownfield-k-orc-clouds-yaml` secret and corresponding OpenBao paths
4. Clean up `kv-v2/brownfield/` paths in OpenBao
5. Decommission the brownfield OpenStack infrastructure

## CRD Brownfield Mode

Independent of the full brownfield integration scenarios above, each service CRD supports a **brownfield mode** for individual infrastructure dependencies. Instead of referencing a managed infrastructure CR via `clusterRef`, operators can point directly at external infrastructure using explicit `host`/`port` fields:

```yaml
# Managed mode (default)
database:
  clusterRef:
    name: mariadb          # References MariaDB CR in cluster

# Brownfield mode
database:
  host: external-db.example.com
  port: 3306
```

This is useful when migrating individual infrastructure components (e.g., using an existing MariaDB cluster during a gradual migration). The two modes are mutually exclusive — setting both `clusterRef` and `host` results in a validation error.

For the full CRD design and Go type definitions, see [Shared Library — Hybrid ClusterRef](../09-implementation/02-shared-library.md) and [CRD Implementation — Validation](../09-implementation/03-crd-implementation.md).
