# Management

## Flux Operator

**Repository:** `github.com/controlplaneio-fluxcd/flux-operator`
**Namespace:** `flux-system`

The Flux Operator manages the lifecycle of the FluxCD installation in the Management Cluster. Instead of the imperative `flux bootstrap` command, FluxCD is configured declaratively via the `FluxInstance` CRD.

**CRDs:**

| CRD              | Description                                                                         |
| ---------------- | ----------------------------------------------------------------------------------- |
| **FluxInstance** | Configures and manages the Flux controller installation (version, components, sync) |
| **FluxReport**   | Automatically generated status report of the Flux installation and all reconcilers  |

**Functions:**

* Automatic Flux upgrades within a SemVer range (e.g., `2.x`)
* Declarative component selection (Source, Kustomize, Helm, Notification Controller)
* Network Policy configuration
* Git repository sync via `spec.sync` in the FluxInstance
* Prometheus metrics (`flux_instance_info`, `flux_resource_info`)

See [GitOps with FluxCD](../05-deployment/01-gitops-fluxcd/index.md) for the complete architecture and [Bootstrap](../05-deployment/01-gitops-fluxcd/04-bootstrap.md) for the installation process.

## OpenBao

**Repository:** [`github.com/openbao/openbao`](https://github.com/openbao/openbao)
**Namespace:** `openbao-system`

Central secret store for the entire CobaltCore environment. OpenBao manages ALL credentials — bootstrap passwords, service credentials, database credentials, Ceph keys, kubeconfigs, and TLS certificates.

**Architecture:**

* HA cluster with 3 Raft replicas in the Management Cluster
* Integrated Raft storage (no external backend required)
* Auto-unseal via Transit or Cloud KMS

**Secret Engines:**

| Engine   | Mount Path              | Purpose                                   |
| -------- | ----------------------- | ----------------------------------------- |
| KV v2    | `kv-v2/bootstrap/`      | Admin passwords, service passwords        |
| KV v2    | `kv-v2/openstack/`      | OpenStack service secrets, AppCredentials |
| KV v2    | `kv-v2/infrastructure/` | MariaDB, RabbitMQ, Valkey credentials     |
| KV v2    | `kv-v2/ceph/`           | Ceph auth keys (client keys)              |
| PKI      | `pki/`                  | TLS certificates for OpenStack APIs       |
| Database | `database/mariadb/`     | Dynamic DB credentials (optional)         |

**Auth Methods:**

| Auth Method | Mount Path                 | Cluster         |
| ----------- | -------------------------- | --------------- |
| Kubernetes  | `kubernetes/management`    | Management      |
| Kubernetes  | `kubernetes/control-plane` | Control Plane   |
| Kubernetes  | `kubernetes/hypervisor`    | Hypervisor      |
| Kubernetes  | `kubernetes/storage`       | Storage         |
| AppRole     | `approle/ci-cd`            | CI/CD pipelines |

See [OpenBao Secret Management](../05-deployment/02-secret-management.md) for the complete documentation.

## External Secrets Operator (ESO)

The External Secrets Operator runs in **all four clusters** and synchronizes secrets between OpenBao and Kubernetes:

* **ClusterSecretStore**: Connection to OpenBao in the Management Cluster (configured per cluster, Kubernetes Auth)
* **ExternalSecret**: Reads secrets from OpenBao and creates local Kubernetes Secrets
* **PushSecret**: Writes operator-generated secrets (Ceph keys, Application Credentials) back to OpenBao

Existing operators and agents continue to read standard Kubernetes Secrets — no code changes required.

See [OpenBao Secret Management](../05-deployment/02-secret-management.md) for details on ESO integration and secret flows.

## Greenhouse

Centralized monitoring and management tool for the entire CobaltCore environment. Aggregates metrics from all four clusters and provides health dashboards and alerting.

For the complete observability architecture see [Observability](../06-operations/02-observability/).

## Aurora Dashboard

**Repository:** `github.com/cobaltcore-dev/aurora-dashboard`

Comprehensive management interface for cloud management systems. Provides a unified view across all clusters for managing servers, networks, volumes, and other cloud components.
