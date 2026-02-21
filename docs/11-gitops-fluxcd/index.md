# GitOps with FluxCD

This section documents the FluxCD-based GitOps architecture of CobaltCore, including Credential Lifecycle Management, Dependency Management, and Bootstrap process.

**Repository:** `github.com/fluxcd/flux2`
**Deployment via:** [Flux Operator](https://github.com/controlplaneio-fluxcd/flux-operator) (`fluxcd.controlplane.io/v1`)
**Runs in:** Management Cluster (Hub)

FluxCD is a CNCF Graduated GitOps solution used for continuous deployment of all CobaltCore components across all clusters. The Management Cluster acts as the central **GitOps Hub**, managing the configuration of all clusters.

## Flux Operator

The deployment and lifecycle management of FluxCD is handled by the **Flux Operator** — a Kubernetes operator from the CNCF Flux Maintainers (ControlPlane). Instead of the imperative `flux bootstrap` command, FluxCD is managed declaratively via a `FluxInstance` CRD. This approach is consistent with CobaltCore's comprehensive operator pattern (MariaDB Operator, Valkey Operator, RabbitMQ Operator, etc.).

**Advantages over `flux bootstrap`:**

| Aspect                  | `flux bootstrap`                                    | Flux Operator                                    |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------ |
| **Management Model**    | Imperative (CLI); Flux manages itself via Git       | Declarative (CRD); Operator manages Flux         |
| **Upgrades**            | Manual: run `flux bootstrap` again                  | Automatic via SemVer range (e.g., `2.x`)         |
| **Configuration**       | Kustomize overlays in Git repo under `flux-system/` | Structured spec fields in the `FluxInstance` CRD |
| **Observability**       | Standard Flux metrics                               | Extended: `FluxReport` CRD, Prometheus metrics   |
| **Circular Dependency** | Flux deploys itself                                 | Eliminated: Operator manages Flux externally     |

**Flux Operator CRDs:**

| CRD              | API Group                   | Description                                                                     |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------- |
| **FluxInstance** | `fluxcd.controlplane.io/v1` | Lifecycle management of the Flux installation (one `flux` instance per cluster) |
| **FluxReport**   | `fluxcd.controlplane.io/v1` | Automatically generated status of the Flux installation and all reconcilers     |

**FluxInstance Configuration:**

```yaml
apiVersion: fluxcd.controlplane.io/v1
kind: FluxInstance
metadata:
  name: flux
  namespace: flux-system
spec:
  distribution:
    version: "2.x"
    registry: ghcr.io/fluxcd
  components:
    - source-controller
    - kustomize-controller
    - helm-controller
    - notification-controller
  cluster:
    multitenant: false
    networkPolicy: true
  sync:
    kind: GitRepository
    url: ssh://git@github.com/c5c3/c5c3-gitops.git
    ref: refs/heads/main
    path: clusters/management
    pullSecret: flux-system
```

The Flux Operator itself is installed as a Helm Chart in the Management Cluster and can thus also be managed via GitOps (e.g., through an initial HelmRelease).

## Hub-and-Spoke Architecture

```text
+----------------------------------------------------------------------------+
|                          MANAGEMENT CLUSTER (Hub)                          |
|                                                                            |
|  +----------------------------------------------------------------------+  |
|  |                         FluxCD Controllers                           |  |
|  |                                                                      |  |
|  |  +-------------+ +-------------+ +-------------+ +-----------------+ |  |
|  |  |   Source    | | Kustomize   | |    Helm     | |  Notification   | |  |
|  |  | Controller  | | Controller  | | Controller  | |   Controller    | |  |
|  |  +------+------+ +------+------+ +------+------+ +--------+--------+ |  |
|  |         |               |               |                 |          |  |
|  |         +---------------+-------+-------+-----------------+          |  |
|  |                                 |                                    |  |
|  +---------------------------------+------------------------------------+  |
|                                    |                                       |
|  +---------------------------------v------------------------------------+  |
|  |                          Git Repository                              |  |
|  |           (c5c3-gitops - Single Source of Truth)                     |  |
|  |                                                                      |  |
|  |  +-- clusters/                                                       |  |
|  |  |   +-- management/      # Greenhouse, Aurora, FluxCD               |  |
|  |  |   +-- control-plane/   # OpenStack APIs, Cortex, K-ORC, Infra     |  |
|  |  |   +-- hypervisor/      # Hypervisor Operator, Agents              |  |
|  |  |   +-- storage/         # Rook, External Arbiter, Prysm            |  |
|  |  +-- apps/                                                           |  |
|  |  |   +-- greenhouse/                                                 |  |
|  |  |   +-- aurora-dashboard/                                           |  |
|  |  |   +-- openstack/                                                  |  |
|  |  |   +-- cortex/                                                     |  |
|  |  |   +-- k-orc/                                                      |  |
|  |  |   +-- infrastructure/  # MariaDB, Valkey, RabbitMQ, Memcached     |  |
|  |  |   +-- hypervisor-operator/                                        |  |
|  |  |   +-- openbao/                                                    |  |
|  |  |   +-- external-secrets/                                           |  |
|  |  |   +-- rook-ceph/                                                  |  |
|  |  |   +-- prysm/                                                      |  |
|  |  +-- infrastructure/                                                 |  |
|  |      +-- sources/         # HelmRepository, GitRepository            |  |
|  +----------------------------------------------------------------------+  |
|                                                                            |
|  +----------------------------------------------------------------------+  |
|  |                      Kubeconfig Secrets                              |  |
|  |  +-------------+  +-------------+  +-------------+                   |  |
|  |  |control-plane|  | hypervisor  |  |   storage   |                   |  |
|  |  |  kubeconfig |  |  kubeconfig |  |  kubeconfig |                   |  |
|  |  +------+------+  +------+------+  +------+------+                   |  |
|  +---------+----------------+----------------+--------------------------+  |
|            |                |                |                             |
+------------+----------------+----------------+-----------------------------+
             |                |                |
             v                v                v
+--------------------+ +--------------------+ +--------------------+
|  CONTROL PLANE     | |  HYPERVISOR        | |  STORAGE           |
|  CLUSTER           | |  CLUSTER           | |  CLUSTER           |
|                    | |                    | |                    |
|  Deployed via      | |  Deployed via      | |  Deployed via      |
|  Kustomization     | |  Kustomization     | |  Kustomization     |
|  + HelmRelease     | |  + HelmRelease     | |  + HelmRelease     |
|                    | |                    | |                    |
|  kubeConfigSecret  | |  kubeConfigSecret  | |  kubeConfigSecret  |
|  Ref: cp-kubeconf  | |  Ref: hv-kubeconf  | |  Ref: st-kubeconf  |
+--------------------+ +--------------------+ +--------------------+
```

## FluxCD Components

| Controller                  | Function                                       |
| --------------------------- | ---------------------------------------------- |
| **Source Controller**       | Monitors Git repos, Helm charts, OCI artifacts |
| **Kustomize Controller**    | Applies Kustomize overlays                     |
| **Helm Controller**         | Manages HelmRelease deployments declaratively  |
| **Notification Controller** | Alerts, webhooks, integration with Slack/Teams |
| **Image Automation**        | Automatic image updates in Git (optional)      |

## Deployment Strategy per Cluster

## Management Cluster (Local)

The **Flux Operator** manages the FluxCD installation. The `FluxInstance` CRD configures the sync with the Git repository, through which all other components are deployed:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: management-apps
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  path: ./clusters/management
  prune: true
```

**Components:**

* Flux Operator + FluxInstance (GitOps Lifecycle)
* OpenBao (Secret Store)
* External Secrets Operator (ESO)
* Greenhouse (Monitoring)
* Aurora Dashboard (UI)

## Control Plane Cluster (Remote)

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: control-plane-apps
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  path: ./clusters/control-plane
  prune: true
  kubeConfig:
    secretRef:
      name: control-plane-kubeconfig
  dependsOn:
    - name: control-plane-infrastructure
```

**Components:**

* **Infrastructure Operators** (Helm Charts):
  * MariaDB Operator
  * Valkey Operator
  * RabbitMQ Operator
  * Memcached Operator
* **c5c3-operator** (Helm Chart) -> Orchestration:
  * Infrastructure CRs (creates CRs for MariaDB/Valkey/RabbitMQ/Memcached Operators)
  * Dependency Management
  * Credential Orchestration
  * Creates Service CRs for Service Operators
* **Service Operators** (Helm Charts):
  * keystone-operator
  * glance-operator
  * placement-operator
  * nova-operator
  * neutron-operator
  * cinder-operator
  * cortex-operator (optional)
* **ovn-operator** (OVN Cluster Management)
  * OVN Northbound/Southbound (StatefulSets)

## Hypervisor Cluster (Remote)

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: hypervisor-apps
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  path: ./clusters/hypervisor
  prune: true
  kubeConfig:
    secretRef:
      name: hypervisor-kubeconfig
```

**Components:**

* OpenStack Hypervisor Operator
* Hypervisor Node Agent (DaemonSet)
* OVS Agent (DaemonSet)
* HA Agent (DaemonSet)
* Nova Compute Agent
* ovn-controller (DaemonSet)
* ovs-vswitchd (DaemonSet)
* Labels Injector (Deployment)

## Storage Cluster (Remote)

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: storage-apps
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  path: ./clusters/storage
  prune: true
  kubeConfig:
    secretRef:
      name: storage-kubeconfig
  dependsOn:
    - name: storage-rook-operator
```

**Components:**

* Rook Operator
* CephCluster CRD
* External Arbiter Operator
* Prysm (Sidecar Injection)

***
