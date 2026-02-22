# Secret Management

## Design Principle

**ALL secrets are centrally managed via OpenBao.** OpenBao is the single source of truth for all credentials in CobaltCore — bootstrap passwords, service credentials, database credentials, Ceph keys, kubeconfigs, TLS certificates, and messaging credentials.

Integration is done via the **External Secrets Operator (ESO)**, which runs in each cluster and reads secrets from OpenBao. Existing operators continue to read Kubernetes Secrets — no code changes to operators needed. PushSecret CRDs write operator-generated secrets (Ceph Keys, Application Credentials) back to OpenBao.

## OpenBao Architecture

OpenBao runs as an HA cluster in the Management Cluster (namespace `openbao-system`):

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MANAGEMENT CLUSTER — openbao-system                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐           │
│  │  OpenBao Node 0  │  │  OpenBao Node 1  │  │  OpenBao Node 2  │           │
│  │  (Leader/Standby)│  │  (Standby)       │  │  (Standby)       │           │
│  ├──────────────────┤  ├──────────────────┤  ├──────────────────┤           │
│  │ Raft Storage     │◀─┼──────────────────┼──▶│ Raft Storage    │           │
│  │ Seal: Transit/   │  │ Raft Storage     │  │ Seal: Transit/   │           │
│  │       Auto-Unseal│  │ Seal: Transit/   │  │       Auto-Unseal│           │
│  └──────────────────┘  │       Auto-Unseal│  └──────────────────┘           │
│                        └──────────────────┘                                 │
│                                                                             │
│  Raft Consensus: 3 Replicas, integrated storage                             │
│  Listener: HTTPS (TLS) on Port 8200                                         │
│  Service: openbao.openbao-system.svc.cluster.local                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Secret Engines

| Engine   | Mount Path              | Purpose                           | Example Paths                                                                                  |
| -------- | ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| KV v2    | `kv-v2/bootstrap/`      | Bootstrap credentials             | `kv-v2/bootstrap/keystone-admin`, `kv-v2/bootstrap/service-passwords`                          |
| KV v2    | `kv-v2/openstack/`      | OpenStack service secrets         | `kv-v2/openstack/nova/db`, `kv-v2/openstack/neutron/config`                                    |
| KV v2    | `kv-v2/infrastructure/` | Infrastructure credentials        | `kv-v2/infrastructure/mariadb`, `kv-v2/infrastructure/rabbitmq`, `kv-v2/infrastructure/valkey` |
| KV v2    | `kv-v2/ceph/`           | Ceph auth keys                    | `kv-v2/ceph/client-nova`, `kv-v2/ceph/client-cinder`, `kv-v2/ceph/client-glance`               |
| PKI      | `pki/`                  | TLS certificates                  | `pki/issue/openstack-internal`, `pki/issue/api-external`                                       |
| Database | `database/mariadb/`     | Dynamic DB credentials (optional) | `database/mariadb/creds/nova-rw`, `database/mariadb/creds/neutron-rw`                          |

## Auth Methods

| Auth Method | Mount Path                 | Usage                                   | Cluster       |
| ----------- | -------------------------- | --------------------------------------- | ------------- |
| Kubernetes  | `kubernetes/management`    | ESO, FluxCD in Management Cluster       | Management    |
| Kubernetes  | `kubernetes/control-plane` | ESO in Control Plane Cluster            | Control Plane |
| Kubernetes  | `kubernetes/hypervisor`    | ESO in Hypervisor Cluster               | Hypervisor    |
| Kubernetes  | `kubernetes/storage`       | ESO in Storage Cluster                  | Storage       |
| AppRole     | `approle/ci-cd`            | CI/CD pipelines for secret provisioning | External      |

## Policies (Least Privilege)

| Role                   | Allowed Paths                                                                                          | Capabilities         |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| `eso-control-plane`    | `kv-v2/data/bootstrap/*`, `kv-v2/data/openstack/*`, `kv-v2/data/infrastructure/*`, `kv-v2/data/ceph/*` | read                 |
| `eso-hypervisor`       | `kv-v2/data/ceph/client-nova`, `kv-v2/data/openstack/nova/compute-*`                                   | read                 |
| `eso-storage`          | `kv-v2/data/ceph/*`                                                                                    | read, create, update |
| `eso-management`       | `kv-v2/data/bootstrap/*`, `kv-v2/data/infrastructure/*`                                                | read                 |
| `push-ceph-keys`       | `kv-v2/data/ceph/*`                                                                                    | create, update       |
| `push-app-credentials` | `kv-v2/data/openstack/*/app-credential`                                                                | create, update       |
| `ci-cd-provisioner`    | `kv-v2/data/*`                                                                                         | create, update, read |
| `pki-issuer`           | `pki/issue/*`                                                                                          | create, update       |

## ESO Integration

The External Secrets Operator (ESO) runs in each cluster and synchronizes secrets from OpenBao. ESO uses `ClusterSecretStore` resources (cluster-wide scope, as opposed to namespace-scoped `SecretStore`) to define the connection to OpenBao:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ESO INTEGRATION PATTERN                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Per Cluster:                                                               │
│                                                                             │
│  ┌────────────────────────┐     ┌────────────────────────┐                  │
│  │   ClusterSecretStore   │     │    ExternalSecret      │                  │
│  │   ───────────────────  │     │    ──────────────      │                  │
│  │   provider: vault      │     │    secretStoreRef:     │                  │
│  │   server: https://     │◀────│      clusterStore      │                  │
│  │     openbao.mgmt:8200  │     │    target:             │                  │
│  │   auth:                │     │      name: <k8s-sec>   │                  │
│  │     kubernetes:        │     │    data:               │                  │
│  │       mountPath: ...   │     │      - remoteRef:      │                  │
│  │       role: eso-<cls>  │     │          key: <path>   │                  │
│  └────────────────────────┘     └────────────────────────┘                  │
│                                                                             │
│  ┌────────────────────────┐                                                 │
│  │     PushSecret         │     (Return channel: K8s Secret → OpenBao)      │
│  │     ──────────         │                                                 │
│  │     selector:          │                                                 │
│  │       name: <k8s-sec>  │                                                 │
│  │     data:              │                                                 │
│  │       - match:         │                                                 │
│  │          remoteRef:    │                                                 │
│  │            remoteKey:  │                                                 │
│  │              <vaultpath>                                                 │
│  └────────────────────────┘                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Complete Secret Inventory

| Secret Type                      | OpenBao Path                               | Engine | Consumer(s)                            | Cluster       |
| -------------------------------- | ------------------------------------------ | ------ | -------------------------------------- | ------------- |
| Keystone Admin Password          | `kv-v2/bootstrap/keystone-admin`           | KV v2  | Keystone Bootstrap Job                 | Control Plane |
| Service User Passwords           | `kv-v2/bootstrap/service-passwords`        | KV v2  | c5c3-operator                          | Control Plane |
| K-ORC Service User Password      | `kv-v2/openstack/k-orc/credentials`        | KV v2  | c5c3-operator (creates Keystone User)  | Control Plane |
| MariaDB Root Credentials         | `kv-v2/infrastructure/mariadb`             | KV v2  | MariaDB Operator                       | Control Plane |
| RabbitMQ Credentials             | `kv-v2/infrastructure/rabbitmq`            | KV v2  | RabbitMQ Operator                      | Control Plane |
| Valkey Auth                      | `kv-v2/infrastructure/valkey`              | KV v2  | Valkey Operator                        | Control Plane |
| Nova DB Credentials              | `kv-v2/openstack/nova/db`                  | KV v2  | Nova API                               | Control Plane |
| Neutron DB Credentials           | `kv-v2/openstack/neutron/db`               | KV v2  | Neutron API                            | Control Plane |
| Glance DB Credentials            | `kv-v2/openstack/glance/db`                | KV v2  | Glance API                             | Control Plane |
| Cinder DB Credentials            | `kv-v2/openstack/cinder/db`                | KV v2  | Cinder API                             | Control Plane |
| Nova Application Credential      | `kv-v2/openstack/nova/app-credential`      | KV v2  | nova-operator (via c5c3-operator)      | Control Plane |
| Neutron Application Credential   | `kv-v2/openstack/neutron/app-credential`   | KV v2  | neutron-operator (via c5c3-operator)   | Control Plane |
| Glance Application Credential    | `kv-v2/openstack/glance/app-credential`    | KV v2  | glance-operator (via c5c3-operator)    | Control Plane |
| Cinder Application Credential    | `kv-v2/openstack/cinder/app-credential`    | KV v2  | cinder-operator (via c5c3-operator)    | Control Plane |
| Placement Application Credential | `kv-v2/openstack/placement/app-credential` | KV v2  | placement-operator (via c5c3-operator) | Control Plane |
| K-ORC Application Credential     | `kv-v2/openstack/k-orc/app-credential`     | KV v2  | K-ORC Controller                       | Control Plane |
| Cortex Application Credential    | `kv-v2/openstack/cortex/app-credential`    | KV v2  | Cortex                                 | Control Plane |
| Ceph Client Key (Nova)           | `kv-v2/ceph/client-nova`                   | KV v2  | Nova Compute, Hypervisor Node Agent    | Hypervisor    |
| Ceph Client Key (Cinder)         | `kv-v2/ceph/client-cinder`                 | KV v2  | Cinder Volume                          | Control Plane |
| Ceph Client Key (Glance)         | `kv-v2/ceph/client-glance`                 | KV v2  | Glance API                             | Control Plane |
| Nova Compute Credentials         | `kv-v2/openstack/nova/compute-config`      | KV v2  | Nova Compute Agent                     | Hypervisor    |
| OVN Config                       | `kv-v2/openstack/ovn/config`               | KV v2  | ovn-controller                         | Hypervisor    |
| Kubeconfig Control Plane         | `kv-v2/infrastructure/kubeconfig-cp`       | KV v2  | FluxCD                                 | Management    |
| Kubeconfig Hypervisor            | `kv-v2/infrastructure/kubeconfig-hv`       | KV v2  | FluxCD                                 | Management    |
| Kubeconfig Storage               | `kv-v2/infrastructure/kubeconfig-st`       | KV v2  | FluxCD                                 | Management    |
| TLS Certificates                 | `pki/issue/openstack-internal`             | PKI    | OpenStack APIs                         | Control Plane |

## Multi-Cluster Secret Distribution

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                  MULTI-CLUSTER SECRET DISTRIBUTION                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                    ┌─────────────────────────┐                              │
│                    │      OpenBao            │                              │
│                    │  (Management Cluster)   │                              │
│                    │                         │                              │
│                    │  kv-v2/bootstrap/*      │                              │
│                    │  kv-v2/openstack/*      │                              │
│                    │  kv-v2/infrastructure/* │                              │
│                    │  kv-v2/ceph/*           │                              │
│                    │  pki/*                  │                              │
│                    └───┬─────┬─────┬─────────┘                              │
│                        │     │     │                                        │
│               ┌────────┘     │     └────────┐                               │
│               │              │              │                               │
│               ▼              ▼              ▼                               │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐                   │
│  │ ESO            │ │ ESO            │ │ ESO            │                   │
│  │ Control Plane  │ │ Hypervisor     │ │ Storage        │                   │
│  ├────────────────┤ ├────────────────┤ ├────────────────┤                   │
│  │ ExternalSecret │ │ ExternalSecret │ │ PushSecret     │                   │
│  │ → K8s Secrets: │ │ → K8s Secrets: │ │ (Ceph Keys →  │                    │
│  │  - DB Creds    │ │  - Ceph Keys   │ │  OpenBao)      │                   │
│  │  - SvcPasswords│ │  - Nova Config │ │                │                   │
│  │  - AppCreds    │ │  - OVN Config  │ │ ExternalSecret │                   │
│  │  - Ceph Keys   │ │                │ │ → K8s Secrets: │                   │
│  └────────────────┘ └────────────────┘ │  - Ceph Config │                   │
│                                        └────────────────┘                   │
│                                                                             │
│  ESO in Management Cluster itself:                                          │
│  ExternalSecret → K8s Secrets: Kubeconfigs, FluxCD Secrets                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Ceph Key Flow

The flow for Ceph credentials from Rook Operator via OpenBao to the Libvirt daemon:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CEPH KEY FLOW (via OpenBao)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  STORAGE CLUSTER                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 1. Rook Operator creates CephClient + K8s Secret                    │    │
│  │    Secret: rook-ceph-client-openstack-nova (key: AQBxxxx==)         │    │
│  │                                                                     │    │
│  │ 2. PushSecret writes key to OpenBao                                 │    │
│  │    PushSecret → kv-v2/ceph/client-nova                              │    │
│  └───────────────────────────────┬─────────────────────────────────────┘    │
│                                  │                                          │
│                                  ▼                                          │
│  MANAGEMENT CLUSTER                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 3. OpenBao stores Ceph key                                          │    │
│  │    Path: kv-v2/data/ceph/client-nova                                │    │
│  └───────────────────────────────┬─────────────────────────────────────┘    │
│                                  │                                          │
│                                  ▼                                          │
│  HYPERVISOR CLUSTER                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ 4. ESO ExternalSecret reads from OpenBao                            │    │
│  │    → Creates K8s Secret: ceph-client-nova (namespace: openstack)    │    │
│  │                                                                     │    │
│  │ 5. Nova Compute DaemonSet mounts secret                             │    │
│  │    → /etc/ceph/ceph.client.nova.keyring                             │    │
│  │                                                                     │    │
│  │ 6. Hypervisor Node Agent creates Libvirt Secret on each node        │    │
│  │    → virsh secret-define + virsh secret-set-value                   │    │
│  │                                                                     │    │
│  │ 7. Libvirt uses secret for RBD access                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Bootstrap Sequence

The bootstrap sequence with OpenBao as central secret store:

| Phase       | Description                                                                                            | Secret Source        |
| ----------- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| **Phase 0** | Initialize OpenBao, Unseal, configure Secret Engines + Auth Methods                                    | Manual / CI-CD       |
| **Phase 1** | Write bootstrap secrets to OpenBao (Admin PW, Service Passwords)                                       | CI-CD → OpenBao      |
| **Phase 2** | Deploy ESO in all clusters, configure ClusterSecretStores                                              | FluxCD               |
| **Phase 3** | ESO creates K8s Secrets from OpenBao in all clusters                                                   | ESO → OpenBao        |
| **Phase 4** | Infrastructure Operators start (MariaDB, RabbitMQ, Valkey)                                             | K8s Secrets          |
| **Phase 5** | Keystone Bootstrap with Admin credentials from OpenBao                                                 | K8s Secrets          |
| **Phase 6** | c5c3-operator creates Keystone Services, Endpoints, Service Users, Application Credentials (via K-ORC) | Keystone API         |
| **Phase 7** | PushSecrets write generated credentials back to OpenBao                                                | PushSecret → OpenBao |
| **Phase 8** | ESO distributes all secrets to target clusters, services start                                         | ESO → K8s Secrets    |

## Credential Rotation

OpenBao KV v2 supports versioned secrets. In combination with the `CredentialRotation` CRD of the c5c3-operator:

* **Versioned Secrets**: OpenBao KV v2 stores all secret versions with metadata
* **ESO Refresh**: ExternalSecrets have a configurable `refreshInterval` (default: 1h)
* **Rotation Flow**: Write new secret to OpenBao → ESO updates K8s Secret → Pods receive new secret via Secret watch or rolling update
* **CredentialRotation CRD**: The c5c3-operator automatically rotates Application Credentials based on schedule and grace period

For the CRD definitions of `SecretAggregate` and `CredentialRotation`, see [CRDs](../04-architecture/01-crds.md#secretaggregate-crd-c5c3iov1alpha1).

## Further Reading

- [OpenBao Deployment](../09-implementation/09-openbao-deployment.md) — Deployment, initialization, secret engines, auth methods, policies, and bootstrap automation
- [Credential Lifecycle](./01-gitops-fluxcd/01-credential-lifecycle.md) — GitOps-driven credential flow with FluxCD
- [C5C3 Operator](../09-implementation/08-c5c3-operator.md#credentialrotation-crd) — CredentialRotation CRD implementation and rotation flow
- [Brownfield Integration](../06-operations/03-brownfield-integration.md) — Secret management for existing OpenStack deployments
