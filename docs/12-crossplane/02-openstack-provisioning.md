# OpenStack Cluster Provisioning

## provider-kubernetes Setup

The `provider-kubernetes` enables Crossplane to create resources in the Control Plane Cluster (after it has been provisioned by Gardener):

```yaml
# ProviderConfig for Control Plane Cluster
apiVersion: kubernetes.crossplane.io/v1alpha1
kind: ProviderConfig
metadata:
  name: control-plane-cluster
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: control-plane-kubeconfig
      key: kubeconfig
```

## Custom API: XOpenStackCluster (with Pool References)

The XOpenStackCluster XRD defines OpenStack clusters that **explicitly reference Hypervisor and Storage pools**:

```yaml
# XRD - OpenStack Cluster with Pool References
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xopenstackclusters.c5c3.io
spec:
  group: c5c3.io
  names:
    kind: XOpenStackCluster
    plural: xopenstackclusters
  claimNames:
    kind: OpenStackCluster
    plural: openstackclusters
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
                - size
                - hypervisorClusters
                - storageClusters
              properties:
                region:
                  type: string
                  description: "Deployment region (e.g., eu-de-1)"

                size:
                  type: string
                  enum: [small, medium, large, xlarge]
                  description: "Cluster size preset (affects replicas)"

                # Pool References (Pool Model)
                hypervisorClusters:
                  type: array
                  minItems: 1
                  items:
                    type: string
                  description: |
                    List of Hypervisor cluster pools that this OpenStack cluster
                    consumes. Enables multi-pool deployments for HA and scaling.
                    Example: ["hv-pool-a", "hv-pool-b"]

                storageClusters:
                  type: array
                  minItems: 1
                  items:
                    type: string
                  description: |
                    List of Storage cluster pools that this OpenStack cluster
                    consumes. Enables multi-pool setups for different storage tiers.
                    Example: ["st-pool-a"]

                # Optional: Control Plane Cluster Override
                controlPlaneCluster:
                  type: string
                  description: |
                    Control Plane cluster name (default: region-control-plane).
                    Normally there is one Control Plane cluster per region.

                # OpenStack Services
                services:
                  type: object
                  properties:
                    nova:
                      type: boolean
                      default: true
                    neutron:
                      type: boolean
                      default: true
                    cinder:
                      type: boolean
                      default: true
                    glance:
                      type: boolean
                      default: true
                    octavia:
                      type: boolean
                      default: false
                    manila:
                      type: boolean
                      default: false

                # Cortex Integration
                cortex:
                  type: object
                  properties:
                    enabled:
                      type: boolean
                      default: true
                    pipelines:
                      type: array
                      items:
                        type: string
                      default: ["nova", "cinder"]

                # TLS Configuration
                tls:
                  type: object
                  properties:
                    enabled:
                      type: boolean
                      default: true
                    issuerRef:
                      type: string

                # Network Configuration
                network:
                  type: object
                  properties:
                    externalNetwork:
                      type: string
                      description: "External network for floating IPs"
                    mtu:
                      type: integer
                      default: 1500

                # Ceph Storage Configuration
                storage:
                  type: object
                  properties:
                    ceph:
                      type: object
                      properties:
                        volumePool:
                          type: object
                          description: "CephBlockPool for Cinder volumes"
                          properties:
                            replication:
                              type: integer
                              default: 3
                              minimum: 1
                              maximum: 5
                            compression:
                              type: string
                              enum: [none, passive, aggressive, force]
                              default: aggressive
                            quotaGB:
                              type: integer
                              description: "Pool quota in GB (0 = unlimited)"
                        imagePool:
                          type: object
                          description: "CephBlockPool for Glance images"
                          properties:
                            replication:
                              type: integer
                              default: 3
                            compression:
                              type: string
                              default: aggressive
                        ephemeralPool:
                          type: object
                          description: "CephBlockPool for Nova ephemeral disks"
                          properties:
                            enabled:
                              type: boolean
                              default: true
                            replication:
                              type: integer
                              default: 2
                              description: "Fewer replicas for ephemeral storage"
                        filesystem:
                          type: object
                          description: "CephFilesystem for Manila shares"
                          properties:
                            enabled:
                              type: boolean
                              default: false
                            dataPoolReplication:
                              type: integer
                              default: 3
                            metadataPoolReplication:
                              type: integer
                              default: 3
                        objectStore:
                          type: object
                          description: "CephObjectStore for Swift/S3 API"
                          properties:
                            enabled:
                              type: boolean
                              default: false
                            dataPoolReplication:
                              type: integer
                              default: 3

            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Pending, Provisioning, Ready, Degraded, Failed]
                endpoints:
                  type: object
                  properties:
                    keystone:
                      type: string
                    horizon:
                      type: string
                    nova:
                      type: string
                consumedPools:
                  type: object
                  properties:
                    hypervisor:
                      type: array
                      items:
                        type: object
                        properties:
                          name:
                            type: string
                          status:
                            type: string
                          nodeCount:
                            type: integer
                    storage:
                      type: array
                      items:
                        type: object
                        properties:
                          name:
                            type: string
                          status:
                            type: string
                          availableCapacity:
                            type: string
                cephResources:
                  type: object
                  description: "Status of created Ceph resources"
                  properties:
                    volumePool:
                      type: object
                      properties:
                        name:
                          type: string
                        status:
                          type: string
                          enum: [Creating, Ready, Degraded, Failed]
                        usedBytes:
                          type: integer
                        availableBytes:
                          type: integer
                    imagePool:
                      type: object
                      properties:
                        name:
                          type: string
                        status:
                          type: string
                    ephemeralPool:
                      type: object
                      properties:
                        name:
                          type: string
                        status:
                          type: string
                    filesystem:
                      type: object
                      properties:
                        name:
                          type: string
                        status:
                          type: string
                        mdsActive:
                          type: integer
                    client:
                      type: object
                      properties:
                        name:
                          type: string
                        secretRef:
                          type: string
                          description: "Secret with Ceph auth key"
```

## Composition: OpenStack Cluster Template (Pool Model)

The Composition maps the XRD to concrete resources in the Control Plane Cluster and passes the **pool references** to the ControlPlane CR:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: openstack-cluster-production
  labels:
    crossplane.io/xrd: xopenstackclusters.c5c3.io
    environment: production
spec:
  compositeTypeRef:
    apiVersion: c5c3.io/v1alpha1
    kind: XOpenStackCluster

  resources:
    # Namespace for the OpenStack cluster
    - name: namespace
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha2
        kind: Object
        spec:
          providerConfigRef:
            name: control-plane-cluster
          forProvider:
            manifest:
              apiVersion: v1
              kind: Namespace
              metadata:
                name: ""  # Patched
                labels:
                  c5c3.io/openstack-cluster: "true"
      patches:
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.metadata.name
          transforms:
            - type: string
              string:
                fmt: "openstack-%s"

    # ControlPlane CR (c5c3-operator) with pool references
    - name: controlplane
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha2
        kind: Object
        spec:
          providerConfigRef:
            name: control-plane-cluster
          forProvider:
            manifest:
              apiVersion: c5c3.io/v1alpha1
              kind: ControlPlane
              metadata:
                name: ""  # Patched
                namespace: ""  # Patched
              spec:
                # Pool references (critical for pool model)
                compute:
                  hypervisorClusters: []  # Patched - List of hypervisor pools
                storage:
                  storageClusters: []     # Patched - List of storage pools

                # Infrastructure Services
                infrastructure:
                  mariadb:
                    replicas: 3
                    storageSize: 100Gi
                  rabbitmq:
                    replicas: 3
                  valkey:
                    replicas: 3
                    sentinel:
                      enabled: true
                  memcached:
                    replicas: 3

                # OpenStack Services
                openstack:
                  keystone:
                    replicas: 3
                  nova:
                    api:
                      replicas: 3
                    scheduler:
                      replicas: 2
                    conductor:
                      replicas: 3
                  neutron:
                    api:
                      replicas: 3
                    server:
                      replicas: 3
                  glance:
                    replicas: 2
                  cinder:
                    api:
                      replicas: 2
                    scheduler:
                      replicas: 2

                # Cortex Integration
                cortex:
                  enabled: true

                # TLS
                tls:
                  enabled: true
      patches:
        # Name and namespace
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.metadata.name
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.metadata.namespace
          transforms:
            - type: string
              string:
                fmt: "openstack-%s"

        # Pass pool references
        - fromFieldPath: spec.hypervisorClusters
          toFieldPath: spec.forProvider.manifest.spec.compute.hypervisorClusters
        - fromFieldPath: spec.storageClusters
          toFieldPath: spec.forProvider.manifest.spec.storage.storageClusters

        # Size-based scaling for infrastructure
        - fromFieldPath: spec.size
          toFieldPath: spec.forProvider.manifest.spec.infrastructure.mariadb.replicas
          transforms:
            - type: map
              map:
                small: "1"
                medium: "3"
                large: "3"
                xlarge: "5"
        - fromFieldPath: spec.size
          toFieldPath: spec.forProvider.manifest.spec.openstack.keystone.replicas
          transforms:
            - type: map
              map:
                small: "1"
                medium: "3"
                large: "3"
                xlarge: "5"
        - fromFieldPath: spec.size
          toFieldPath: spec.forProvider.manifest.spec.openstack.nova.api.replicas
          transforms:
            - type: map
              map:
                small: "1"
                medium: "3"
                large: "5"
                xlarge: "7"

        # Enable/disable services
        - fromFieldPath: spec.services.octavia
          toFieldPath: spec.forProvider.manifest.spec.openstack.octavia.enabled
        - fromFieldPath: spec.services.manila
          toFieldPath: spec.forProvider.manifest.spec.openstack.manila.enabled

        # Cortex configuration
        - fromFieldPath: spec.cortex.enabled
          toFieldPath: spec.forProvider.manifest.spec.cortex.enabled
        - fromFieldPath: spec.cortex.pipelines
          toFieldPath: spec.forProvider.manifest.spec.cortex.pipelines

        # TLS configuration
        - fromFieldPath: spec.tls.enabled
          toFieldPath: spec.forProvider.manifest.spec.tls.enabled
        - fromFieldPath: spec.tls.issuerRef
          toFieldPath: spec.forProvider.manifest.spec.tls.issuerRef

    # ══════════════════════════════════════════════════════════════════════════
    # Ceph Resources (created in Storage Cluster via provider-kubernetes)
    # ══════════════════════════════════════════════════════════════════════════

    # CephBlockPool for Cinder volumes
    - name: ceph-blockpool-volumes
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha2
        kind: Object
        spec:
          providerConfigRef:
            name: ""  # Patched to storage cluster
          forProvider:
            manifest:
              apiVersion: ceph.rook.io/v1
              kind: CephBlockPool
              metadata:
                name: ""  # Patched
                namespace: rook-ceph
              spec:
                failureDomain: host
                replicated:
                  size: 3
                  requireSafeReplicaSize: true
                parameters:
                  compression_mode: aggressive
      patches:
        - fromFieldPath: spec.storageClusters[0]
          toFieldPath: spec.providerConfigRef.name
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.metadata.name
          transforms:
            - type: string
              string:
                fmt: "%s-volumes"

    # CephBlockPool for Glance images
    - name: ceph-blockpool-images
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha2
        kind: Object
        spec:
          providerConfigRef:
            name: ""  # Patched to storage cluster
          forProvider:
            manifest:
              apiVersion: ceph.rook.io/v1
              kind: CephBlockPool
              metadata:
                name: ""  # Patched
                namespace: rook-ceph
              spec:
                failureDomain: host
                replicated:
                  size: 3
                parameters:
                  compression_mode: aggressive
      patches:
        - fromFieldPath: spec.storageClusters[0]
          toFieldPath: spec.providerConfigRef.name
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.metadata.name
          transforms:
            - type: string
              string:
                fmt: "%s-images"

    # CephBlockPool for Nova ephemeral (optional)
    - name: ceph-blockpool-ephemeral
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha2
        kind: Object
        spec:
          providerConfigRef:
            name: ""  # Patched to storage cluster
          forProvider:
            manifest:
              apiVersion: ceph.rook.io/v1
              kind: CephBlockPool
              metadata:
                name: ""  # Patched
                namespace: rook-ceph
              spec:
                failureDomain: host
                replicated:
                  size: 2  # Fewer replicas for ephemeral
                parameters:
                  compression_mode: none  # Performance > Space
      patches:
        - fromFieldPath: spec.storageClusters[0]
          toFieldPath: spec.providerConfigRef.name
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.metadata.name
          transforms:
            - type: string
              string:
                fmt: "%s-ephemeral"

    # CephClient for OpenStack access (Cinder, Glance, Nova)
    - name: ceph-client-openstack
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha2
        kind: Object
        spec:
          providerConfigRef:
            name: ""  # Patched to storage cluster
          forProvider:
            manifest:
              apiVersion: ceph.rook.io/v1
              kind: CephClient
              metadata:
                name: ""  # Patched
                namespace: rook-ceph
              spec:
                caps:
                  mon: "profile rbd"
                  osd: ""  # Patched with pool permissions
                  mgr: "profile rbd"
      patches:
        - fromFieldPath: spec.storageClusters[0]
          toFieldPath: spec.providerConfigRef.name
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.metadata.name
          transforms:
            - type: string
              string:
                fmt: "openstack-%s"
        # OSD caps with pool permissions
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.spec.caps.osd
          transforms:
            - type: string
              string:
                fmt: "profile rbd pool=%s-volumes, profile rbd pool=%s-images, profile rbd pool=%s-ephemeral"
              string:
                fmt: "profile rbd pool=%s-volumes, profile rbd pool=%s-images, profile rbd pool=%s-ephemeral"

    # CephFilesystem for Manila (optional, when Manila enabled)
    - name: ceph-filesystem-manila
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha2
        kind: Object
        spec:
          providerConfigRef:
            name: ""  # Patched to storage cluster
          forProvider:
            manifest:
              apiVersion: ceph.rook.io/v1
              kind: CephFilesystem
              metadata:
                name: ""  # Patched
                namespace: rook-ceph
              spec:
                metadataPool:
                  replicated:
                    size: 3
                dataPools:
                  - name: data0
                    replicated:
                      size: 3
                metadataServer:
                  activeCount: 1
                  activeStandby: true
      patches:
        - fromFieldPath: spec.storageClusters[0]
          toFieldPath: spec.providerConfigRef.name
        - fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.manifest.metadata.name
          transforms:
            - type: string
              string:
                fmt: "%s-cephfs"
```

## Ceph Resource Management via CRDs

Crossplane **automatically creates all required Ceph resources** in the Storage cluster when an OpenStack cluster is provisioned:

```text
┌────────────────────────────────────────────────────────────────────────────────────┐
│              Ceph Resource Management via Crossplane + Rook                        │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│  MANAGEMENT CLUSTER                                                                │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │  Crossplane                                                                  │  │
│  │                                                                              │  │
│  │  XOpenStackCluster Claim                                                     │  │
│  │  ┌────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  name: customer-a-prod                                                 │  │  │
│  │  │  storageClusters: [st-pool-a]                                          │  │  │
│  │  └────────────────────────────────────────────────────────────────────────┘  │  │
│  │                          │                                                   │  │
│  │                          │ Composition creates                               │  │
│  │                          ▼                                                   │  │
│  │  ┌────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  provider-kubernetes Objects (for Storage Cluster st-pool-a)           │  │  │
│  │  │                                                                        │  │  │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │  │  │
│  │  │  │CephBlockPool │ │CephBlockPool │ │CephBlockPool │ │ CephClient   │   │  │  │
│  │  │  │customer-a-   │ │customer-a-   │ │customer-a-   │ │ openstack-   │   │  │  │
│  │  │  │prod-volumes  │ │prod-images   │ │prod-ephemeral│ │ customer-a   │   │  │  │
│  │  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘   │  │  │
│  │  │                                                                        │  │  │
│  │  │  ┌──────────────┐                                                      │  │  │
│  │  │  │CephFilesystem│  (when Manila enabled)                               │  │  │
│  │  │  │customer-a-   │                                                      │  │  │
│  │  │  │prod-cephfs   │                                                      │  │  │
│  │  │  └──────────────┘                                                      │  │  │
│  │  └────────────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                          │                                                         │
│                          │ provider-kubernetes                                     │
│                          ▼                                                         │
│  STORAGE CLUSTER (st-pool-a)                                                       │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │  Rook-Ceph Operator                                                          │  │
│  │                                                                              │  │
│  │  ┌────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  CephCluster (from Storage Pool provisioning)                          │  │  │
│  │  └────────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                              │  │
│  │  Per OpenStack cluster created:                                              │  │
│  │  ┌────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │                                                                        │  │  │
│  │  │  CephBlockPool: customer-a-prod-volumes                                │  │  │
│  │  │  ├── Replication: 3                                                    │  │  │
│  │  │  ├── Failure Domain: host                                              │  │  │
│  │  │  └── Usage: Cinder Volumes                                             │  │  │
│  │  │                                                                        │  │  │
│  │  │  CephBlockPool: customer-a-prod-images                                 │  │  │
│  │  │  ├── Replication: 3                                                    │  │  │
│  │  │  ├── Compression: aggressive                                           │  │  │
│  │  │  └── Usage: Glance Images                                              │  │  │
│  │  │                                                                        │  │  │
│  │  │  CephBlockPool: customer-a-prod-ephemeral                              │  │  │
│  │  │  ├── Replication: 2 (fewer for ephemeral)                              │  │  │
│  │  │  └── Usage: Nova Ephemeral Disks                                       │  │  │
│  │  │                                                                        │  │  │
│  │  │  CephClient: openstack-customer-a-prod                                 │  │  │
│  │  │  ├── Mon Caps: profile rbd                                             │  │  │
│  │  │  ├── OSD Caps: profile rbd pool=*-volumes, pool=*-images, ...          │  │  │
│  │  │  └── Secret: rook-ceph-client-openstack-customer-a-prod                │  │  │
│  │  │                                                                        │  │  │
│  │  │  CephFilesystem: customer-a-prod-cephfs (when Manila enabled)          │  │  │
│  │  │  ├── Metadata Pool: 3 replicas                                         │  │  │
│  │  │  ├── Data Pool: 3 replicas                                             │  │  │
│  │  │  └── MDS: 1 active + 1 standby                                         │  │  │
│  │  │                                                                        │  │  │
│  │  └────────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                              │  │
│  │  Rook-Ceph Operator reconciles the CRDs and creates:                         │  │
│  │  • RADOS pools in the Ceph cluster                                           │  │
│  │  • Ceph auth keys as Kubernetes Secrets                                      │  │
│  │  • CephFS MDS daemons (when CephFilesystem)                                  │  │
│  │                                                                              │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## Rook-Ceph CRDs for OpenStack

| CRD                     | Description                        | OpenStack Service          |
| ----------------------- | ---------------------------------- | -------------------------- |
| **CephBlockPool**       | RBD pool for block storage         | Cinder, Glance, Nova       |
| **CephClient**          | Ceph auth client with capabilities | All services               |
| **CephFilesystem**      | CephFS for shared filesystem       | Manila                     |
| **CephObjectStore**     | RadosGW for object storage         | Swift (optional)           |
| **CephRBDMirror**       | RBD mirroring for DR               | Cinder (Disaster Recovery) |
| **CephObjectStoreUser** | S3/Swift user credentials          | Swift, RadosGW             |

## Ceph Resource Lifecycle

```text
┌────────────────────────────────────────────────────────────────────────────────────┐
│                      Ceph Resource Lifecycle (End-to-End)                          │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│  1. USER CLAIM (Management Cluster)                                                │
│  ══════════════════════════════════                                                │
│                                                                                    │
│  OpenStackCluster Claim                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │  spec:                                                                       │  │
│  │    storageClusters: [st-pool-a]                                              │  │
│  │    storage:                                                                  │  │
│  │      ceph:                                                                   │  │
│  │        volumePool: { replication: 3, quotaGB: 10000 }                        │  │
│  │        imagePool: { replication: 3, compression: aggressive }                │  │
│  │        filesystem: { enabled: true }                                         │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                          │                                                         │
│                          ▼                                                         │
│  2. CROSSPLANE COMPOSITION (Management Cluster)                                    │
│  ══════════════════════════════════════════════                                    │
│                                                                                    │
│  Composition creates provider-kubernetes Objects:                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                              │  │
│  │  Object: CephBlockPool (→ Storage Cluster)                                   │  │
│  │  Object: CephClient (→ Storage Cluster)                                      │  │
│  │  Object: CephFilesystem (→ Storage Cluster)                                  │  │
│  │  Object: Secret-Sync (Storage → Control Plane)                               │  │
│  │  Object: ControlPlane CR (→ Control Plane Cluster)                           │  │
│  │                                                                              │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                          │                                                         │
│          ┌───────────────┼───────────────┐                                         │
│          ▼               ▼               ▼                                         │
│                                                                                    │
│  3. ROOK-CEPH (Storage Cluster)      4. C5C3-OPERATOR (Control Plane Cluster)      │
│  ══════════════════════════════      ════════════════════════════════════════      │
│                                                                                    │
│  ┌────────────────────────────┐      ┌────────────────────────────────────────┐    │
│  │ Rook Operator reconciles:  │      │ c5c3-operator reconciles ControlPlane: │    │
│  │                            │      │                                        │    │
│  │ CephBlockPool CR           │      │ • Reads Ceph Secret                    │    │
│  │ ├── Creates RADOS Pool     │ ───► │ • Configures Cinder Backend            │    │
│  │ └── Sets Pool Quotas       │      │ • Configures Glance Backend            │    │
│  │                            │      │ • Configures Nova Ephemeral            │    │
│  │ CephClient CR              │      │ • Starts OpenStack Services            │    │
│  │ ├── Creates Ceph User      │      │                                        │    │
│  │ ├── Sets Capabilities      │      │ ControlPlane CR Status:                │    │
│  │ └── Creates K8s Secret     │      │ ├── ceph.volumePool: Ready             │    │
│  │                            │      │ ├── ceph.imagePool: Ready              │    │
│  │ CephFilesystem CR          │      │ └── services.cinder: Running           │    │
│  │ ├── Creates CephFS         │      │                                        │    │
│  │ ├── Starts MDS Daemons     │      └────────────────────────────────────────┘    │
│  │ └── Creates CephFS Pools   │                                                    │
│  │                            │                                                    │
│  │ Status written back to CR  │                                                    │
│  └────────────────────────────┘                                                    │
│                          │                                                         │
│                          ▼                                                         │
│  5. STATUS PROPAGATION                                                             │
│  ═════════════════════════                                                         │
│                                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │  Crossplane propagates status back to claim:                                 │  │
│  │                                                                              │  │
│  │  OpenStackCluster Status:                                                    │  │
│  │  ├── phase: Ready                                                            │  │
│  │  ├── cephResources:                                                          │  │
│  │  │   ├── volumePool:                                                         │  │
│  │  │   │   ├── name: customer-a-prod-volumes                                   │  │
│  │  │   │   ├── status: Ready                                                   │  │
│  │  │   │   ├── usedBytes: 1073741824                                           │  │
│  │  │   │   └── quotaBytes: 10737418240000                                      │  │
│  │  │   ├── imagePool:                                                          │  │
│  │  │   │   └── status: Ready                                                   │  │
│  │  │   ├── filesystem:                                                         │  │
│  │  │   │   ├── name: customer-a-prod-cephfs                                    │  │
│  │  │   │   └── mdsActive: 1                                                    │  │
│  │  │   └── client:                                                             │  │
│  │  │       ├── name: openstack-customer-a-prod                                 │  │
│  │  │       └── secretRef: ceph-client-customer-a-prod                          │  │
│  │  └── endpoints:                                                              │  │
│  │      └── keystone: https://keystone.customer-a-prod.svc                      │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## Ceph Integration in c5c3-operator

The c5c3-operator consumes the Ceph resources created by Crossplane:

```yaml
# ControlPlane CR with Ceph references (in Control Plane Cluster)
apiVersion: c5c3.io/v1alpha1
kind: ControlPlane
metadata:
  name: customer-a-prod
  namespace: openstack-customer-a-prod
spec:
  storage:
    storageClusters:
      - st-pool-a

    # Ceph configuration (provided by Crossplane)
    ceph:
      # Secret with Ceph auth key (synchronized by Crossplane)
      secretRef:
        name: ceph-client-customer-a-prod
        key: userKey

      # Ceph monitor endpoints (from Storage Cluster)
      monitors:
        - 10.0.1.10:6789
        - 10.0.1.11:6789
        - 10.0.1.12:6789

      # Pool names (created by Crossplane)
      pools:
        volumes: customer-a-prod-volumes
        images: customer-a-prod-images
        ephemeral: customer-a-prod-ephemeral

      # CephFS (when Manila enabled)
      filesystem:
        name: customer-a-prod-cephfs

  openstack:
    cinder:
      enabled: true
      backends:
        - name: ceph-volumes
          type: rbd
          pool: customer-a-prod-volumes
          secretRef: ceph-client-customer-a-prod

    glance:
      enabled: true
      backend:
        type: rbd
        pool: customer-a-prod-images

    nova:
      ephemeral:
        backend: rbd
        pool: customer-a-prod-ephemeral

    manila:
      enabled: true
      backends:
        - name: cephfs
          type: cephfs
          filesystem: customer-a-prod-cephfs
```

## CephObjectStore for Swift Compatibility (optional)

If Swift API compatibility is required, Crossplane can also provision RadosGW:

```yaml
# In the OpenStack Composition (when Swift/Object Storage enabled)
- name: ceph-objectstore
  base:
    apiVersion: kubernetes.crossplane.io/v1alpha2
    kind: Object
    spec:
      providerConfigRef:
        name: ""  # Storage Cluster
      forProvider:
        manifest:
          apiVersion: ceph.rook.io/v1
          kind: CephObjectStore
          metadata:
            name: ""  # Patched
            namespace: rook-ceph
          spec:
            metadataPool:
              replicated:
                size: 3
            dataPool:
              replicated:
                size: 3
            gateway:
              port: 80
              securePort: 443
              instances: 2
  patches:
    - fromFieldPath: spec.storageClusters[0]
      toFieldPath: spec.providerConfigRef.name
    - fromFieldPath: metadata.name
      toFieldPath: spec.forProvider.manifest.metadata.name
      transforms:
        - type: string
          string:
            fmt: "%s-rgw"

# CephObjectStoreUser for Swift/S3 access
- name: ceph-objectstore-user
  base:
    apiVersion: kubernetes.crossplane.io/v1alpha2
    kind: Object
    spec:
      providerConfigRef:
        name: ""  # Storage Cluster
      forProvider:
        manifest:
          apiVersion: ceph.rook.io/v1
          kind: CephObjectStoreUser
          metadata:
            name: ""  # Patched
            namespace: rook-ceph
          spec:
            store: ""  # Patched
            displayName: ""  # Patched
            capabilities:
              user: "*"
              bucket: "*"
  patches:
    - fromFieldPath: spec.storageClusters[0]
      toFieldPath: spec.providerConfigRef.name
    - fromFieldPath: metadata.name
      toFieldPath: spec.forProvider.manifest.metadata.name
      transforms:
        - type: string
          string:
            fmt: "swift-%s"
    - fromFieldPath: metadata.name
      toFieldPath: spec.forProvider.manifest.spec.store
      transforms:
        - type: string
          string:
            fmt: "%s-rgw"
    - fromFieldPath: metadata.name
      toFieldPath: spec.forProvider.manifest.spec.displayName
      transforms:
        - type: string
          string:
            fmt: "OpenStack Swift User - %s"
```

## CephClient Secret Propagation

The Ceph keys created by Rook are automatically propagated to the Control Plane Cluster:

```yaml
# Rook automatically creates a Secret in the Storage Cluster
apiVersion: v1
kind: Secret
metadata:
  name: rook-ceph-client-openstack-customer-a-prod
  namespace: rook-ceph
type: kubernetes.io/rook
data:
  # Base64-encoded Ceph keyring
  userKey: QVFEa1...==

---
# Crossplane copies the Secret to the Control Plane Cluster
# via provider-kubernetes ExternalSecret or Secret-Sync
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  name: ceph-client-secret-sync
spec:
  providerConfigRef:
    name: control-plane-cluster
  forProvider:
    manifest:
      apiVersion: v1
      kind: Secret
      metadata:
        name: ceph-client-customer-a-prod
        namespace: openstack-customer-a-prod
      type: Opaque
      # Data is synchronized via Crossplane Function or External-Secrets
```

## Ceph Resources in XOpenStackCluster Claim

The user can optionally specify Ceph-specific configuration in the Claim:

```yaml
apiVersion: c5c3.io/v1alpha1
kind: OpenStackCluster
metadata:
  name: customer-a-prod
  namespace: tenant-customer-a
spec:
  region: eu-de-1
  size: large

  hypervisorClusters:
    - hv-pool-a
  storageClusters:
    - st-pool-a

  # Ceph storage configuration (optional)
  storage:
    ceph:
      # Volume pool configuration
      volumePool:
        replication: 3
        compression: aggressive
        quotaGB: 10000  # 10TB quota

      # Image pool configuration
      imagePool:
        replication: 3
        compression: aggressive

      # Ephemeral pool (for Nova local disk)
      ephemeralPool:
        enabled: true
        replication: 2

      # CephFS for Manila
      filesystem:
        enabled: true  # Only when Manila activated
        dataPoolReplication: 3

  services:
    cinder: true
    glance: true
    manila: true  # Activates CephFilesystem
```

***
