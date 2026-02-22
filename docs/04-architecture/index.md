# Architecture Deep Dives

This section provides detailed architectural documentation for individual CobaltCore subsystems. For the high-level multi-cluster architecture, see [Architecture Overview](../02-architecture-overview.md).

- [CRDs](./01-crds.md) — Custom Resource Definitions forming the central API interface
- [Component Interaction](./02-component-interaction.md) — Cross-cluster communication and reconciliation flows
- [Hypervisor Lifecycle](./03-hypervisor-lifecycle.md) — State machine, provisioning, maintenance, and decommissioning
- [High Availability](./04-high-availability.md) — HA architecture, failure detection, and evacuation strategies
- [Cortex Scheduling](./05-cortex-scheduling.md) — AI-driven scheduling and placement optimization
- [Storage](./06-storage.md) — Ceph integration, Rook operator, and storage arbitration
- [Network](./07-network.md) — OVN/OVS networking, distributed routing, and network segmentation
