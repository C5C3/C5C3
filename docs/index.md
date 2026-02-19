# CobaltCore Architecture Documentation

> **⚠️ Notice: Early Concept Phase**
> This project is in an early concept phase. Feedback, reviews, and suggestions are currently being incorporated. All concepts, architectures, and implementations are in flux and subject to fundamental changes. Nothing is finalized yet – everything is open to adjustments and improvements.

**CobaltCore** is a Kubernetes-native OpenStack distribution for operating Hosted Control Planes.

## Multi-Cluster Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│  ┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐  │
│  │  MANAGEMENT CLUSTER │    │CONTROL PLANE CLUSTER│    │  HYPERVISOR CLUSTER │  │
│  │  (Gardener)         │    │(Gardener)           │    │  (Bare-Metal)       │  │
│  ├─────────────────────┤    ├─────────────────────┤    ├─────────────────────┤  │
│  │ • Flux Op. (GitOps) │    │ • c5c3-operator     │    │ • Hypervisor Op.    │  │
│  │ • OpenBao (Secrets) │───▶│ • Service Operators │───▶│ • ovn-controller    │  │
│  │ • ESO (Secrets)     │    │ • ovn-operator      │    │ • Node Agents       │  │
│  │ • Greenhouse (opt)  │    │ • K-ORC             │    │ • LibVirt           │  │
│  │ • Aurora (opt)      │    │                     │    │                     │  │
│  └─────────────────────┘    └─────────────────────┘    └──────────┬──────────┘  │
│                                                                   │             │
│                                      ┌────────────────────────────┘             │
│                                      │                                          │
│                                      ▼                                          │
│                             ┌─────────────────────┐                             │
│                             │   STORAGE CLUSTER   │                             │
│                             │   (Bare-Metal)      │                             │
│                             ├─────────────────────┤                             │
│                             │ • Rook Operator     │                             │
│                             │ • Ceph (MON/OSD)    │                             │
│                             │ • Prysm             │                             │
│                             └─────────────────────┘                             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## API Groups

> **Naming Convention for OpenStack Services:** `<service>.openstack.c5c3.io` — extensible for future services (e.g., Ceilometer, Limes)

| API Group                     | Version      | CRDs                                                                         | Usage                                             |
| ----------------------------- | ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `c5c3.io`                     | v1alpha1     | ControlPlane, SecretAggregate, CredentialRotation                            | Orchestration, Dependencies, Credential Lifecycle |
| `keystone.openstack.c5c3.io`  | v1alpha1     | Keystone                                                                     | Identity Service                                  |
| `glance.openstack.c5c3.io`    | v1alpha1     | Glance                                                                       | Image Service                                     |
| `placement.openstack.c5c3.io` | v1alpha1     | Placement                                                                    | Resource Tracking                                 |
| `nova.openstack.c5c3.io`      | v1alpha1     | Nova                                                                         | Compute Service                                   |
| `neutron.openstack.c5c3.io`   | v1alpha1     | Neutron                                                                      | Network Service                                   |
| `cinder.openstack.c5c3.io`    | v1alpha1     | Cinder                                                                       | Block Storage                                     |
| `ovn.c5c3.io`                 | v1alpha1     | OVNCluster, OVNChassis                                                       | OVN SDN Backend                                   |
| `ovs.c5c3.io`                 | v1alpha1     | OVSNode                                                                      | OVS Node Status                                   |
| `hypervisor.c5c3.io`          | v1, v1alpha1 | Hypervisor, Eviction, Migration                                              | Hypervisor Lifecycle                              |
| `ceph.c5c3.io`                | v1alpha1     | RemoteCluster, RemoteArbiter                                                 | Ceph Stretched Cluster Arbiter                    |
| `cortex.c5c3.io`              | v1alpha1     | Cortex                                                                       | Intelligent Scheduler (optional)                  |
| `openstack.k-orc.cloud`       | v1alpha1     | Domain, Project, Role, Group, Service, Endpoint, User, ApplicationCredential | Keystone Resource Management (K-ORC)              |
| `crossplane.c5c3.io`          | v1alpha1     | XControlPlaneCluster, XHypervisorCluster, XStorageCluster                    | Consumer Interface (Crossplane XRDs)              |

## Repositories

| Repository                    | Description                              |
| ----------------------------- | ---------------------------------------- |
| `github.com/c5c3/c5c3`        | Monorepo (Operators, Agents, Components) |
| `github.com/cobaltcore-dev/*` | Prysm, Cortex, Aurora, Labels Injector   |

## Container Registry

```text
ghcr.io/c5c3/<service>:<upstream-version>
```

OpenStack Release: **2025.2 (Flamingo)**

Container images are built as Multi-Stage OCI images using `uv` as the Python package manager. They support structured patching (Service-Patches, Library-Patches, Constraint-Overrides) without requiring repository forks. Details: [Container Images](./17-container-images/).

Container images are tagged with the **upstream project version** (not the release series). The full list of currently integrated components, the tag schema, and versioning details are maintained in [Container Images](./17-container-images/#container-registry).
