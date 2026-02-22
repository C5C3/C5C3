# Hypervisor Lifecycle

## Complete State Diagram

The following diagram shows all states of a hypervisor node and the transitions between them. Each transition is triggered by a specific trigger and processed by a specific controller. For the agent and controller architecture, see [Component Interaction](./05-component-interaction.md).

```text
                                ┌─────────┐
                                │ Initial │
                                └────┬────┘
                                     │ Trigger: New K8s Node detected
                                     │ Controller: Hypervisor Controller
                                     ▼
                          ┌─────────────────────┐
                     ┌───▶│     Onboarding      │───────┐
                     │    └──────────┬──────────┘       │
                     │               │                  │ Error during configuration
                     │               │ Trigger:         │ Controller: Onboarding Controller
                     │               │ Configuration    │
                     │               │ completed        ▼
                     │               │            ┌──────────┐
                     │               │            │ Aborted  │
                     │               ▼            └──────────┘
                     │         ┌───────────┐           ▲
                     │         │  Testing  │───────────┘
                     │         └─────┬─────┘  Error during validation
                     │               │        Controller: Onboarding Controller
                     │               │
                     │               │ Trigger: Tests passed
                     │               │ (or skipTests: true)
                     │               ▼
                     │         ┌───────────┐
                     │         │   Ready   │
                     │         └─────┬─────┘
                     │               │ Trigger: Nova Scheduling enabled
                     │               │ Controller: Hypervisor Controller
                     │               ▼
     Re-Enable       │    ┌─────────────────────┐
     after maint. ───┘    │       Active        │◀────────────────────────┐
                          └──┬──────────┬───────┘                         │
                             │          │                                 │
          Trigger: Admin/    │          │ Trigger: Node-Failure/          │
          Gardener Rolling   │          │ Admin/Gardener Rolling Update   │
          Update             │          │ Controller: Eviction Controller │
          Controller:        │          │                                 │
          Hypervisor Ctrl    │          ▼                                 │
                             │   ┌─────────────┐                          │
                             │   │  Evicting   │                          │
                             │   └──────┬──────┘                          │
                             │          │                                 │
                             │          ├── Trigger: Eviction Complete    │
                             │          │   (planned maintenance)         │
                             │          │   Controller: Eviction Ctrl ────┘
                             │          │
                             ▼          ▼ Trigger: Eviction Complete
                      ┌─────────────┐     (Decommission)
                      │ Maintenance │     Controller: Eviction Controller
                      └──────┬──────┘          │
                             │                 ▼
                             │     ┌──────────────────┐
                             │     │ Decommissioned   │
                             │     └──────────────────┘
                             │
                             │ Trigger: Maintenance completed,
                             │ Re-Enable
                             │ Controller: Hypervisor Controller
                             └──────────▶ (back to Active)
```

**State Overview:**

| State              | Description                                          | Responsible Controller |
| ------------------ | ---------------------------------------------------- | ---------------------- |
| **Initial**        | Newly discovered K8s Node, Hypervisor CRD is created | Hypervisor Controller  |
| **Onboarding**     | Configuration and integration into OpenStack         | Onboarding Controller  |
| **Testing**        | Validation checks running                            | Onboarding Controller  |
| **Aborted**        | Onboarding/Testing failed                            | Onboarding Controller  |
| **Ready**          | Node is ready, waiting for scheduling approval       | Hypervisor Controller  |
| **Active**         | Node actively hosts VMs                              | Hypervisor Controller  |
| **Maintenance**    | Planned maintenance, VMs evacuated                   | Hypervisor Controller  |
| **Evicting**       | VM evacuation in progress                            | Eviction Controller    |
| **Decommissioned** | Node decommissioned                                  | Hypervisor Controller  |

## Onboarding Process

```text
┌─────────┐     ┌───────────┐     ┌─────────┐     ┌───────┐     ┌───────┐
│ Initial │────▶│ Onboarding│────▶│ Testing │────▶│ Ready │────▶│ Active│
└─────────┘     └───────────┘     └─────────┘     └───────┘     └───────┘
     │                                  │
     │                                  │
     ▼                                  ▼
┌─────────┐                       ┌─────────┐
│ Aborted │                       │ Aborted │
└─────────┘                       └─────────┘
```

**Phase "Initial":**

The Hypervisor Controller watches the Kubernetes Node API in the Hypervisor Cluster. When a new node joins the cluster, the controller automatically creates a **Hypervisor CRD** (see [CRDs](./04-crds.md#hypervisor-crd-hypervisorc5c3iov1)) with the initial state. The CRD contains the node reference and the desired configuration.

**Phase "Onboarding":**

The Onboarding Controller takes over configuration of the new node:

1. **Nova Host Aggregate**: Node is assigned to the configured Host Aggregate in Nova
2. **Traits Sync**: OpenStack Traits (CPU capabilities, hardware features) are synchronized from the Hypervisor CRD into Nova
3. **OpenStack API Registration**: Node is registered as Compute Host in Nova, Service-ID and Hypervisor-ID are stored in the CRD

**Phase "Testing":**

After onboarding, automatic validation checks are performed:

* **LibVirt Connectivity**: Check if the LibVirt daemon is reachable via TCP (Connection URI `qemu+tcp://<host>:16509/system` or `ch+tcp://<host>:16509/system` depending on the backend), if VMs can be started, and if the LibVirt version meets the expected minimum version. The result is documented in the Hypervisor CRD status (`libVirtVersion`).
* **OVS Bridges**: Verification that br-int, br-ex (and optionally br-provider) are correctly configured
* **Ceph RBD Access**: Test if the node can access the Ceph RBD pools (block storage for VM disks)

> **Note:** With `skipTests: true` in the Hypervisor CRD Spec, the Testing phase can be skipped. This is useful for development environments, not recommended for production.

**Phase "Ready -> Active":**

Once all tests pass, the node is marked as `Ready`. The Hypervisor Controller enables the node for Nova scheduling --- from this point, VMs can be placed on the node and the state changes to `Active`.

**Error Handling:**

The `Aborted` state is set when:

* OpenStack API registration fails (e.g., Keystone authentication fails)
* Host Aggregate assignment is not possible (e.g., aggregate does not exist)
* One or more validation checks fail in the Testing phase

With `Aborted`, the cause must be fixed and the onboarding process manually restarted by resetting the Hypervisor CRD status.

<!-- TODO: Document how to reset Hypervisor CRD status for re-onboarding (which field to reset, example kubectl command) -->

## Maintenance Mode

Maintenance mode enables planned maintenance work on a hypervisor node without permanently losing VMs.

**Triggers:**

| Trigger              | Initiator                                                                                                                      | Maintenance Mode |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Manual (Admin)       | Admin sets `spec.maintenance: "manual"` in the Hypervisor CRD                                                                  | `manual`         |
| Automatic (Gardener) | [Gardener](https://gardener.cloud/) Rolling Update requires node restart                                                       | `auto`           |
| HA Event             | HA Agent detects hardware problem (see [High Availability](./07-high-availability.md))                                         | `ha`             |
| Node Termination     | Kubernetes Node is terminated                                                                                                  | `termination`    |

**Flow:**

```text
┌──────────┐    ┌───────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────┐
│  Active  │───▶│  Scheduling   │───▶│     VM       │───▶│ Maintenance │───▶│  Active  │
│          │    │  Stop         │    │  Evacuation  │    │  (Maint.)   │    │          │
└──────────┘    └───────────────┘    └──────────────┘    └─────────────┘    └──────────┘
```

1. **Scheduling Stop**: Hypervisor is disabled in Nova, no new VMs are placed
2. **VM Evacuation**: All VMs are migrated via live migration to other hypervisors (identical to eviction process)
3. **Maintenance**: Node is free for maintenance work (OS update, firmware update, hardware replacement)
4. **Re-Enable**: After maintenance is complete, the hypervisor is re-activated in Nova and returns to `Active` state

**Difference to Eviction:** Maintenance mode is planned and controlled. Return to active operation is expected. With eviction due to node failure, return is not guaranteed.

## Eviction Process

```text
┌────────────────────┐
│  Eviction Request  │
│  (CRD created)     │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│  Preflight Checks  │
│  - OS Validation   │
│  - Resource Check  │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Hypervisor Disable │
│ (Scheduling Stop)  │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│   VM Migration     │◀──────┐
│ (Instance by       │       │
│  Instance)         │───────┘ (Loop until all migrated)
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│    Eviction        │
│    Complete        │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Hypervisor Re-     │ (optional, based on reason)
│ Enable             │
└────────────────────┘
```

**Eviction Reasons:**

| Reason                  | Initiator                                                                                                                    | Re-Enable after Eviction         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Node Failure            | HA Agent detects via LibVirt Events, automatically creates Eviction CRD (see [High Availability](./07-high-availability.md)) | No (node must be restored first) |
| Gardener Rolling Update | [Gardener](https://gardener.cloud/) sets Node Drain, Operator creates Eviction CRD                                           | Yes (after successful update)    |
| Admin Request           | Admin manually creates an Eviction CRD                                                                                       | Depends on reason                |
| Decommissioning         | Admin marks node for decommissioning                                                                                         | No                               |

**Preflight Checks:**

Before eviction begins, the Eviction Controller checks:

1. **Target Capacity**: Enough free resources (RAM, vCPUs) on other hypervisors for all VMs
2. **Nova Scheduling Filter**: Check if Nova Scheduler filters (Availability Zone, Host Aggregates, Traits) allow placement
3. **VM Compatibility**: Check for VMs that cannot be migrated (e.g., PCI passthrough, local disks)

The eviction process is aborted if preflight checks fail. The Eviction CRD is updated with an appropriate condition (see [CRDs](./04-crds.md#eviction-crd-hypervisorc5c3iov1)).

**VM Migration:**

Migration occurs **instance by instance** via the Nova Live Migration API:

1. Hypervisor Operator selects the next VM to migrate
2. Nova Live Migration API is called (target host is determined by Nova Scheduler)
3. Migration CRD is created and monitored (see [CRDs](./04-crds.md#migration-crd-hypervisorc5c3iov1alpha1))
4. After successful migration: next VM, until all are migrated

**Timeout Handling:**

<!-- TODO: Document timeout configuration (CRD field or operator flag, default value) -->

If a single VM migration does not complete within the configured timeout:

* Migration is marked as `stuck`
* Eviction Controller attempts to cancel the migration and restart it
* On repeated failure: VM is marked as non-migratable, eviction continues with remaining VMs
* The Eviction CRD documents all results via Conditions

**Completion:**

After eviction completes:

* All VMs have been successfully migrated (or marked as non-migratable)
* Hypervisor is disabled in Nova (`disabled`)
* For planned maintenance: Re-enable after maintenance completes
* For decommissioning: No re-enable, proceed to decommissioning process

## Decommissioning

After complete eviction, a node can be permanently decommissioned:

1. **Remove Nova Host Aggregate**: Node is removed from all Host Aggregates in Nova
2. **Clean up Traits**: OpenStack Traits for this hypervisor are deleted
3. **Remove Nova Compute Service**: Compute Service registration is deleted from Nova
4. **CRD Status**: Hypervisor CRD is set to `Decommissioned`

The node can subsequently be removed from the Kubernetes cluster. The Hypervisor CRD remains as documentation until manually deleted.
