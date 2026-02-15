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
│  │ • Greenhouse (opt)  │    │ • K-ORC             │    │ • KVM/LibVirt       │  │
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
| `kvm.c5c3.io`                 | v1, v1alpha1 | Hypervisor, Eviction, Migration                                              | Hypervisor Lifecycle                              |
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

Container images are tagged with the **upstream project version** (not the release series). The following table shows the currently integrated components (exemplary, additional services will be added incrementally):

| Component  | Upstream Version | Image                           |
| ---------- | ---------------- | ------------------------------- |
| Keystone   | 28.0.0           | `ghcr.io/c5c3/keystone:28.0.0`  |
| Nova       | 32.1.0           | `ghcr.io/c5c3/nova:32.1.0`      |
| Neutron    | 27.0.1           | `ghcr.io/c5c3/neutron:27.0.1`   |
| Glance     | 31.0.0           | `ghcr.io/c5c3/glance:31.0.0`    |
| Cinder     | 27.0.0           | `ghcr.io/c5c3/cinder:27.0.0`    |
| Placement  | 14.0.0           | `ghcr.io/c5c3/placement:14.0.0` |
| OVN        | 24.03.4          | `ghcr.io/c5c3/ovn:24.03.4`      |
| OVS        | 3.4.1            | `ghcr.io/c5c3/ovs:3.4.1`        |
