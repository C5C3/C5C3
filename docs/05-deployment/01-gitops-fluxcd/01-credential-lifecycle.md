# Credential Lifecycle

## Secret Management with OpenBao + ESO

Secrets are centrally stored in **OpenBao** (Management Cluster) and distributed to all clusters via the **External Secrets Operator (ESO)**. OpenBao forms the foundation for [OpenStack Credential Lifecycle Management](#openstack-credential-lifecycle-management), which manages service users, application credentials, and cross-cluster secret synchronization on top of it.

```text
┌───────────────────────────────────────────────────────────────────┐
│                    Secret Management Flow                         │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  MANAGEMENT CLUSTER                                               │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                        OpenBao                              │  │
│  │                   (openbao-system)                          │  │
│  │                                                             │  │
│  │  kv-v2/bootstrap/*      → Admin passwords, service passwords│  │
│  │  kv-v2/openstack/*      → Service secrets, AppCredentials   │  │
│  │  kv-v2/infrastructure/* → DB, RabbitMQ, Valkey credentials  │  │
│  │  kv-v2/ceph/*           → Ceph auth keys                    │  │
│  │  pki/*                  → TLS certificates                  │  │
│  └──────────────────────────────┬──────────────────────────────┘  │
│                                 │                                 │
│                                 │ HTTPS (Port 8200)               │
│                                 ▼                                 │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │           External Secrets Operator (per cluster)            │ │
│  │                                                              │ │
│  │  ClusterSecretStore    → Connection to OpenBao               │ │
│  │  ExternalSecret        → Reads secret, creates K8s Secret    │ │
│  │  PushSecret            → Writes K8s Secret to OpenBao        │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Authentication:** Each cluster has its own Kubernetes Auth Method (`kubernetes/management`, `kubernetes/control-plane`, `kubernetes/hypervisor`, `kubernetes/storage`) with Least-Privilege Policies.

See [OpenBao Secret Management](../02-secret-management.md) for the complete documentation.

## OpenStack Credential Lifecycle Management

Managing credentials in a multi-cluster OpenStack environment requires an architecture that solves the bootstrap problem (Keystone needs credentials before it can issue them), enables service-to-service authentication via Application Credentials, and supports credential rotation across clusters.

## Credential Types and Sources

| Secret Type                     | Source                | Created By                  | Distributed By   | Consumer                                   |
| ------------------------------- | --------------------- | --------------------------- | ---------------- | ------------------------------------------ |
| Admin Password                  | OpenBao               | Manual / CI-CD              | ESO              | Keystone Bootstrap                         |
| Service User Passwords          | OpenBao               | Manual / CI-CD              | ESO              | c5c3-operator (initial user creation only) |
| Service Users (Keystone)        | Keystone              | K-ORC                       | -                | OpenStack Services                         |
| Service Application Credentials | Keystone              | K-ORC                       | PushSecret + ESO | Service Operators (Glance, Nova, …)        |
| K-ORC Application Credential    | Keystone              | K-ORC                       | PushSecret + ESO | K-ORC Controller                           |
| Cortex Application Credential   | Keystone              | K-ORC                       | PushSecret + ESO | Cortex                                     |
| Keystone Services               | Keystone              | K-ORC                       | -                | Service Catalog                            |
| Keystone Endpoints              | Keystone              | K-ORC                       | -                | Service Catalog                            |
| clouds.yaml (Compute)           | c5c3-operator         | c5c3-operator               | ESO              | Nova Compute                               |
| Ceph Auth Keys                  | Rook                  | Rook Operator               | PushSecret + ESO | Cinder, Glance, Nova                       |
| Libvirt Ceph Secret             | Hypervisor Node Agent | Hypervisor Node Agent       | -                | LibVirt                                    |
| Infrastructure Secrets          | Operators             | MariaDB/RabbitMQ/Valkey Op. | c5c3-operator    | OpenStack Services                         |

## Bootstrap Problem and Solution Architecture

> See also [Bootstrap](./04-bootstrap.md) for the FluxCD-level bootstrap process.

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CREDENTIAL BOOTSTRAP FLOW                                  │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  PHASE 0: Pre-Bootstrap (Secrets in OpenBao)                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  OpenBao Paths:                                                         │  │
│  │  ├── kv-v2/bootstrap/keystone-admin      # Admin password               │  │
│  │  ├── kv-v2/bootstrap/service-passwords   # nova, neutron, glance, ...   │  │
│  │  └── kv-v2/openstack/k-orc/credentials  # K-ORC Service User            │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              │ ESO ExternalSecret → K8s Secret                │
│                              ▼                                                │
│  PHASE 1: Keystone Bootstrap                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  Keystone Bootstrap Job creates:                                        │  │
│  │  • Admin User (from OpenBao Secret via ESO)                             │  │
│  │  • Service Project                                                      │  │
│  │  • Admin Role, Service Role                                             │  │
│  │  • Default Domain                                                       │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  PHASE 2: Import Bootstrap Resources & K-ORC Credential Setup                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  c5c3-operator imports bootstrap resources into K-ORC (unmanaged):      │  │
│  │  • Default Domain, Service Project, Roles                               │  │
│  │    (created by Keystone Bootstrap Job — K-ORC must see them first)      │  │
│  │                                                                         │  │
│  │  c5c3-operator creates K-ORC Service User via Keystone API:             │  │
│  │  • k-orc user (service project, admin role)                             │  │
│  │  • K-ORC Application Credential → clouds.yaml → K-ORC Deployment        │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  PHASE 3: Service Users, Services & Endpoints (c5c3-operator via K-ORC)       │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  c5c3-operator creates via K-ORC (managed):                             │  │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │  │
│  │  │ User        │ Project  │ Role         │ Used By                   │  │  │
│  │  ├─────────────┼──────────┼──────────────┼───────────────────────────│  │  │
│  │  │ nova        │ service  │ admin        │ Nova API, Nova Compute    │  │  │
│  │  │ neutron     │ service  │ admin        │ Neutron API, Agents       │  │  │
│  │  │ glance      │ service  │ admin        │ Glance API                │  │  │
│  │  │ cinder      │ service  │ admin        │ Cinder API, Volume        │  │  │
│  │  │ placement   │ service  │ admin        │ Placement API             │  │  │
│  │  │ cortex      │ service  │ reader       │ Cortex (read-only)        │  │  │
│  │  └───────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                         │  │
│  │  • Keystone Service entries (glance, nova, neutron, etc.)               │  │
│  │  • Endpoints (public + internal) for each service                       │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  PHASE 4: Application Credentials (Optional, recommended)                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  For K-ORC, Cortex and external tools:                                  │  │
│  │  • Cannot be used to create additional credentials                      │  │
│  │  • Can have restricted roles                                            │  │
│  │  • Can have expiration date (automatic rotation)                        │  │
│  │  • Revocable anytime without deleting user                              │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  PHASE 5: Config Rendering & Secret Sync                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  • c5c3-operator renders service configs with all credentials           │  │
│  │  • PushSecrets write generated credentials to OpenBao                   │  │
│  │  • ESO synchronizes secrets to Hypervisor/Storage Cluster               │  │
│  │  • Services start with complete configuration                           │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Bootstrap Sequence Diagram

The following sequence diagram shows the complete credential bootstrap process from the first FluxCD reconcile to the running OpenStack Control Plane:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              COMPLETE BOOTSTRAP SEQUENCE DIAGRAM                                            │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                             │
│  ACTORS:                                                                                                    │
│  ───────                                                                                                    │
│  [Git]     [FluxCD]  [OpenBao/ESO] [MariaDB-Op]  [c5c3-Op]   [keystone-Op]  [Service-Ops]  [ESO]            │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 0: GitOps Bootstrap                                                                                   │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │──────────┼─────────▶│           │            │              │              │             │             │
│    │  fetch   │ read from│           │            │              │              │             │             │
│    │  secrets │ OpenBao  │           │            │              │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │◀─────────│           │            │              │              │             │             │
│    │          │ K8s      │           │            │              │              │             │             │
│    │          │ Secrets via          │            │              │              │             │             │
│    │          │ ESO      │           │            │              │              │             │             │
│    │          │ (admin-pw,           │            │              │              │             │             │
│    │          │  svc-pws)            │            │              │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │──────────┼───────────┼────────────┼──────────────┼──────────────┼─────────────▶             │
│    │          │          │  Deploy   │            │              │              │  Deploy     │             │
│    │          │          │  Operators│            │              │              │  Operators  │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 1: Infrastructure Provisioning                                                                        │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │          │──────────┼───────────┼────────────▶              │              │             │             │
│    │          │          │           │ ControlPlane              │              │             │             │
│    │          │          │           │    CR                     │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │◀───────────│              │              │             │             │
│    │          │          │           │  MariaDB   │              │              │             │             │
│    │          │          │           │    CR      │              │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │─────┐      │              │              │             │             │
│    │          │          │           │     │Create│              │              │             │             │
│    │          │          │           │     │Galera│              │              │             │             │
│    │          │          │           │◀────┘Cluster              │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │───────────▶│              │              │             │             │
│    │          │          │           │  Ready     │              │              │             │             │
│    │          │          │           │  + DB Secret              │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────┼──────────────┼─────────────▶             │
│    │          │          │           │            │  RabbitMQ CR │              │ (parallel)  │             │
│    │          │          │           │            │  Valkey CR   │              │             │             │
│    │          │          │           │            │  Memcached CR│              │             │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 2: Keystone Bootstrap                                                                                 │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────▶              │             │             │
│    │          │          │           │            │  Keystone CR │              │             │             │
│    │          │          │           │            │  (depends:   │              │             │             │
│    │          │          │           │            │   MariaDB,   │              │             │             │
│    │          │          │           │            │   Memcached) │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │─────┐        │             │             │
│    │          │          │           │            │              │     │Deploy  │             │             │
│    │          │          │           │            │              │     │Keystone│             │             │
│    │          │          │           │            │              │◀────┘        │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │─────┐        │             │             │
│    │          │          │           │            │              │     │Bootstrap             │             │
│    │          │          │           │            │              │     │Job:    │             │             │
│    │          │          │           │            │              │     │-Admin  │             │             │
│    │          │          │           │            │              │     │-Service│             │             │
│    │          │          │           │            │              │     │ Project│             │             │
│    │          │          │           │            │              │     │-Roles  │             │             │
│    │          │          │           │            │              │◀────┘        │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │◀─────────────│              │             │             │
│    │          │          │           │            │  Keystone    │              │             │             │
│    │          │          │           │            │  Ready       │              │             │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 3: Import Bootstrap Resources, K-ORC Setup & Credential Creation                                      │
│          (keystone-Op column = K-ORC in this phase)                                                         │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │─────┐        │              │             │             │
│    │          │          │           │            │     │Import  │              │             │             │
│    │          │          │           │            │     │bootstrap              │             │             │
│    │          │          │           │            │     │resources              │             │             │
│    │          │          │           │            │     │(unmanaged):           │             │             │
│    │          │          │           │            │     │Domain,  │             │             │             │
│    │          │          │           │            │     │Projects,│             │             │             │
│    │          │          │           │            │◀────┘Roles   │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────▶              │             │             │
│    │          │          │           │            │ K-ORC User   │              │             │             │
│    │          │          │           │            │ CRs: nova,   │              │             │             │
│    │          │          │           │            │ neutron,     │              │             │             │
│    │          │          │           │            │ glance,      │              │             │             │
│    │          │          │           │            │ cinder,      │              │             │             │
│    │          │          │           │            │ placement,   │              │             │             │
│    │          │          │           │            │ k-orc, cortex│              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────▶              │             │             │
│    │          │          │           │            │ K-ORC Service│              │             │             │
│    │          │          │           │            │ + Endpoint   │              │             │             │
│    │          │          │           │            │ CRs          │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │─────┐        │             │             │
│    │          │          │           │            │              │     │K-ORC:  │             │             │
│    │          │          │           │            │              │     │Create  │             │             │
│    │          │          │           │            │              │     │Users,  │             │             │
│    │          │          │           │            │              │     │Services│             │             │
│    │          │          │           │            │              │     │Endpts  │             │             │
│    │          │          │           │            │              │◀────┘        │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────▶              │             │             │
│    │          │          │           │            │ K-ORC AppCred│              │             │             │
│    │          │          │           │            │ CRs: k-orc,  │              │             │             │
│    │          │          │           │            │ cortex       │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │─────┐        │             │             │
│    │          │          │           │            │              │     │K-ORC:  │             │             │
│    │          │          │           │            │              │     │AppCreds│             │             │
│    │          │          │           │            │              │     │+ Secret│             │             │
│    │          │          │           │            │              │◀────┘        │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │◀─────────────│              │             │             │
│    │          │          │           │            │ Credentials  │              │             │             │
│    │          │          │           │            │ Ready        │              │             │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 4: Core Services Deployment (Glance, Placement)                                                       │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────┼──────────────▶             │             │
│    │          │          │           │            │  Glance CR,  │              │             │             │
│    │          │          │           │            │  Placement CR│              │             │             │
│    │          │          │           │            │  (parallel)  │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │              │─────┐       │             │
│    │          │          │           │            │              │              │     │Deploy │             │
│    │          │          │           │            │              │              │     │Glance,│             │
│    │          │          │           │            │              │              │     │Placem.│             │
│    │          │          │           │            │              │              │◀────┘       │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │◀─────────────┼──────────────│             │             │
│    │          │          │           │            │  Glance,     │              │             │             │
│    │          │          │           │            │  Placement   │              │             │             │
│    │          │          │           │            │  Ready       │              │             │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 5: Compute Services Deployment (Nova, Neutron, Cinder)                                                │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────┼──────────────▶             │             │
│    │          │          │           │            │  Nova CR,    │              │             │             │
│    │          │          │           │            │  Neutron CR, │              │             │             │
│    │          │          │           │            │  Cinder CR   │              │             │             │
│    │          │          │           │            │  (parallel)  │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │              │─────┐       │             │
│    │          │          │           │            │              │              │     │Deploy │             │
│    │          │          │           │            │              │              │     │Nova,  │             │
│    │          │          │           │            │              │              │     │Neutron│             │
│    │          │          │           │            │              │              │     │Cinder │             │
│    │          │          │           │            │              │              │◀────┘       │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │◀─────────────┼──────────────│             │             │
│    │          │          │           │            │  Nova,       │              │             │             │
│    │          │          │           │            │  Neutron,    │              │             │             │
│    │          │          │           │            │  Cinder      │              │             │             │
│    │          │          │           │            │  Ready       │              │             │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 6: Cross-Cluster Secret Sync & Hypervisor Integration                                                 │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────┼──────────────┼─────────────▶             │
│    │          │          │           │            │ PushSecret + │              │             │             │
│    │          │          │           │            │ ExternalSec: │              │             │             │
│    │          │          │           │            │ - Ceph Keys  │              │             │             │
│    │          │          │           │            │ - Nova Config│              │             │             │
│    │          │          │           │            │ - OVN Config │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │              │             │─────┐       │
│    │          │          │           │            │              │              │             │     │Sync   │
│    │          │          │           │            │              │              │             │     │via ESO│
│    │          │          │           │            │              │              │             │     │to HV  │
│    │          │          │           │            │              │              │             │◀────┘       │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │◀─────────────┼──────────────┼─────────────│             │
│    │          │          │           │            │ Secrets      │              │             │             │
│    │          │          │           │            │ Synced       │              │             │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 7: Optional Components (Cortex)                                                                       │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │──────────────┼──────────────▶             │             │
│    │          │          │           │            │ Cortex CR    │              │             │             │
│    │          │          │           │            │ (if enabled) │              │             │             │
│    │          │          │           │            │              │              │             │             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ COMPLETE: ControlPlane CR Status = Ready                                                                    │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │              │              │             │             │
│    │          │          │           │            │ status:      │              │             │             │
│    │          │          │           │            │   phase: Ready              │             │             │
│    │          │          │           │            │   conditions:│              │             │             │
│    │          │          │           │            │   - InfrastructureReady     │             │             │
│    │          │          │           │            │   - KeystoneReady           │             │             │
│    │          │          │           │            │   - CredentialsReady        │             │             │
│    │          │          │           │            │   - ServicesReady           │             │             │
│    │          │          │           │            │   - CrossClusterSyncReady   │             │             │
│    │          │          │           │            │              │              │             │             │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Bootstrap Times (typical):**

| Phase                       | Duration        | Description                                                             |
| --------------------------- | --------------- | ----------------------------------------------------------------------- |
| Phase 0: GitOps Bootstrap   | \~1 min         | FluxCD Reconcile, ESO Secret Sync                                       |
| Phase 1: Infrastructure     | \~5-10 min      | MariaDB Galera, RabbitMQ, Valkey Sentinel                               |
| Phase 2: Keystone Bootstrap | \~2-3 min       | Keystone Deploy + Bootstrap Job                                         |
| Phase 3: Credentials        | \~1-2 min       | Import bootstrap resources, Service Users + App Credentials (via K-ORC) |
| Phase 4: Core Services      | \~2-3 min       | Glance, Placement (parallel)                                            |
| Phase 5: Compute Services   | \~3-5 min       | Nova, Neutron, Cinder (parallel)                                        |
| Phase 6: Cross-Cluster Sync | \~1-2 min       | ESO Secret Sync (OpenBao → all clusters)                                |
| Phase 7: Optional           | \~2-3 min       | Cortex (if enabled)                                                     |
| **Total**                   | **\~17-29 min** | Complete Control Plane                                                  |

**Failure Recovery:**

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                         BOOTSTRAP FAILURE RECOVERY                            │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Failure in Phase    │ Recovery Strategy                                      │
│  ────────────────────┼────────────────────────────────────────────────────────│
│  Phase 1 (Infra)     │ c5c3-operator waits for Infrastructure readiness       │
│                      │ → Automatic retry every 30s                            │
│                      │ → Condition: InfrastructureReady=False                 │
│                      │                                                        │
│  Phase 2 (Keystone)  │ keystone-operator has its own retry logic              │
│                      │ → Bootstrap Job restarted on failure                   │
│                      │ → Condition: KeystoneReady=False                       │
│                      │                                                        │
│  Phase 3 (Creds)     │ Credentials created idempotently                       │
│                      │ → Existing Users/AppCreds not overwritten              │
│                      │ → Condition: CredentialsReady=False                    │
│                      │                                                        │
│  Phase 4-5 (Services)│ Service Operators wait for dependencies                │
│                      │ → dependsOn Conditions must be True                    │
│                      │ → Automatic retry on dependency failure                │
│                      │                                                        │
│  Phase 6 (Sync)      │ ESO Reconciliation Loop                                │
│                      │ → Secrets automatically synced on change               │
│                      │ → Condition: CrossClusterSyncReady=False               │
│                      │                                                        │
│  Manual Recovery     │ kubectl delete pod -l app=<service> -n openstack       │
│                      │ → Operator reconciles automatically                    │
│                      │                                                        │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Service User Configuration in ControlPlane CRD

```yaml
apiVersion: c5c3.io/v1alpha1
kind: ControlPlane
metadata:
  name: production
  namespace: openstack
spec:
  identity:
    keystone:
      replicas: 3

      # Bootstrap configuration
      bootstrap:
        adminUser:
          name: admin
          passwordSecretRef:
            name: keystone-admin-credentials
            key: password

        # Service Users — each gets an Application Credential via K-ORC.
        # The passwordSecretRef is only used for initial user creation;
        # all runtime authentication uses Application Credentials
        # distributed via PushSecret → OpenBao → ESO.
        serviceUsers:
          - name: nova
            project: service
            roles: [admin, service]
            passwordSecretRef:
              name: openstack-service-passwords
              key: nova-password
            applicationCredential:
              enabled: true
              name: nova-app-credential
              targetSecretRef:
                name: nova-app-credential
                namespace: openstack

          - name: neutron
            project: service
            roles: [admin, service]
            passwordSecretRef:
              name: openstack-service-passwords
              key: neutron-password
            applicationCredential:
              enabled: true
              name: neutron-app-credential
              targetSecretRef:
                name: neutron-app-credential
                namespace: openstack

          - name: glance
            project: service
            roles: [admin, service]
            passwordSecretRef:
              name: openstack-service-passwords
              key: glance-password
            applicationCredential:
              enabled: true
              name: glance-app-credential
              targetSecretRef:
                name: glance-app-credential
                namespace: openstack

          - name: cinder
            project: service
            roles: [admin, service]
            passwordSecretRef:
              name: openstack-service-passwords
              key: cinder-password
            applicationCredential:
              enabled: true
              name: cinder-app-credential
              targetSecretRef:
                name: cinder-app-credential
                namespace: openstack

          - name: placement
            project: service
            roles: [admin, service]
            passwordSecretRef:
              name: openstack-service-passwords
              key: placement-password
            applicationCredential:
              enabled: true
              name: placement-app-credential
              targetSecretRef:
                name: placement-app-credential
                namespace: openstack

          # K-ORC Service User
          - name: k-orc
            project: service
            roles: [admin]
            passwordSecretRef:
              name: k-orc-credentials
              key: password
            applicationCredential:
              enabled: true
              name: k-orc-app-credential
              targetSecretRef:
                name: k-orc-clouds-yaml
                namespace: orc-system

          # Cortex Service User (read-only)
          - name: cortex
            project: service
            roles: [reader]
            passwordSecretRef:
              name: cortex-credentials
              key: password
            applicationCredential:
              enabled: true
              name: cortex-app-credential
              roles: [reader]  # Restricted to read-only
              targetSecretRef:
                name: cortex-clouds-yaml
                namespace: openstack

status:
  identity:
    phase: Ready
    serviceUsers:
      - name: nova
        status: Ready
        userID: "abc123..."
        applicationCredential:
          status: Ready
          credentialID: "aaa111..."
          expiresAt: "2024-04-15T00:00:00Z"
      - name: glance
        status: Ready
        userID: "bbb222..."
        applicationCredential:
          status: Ready
          credentialID: "ccc333..."
          expiresAt: "2024-04-15T00:00:00Z"
      - name: k-orc
        status: Ready
        userID: "def456..."
        applicationCredential:
          status: Ready
          credentialID: "ghi789..."
          expiresAt: "2024-04-15T00:00:00Z"
```

> **See also:** [K-ORC section](../../03-components/01-control-plane.md#openstack-resource-controller-k-orc) for K-ORC architecture, CRD types, management policies, and deployment details.

## K-ORC Credential Flow

K-ORC requires credentials for accessing OpenStack APIs. Using Application Credentials is recommended:

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    K-ORC APPLICATION CREDENTIAL FLOW                          │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  1. OpenBao Secret (kv-v2/openstack/k-orc/credentials)                        │
│     └──▶ ESO ExternalSecret creates Kubernetes Secret                         │
│                                                                               │
│  2. c5c3-operator reads password                                              │
│     └──▶ Creates Keystone User "k-orc" with password                          │
│                                                                               │
│  3. c5c3-operator creates K-ORC ApplicationCredential CR                      │
│     └──▶ K-ORC reconciles → Keystone returns credential ID + secret           │
│                                                                               │
│  4. K-ORC writes clouds.yaml to Kubernetes Secret                             │
│     └──▶ Secret: k-orc-app-credential (namespace: openstack)                  │
│                                                                               │
│  5. PushSecret writes Secret to OpenBao                                       │
│     └──▶ kv-v2/openstack/k-orc/app-credential                                 │
│                                                                               │
│  6. ESO ExternalSecret reads from OpenBao                                     │
│     └──▶ Creates Secret: k-orc-clouds-yaml (namespace: orc-system)            │
│                                                                               │
│  7. K-ORC Deployment mounts Secret                                            │
│     ┌─────────────────────────────────────────────────────────────────────┐   │
│     │ spec:                                                               │   │
│     │   containers:                                                       │   │
│     │   - name: manager                                                   │   │
│     │     volumeMounts:                                                   │   │
│     │     - name: clouds-yaml                                             │   │
│     │       mountPath: /etc/openstack                                     │   │
│     │     env:                                                            │   │
│     │     - name: OS_CLIENT_CONFIG_FILE                                   │   │
│     │       value: /etc/openstack/clouds.yaml                             │   │
│     │   volumes:                                                          │   │
│     │   - name: clouds-yaml                                               │   │
│     │     secret:                                                         │   │
│     │       secretName: k-orc-clouds-yaml                                 │   │
│     └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

> **See also:** [K-ORC Credential Management](../../03-components/01-control-plane.md#openstack-resource-controller-k-orc) for the concrete PushSecret and ExternalSecret manifests that implement steps 5–6.

## Application Credential Distribution to Service Operators

K-ORC creates Application Credentials not only for its own authentication but for **all OpenStack service users** (Glance, Nova, Neutron, Cinder, Placement). These flow through OpenBao + ESO to the service operator deployments. The service user passwords from OpenBao are only used for initial user creation in Keystone — all runtime authentication uses Application Credentials.

**Advantages over direct password auth:**

* **Least Privilege**: Application Credentials cannot create further credentials
* **Rotatable**: Automatic rotation via `CredentialRotation` CRD with zero-downtime
* **Time-limited**: Built-in expiration dates enforced by Keystone
* **Revocable**: Instant revocation without deleting the service user
* **Auditable**: Every credential stored and versioned in OpenBao KV v2

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│        APPLICATION CREDENTIAL DISTRIBUTION (K-ORC → OpenBao → Service)        │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  CONTROL PLANE CLUSTER                                                        │
│                                                                               │
│  ┌──────────────────────┐     ┌──────────────────────┐                        │
│  │ c5c3-operator        │     │ K-ORC                │                        │
│  │                      │     │ (orc-system)         │                        │
│  │ Creates K-ORC CRs:   │     │                      │                        │
│  │ ApplicationCredential│────▶│ Reconciles CRs:      │                        │
│  │ for each service     │     │ Creates AppCred in   │                        │
│  │ (nova, glance, ...)  │     │ Keystone, writes     │                        │
│  │                      │     │ result to K8s Secret │                        │
│  └──────────────────────┘     └──────────┬───────────┘                        │
│                                          │                                    │
│              K8s Secrets (namespace: openstack):                              │
│              nova-app-credential, glance-app-credential,                      │
│              neutron-app-credential, cinder-app-credential, ...               │
│                                          │                                    │
│                                          ▼                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐    │
│  │                    PushSecrets (per service)                          │    │
│  │                                                                       │    │
│  │  nova-app-credential     ──▶  kv-v2/openstack/nova/app-credential     │    │
│  │  glance-app-credential   ──▶  kv-v2/openstack/glance/app-credential   │    │
│  │  neutron-app-credential  ──▶  kv-v2/openstack/neutron/app-credential  │    │
│  │  cinder-app-credential   ──▶  kv-v2/openstack/cinder/app-credential   │    │
│  │  placement-app-credential──▶  kv-v2/openstack/placement/app-credential│    │
│  │  k-orc-app-credential    ──▶  kv-v2/openstack/k-orc/app-credential    │    │
│  │  cortex-app-credential   ──▶  kv-v2/openstack/cortex/app-credential   │    │
│  └───────────────────────────────────────┬───────────────────────────────┘    │
│                                          │                                    │
└──────────────────────────────────────────┼────────────────────────────────────┘
                                           │
                                           ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                         OpenBao (Management Cluster)                          │
│                                                                               │
│  kv-v2/openstack/nova/app-credential                                          │
│  kv-v2/openstack/glance/app-credential                                        │
│  kv-v2/openstack/neutron/app-credential                                       │
│  kv-v2/openstack/cinder/app-credential                                        │
│  kv-v2/openstack/placement/app-credential                                     │
│  kv-v2/openstack/k-orc/app-credential                                         │
│  kv-v2/openstack/cortex/app-credential                                        │
│                                                                               │
└───────────────────────────────────────────┬───────────────────────────────────┘
                                            │
                                            ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                    ESO ExternalSecrets (per service)                          │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  CONTROL PLANE CLUSTER                                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐    │
│  │  ExternalSecret → K8s Secret (namespace: openstack)                   │    │
│  │                                                                       │    │
│  │  nova-keystone-credentials      ← kv-v2/openstack/nova/app-credential │    │
│  │  glance-keystone-credentials    ← kv-v2/openstack/glance/app-cred.    │    │
│  │  neutron-keystone-credentials   ← kv-v2/openstack/neutron/app-cred.   │    │
│  │  cinder-keystone-credentials    ← kv-v2/openstack/cinder/app-cred.    │    │
│  │  placement-keystone-credentials ← kv-v2/openstack/placement/app-cred. │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                          │                                    │
│                                          ▼                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐    │
│  │  c5c3-operator: Config Rendering                                      │    │
│  │                                                                       │    │
│  │  Reads Application Credential from K8s Secret                         │    │
│  │  Renders [keystone_authtoken] with:                                   │    │
│  │    auth_type = v3applicationcredential                                │    │
│  │    application_credential_id = <from secret>                          │    │
│  │    application_credential_secret = <from secret>                      │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                          │                                    │
│                                          ▼                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐    │
│  │  Service Operators deploy with rendered config                        │    │
│  │                                                                       │    │
│  │  glance-operator  → Glance API Pods (glance-api.conf)                 │    │
│  │  nova-operator    → Nova API/Scheduler/Conductor Pods (nova.conf)     │    │
│  │  neutron-operator → Neutron API Pods (neutron.conf)                   │    │
│  │  cinder-operator  → Cinder API/Scheduler Pods (cinder.conf)           │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Concrete Example — Glance Application Credential:**

```yaml
# 1. c5c3-operator creates K-ORC ApplicationCredential CR
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: ApplicationCredential
metadata:
  name: glance-app-credential
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  resource:
    name: glance-app-credential
    description: "Glance service authentication"
    userRef:
      name: glance  # K-ORC User CR
    roles:
      - name: admin
      - name: service

---
# 2. PushSecret pushes K-ORC-created Secret to OpenBao
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: glance-app-credential
  namespace: openstack
spec:
  secretStoreRefs:
    - name: openbao-cluster-store
      kind: ClusterSecretStore
  selector:
    secret:
      name: glance-app-credential  # Written by K-ORC
  data:
    - match:
        secretKey: clouds.yaml
        remoteRef:
          remoteKey: kv-v2/data/openstack/glance/app-credential
          property: clouds.yaml

---
# 3. ExternalSecret reads from OpenBao → K8s Secret for glance-operator
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: glance-keystone-credentials
  namespace: openstack
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-cluster-store
    kind: ClusterSecretStore
  target:
    name: glance-keystone-credentials
    creationPolicy: Owner
  data:
    - secretKey: application_credential_id
      remoteRef:
        key: kv-v2/data/openstack/glance/app-credential
        property: application_credential_id
    - secretKey: application_credential_secret
      remoteRef:
        key: kv-v2/data/openstack/glance/app-credential
        property: application_credential_secret
```

The c5c3-operator watches `glance-keystone-credentials` and renders the Glance configuration with Application Credential auth. The glance-operator then deploys the Glance API pods with the rendered configuration. The same pattern applies to all OpenStack service operators.

## Cross-Cluster Secret Synchronization

Credentials must be synchronized between clusters. This is done via OpenBao and the External Secrets Operator (ESO):

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CROSS-CLUSTER SECRET SYNC (via OpenBao + ESO)              │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  STORAGE CLUSTER              MANAGEMENT CLUSTER           HYPERVISOR CLUSTER │
│  ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐  │
│  │                 │         │                 │         │                 │  │
│  │ Rook Operator   │         │     OpenBao     │         │ Nova Compute    │  │
│  │ creates:        │         │                 │         │ receives:       │  │
│  │                 │         │  kv-v2/ceph/    │         │                 │  │
│  │ Secret:         │────────▶│  client-nova    │────────▶│ Secret:         │  │
│  │ rook-ceph-      │PushSec. │                 │External │ ceph-client-    │  │
│  │ client-nova     │         │  (centrally     │ Secret  │ nova            │  │
│  │                 │         │   stored)       │         │                 │  │
│  └─────────────────┘         └─────────────────┘         └─────────────────┘  │
│                                                                               │
│  CONTROL PLANE CLUSTER                                    HYPERVISOR CLUSTER  │
│  ┌─────────────────┐                                     ┌─────────────────┐  │
│  │                 │                                     │                 │  │
│  │ c5c3-operator   │         ┌─────────────────┐         │ Nova Compute    │  │
│  │ creates:        │         │     OpenBao     │         │ ovn-controller  │  │
│  │                 │         │                 │         │ receives:       │  │
│  │ Secret:         │────────▶│  kv-v2/openstack│────────▶│ Secret:         │  │
│  │ nova-compute-   │PushSec. │  /nova/compute- │External │ nova-compute-   │  │
│  │ credentials     │         │  config         │ Secret  │ credentials     │  │
│  │                 │         │                 │         │                 │  │
│  └─────────────────┘         └─────────────────┘         └─────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Flow:**

1. Operator creates K8s Secret in source cluster (Rook, c5c3-operator)
2. PushSecret CRD writes the secret to OpenBao (kv-v2 Engine)
3. ExternalSecret CRD in target cluster reads from OpenBao and creates local K8s Secret
4. ESO reconciles automatically on changes (configurable refreshInterval)

## Ceph Keys Flow to Compute/Libvirt

The complete flow for Ceph credentials from Storage Cluster to the Libvirt daemon:

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CEPH SECRET FLOW TO HYPERVISOR                             │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  STORAGE CLUSTER                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                         │  │
│  │  1. CephClient CRD (created by Rook Operator)                           │  │
│  │     apiVersion: ceph.rook.io/v1                                         │  │
│  │     kind: CephClient                                                    │  │
│  │     metadata:                                                           │  │
│  │       name: openstack-nova-compute                                      │  │
│  │     spec:                                                               │  │
│  │       caps:                                                             │  │
│  │         mon: "profile rbd"                                              │  │
│  │         osd: "profile rbd pool=volumes, pool=images, pool=vms"          │  │
│  │                              │                                          │  │
│  │                              ▼                                          │  │
│  │  2. Rook Operator creates Kubernetes Secret                             │  │
│  │     Secret: rook-ceph-client-openstack-nova-compute                     │  │
│  │     data:                                                               │  │
│  │       openstack-nova-compute: AQBxxxxxxxxxxxxxxxxxxx==                  │  │
│  │                                                                         │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              │ PushSecret → OpenBao → ESO ExternalSecret      │
│                              ▼                                                │
│  HYPERVISOR CLUSTER                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                         │  │
│  │  3. Secret arrives (synced by ESO via OpenBao)                          │  │
│  │     Secret: ceph-client-nova (namespace: openstack)                     │  │
│  │     data:                                                               │  │
│  │       key: AQBxxxxxxxxxxxxxxxxxxx==                                     │  │
│  │       monitors: MTAuMC4xLjEwOjY3ODksMTAuMC4xLjExOjY3ODk=                │  │
│  │                              │                                          │  │
│  │                              ▼                                          │  │
│  │  4. Nova Compute DaemonSet mounts Secret                                │  │
│  │     volumeMounts:                                                       │  │
│  │     - name: ceph-secret                                                 │  │
│  │       mountPath: /etc/ceph/ceph.client.nova.keyring                     │  │
│  │       subPath: keyring                                                  │  │
│  │                              │                                          │  │
│  │                              ▼                                          │  │
│  │  5. Hypervisor Node Agent creates Libvirt Secret on each node           │  │
│  │     ┌─────────────────────────────────────────────────────────────────┐ │  │
│  │     │ # ceph-secret.xml                                               │ │  │
│  │     │ <secret ephemeral='no' private='no'>                            │ │  │
│  │     │   <uuid>457eb676-xxxx-xxxx-xxxx-xxxxxxxxxxxx</uuid>             │ │  │
│  │     │   <usage type='ceph'>                                           │ │  │
│  │     │     <name>client.nova secret</name>                             │ │  │
│  │     │   </usage>                                                      │ │  │
│  │     │ </secret>                                                       │ │  │
│  │     │                                                                 │ │  │
│  │     │ virsh secret-define --file /tmp/ceph-secret.xml                 │ │  │
│  │     │ virsh secret-set-value --secret $UUID --base64 $KEY             │ │  │
│  │     └─────────────────────────────────────────────────────────────────┘ │  │
│  │                              │                                          │  │
│  │                              ▼                                          │  │
│  │  6. Libvirt uses Secret for RBD access                                  │  │
│  │     VM Disk: rbd:volumes/volume-xxx:auth_supported=cephx:...            │  │
│  │                                                                         │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Service Config Rendering with Credentials

The c5c3-operator aggregates all secrets and renders OpenStack configuration files:

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CONFIG RENDERING ARCHITECTURE                              │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  INPUT: ControlPlane CRD + Aggregated Secrets                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                         │  │
│  │  ControlPlane CR                    Secrets (watched by c5c3-operator)  │  │
│  │  ┌──────────────────────┐          ┌──────────────────────┐             │  │
│  │  │ spec:                │          │ mariadb-credentials  │             │  │
│  │  │   openstack:         │          │ ├── host: mariadb    │             │  │
│  │  │     nova:            │          │ ├── password: xxxxx  │             │  │
│  │  │       replicas: 3    │          ├──────────────────────┤             │  │
│  │  │   storage:           │          │ rabbitmq-credentials │             │  │
│  │  │     ceph:            │          │ ├── host: rabbitmq   │             │  │
│  │  │       monitors: [...]│          │ ├── password: yyyyy  │             │  │
│  │  └──────────────────────┘          ├──────────────────────┤             │  │
│  │                                    │ ceph-client-cinder   │             │  │
│  │                                    │ └── key: AQBxxxx     │             │  │
│  │                                    └──────────────────────┘             │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  PROCESSING: ConfigRenderer (Go Templates + Sprig)                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  type ConfigRenderer struct {                                           │  │
│  │      templates     map[string]*template.Template                        │  │
│  │      secretStore   SecretStore                                          │  │
│  │      controlPlane  *v1alpha1.ControlPlane                               │  │
│  │  }                                                                      │  │
│  │                                                                         │  │
│  │  func (r *ConfigRenderer) RenderNovaConf() (string, error) {            │  │
│  │      data := map[string]interface{}{                                    │  │
│  │          "Database":  r.secretStore.Get("mariadb"),                     │  │
│  │          "RabbitMQ":  r.secretStore.Get("rabbitmq"),                    │  │
│  │          "AppCred":   r.secretStore.Get("nova-keystone-credentials"),   │  │
│  │          "Ceph":      r.secretStore.Get("ceph-client-nova"),            │  │
│  │          "Spec":      r.controlPlane.Spec.OpenStack.Nova,               │  │
│  │      }                                                                  │  │
│  │      return r.templates["nova.conf"].Execute(data)                      │  │
│  │  }                                                                      │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  OUTPUT: Rendered ConfigMap                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  ConfigMap: nova-config                                                 │  │
│  │  data:                                                                  │  │
│  │    nova.conf: |                                                         │  │
│  │      [DEFAULT]                                                          │  │
│  │      compute_driver = libvirt.LibvirtDriver                             │  │
│  │                                                                         │  │
│  │      [database]                                                         │  │
│  │      connection = mysql+pymysql://nova:xxxxx@mariadb:3306/nova          │  │
│  │                                                                         │  │
│  │      [oslo_messaging_rabbit]                                            │  │
│  │      rabbit_host = rabbitmq                                             │  │
│  │      rabbit_userid = openstack                                          │  │
│  │      rabbit_password = yyyyy                                            │  │
│  │                                                                         │  │
│  │      [keystone_authtoken]                                               │  │
│  │      auth_url = https://keystone:5000                                   │  │
│  │      auth_type = v3applicationcredential                                │  │
│  │      application_credential_id = abc123...                              │  │
│  │      application_credential_secret = xyz789...                          │  │
│  │                                                                         │  │
│  │      [libvirt]                                                          │  │
│  │      rbd_user = nova                                                    │  │
│  │      rbd_secret_uuid = 457eb676-xxxx-xxxx-xxxx-xxxxxxxxxxxx             │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Credential Rotation

For Application Credentials, the c5c3-operator supports automatic rotation:

```yaml
apiVersion: c5c3.io/v1alpha1
kind: CredentialRotation
metadata:
  name: k-orc-rotation
  namespace: openstack
spec:
  targetServiceUser: k-orc
  rotationType: applicationCredential
  schedule:
    intervalDays: 90              # Valid for: 90 days
    preRotationDays: 7            # New credential 7 days before expiration
  gracePeriodDays: 1              # Delete old credential 1 day after rotation
status:
  currentCredential:
    id: "abc123..."
    createdAt: "2024-01-15T00:00:00Z"
    expiresAt: "2024-04-15T00:00:00Z"
  lastRotation: "2024-01-15T00:00:00Z"
  nextRotation: "2024-04-08T00:00:00Z"
  conditions:
    - type: RotationScheduled
      status: "True"
```

**Rotation Timeline:**

```text
├──────────────────────────────────────────────────────────────────────────────┤
│ Day 0        │ Day 83          │ Day 90          │ Day 91                    │
│ Create       │ New Credential  │ Old Expires     │ Delete Old                │
│ AppCred      │ Created         │ (unused)        │ Credential                │
│ (90 days)    │ (7d before)     │                 │                           │
├──────────────────────────────────────────────────────────────────────────────┤
```

## Secret Aggregation CRD

For aggregating operator-generated secrets:

```yaml
apiVersion: c5c3.io/v1alpha1
kind: SecretAggregate
metadata:
  name: openstack-infrastructure
  namespace: openstack
spec:
  sources:
    - name: mariadb
      secretRef:
        name: mariadb-root-credentials    # From MariaDB Operator
        namespace: openstack
      keys:
        - sourceKey: password
          targetKey: MARIADB_PASSWORD
        - sourceKey: username
          targetKey: MARIADB_USERNAME

    - name: rabbitmq
      secretRef:
        name: rabbitmq-default-user       # From RabbitMQ Operator
        namespace: openstack
      keys:
        - sourceKey: password
          targetKey: RABBITMQ_PASSWORD

    - name: valkey
      secretRef:
        name: valkey-openstack-valkey-binding  # From Valkey Operator (SAP)
        namespace: openstack
      keys:
        - sourceKey: password
          targetKey: VALKEY_PASSWORD

    - name: ceph
      secretRef:
        name: ceph-client-openstack       # Synced by ESO (OpenBao)
        namespace: openstack
      keys:
        - sourceKey: key
          targetKey: CEPH_KEY

  target:
    secretName: openstack-credentials
    namespace: openstack

status:
  conditions:
    - type: Ready
      status: "True"
    - type: AllSourcesAvailable
      status: "True"
  lastAggregated: "2024-01-15T10:30:00Z"
```

## Overall View: Credential Layers

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CREDENTIAL ARCHITECTURE LAYERS                             │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  LAYER 1: OpenBao (Bootstrap Secrets)                                         │
│  ────────────────────────────────────                                         │
│  • keystone-admin-password (Initial Admin)                                    │
│  • service-user-passwords (nova, neutron, glance, cinder, ...)                │
│  • k-orc-password, cortex-password                                            │
│  • Versioned in KV v2, audit log, policy-based access control                 │
│                                                                               │
│  LAYER 2: K-ORC + c5c3-operator (Keystone Integration)                        │
│  ─────────────────────────────────────────────────────                        │
│  • Bootstrap Keystone (Admin, Service Project, Roles)                         │
│  • K-ORC creates Keystone Services + Endpoints                                │
│  • K-ORC creates Service Users (passwords only for initial creation)          │
│  • K-ORC creates Application Credentials for ALL services                     │
│  • PushSecrets write AppCredentials to OpenBao                                │
│  • ESO provides AppCredential secrets in target namespaces                    │
│  • c5c3-operator renders service configs with AppCredential auth              │
│  • CredentialRotation CRD manages automatic rotation                          │
│                                                                               │
│  LAYER 3: ESO + OpenBao (Cross-Cluster Sync)                                  │
│  ────────────────────────────────────────────                                 │
│  • PushSecret: K-ORC AppCredentials + Operator Secrets → OpenBao              │
│  • ExternalSecret: OpenBao → K8s Secrets in target clusters                   │
│  • Sync AppCredentials, nova-compute-credentials, ceph-client-*               │
│                                                                               │
│  LAYER 4: Config Rendering (c5c3-operator)                                    │
│  ─────────────────────────────────────────                                    │
│  • Aggregates all Secrets (Infrastructure + Ceph + AppCredentials)            │
│  • Renders nova.conf, neutron.conf, etc. with AppCredential auth              │
│  • Injects rendered configs into Service Pods                                 │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```
