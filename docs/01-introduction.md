# Introduction

**CobaltCore** (c5c3) is a Kubernetes-native OpenStack distribution for operating Hosted Control Planes. The system enables fully automated provisioning and management of OpenStack environments on bare-metal infrastructure through the use of Kubernetes Operators and GitOps principles.

## Target Audience

This documentation is intended for:

* **Platform Architects** evaluating CobaltCore or integrating it into existing infrastructure
* **Platform Engineers** deploying, operating, and extending CobaltCore
* **Consumers (Tenants)** using CobaltCore as a platform via Crossplane (see [Crossplane Documentation](12-crossplane/))

## Scope and Boundaries

This documentation describes the **architecture and design** of CobaltCore. It covers:

* Multi-cluster architecture and cluster roles
* Operator and agent architecture with CRD definitions
* Component interaction and cross-cluster communication
* Lifecycle management (Hypervisor, Upgrades, Secrets)
* GitOps deployment with FluxCD
* Consumer interface via Crossplane

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
* **Container Image Build Pipeline**: Custom OCI images built with [uv](https://github.com/astral-sh/uv), structured patching without repository forks, and signed SBOM attestation via Sigstore (see [Container Images](./17-container-images/))

## Optional and Future Extensions

The modular architecture enables the integration of additional OpenStack services and extensions. The following list is exemplary and will be continuously expanded:

* [Cortex](https://github.com/cobaltcore-dev/cortex): Intelligent multi-domain scheduler for advanced placement logic
* [Ceilometer](https://docs.openstack.org/ceilometer/latest/): Metering and telemetry for resource consumption
* [Limes](https://github.com/sapcc/limes): Quota and limits management
* [Greenhouse](https://github.com/cloudoperators/greenhouse): Centralized monitoring and alerting
* [Aurora Dashboard](https://github.com/cobaltcore-dev/aurora-dashboard): Unified management UI

***
