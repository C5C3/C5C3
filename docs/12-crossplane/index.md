# Crossplane

This chapter describes how consumers (platform teams, tenants) can use CobaltCore as a platform via Crossplane.

> **Note:** Crossplane is **not part of CobaltCore** itself. This document describes how consumers (platform teams, tenants) can use CobaltCore as a platform via Crossplane — similar to Terraform or a CLI working against the c5c3 interfaces.

**Repository:** `github.com/crossplane/crossplane`
**Runs in:** Consumer clusters (e.g., user's Management Cluster)
**Status:** CNCF Incubating Project

Crossplane is a framework for building cloud-native control planes. In the CobaltCore context, Crossplane enables consumers to perform **self-service provisioning** of:

1. **Kubernetes clusters with Gardener** (Control Plane Cluster, Hypervisor Cluster Pools, Storage Cluster Pools)
2. **OpenStack clusters in the Control Plane Cluster** (via c5c3-operator) - consume Hypervisor and Storage clusters

## Resource Model

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CobaltCore Resource Model                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONTROL PLANE CLUSTER (1x per region)                                      │
│  ══════════════════════════════════════                                     │
│  Hosts all OpenStack Control Planes for a region                            │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    OpenStack Control Planes                         │    │
│  │                                                                     │    │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐            │    │
│  │  │ ControlPlane  │  │ ControlPlane  │  │ ControlPlane  │            │    │
│  │  │ "customer-a"  │  │ "customer-b"  │  │ "internal"    │            │    │
│  │  │               │  │               │  │               │            │    │
│  │  │ Nova API      │  │ Nova API      │  │ Nova API      │            │    │
│  │  │ Neutron API   │  │ Neutron API   │  │ Neutron API   │            │    │
│  │  │ Keystone      │  │ Keystone      │  │ Keystone      │            │    │
│  │  │ ...           │  │ ...           │  │ ...           │            │    │
│  │  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘            │    │
│  │          │                  │                  │                    │    │
│  └──────────┼──────────────────┼──────────────────┼────────────────────┘    │
│             │                  │                  │                         │
│             │ consumes         │ consumes         │ consumes                │
│             ▼                  ▼                  ▼                         │
│                                                                             │
│  HYPERVISOR CLUSTER POOLS                    STORAGE CLUSTER POOLS          │
│  ════════════════════════                    ═════════════════════          │
│                                                                             │
│  ┌─────────────┐ ┌─────────────┐            ┌─────────────┐ ┌─────────────┐ │
│  │ Hypervisor  │ │ Hypervisor  │            │  Storage    │ │  Storage    │ │
│  │ Cluster 1   │ │ Cluster 2   │            │  Cluster 1  │ │  Cluster 2  │ │
│  │ "hv-pool-a" │ │ "hv-pool-b" │            │ "st-pool-a" │ │ "st-pool-b" │ │
│  │             │ │             │            │             │ │             │ │
│  │ 50 Nodes    │ │ 100 Nodes   │            │ Ceph        │ │ Ceph        │ │
│  │   LibVirt   │ │   LibVirt   │            │ 500TB       │ │ 1PB         │ │
│  └─────────────┘ └─────────────┘            └─────────────┘ └─────────────┘ │
│        │               │                          │               │         │
│        └───────┬───────┘                          └───────┬───────┘         │
│                │                                          │                 │
│  Assignment: 1 OpenStack cluster can                                        │
│  - use 1..N Hypervisor clusters                                             │
│  - use 1..M Storage clusters                                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Architecture Overview (Pool Model)

The pool model enables the **independent provisioning** of Hypervisor and Storage clusters as resource pools that can be consumed by multiple OpenStack clusters:

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              MANAGEMENT CLUSTER                                  │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                            Crossplane                                      │  │
│  │                                                                            │  │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │  │
│  │  │                       Crossplane Core                                │  │  │
│  │  │   - Composition Engine    - Package Manager    - RBAC Manager        │  │  │
│  │  └──────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                            │  │
│  │  ┌───────────────────────────────────────────────────────────┐             │  │
│  │  │              provider-kubernetes                          │             │  │
│  │  │                                                           │             │  │
│  │  │  - Manages Gardener Shoot resources (K8s clusters)        │             │  │
│  │  │    in Gardener API (garden-c5c3 namespace)                │             │  │
│  │  │  - Manages ControlPlane CRs in Control Plane Cluster      │             │  │
│  │  │                                                           │             │  │
│  │  └───────────────────────────────────────────────────────────┘             │  │
│  │                                                                            │  │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │  │
│  │  │              Custom XRDs + Compositions (Pool Model)                 │  │  │
│  │  │                                                                      │  │  │
│  │  │  ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────┐  │  │  │
│  │  │  │ XControlPlaneCluster │ │ XHypervisorCluster   │ │ XStorage-    │  │  │  │
│  │  │  │ ──────────────────── │ │ ──────────────────── │ │ Cluster      │  │  │  │
│  │  │  │ spec:                │ │ spec:                │ │ ──────────── │  │  │  │
│  │  │  │   region: eu-de-1    │ │   region: eu-de-1    │ │ spec:        │  │  │  │
│  │  │  │   workers: 5         │ │   name: hv-pool-a    │ │   region:    │  │  │  │
│  │  │  │                      │ │   workers: 50        │ │   eu-de-1    │  │  │  │
│  │  │  │ Creates:             │ │   machinePool: kvm   │ │   name:      │  │  │  │
│  │  │  │ - Gardener Shoot     │ │                      │ │   st-pool-a  │  │  │  │
│  │  │  │   (Control Plane)    │ │ Creates:             │ │   capacity:  │  │  │  │
│  │  │  └──────────────────────┘ │ - Gardener Shoot     │ │   500TB      │  │  │  │
│  │  │                           │   (Hypervisor Pool)  │ │              │  │  │  │
│  │  │                           └──────────────────────┘ │ Creates:     │  │  │  │
│  │  │                                                    │ - Gardener   │  │  │  │
│  │  │                                                    │   Shoot      │  │  │  │
│  │  │                                                    │   (Storage)  │  │  │  │
│  │  │                                                    └──────────────┘  │  │  │
│  │  │                                                                      │  │  │
│  │  │  ┌───────────────────────────────────────────────────────────────┐   │  │  │
│  │  │  │ XOpenStackCluster                                             │   │  │  │
│  │  │  │ ─────────────────                                             │   │  │  │
│  │  │  │ spec:                                                         │   │  │  │
│  │  │  │   region: eu-de-1                                             │   │  │  │
│  │  │  │   size: large                                                 │   │  │  │
│  │  │  │   hypervisorClusters:           # Pool references             │   │  │  │
│  │  │  │     - hv-pool-a                                               │   │  │  │
│  │  │  │     - hv-pool-b                                               │   │  │  │
│  │  │  │   storageClusters:              # Pool references             │   │  │  │
│  │  │  │     - st-pool-a                                               │   │  │  │
│  │  │  │                                                               │   │  │  │
│  │  │  │ Creates: ControlPlane CR (references pools)                   │   │  │  │
│  │  │  └───────────────────────────────────────────────────────────────┘   │  │  │
│  │  └──────────────────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
│    │ provider-kubernetes                                                        │
│    │ - Creates Shoot CRs in Gardener (garden-c5c3)                              │
│    │ - Creates Object CRs in Control Plane Cluster                              │
│    ▼                                                                            │
└────┼────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│        GARDENER         │
│  (garden-c5c3)          │
│                         │
│  Provisions             │
│  independently:         │
│                         │
│  ┌─────────────────┐    │
│  │ Control Plane   │    │
│  │ Cluster (1x)    │◀───┼──┐
│  └─────────────────┘    │  │
│                         │  │  After cluster ready:
│  ┌─────────────────┐    │  │  provider-kubernetes
│  │ Hypervisor Pool │    │  │  creates ControlPlane CRs
│  │ (1..N Clusters) │    │  │
│  └─────────────────┘    │  │  Hypervisor/Storage pools
│                         │  │  are provisioned independently
│  ┌─────────────────┐    │  │  and referenced by OpenStack
│  │ Storage Pool    │    │  │  clusters
│  │ (1..M Clusters) │    │  │
│  └─────────────────┘    │  │
└───────────┬─────────────┘  │
            │                │
            │ Creates K8s    │
            │ Clusters       │
            ▼                │
            │
            │ Creates Kubernetes Clusters
            │
            ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                    │
│  CONTROL PLANE CLUSTER (1x per region)                                             │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │  c5c3-operator                                                               │  │
│  │                                                                              │  │
│  │  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐   │  │
│  │  │ ControlPlane CR     │  │ ControlPlane CR     │  │ ControlPlane CR     │   │  │
│  │  │ "customer-a"        │  │ "customer-b"        │  │ "internal"          │   │  │
│  │  │                     │  │                     │  │                     │   │  │
│  │  │ hypervisorClusters: │  │ hypervisorClusters: │  │ hypervisorClusters: │   │  │
│  │  │ - hv-pool-a         │  │ - hv-pool-a         │  │ - hv-pool-b         │   │  │
│  │  │ - hv-pool-b         │  │                     │  │                     │   │  │
│  │  │ storageClusters:    │  │ storageClusters:    │  │ storageClusters:    │   │  │
│  │  │ - st-pool-a         │  │ - st-pool-a         │  │ - st-pool-a         │   │  │
│  │  └─────────┬───────────┘  └─────────┬───────────┘  └─────────┬───────────┘   │  │
│  │            │                        │                        │               │  │
│  └────────────┼────────────────────────┼────────────────────────┼───────────────┘  │
│               │                        │                        │                  │
│               │ consumes               │ consumes               │ consumes         │
│               ▼                        ▼                        ▼                  │
│                                                                                    │
│  HYPERVISOR CLUSTER POOLS                    STORAGE CLUSTER POOLS                 │
│  ┌──────────────────────┐ ┌──────────────────────┐  ┌──────────────────────┐       │
│  │ Hypervisor Cluster   │ │ Hypervisor Cluster   │  │ Storage Cluster      │       │
│  │ "hv-pool-a"          │ │ "hv-pool-b"          │  │ "st-pool-a"          │       │
│  │ (Gardener Shoot)     │ │ (Gardener Shoot)     │  │ (Gardener Shoot)     │       │
│  │                      │ │                      │  │                      │       │
│  │ 50 Nodes             │ │ 100 Nodes            │  │ Rook Operator        │       │
│  │ LibVirt              │ │ LibVirt              │  │ Ceph 500TB           │       │
│  │ Nova/OVN Agents      │ │ Nova/OVN Agents      │  │ Prysm                │       │
│  └──────────────────────┘ └──────────────────────┘  └──────────────────────┘       │
│                                                                                    │
│  Pool Sharing:                                                                     │
│  - customer-a uses: hv-pool-a, hv-pool-b, st-pool-a                                │
│  - customer-b uses: hv-pool-a, st-pool-a (shared)                                  │
│  - internal uses: hv-pool-b, st-pool-a (shared)                                    │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## Crossplane Components

| Component                             | Description                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Crossplane Core**                   | Composition Engine, Package Manager, RBAC                                                             |
| **provider-kubernetes**               | Manages K8s objects in remote clusters (Gardener Shoots + ControlPlane CRs) via kubeconfig            |
| **XRD (CompositeResourceDefinition)** | Defines custom APIs (e.g., `XCobaltCoreEnvironment`, `XOpenStackCluster`)                             |
| **Composition**                       | Template that maps XRD to concrete resources                                                          |
| **Claim (XRC)**                       | Namespace-scoped request for a Composite Resource                                                     |

## provider-kubernetes Setup

The `provider-kubernetes` ([crossplane-contrib/provider-kubernetes](https://github.com/crossplane-contrib/provider-kubernetes)) enables Crossplane to manage Kubernetes resources in remote clusters, including:

1. **Gardener Shoot resources** in the Gardener cluster (garden-c5c3 namespace)
2. **ControlPlane CRs** in the Control Plane Cluster (via c5c3-operator)

### ProviderConfig for Gardener

```yaml
# ProviderConfig to access Gardener API
apiVersion: kubernetes.crossplane.io/v1alpha1
kind: ProviderConfig
metadata:
  name: gardener
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: gardener-kubeconfig
      key: kubeconfig
```

### ProviderConfig for Control Plane Cluster

```yaml
# ProviderConfig to access Control Plane Cluster
apiVersion: kubernetes.crossplane.io/v1alpha1
kind: ProviderConfig
metadata:
  name: control-plane
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: control-plane-kubeconfig
      key: kubeconfig
```

***
