# Introduction

**CobaltCore** (C5C3) is a Kubernetes-native OpenStack distribution for operating Hosted Control Planes.
The system enables automated provisioning and management of OpenStack environments on bare-metal infrastructure
— from cluster creation via [Crossplane](./07-crossplane/), through GitOps-driven service deployment with [FluxCD](./05-deployment/01-gitops-fluxcd/), to secret lifecycle management via [OpenBao](./05-deployment/02-secret-management.md).

## Target Audience

This documentation is intended for:

* **Platform Architects** evaluating CobaltCore or integrating it into existing infrastructure
* **Platform Engineers** deploying, operating, and extending CobaltCore
* **Consumers (Tenants)** using CobaltCore as a platform via Crossplane (see [Crossplane Documentation](./07-crossplane/))

## Scope and Boundaries

This documentation describes the **architecture and design** of CobaltCore. It covers:

* [Multi-cluster architecture](./02-architecture-overview.md) and cluster roles
* [Operator and agent architecture](./03-components/) with [CRD definitions](./04-architecture/01-crds.md)
* [Component interaction](./04-architecture/02-component-interaction.md) and cross-cluster communication
* Lifecycle management ([Hypervisor](./04-architecture/03-hypervisor-lifecycle.md), [Upgrades](./06-operations/01-upgrades.md), [Secrets](./05-deployment/02-secret-management.md))
* [GitOps deployment with FluxCD](./05-deployment/01-gitops-fluxcd/)
* Consumer interface via [Crossplane](./07-crossplane/)

**Out of scope** for this documentation:

* Installation and operations manual (Runbooks)
* Troubleshooting and debugging procedures
* Performance benchmarks and sizing recommendations

## Core Functionality

* **Kubernetes-native OpenStack Control Plane**: Modular, extensible operator architecture for OpenStack services (e.g., Keystone, Nova, Neutron, Glance, Cinder, Placement)
* **Automated Bare-Metal Provisioning**: [IronCore](https://github.com/ironcore-dev/ironcore) integration for server discovery, OS installation, and hardware configuration
* **Multi-Cluster Architecture**: Strict separation of Management, Control Plane, Hypervisor, and Storage clusters for isolation and scalability
* **GitOps-based Lifecycle Management**: [FluxCD](https://github.com/fluxcd/flux2) for declarative deployment, [OpenBao](https://github.com/openbao/openbao) for centralized secret management
* **High Availability**: Automatic failover for VMs, Galera cluster for databases, Raft consensus for OVN
* **Container Image Build Pipeline**: Custom OCI images built with [uv](https://github.com/astral-sh/uv), structured patching without repository forks, and signed SBOM attestation via Sigstore (see [Container Images](./08-container-images/))

## Optional Extensions

The modular architecture enables the integration of additional OpenStack services and extensions:

* [Cortex](https://github.com/cobaltcore-dev/cortex): Intelligent multi-domain scheduler for advanced placement logic (see [Cortex Scheduling](./04-architecture/05-cortex-scheduling.md))
* [Greenhouse](https://github.com/cloudoperators/greenhouse): Centralized monitoring and alerting
* [Aurora Dashboard](https://github.com/cobaltcore-dev/aurora-dashboard): Unified management UI

## Future Extensions

The following services are planned for future integration:

* [Ceilometer](https://docs.openstack.org/ceilometer/latest/): Metering and telemetry for resource consumption
* [Limes](https://github.com/sapcc/limes): Quota and limits management
