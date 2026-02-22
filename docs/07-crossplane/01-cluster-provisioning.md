# Cluster Provisioning

This page describes the Crossplane XRDs and Compositions for provisioning infrastructure cluster pools (Phase 1). These pools are consumed by [OpenStack clusters](./02-openstack-provisioning.md) in Phase 2.

The pool model defines **separate XRDs** for each cluster type that can be provisioned independently:

## XControlPlaneCluster (Control Plane Provisioning)

```yaml
# XRD - Control Plane Cluster API
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xcontrolplaneclusters.crossplane.c5c3.io
spec:
  group: crossplane.c5c3.io
  names:
    kind: XControlPlaneCluster
    plural: xcontrolplaneclusters
  claimNames:
    kind: ControlPlaneCluster
    plural: controlplaneclusters
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required:
                - region
              properties:
                region:
                  type: string
                  description: "Gardener region (e.g., eu-de-1)"
                kubernetesVersion:
                  type: string
                  default: "1.29"
                workers:
                  type: integer
                  default: 5
                  description: "Number of worker nodes"
                machineType:
                  type: string
                  default: "m5.2xlarge"
                volumeSize:
                  type: string
                  default: "200Gi"
                highAvailability:
                  type: boolean
                  default: true
                  description: "HA mode with multi-AZ"
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Provisioning, Ready, Failed]
                clusterName:
                  type: string
                kubeconfig:
                  type: string
                  description: "Secret reference for kubeconfig"
```

## XHypervisorCluster (Hypervisor Pool Provisioning)

```yaml
# XRD - Hypervisor Cluster Pool API
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xhypervisorclusters.crossplane.c5c3.io
spec:
  group: crossplane.c5c3.io
  names:
    kind: XHypervisorCluster
    plural: xhypervisorclusters
  claimNames:
    kind: HypervisorCluster
    plural: hypervisorclusters
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required:
                - region
                - name
              properties:
                region:
                  type: string
                  description: "Gardener region (e.g., eu-de-1)"
                name:
                  type: string
                  description: "Pool name (e.g., hv-pool-a)"
                kubernetesVersion:
                  type: string
                  default: "1.29"
                workers:
                  type: integer
                  default: 20
                  description: "Number of hypervisor nodes in the pool"
                maxWorkers:
                  type: integer
                  default: 100
                  description: "Maximum number for autoscaling"
                ironcore:
                  type: object
                  required:
                    - machinePool
                  properties:
                    machinePool:
                      type: string
                      description: "IronCore machine pool name"
                    machineClass:
                      type: string
                      default: "baremetal-kvm"
                labels:
                  type: object
                  additionalProperties:
                    type: string
                  description: "Labels for scheduling (e.g., availability-zone, hardware-gen)"
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Provisioning, Ready, Scaling, Failed]
                clusterName:
                  type: string
                nodeCount:
                  type: integer
                availableCapacity:
                  type: object
                  properties:
                    vcpus:
                      type: integer
                    memoryGB:
                      type: integer
```

## XStorageCluster (Storage Pool Provisioning)

```yaml
# XRD - Storage Cluster Pool API
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xstorageclusters.crossplane.c5c3.io
spec:
  group: crossplane.c5c3.io
  names:
    kind: XStorageCluster
    plural: xstorageclusters
  claimNames:
    kind: StorageCluster
    plural: storageclusters
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required:
                - region
                - name
              properties:
                region:
                  type: string
                  description: "Gardener region (e.g., eu-de-1)"
                name:
                  type: string
                  description: "Pool name (e.g., st-pool-a)"
                kubernetesVersion:
                  type: string
                  default: "1.29"
                workers:
                  type: integer
                  default: 5
                  description: "Number of storage nodes in the pool"
                ironcore:
                  type: object
                  required:
                    - machinePool
                  properties:
                    machinePool:
                      type: string
                      description: "IronCore machine pool name"
                    machineClass:
                      type: string
                      default: "baremetal-storage"
                ceph:
                  type: object
                  properties:
                    osdCount:
                      type: integer
                      default: 15
                      description: "OSDs per node"
                    deviceClass:
                      type: string
                      default: "nvme"
                      enum: [hdd, ssd, nvme]
                    targetCapacity:
                      type: string
                      description: "Target capacity (e.g., 500Ti)"
                    replicationFactor:
                      type: integer
                      default: 3
                arbiterCluster:
                  type: string
                  description: "Reference to arbiter cluster for stretch setup"
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Provisioning, Ready, Expanding, Failed]
                clusterName:
                  type: string
                capacity:
                  type: object
                  properties:
                    total:
                      type: string
                    available:
                      type: string
                    used:
                      type: string
                health:
                  type: string
                  enum: [HEALTH_OK, HEALTH_WARN, HEALTH_ERR]
```

## Compositions: Cluster Pool Templates

Each cluster type has its own Composition that enables independent provisioning.

### Composition: Control Plane Cluster

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: control-plane-cluster
  labels:
    crossplane.io/xrd: xcontrolplaneclusters.crossplane.c5c3.io
spec:
  compositeTypeRef:
    apiVersion: crossplane.c5c3.io/v1alpha1
    kind: XControlPlaneCluster

  resources:
    # Control Plane Cluster (Gardener Shoot)
    - name: control-plane-shoot
      base:
        apiVersion: core.gardener.cloud/v1beta1
        kind: Shoot
        spec:
          cloudProfileName: converged-cloud
          secretBindingName: cc-credentials
          region: ""  # Patched
          kubernetes:
            version: "1.29"
          provider:
            type: openstack
            workers:
              - name: control-plane
                machine:
                  type: ""  # Patched
                minimum: 3
                maximum: 10
                volume:
                  size: ""  # Patched
          purpose: production
          controlPlane:
            highAvailability:
              failureTolerance:
                type: zone
      patches:
        - fromFieldPath: metadata.name
          toFieldPath: metadata.name
        - fromFieldPath: spec.region
          toFieldPath: spec.region
        - fromFieldPath: spec.kubernetesVersion
          toFieldPath: spec.kubernetes.version
        - fromFieldPath: spec.machineType
          toFieldPath: spec.provider.workers[0].machine.type
        - fromFieldPath: spec.workers
          toFieldPath: spec.provider.workers[0].minimum
        - fromFieldPath: spec.volumeSize
          toFieldPath: spec.provider.workers[0].volume.size

    # ProviderConfig for provider-kubernetes
    - name: provider-config
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha1
        kind: ProviderConfig
        spec:
          credentials:
            source: Secret
            secretRef:
              namespace: crossplane-system
              key: kubeconfig
      patches:
        - fromFieldPath: metadata.name
          toFieldPath: metadata.name
        - fromFieldPath: metadata.name
          toFieldPath: spec.credentials.secretRef.name
          transforms:
            - type: string
              string:
                fmt: "%s-kubeconfig"
```

### Composition: Hypervisor Cluster Pool

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: hypervisor-cluster-pool
  labels:
    crossplane.io/xrd: xhypervisorclusters.crossplane.c5c3.io
spec:
  compositeTypeRef:
    apiVersion: crossplane.c5c3.io/v1alpha1
    kind: XHypervisorCluster

  resources:
    # Hypervisor Cluster (Gardener Shoot with IronCore)
    - name: hypervisor-shoot
      base:
        apiVersion: core.gardener.cloud/v1beta1
        kind: Shoot
        spec:
          cloudProfileName: ironcore
          secretBindingName: ironcore-credentials
          region: ""  # Patched
          kubernetes:
            version: "1.29"
          provider:
            type: ironcore
            workers:
              - name: hypervisor
                machine:
                  type: ""  # Patched
                  image:
                    name: gardenlinux
                minimum: 5
                maximum: 100
      patches:
        - fromFieldPath: spec.name
          toFieldPath: metadata.name
        - fromFieldPath: spec.region
          toFieldPath: spec.region
        - fromFieldPath: spec.kubernetesVersion
          toFieldPath: spec.kubernetes.version
        - fromFieldPath: spec.ironcore.machineClass
          toFieldPath: spec.provider.workers[0].machine.type
        - fromFieldPath: spec.workers
          toFieldPath: spec.provider.workers[0].minimum
        - fromFieldPath: spec.maxWorkers
          toFieldPath: spec.provider.workers[0].maximum
        - fromFieldPath: spec.labels
          toFieldPath: metadata.labels
          policy:
            mergeOptions:
              appendSlice: true
```

### Composition: Storage Cluster Pool

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: storage-cluster-pool
  labels:
    crossplane.io/xrd: xstorageclusters.crossplane.c5c3.io
spec:
  compositeTypeRef:
    apiVersion: crossplane.c5c3.io/v1alpha1
    kind: XStorageCluster

  resources:
    # Storage Cluster (Gardener Shoot with IronCore)
    - name: storage-shoot
      base:
        apiVersion: core.gardener.cloud/v1beta1
        kind: Shoot
        spec:
          cloudProfileName: ironcore
          secretBindingName: ironcore-credentials
          region: ""  # Patched
          kubernetes:
            version: "1.29"
          provider:
            type: ironcore
            workers:
              - name: storage
                machine:
                  type: ""  # Patched
                  image:
                    name: gardenlinux
                minimum: 3
                maximum: 30
      patches:
        - fromFieldPath: spec.name
          toFieldPath: metadata.name
        - fromFieldPath: spec.region
          toFieldPath: spec.region
        - fromFieldPath: spec.kubernetesVersion
          toFieldPath: spec.kubernetes.version
        - fromFieldPath: spec.ironcore.machineClass
          toFieldPath: spec.provider.workers[0].machine.type
        - fromFieldPath: spec.workers
          toFieldPath: spec.provider.workers[0].minimum
```

## Claims: Provision Cluster Pools

The pools are provisioned **independently** of each other. Once ready, they can be referenced by [OpenStack cluster claims](./02-openstack-provisioning.md). For full provisioning flow details, see [Operations](./03-operations.md).

```yaml
# Claim: Control Plane Cluster
apiVersion: crossplane.c5c3.io/v1alpha1
kind: ControlPlaneCluster
metadata:
  name: eu-de-1-control-plane
  namespace: infrastructure
spec:
  region: eu-de-1
  kubernetesVersion: "1.29"
  workers: 5
  machineType: m5.4xlarge
  volumeSize: 200Gi
  highAvailability: true

---
# Claim: Hypervisor Pool A (50 Nodes)
apiVersion: crossplane.c5c3.io/v1alpha1
kind: HypervisorCluster
metadata:
  name: hv-pool-a
  namespace: infrastructure
spec:
  region: eu-de-1
  name: hv-pool-a
  workers: 50
  maxWorkers: 100
  ironcore:
    machinePool: ironcore-baremetal-kvm
    machineClass: baremetal-kvm
  labels:
    tier: standard
    availability-zone: az-1

---
# Claim: Hypervisor Pool B (100 Nodes, Premium)
apiVersion: crossplane.c5c3.io/v1alpha1
kind: HypervisorCluster
metadata:
  name: hv-pool-b
  namespace: infrastructure
spec:
  region: eu-de-1
  name: hv-pool-b
  workers: 100
  maxWorkers: 200
  ironcore:
    machinePool: ironcore-baremetal-kvm-premium
    machineClass: baremetal-kvm-premium
  labels:
    tier: premium
    availability-zone: az-2

---
# Claim: Storage Pool A (500TB Ceph)
apiVersion: crossplane.c5c3.io/v1alpha1
kind: StorageCluster
metadata:
  name: st-pool-a
  namespace: infrastructure
spec:
  region: eu-de-1
  name: st-pool-a
  workers: 10
  ironcore:
    machinePool: ironcore-baremetal-storage
    machineClass: baremetal-storage
  ceph:
    osdCount: 30
    deviceClass: nvme
    targetCapacity: 500Ti
    replicationFactor: 3
```
