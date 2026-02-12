# Core Components

This section documents all components of the CobaltCore architecture, organized by cluster affiliation. For the overall multi-cluster architecture and provisioning, see [Architecture Overview](../02-architecture-overview.md).

## Component Overview

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CLUSTER COMPONENTS                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  MANAGEMENT CLUSTER          CONTROL PLANE CLUSTER         HYPERVISOR CLUSTER   │
│  ─────────────────          ──────────────────────         ───────────────────  │
│  • FluxCD                   • c5c3-operator                • Hypervisor Op.     │
│  • OpenBao (Secrets)        • keystone-operator            • KVM Node Agent     │
│  • ESO (Secret Sync)        • glance-operator              • OVS Agent          │
│  • Greenhouse (opt)         • placement-operator           • HA Agent           │
│  • Aurora (opt)             • nova-operator                • ovn-controller     │
│                             • neutron-operator             • Nova Compute       │
│                             • cinder-operator              • ovs-vswitchd       │
│                             • cortex-operator (opt)                             │
│                             • tempest-operator (opt)                            │
│                             • ovn-operator                                      │
│                             • K-ORC                                             │
│                             • Infrastructure Ops                                │
│                                                                                 │
│  STORAGE CLUSTER                                                                │
│  ───────────────                                                                │
│  • Rook Operator                                                                │
│  • Ceph MON/OSD                                                                 │
│  • External Arbiter Op.                                                         │
│  • Prysm                                                                        │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

***
