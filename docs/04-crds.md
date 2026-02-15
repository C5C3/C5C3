# CRDs

CobaltCore defines several Custom Resource Definitions (CRDs) for declarative management of hypervisors, evictions, migrations, storage arbiters, and network status. The following CRDs form the central API interface of the system.

## Hypervisor CRD (`kvm.c5c3.io/v1`)

Represents a KVM hypervisor node in the cluster.

```yaml
apiVersion: kvm.c5c3.io/v1
kind: Hypervisor
metadata:
  name: hypervisor-001
spec:
  version: "1.0.0"                    # Desired OS version
  reboot: false                       # Request reboot after upgrade
  evacuateOnReboot: true              # Evacuation before reboot
  lifecycleEnabled: true              # Lifecycle management enabled
  skipTests: false                    # Skip onboarding tests
  customTraits: []                    # Custom OpenStack traits
  aggregates: []                      # Host aggregates
  allowedProjects: []                 # Allowed OpenStack projects
  highAvailability: true              # HA handling enabled
  createCertManagerCertificate: false # Create Cert-Manager certificate
  installCertificate: true            # Certificate installation via agent
  maintenance: ""                     # manual|auto|ha|termination
status:
  libVirtVersion: "8.0.0"
  operatingSystem:
    version: "1.0.0"
    variantID: "garden-linux"
    kernelRelease: "6.1.0"
    hardwareVendor: "Dell"
    hardwareModel: "PowerEdge R750"
  capabilities:
    cpuArch: "x86_64"
    memory: "512Gi"
    cpus: "128"
  domainCapabilities:
    arch: "x86_64"
    hypervisorType: "kvm"
    supportedDevices: ["video", "network"]
    supportedCpuModes: ["host-passthrough"]
    supportedFeatures: ["sev", "sgx"]
  instances:
    - id: "abc123"
      name: "vm-001"
      active: true
  numInstances: 5
  hypervisorId: "hv-001"
  serviceId: "svc-001"
  conditions:
    - type: Ready
      status: "True"
      reason: Ready
    - type: Onboarding
      status: "False"
```

**Condition Types:**

| Type                | Description                   |
| ------------------- | ----------------------------- |
| `Onboarding`        | Onboarding status of the node |
| `Offboarded`        | Completed offboarding         |
| `Ready`             | Readiness status              |
| `Terminating`       | Node is being terminated      |
| `Tainted`           | Node is tainted               |
| `TraitsUpdated`     | Traits have been updated      |
| `AggregatesUpdated` | Aggregates have been updated  |

**Maintenance Modes:**

| Mode          | Description                              |
| ------------- | ---------------------------------------- |
| `manual`      | Manual maintenance mode by external user |
| `auto`        | Automatic maintenance mode               |
| `ha`          | High availability maintenance mode       |
| `termination` | Internal mode during termination         |

## Eviction CRD (`kvm.c5c3.io/v1`)

Represents an eviction request for a hypervisor.

```yaml
apiVersion: kvm.c5c3.io/v1
kind: Eviction
metadata:
  name: eviction-001
spec:
  hypervisor: "hypervisor-001"    # Name of hypervisor to evacuate
  reason: "Planned maintenance"   # Reason for eviction
status:
  hypervisorServiceId: "svc-001"
  outstandingRamMb: 16384
  outstandingInstances:
    - "vm-001"
    - "vm-002"
  conditions:
    - type: Evicting
      status: "True"
      reason: Running
```

**Eviction Condition Types:**

| Type                       | Description                  |
| -------------------------- | ---------------------------- |
| `MigratingInstance`        | Migration status of a server |
| `PreflightChecksSucceeded` | Preflight checks successful  |
| `HypervisorReEnabled`      | Hypervisor re-enabled        |
| `HypervisorDisabled`       | Hypervisor disabled          |
| `Evicting`                 | Eviction status              |

## Migration CRD (`kvm.c5c3.io/v1alpha1`)

Represents an ongoing VM migration with detailed metrics.

```yaml
apiVersion: kvm.c5c3.io/v1alpha1
kind: Migration
metadata:
  name: migration-vm-001
spec: {}
status:
  origin: "hypervisor-001"
  destination: "hypervisor-002"
  type: "live"
  started: "2024-01-15T10:00:00Z"
  operation: "running"

  # Timing metrics
  timeElapsed: "45s"
  timeRemaining: "30s"
  setupTime: "5s"
  downtime: "0s"

  # Data transfer
  dataTotal: "32Gi"
  dataProcessed: "20Gi"
  dataRemaining: "12Gi"

  # Memory metrics
  memTotal: "16Gi"
  memProcessed: "10Gi"
  memRemaining: "6Gi"
  memBps: "1Gi"
  memDirtyRate: "100Mi"
  memIteration: 3
  memPageSize: "4Ki"
  memNormal: 2621440
  memConstant: 1048576
  memPostcopyRequests: 0

  # Disk metrics
  diskTotal: "16Gi"
  diskProcessed: "10Gi"
  diskRemaining: "6Gi"
  diskBps: "500Mi"

  # Additional information
  autoConvergeThrottle: "0"
  errMsg: ""
```

## RemoteCluster CRD (`ceph.c5c3.io/v1alpha1`)

Defines access to a remote Kubernetes cluster for external arbiter deployment.

```yaml
apiVersion: ceph.c5c3.io/v1alpha1
kind: RemoteCluster
metadata:
  name: arbiter-site
spec:
  # Namespace in remote cluster for arbiter deployment
  namespace: external-arbiter
  # Reference to secret with kubeconfig
  accesskeyRef:
    name: arbiter-kubeconfig
    key: "kubeconfig.yaml"
  # Interval for health checks
  checkInterval: 1m
  # Request timeout for remote client
  timeout: 10s
status:
  state: Ready  # Init|Progressing|Error|Ready|Deleting
  message: "Cluster reachable and permissions verified"
  conditions:
    - type: SecretAvailable
      status: "True"
    - type: ConfigValid
      status: "True"
    - type: ClusterReachable
      status: "True"
    - type: HasEnoughPermissions
      status: "True"
```

## RemoteArbiter CRD (`ceph.c5c3.io/v1alpha1`)

Defines a Ceph Monitor (arbiter) to be deployed in a RemoteCluster.

```yaml
apiVersion: ceph.c5c3.io/v1alpha1
kind: RemoteArbiter
metadata:
  name: stretched-cluster-arbiter
spec:
  # Reference to RemoteCluster or inline spec
  remoteCluster:
    name: arbiter-site  # Name of RemoteCluster in same namespace
  # Reference to Rook-managed CephCluster
  cephCluster:
    name: my-cluster
    namespace: rook-ceph
  # Prefix for monitor ID (e.g., "ext-a", "ext-b")
  monIdPrefix: "ext-"
  # Interval for health checks
  checkInterval: 1m
  # Optional: Service configuration for arbiter exposure
  service:
    type: NodePort
    nodeIp: 10.10.0.1
  # Optional: Pod configuration
  deployment:
    nodeSelector:
      node-role: arbiter
status:
  state: Ready  # Init|Progressing|Error|Ready|Deleting
  monId: "ext-a"  # Reserved monitor ID
  message: "Arbiter deployed and joined quorum"
  conditions:
    - type: RemoteClusterReady
      status: "True"
    - type: CephClusterReady
      status: "True"
    - type: ArbiterDeploymentReady
      status: "True"
```

**Use Case for Stretched Cluster:**

```text
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│    Datacenter A     │     │    Datacenter B     │     │   Arbiter Site      │
│    (Storage Cluster)│     │    (Storage Cluster)│     │   (Arbiter Cluster) │
│                     │     │                     │     │                     │
│  MON + OSDs         │     │  MON + OSDs         │     │  MON only           │
│  Ext. Arbiter Op ───┼─────┼─────────────────────┼─────┼─▶ (Tiebreaker)      │
│                     │     │                     │     │                     │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
```

## OVSNode CRD (`ovs.c5c3.io/v1alpha1`)

Represents the OVS status of a hypervisor node. Automatically created and updated by the **OVS Agent**.

```yaml
apiVersion: ovs.c5c3.io/v1alpha1
kind: OVSNode
metadata:
  name: hypervisor-node-01
  namespace: ovn-system
spec:
  nodeRef:
    name: hypervisor-node-01
status:
  ovsVersion: "3.4.1"
  dpdkEnabled: true
  dpdkVersion: "23.11.1"
  bridges:
    - name: br-int
      ports: 156
      flows: 2847
      status: Active
    - name: br-ex
      ports: 2
      flows: 45
      status: Active
  interfaces:
    bonds:
      - name: bond0
        mode: balance-tcp
        status: Active
        members: 2
  ovnController:
    connected: true
    chassisId: "a1b2c3d4-..."
  conditions:
    - type: Ready
      status: "True"
    - type: OVSDBConnected
      status: "True"
    - type: OVNControllerConnected
      status: "True"
```

## K-ORC Keystone CRDs (`openstack.k-orc.cloud/v1alpha1`)

K-ORC (Kubernetes OpenStack Resource Controller) provides CRDs for declarative management of Keystone resources. These CRDs are essential for the bootstrap process — without them, OpenStack services cannot register in the service catalog or authenticate.

**Common Fields:**

All K-ORC CRDs share the following fields:

| Field | Description |
| ----- | ----------- |
| `spec.cloudCredentialsRef.cloudName` | Cloud name from `clouds.yaml` |
| `spec.cloudCredentialsRef.secretName` | Kubernetes Secret containing `clouds.yaml` |
| `spec.managementPolicy` | `managed` (full lifecycle) or `unmanaged` (read-only import) |

### Service CRD

Registers an OpenStack service in the Keystone service catalog.

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Service
metadata:
  name: nova-service
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    name: nova
    type: compute
    description: "OpenStack Compute Service"
```

### Endpoint CRD

Registers a service endpoint (public or internal) in the Keystone service catalog.

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Endpoint
metadata:
  name: nova-public
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    serviceRef: nova-service
    interface: public
    url: "https://compute.example.com"
    region: RegionOne

---
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Endpoint
metadata:
  name: nova-internal
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    serviceRef: nova-service
    interface: internal
    url: "http://nova-api.openstack.svc:8774"
    region: RegionOne
```

### User CRD

Creates a service user in Keystone for service-to-service authentication.

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: nova-service-user
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    name: nova
    domainRef: default
    passwordSecretRef:
      name: openstack-service-passwords
      key: nova-password
```

### ApplicationCredential CRD

Creates an Application Credential for secure, restricted authentication.

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: ApplicationCredential
metadata:
  name: k-orc-app-credential
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    name: k-orc-app-credential
    userRef: k-orc-service-user
    roles:
      - admin
    expiresAt: "2025-04-15T00:00:00Z"
    secretRef:
      name: k-orc-app-credential-secret
```

### Domain CRD

Manages Keystone identity domains.

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Domain
metadata:
  name: default-domain
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    name: Default
    description: "Default domain"
    enabled: true
```

### Project CRD

Manages Keystone projects within a domain.

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Project
metadata:
  name: service-project
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    name: service
    domainRef: default-domain
    description: "Service project for OpenStack services"
    enabled: true
    tags: ["infrastructure", "service"]
```

### Role CRD

Manages RBAC roles in Keystone.

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Role
metadata:
  name: admin-role
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    name: admin
    description: "Admin role"
```

### Group CRD

Manages user groups in Keystone.

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Group
metadata:
  name: service-admins
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    name: service-admins
    domainRef: default-domain
    description: "Group for service administrators"
```

***
