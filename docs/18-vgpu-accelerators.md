# vGPU & Accelerators

## Overview

CobaltCore supports GPU and accelerator workloads through OpenStack Nova's native mechanisms: **vGPU (mediated devices)** for GPU sharing and **PCI Passthrough** for dedicated GPU assignment. The integration touches multiple layers of the C5C3 stack — from the GardenLinux host OS through the Hypervisor Node Agent, Hypervisor CRD, Nova Compute, Placement API, and Cortex Scheduler.

## GPU Attachment Models

Three models are available for assigning GPUs to virtual machines:

| Model | Mechanism | GPU Sharing | Live Migration | Hypervisor Backend |
| --- | --- | --- | --- | --- |
| **PCI Passthrough** | VFIO direct device assignment | No (1:1) | Limited (Nova ≥ 2025.1) | QEMU/KVM, Cloud Hypervisor |
| **vGPU (mdev)** | NVIDIA vGPU Manager + mediated devices | Yes (N:1) | Yes (Nova ≥ 2024.1) | QEMU/KVM only |
| **SR-IOV GPU** | Hardware-partitioned Virtual Functions | Yes (N:1) | Depends on driver | QEMU/KVM only |

### PCI Passthrough

PCI Passthrough assigns an entire physical GPU exclusively to a single VM via VFIO. The VM receives near-native GPU performance.

```text
┌────────────────────────────────────────────┐
│              Hypervisor Node               │
│                                            │
│  ┌────────┐  ┌────────┐                    │
│  │  VM 1  │  │  VM 2  │                    │
│  │  GPU 0 │  │  GPU 1 │                    │
│  └────┬───┘  └────┬───┘                    │
│       │           │          VFIO          │
│  ┌────▼───┐  ┌────▼───┐  ┌────────┐        │
│  │ pGPU 0 │  │ pGPU 1 │  │ pGPU 2 │ free   │
│  └────────┘  └────────┘  └────────┘        │
└────────────────────────────────────────────┘
```

**Nova Compute Configuration (`nova.conf`):**

```ini
[pci]
device_spec = [{"vendor_id": "10de", "product_id": "20b5",
                "address": "0000:84:00.0",
                "resource_class": "CUSTOM_NVIDIA_A100_40GB",
                "traits": "CUSTOM_GPU_PASSTHROUGH"}]
report_in_placement = True
```

**Placement:** Each PCI device becomes a child resource provider under the compute node. The resource class defaults to `CUSTOM_PCI_<VENDOR_ID>_<PRODUCT_ID>` but can be overridden via `resource_class` in `device_spec`.

**Live Migration:** Historically not possible for PCI Passthrough devices. Starting with Nova 2025.1, limited support exists via VFIO variant kernel drivers. Requires `live_migratable: "yes"` in `device_spec` and matching hardware on source and destination.

### vGPU (Mediated Devices)

vGPU uses the NVIDIA vGPU Manager (GRID) to partition a physical GPU into multiple virtual GPUs through the Linux kernel's mediated device (mdev) framework. Each vGPU appears as a separate device to the guest VM.

```text
┌──────────────────────────────────────────────┐
│               Hypervisor Node                │
│                                              │
│  ┌────────┐  ┌────────┐  ┌────────┐          │
│  │  VM 1  │  │  VM 2  │  │  VM 3  │          │
│  │ vGPU-a │  │ vGPU-b │  │ vGPU-c │          │
│  └────┬───┘  └────┬───┘  └────┬───┘          │
│       │           │           │              │
│       └───────────┼───────────┘              │
│                   ▼                          │
│  ┌────────────────────────────────────┐      │
│  │  pGPU 0 (NVIDIA vGPU Manager)      │      │
│  │  mdev type: nvidia-558             │      │
│  │  3 of 16 vGPU instances allocated  │      │
│  └────────────────────────────────────┘      │
└──────────────────────────────────────────────┘
```

**Nova Compute Configuration (`nova.conf`):**

```ini
[devices]
enabled_mdev_types = nvidia-558, nvidia-559

[mdev_nvidia-558]
device_addresses = 0000:84:00.0,0000:85:00.0

[mdev_nvidia-559]
device_addresses = 0000:86:00.0
```

**mdev Type Discovery:** Nova reads available mdev types from `/sys/class/mdev_bus/<pci_address>/mdev_supported_types/` at startup. Each type defines a vGPU profile (framebuffer size, max instances, display heads).

**Placement:** Nova creates a child resource provider per physical GPU with resource class `VGPU`. Custom traits distinguish GPU types:

```text
ComputeNode "hypervisor-001" (Root RP)
  ├── VCPU: 128, MEMORY_MB: 524288
  │
  ├── hypervisor-001_pci_0000_84_00_0  (Child RP — pGPU 0)
  │   ├── VGPU: 16
  │   └── traits: CUSTOM_NVIDIA_A100_40GB
  │
  └── hypervisor-001_pci_0000_85_00_0  (Child RP — pGPU 1)
      ├── VGPU: 16
      └── traits: CUSTOM_NVIDIA_A100_40GB
```

**mdev Lifecycle:** Starting with Nova 2024.2 (Dalmatian) and libvirt ≥ 7.3.0, Nova supports persistent mdev management via `mdevctl`. This ensures mdev devices survive host reboots.

**Live Migration:** Supported since Nova 2024.1 (Caracal). Requires libvirt ≥ 8.6.0, QEMU ≥ 8.1.0, and kernel ≥ 5.18.0. Source and destination must support the same mdev type.

> **Constraint:** Cloud Hypervisor does **not** support mediated devices. vGPU is only available with the QEMU/KVM backend.

### SR-IOV GPU

SR-IOV (Single Root I/O Virtualization) creates hardware-partitioned Virtual Functions (VFs) at the PCIe level, providing hardware-enforced isolation between GPU partitions.

| Vendor | Implementation | Nova Path |
| --- | --- | --- |
| **NVIDIA (Ampere+)** | SR-IOV VFs wrapped by mdev framework | Same as vGPU (mdev) |
| **Intel (Flex Series)** | Native SR-IOV VFs, no vGPU license | PCI Passthrough (VF per VM) |

For NVIDIA Ampere and later architectures, SR-IOV must be enabled first:

```bash
/usr/lib/nvidia/sriov-manage -e 0000:41:00.0
```

Each resulting VF supports exactly one mdev device. From Nova's perspective, this is configured identically to mdev-based vGPU, using `enabled_mdev_types` with a `max_instances` parameter.

## Hypervisor Node Stack

GPU-capable hypervisor nodes extend the standard node stack with GPU drivers and device management:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                     HYPERVISOR NODE (GPU-capable)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │    VM 1     │  │  VM 2 (GPU) │  │  VM 3 (vGPU) │  │  VM 4 (vGPU) │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘   │
│         └────────────────┴────────────────┴─────────────────┘           │
│                                    │                                    │
│                                    ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              libvirtd (QEMU/KVM)                                │    │
│  │                                                                 │    │
│  │   TCP Port: 16509                                               │    │
│  │   mdev:  /sys/class/mdev_bus/<pci>/mdev_supported_types         │    │
│  │   VFIO:  /dev/vfio/<group>                                      │    │
│  └───────────────────────────┬─────────────────────────────────────┘    │
│                              │                                          │
│              ┌───────────────┼───────────────┐                          │
│              ▼               ▼               ▼                          │
│  ┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐                │
│  │  Hypervisor     │ │  HA Agent   │ │ Nova Compute    │                │
│  │  Node Agent     │ │             │ │                 │                │
│  │ + GPU Discovery │ │             │ │ + mdev mgmt     │                │
│  │ + mdev types    │ │             │ │ + PCI whitelist │                │
│  │ + NUMA mapping  │ │             │ │ + Placement RP  │                │
│  └─────────────────┘ └─────────────┘ └─────────────────┘                │
│                              │                                          │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  GardenLinux (Bare-Metal OS)                                    │    │
│  │  ├── NVIDIA vGPU Manager (GRID) or GPU Driver                   │    │
│  │  ├── VFIO Kernel Modules (vfio, vfio-pci, vfio-mdev)            │    │
│  │  ├── mdevctl (persistent mdev management)                       │    │
│  │  └── Kernel: intel_iommu=on iommu=pt                            │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Physical GPUs                                                  │    │
│  │  ├── GPU 0: 0000:84:00.0 (NUMA Node 0)                          │    │
│  │  └── GPU 1: 0000:85:00.0 (NUMA Node 1)                          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Host Prerequisites (GardenLinux):**

| Component | Purpose |
| --- | --- |
| NVIDIA vGPU Manager (GRID) | Registers mdev types, manages GPU partitioning |
| GPU Driver (for Passthrough) | VFIO-compatible driver or vendor driver |
| VFIO Kernel Modules | `vfio`, `vfio-pci`, `vfio-mdev` for device isolation |
| `mdevctl` | Persistent mdev device management (Nova ≥ 2024.2) |
| IOMMU | `intel_iommu=on iommu=pt` in kernel command line |

## Hypervisor CRD Extension

The Hypervisor CRD (see [CRDs](04-crds.md)) is extended with GPU inventory in the status:

```yaml
apiVersion: hypervisor.c5c3.io/v1
kind: Hypervisor
metadata:
  name: hypervisor-001
spec:
  customTraits:
    - "CUSTOM_NVIDIA_A100_40GB"
    - "CUSTOM_VGPU_CAPABLE"
status:
  # ... existing fields ...
  gpuDevices:
    - pciAddress: "0000:84:00.0"
      vendor: "NVIDIA"
      model: "A100 40GB"
      vendorId: "10de"
      productId: "20b5"
      driver: "nvidia"
      numaNode: 0
      mdevCapable: true
      mdevTypes:
        - name: "nvidia-558"
          maxInstances: 16
          description: "NVIDIA A100-1G-5GB"
        - name: "nvidia-559"
          maxInstances: 8
          description: "NVIDIA A100-2G-10GB"
    - pciAddress: "0000:85:00.0"
      vendor: "NVIDIA"
      model: "A100 40GB"
      vendorId: "10de"
      productId: "20b5"
      driver: "nvidia"
      numaNode: 1
      mdevCapable: true
      mdevTypes:
        - name: "nvidia-558"
          maxInstances: 16
          description: "NVIDIA A100-1G-5GB"
  domainCapabilities:
    arch: "x86_64"
    hypervisorType: "kvm"
    supportedDevices: ["video", "network", "vgpu", "pci-passthrough"]
    supportedCpuModes: ["host-passthrough"]
    supportedFeatures: ["sev", "sgx"]
```

The `gpuDevices` status field is populated by the Hypervisor Node Agent through GPU discovery (see below).

## Hypervisor Node Agent — GPU Discovery

The Hypervisor Node Agent (`kvm-node-agent`) is extended with GPU discovery capabilities. It collects GPU information and writes it to the Hypervisor CRD status.

**Data Sources:**

| Source | Information | Method |
| --- | --- | --- |
| `/sys/class/mdev_bus/*/mdev_supported_types` | Available mdev types per pGPU | sysfs read |
| `/sys/bus/pci/devices/` | PCI devices with GPU vendor IDs | sysfs read |
| LibVirt `virNodeDeviceListCaps` | PCI device capabilities | LibVirt API (TCP) |
| LibVirt `virConnectGetCapabilities` | Host capabilities incl. NUMA | LibVirt API (TCP) |

**Discovery Flow:**

```text
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Hypervisor Node │     │   Hypervisor     │     │   Hypervisor     │
│  Agent starts    │────▶│   Node Agent     │────▶│   CRD Status     │
│  on node         │     │   GPU Discovery  │     │   .gpuDevices    │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                  │
                   ┌──────────────┼──────────────┐
                   ▼              ▼              ▼
            ┌────────────┐ ┌───────────┐ ┌─────────────┐
            │   sysfs    │ │  LibVirt  │ │  PCI Bus    │
            │  mdev_bus  │ │  nodedev  │ │  Enumeration│
            └────────────┘ └───────────┘ └─────────────┘
```

The agent runs discovery on startup and periodically (configurable interval). Changes to GPU state (e.g., driver changes, hardware events) trigger immediate CRD status updates.

## Cortex Scheduling

The Cortex scheduler (see [Cortex Scheduling](08-cortex-scheduling.md)) provides GPU-aware scheduling through its filter and weigher plugins.

### filter_has_accelerators

The `filter_has_accelerators` filter checks whether candidate hosts have the required GPU/accelerator resources available in Placement:

```yaml
apiVersion: cortex.c5c3.io/v1alpha1
kind: Pipeline
metadata:
  name: nova-gpu-pipeline
spec:
  type: filter-weigher
  schedulingDomain: nova
  filters:
    - name: filter_has_enough_capacity
    - name: filter_correct_az
    - name: filter_has_accelerators
    - name: filter_has_requested_traits
  weighers:
    - name: weigher_general_purpose_balancing
      multiplier: 1.0
```

### GPU-specific Datasources

Cortex can ingest GPU telemetry for informed scheduling decisions:

| Datasource | Knowledge | Scheduling Benefit |
| --- | --- | --- |
| Prometheus (DCGM Exporter) | GPU utilization, temperature, ECC errors | Thermal-aware placement, avoid degraded GPUs |
| Nova Placement API | vGPU inventory and allocations | Capacity-aware scheduling |
| Hypervisor CRD Status | GPU hardware details, NUMA topology | Feature matching, NUMA-locality optimization |

### Flavor Configuration

```bash
# vGPU Flavor (shared GPU)
openstack flavor create gpu.small --vcpus 4 --ram 8192 --disk 0
openstack flavor set gpu.small \
    --property resources:VGPU=1 \
    --property trait:CUSTOM_NVIDIA_A100_40GB=required

# Dedicated GPU Flavor (PCI Passthrough)
openstack flavor create gpu.dedicated --vcpus 16 --ram 65536 --disk 0
openstack flavor set gpu.dedicated \
    --property "pci_passthrough:alias"="a100-40g:1"

# Multi-GPU Flavor
openstack flavor create gpu.multi --vcpus 32 --ram 131072 --disk 0
openstack flavor set gpu.multi \
    --property "pci_passthrough:alias"="a100-40g:2"
```

## Lifecycle Implications

GPU workloads affect the hypervisor lifecycle (see [Hypervisor Lifecycle](06-hypervisor-lifecycle.md)) at several stages.

### Onboarding

The onboarding process is extended with GPU-specific validation:

```text
┌─────────┐     ┌────────────────┐     ┌───────────────┐     ┌───────┐     ┌───────┐
│ Initial │────▶│  Onboarding    │────▶│   Testing     │────▶│ Ready │────▶│Active │
└─────────┘     │ + GPU Traits   │     │ + GPU Checks  │     └───────┘     └───────┘
                └────────────────┘     └───────────────┘
```

**Additional Onboarding Steps:**

1. **GPU Driver Validation**: Verify NVIDIA vGPU Manager or GPU driver is loaded and functional
2. **IOMMU Check**: Confirm IOMMU is enabled (`intel_iommu=on iommu=pt`)
3. **mdev Type Discovery**: Enumerate available mdev types and report to Hypervisor CRD
4. **GPU Trait Sync**: Synchronize GPU-related OpenStack Traits (e.g., `CUSTOM_NVIDIA_A100_40GB`, `CUSTOM_VGPU_CAPABLE`) into Nova Placement

**Additional Testing Checks:**

| Check | Description |
| --- | --- |
| GPU Driver Status | vGPU Manager loaded, no ECC errors |
| mdev Creation Test | Create and destroy a test mdev device |
| VFIO Group Access | Verify VFIO groups are accessible |
| NUMA Affinity | Confirm GPU NUMA node matches expected topology |

### Eviction and Maintenance

The eviction process must account for GPU attachment types when performing preflight checks and VM migrations:

**Preflight Check Extension:**

| VM Type | Migration Strategy | Preflight Requirement |
| --- | --- | --- |
| No GPU | Live Migration | Standard capacity check |
| vGPU (mdev) | Live Migration | Matching mdev type on destination, libvirt ≥ 8.6 |
| PCI Passthrough (VFIO variant) | Live Migration | Matching PCI device on destination, Nova ≥ 2025.1 |
| PCI Passthrough (legacy) | Stop + Start | Available PCI device on destination |

**vGPU Live Migration Requirements:**

```text
Source Host                          Destination Host
┌──────────────────┐                ┌──────────────────┐
│  VM with vGPU    │   migration    │  Free mdev slot  │
│  mdev: nvidia-558│ ──────────────▶│  mdev: nvidia-558│
│  pGPU: A100      │                │  pGPU: A100      │
│  libvirt ≥ 8.6   │                │  libvirt ≥ 8.6   │
│  QEMU ≥ 8.1      │                │  QEMU ≥ 8.1      │
└──────────────────┘                └──────────────────┘
```

For VMs that cannot be live migrated (legacy PCI Passthrough), the eviction controller documents them in the Eviction CRD conditions and requires a stop-start cycle:

1. VM is stopped on the source hypervisor
2. PCI device is released
3. VM is started on the destination hypervisor with a new PCI device allocation
4. Downtime is unavoidable for this migration path

### Decommissioning

Additional cleanup steps for GPU nodes:

1. Verify all GPU-attached VMs have been migrated or stopped
2. Release all mdev devices (`mdevctl stop`, `mdevctl undefine`)
3. Remove GPU-related Traits from Nova Placement
4. Standard decommissioning flow continues

## Cloud Hypervisor Constraints

Cloud Hypervisor and QEMU/KVM differ in their GPU support:

| Feature | QEMU/KVM | Cloud Hypervisor |
| --- | --- | --- |
| PCI Passthrough (full GPU) | Yes | Yes (VFIO) |
| vGPU (mdev) | Yes | **No** |
| SR-IOV VF Passthrough | Yes | Yes (as VFIO) |
| vGPU Live Migration | Yes (Nova ≥ 2024.1) | N/A |
| Multi-GPU (GPUDirect P2P) | Yes | Yes (`x_nv_gpudirect_clique`) |

Cloud Hypervisor supports VFIO-based PCI Passthrough for full GPU assignment but does **not** implement the mediated device (mdev) framework. This means:

- **Full GPU Passthrough** works with Cloud Hypervisor — the entire pGPU is assigned to a single VM
- **vGPU (GPU sharing)** requires QEMU/KVM — multiple VMs sharing a single pGPU via mdev is not possible with Cloud Hypervisor

This constraint must be reflected in OpenStack Traits to ensure correct scheduling:

```text
QEMU/KVM Nodes:
  traits: CUSTOM_VGPU_CAPABLE, CUSTOM_GPU_PASSTHROUGH_CAPABLE

Cloud Hypervisor Nodes:
  traits: CUSTOM_GPU_PASSTHROUGH_CAPABLE
```

Flavors requesting vGPU resources must include `trait:CUSTOM_VGPU_CAPABLE=required` to prevent scheduling on Cloud Hypervisor nodes.

## Observability

GPU metrics are collected via the DCGM Exporter (NVIDIA Data Center GPU Manager) running as a DaemonSet on GPU-capable hypervisor nodes.

**Key Metrics:**

| Metric | Description | Alert Threshold |
| --- | --- | --- |
| `DCGM_FI_DEV_GPU_UTIL` | GPU compute utilization (%) | Informational |
| `DCGM_FI_DEV_MEM_COPY_UTIL` | GPU memory utilization (%) | > 95% sustained |
| `DCGM_FI_DEV_GPU_TEMP` | GPU temperature (°C) | > 85°C |
| `DCGM_FI_DEV_ECC_SBE_VOL_TOTAL` | Single-bit ECC errors | > 0 (warning) |
| `DCGM_FI_DEV_ECC_DBE_VOL_TOTAL` | Double-bit ECC errors | > 0 (critical) |
| `DCGM_FI_DEV_POWER_USAGE` | Power consumption (W) | Informational |
| `DCGM_FI_DEV_VGPU_LICENSE_STATUS` | vGPU license status | != Licensed |

GPU metrics are scraped by Prometheus and available in Greenhouse/Aurora dashboards (see [Observability](15-observability/)).

Cortex can consume these metrics as a Datasource for thermal-aware scheduling and proactive detection of degrading GPUs.

## OpenStack Cyborg

OpenStack Cyborg provides a general accelerator lifecycle management framework. It manages FPGAs, SmartNICs, and other non-GPU accelerators through a separate API service.

| Aspect | Nova-native (vGPU/PCI) | Cyborg |
| --- | --- | --- |
| **GPU support** | Mature, widely deployed | Limited, niche |
| **FPGA support** | Not applicable | Primary use case |
| **Live Migration** | vGPU: Yes, PCI: Limited | No |
| **Scheduling** | Placement API + Cortex | Placement API (device profiles) |
| **Operational complexity** | Standard Nova configuration | Additional API service + agents |

**Recommendation:** For GPU workloads, use Nova's native vGPU and PCI Passthrough mechanisms. Cyborg is only relevant for FPGA or SmartNIC accelerators that require bitstream programming or vendor-specific lifecycle management.

***
