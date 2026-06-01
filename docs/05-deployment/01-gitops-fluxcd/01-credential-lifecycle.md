# Credential Lifecycle

## Secret Management with OpenBao + ESO

Secrets are centrally stored in **OpenBao** (Management Cluster) and distributed to all clusters via the **External Secrets Operator (ESO)**. OpenBao forms the foundation for [OpenStack Credential Lifecycle Management](#openstack-credential-lifecycle-management), which manages service users, the K-ORC admin credential, and cross-cluster secret synchronization on top of it.

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
│  │  kv-v2/bootstrap/*      → Admin password (root of trust)    │  │
│  │  kv-v2/openstack/*      → Admin App Cred, per-pod user pws  │  │
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

::: tip Target architecture (issue [#30](https://github.com/C5C3/C5C3/issues/30))
This chapter describes the **target** credential model for the control plane. The
`c5c3-operator` that implements it currently exists only as a stub
(see [C5C3 Operator](../../09-implementation/08-c5c3-operator.md)); the
[Implementation Roadmap](#implementation-roadmap) at the end of this page breaks the
model into the incremental steps that forge will build. K-ORC capabilities and the
Keystone policy behavior below were verified against upstream source.
:::

CobaltCore manages OpenStack credentials around two settled choices:

1. **K-ORC owns the Keystone identity lifecycle.** Keystone users, projects, role
   assignments, domains, groups, services, and endpoints are reconciled declaratively by
   [`k-orc/openstack-resource-controller`](https://github.com/k-orc/openstack-resource-controller).
2. **Every workload pod that needs OpenStack credentials gets its own dedicated, *real*
   Keystone service user with its own password** — provisioned ahead of pod start, stored
   in OpenBao, and distributed only to that pod. **Credential lifetime = pod lifetime;
   rotation is pod recreation.**

K-ORC authenticates with a single **admin Application Credential**, bootstrapped once from
the admin password and **rotated on its own schedule**. That admin App Cred is the *only*
Application Credential in the design and is **never rendered into a workload pod**.

Workload service users are deliberately **real users + passwords, not Application
Credentials** — App Creds are project-bound, cannot carry `system` scope, and can only be
minted self-service (see [Why real users, not Application Credentials](#why-real-service-users-passwords-not-application-credentials)).

### Settled decisions

| # | Decision |
|---|---|
| D1 | **K-ORC** reconciles all Keystone identity objects (`User`, `Project`, `Role`/grants, `Domain`, `Group`, `Service`, `Endpoint`). |
| D2 | K-ORC's own credential is **one admin Application Credential**, bootstrapped from the admin password, **rotated** on an independent schedule, **never rendered into a workload pod**. |
| D3 | Each workload pod gets a **dedicated real Keystone service user + password** (not an App Cred), provisioned before pod start, stored in OpenBao, distributed only to that pod. |
| D4 | **Credential lifetime = pod lifetime.** Create-on-start, delete-on-terminate (finalizer). Rotation = pod recreation; no in-place per-pod password rotation by default. |
| D5 | All per-pod service users of a given service share **one stable service project** (only the user identity is ephemeral, never the project). |
| D6 | Workload service users are **real users + passwords**, not Application Credentials. |

### Architecture at a glance

```text
                    ┌──────────────────────────────────────────────────────────┐
   admin password   │  c5c3-operator                                           │
   (OpenBao, used   │   • generates per-pod passwords                          │
    only to         │   • renders pod auth config + OpenBao paths              │
    bootstrap/      │   • orchestrates K-ORC CRs                               │
    rotate) ───────▶│                                                          │
                    └───────────────┬──────────────────────────────────────────┘
                                    │ creates/rotates
                                    ▼
                    admin Application Credential  ──────────►  K-ORC
                    (restricted; NEVER in a pod)               authenticates via clouds.yaml
                                                               reconciles identity CRs
                                                                      │
              shared service project "service" (stable)               │ User + Role/grant CRs
              ├── svc-nova-api-0      (own password in OpenBao)  ◄────┤
              ├── svc-nova-api-1      (own password)             ◄────┤  one real user per pod
              ├── svc-neutron-…       (own password)             ◄────┤  deleted with its pod
              └── …                                                   │
                                                                      ▼
                          each password → ESO → Secret → mounted into exactly one pod
```

Three credential classes exist, with strictly different blast radii:

| Class | What | Where it lives | Reaches a workload pod? |
|---|---|---|---|
| **Admin password** | Keystone `admin` user password — the root of trust | `kv-v2/bootstrap/keystone-admin` (operator-only) | **Never** |
| **Admin Application Credential** | K-ORC's only credential; project-scoped, `restricted` | `kv-v2/openstack/admin/app-credential` → `orc-system` only | **Never** |
| **Per-pod service user** | Real Keystone user + password, one per pod | `kv-v2/openstack/<service>/pods/<pod>/user` → exactly one pod | **Yes** (the workload credential) |

**Invariants:**

* The admin App Cred and the admin password **MUST NOT** appear in any workload pod config
  or workload-mounted Secret.
* All per-pod users of a service belong to **one stable service project** with the same
  roles (D5). Authorization for nearly all Nova/Neutron/Cinder/Octavia resources is
  **project-scoped, not user-scoped**, so a resource created by user *N* stays manageable by
  user *N+1* after *N* is deleted.

## Why real service users + passwords, not Application Credentials

The original proposal was per-pod **Application Credentials** minted from a per-service-user
"Master" App Cred. It was rejected **for workload service users**. App Creds remain in use
**only** for K-ORC's admin credential (where they fit), for the following reasons.

### Hard scope limit

Every Application Credential — including a "Master" — is **bound to exactly one project** and
**can never carry `system` scope** (it is created from a project-scoped token; there is no
domain- or system-scoped App Cred, and an app-cred token cannot be rescoped). Minting derived
credentials does not lift this ceiling.

### The two roles a service-user credential plays

1. **Role 1 — on-behalf-of-user** (`X-Service-Token` companion to a forwarded user token;
   e.g. nova → cinder/neutron for a user request). The service token only proves *"trusted
   service"* via `role:service`; the project context comes from the **user** token.
   → an App Cred *would* work.
2. **Role 2 — autonomous** (no user token: periodic tasks, agents, cross-project cleanup,
   anything where the service acts as itself). Needs project-transcending authority — legacy
   global-`admin` or `system` scope. → an App Cred **cannot** do this.

Because the workload credential is rendered as the service user's **primary** credential and
any pod can hit a role-2 path, a project-bound App Cred is structurally insufficient. The
two-tier Master/per-pod refinement improves blast radius and rotation but **cannot raise the
scope ceiling**.

### Self-service minting makes App Creds no simpler than passwords

Keystone creation of an App Cred is **strictly self-service**:
`POST /v3/users/{user_id}/application_credentials` is hard-rejected unless the token's user
**is** that user (`keystone/api/users.py`). So even an admin App Cred **cannot mint a service
user's App Cred** — you must authenticate **as that user** with its password. Since you need
the user's password anyway, a real **user + password** is the simpler, more capable primitive,
and it also gets full scope.

### Classification

| Path | Example | Workload credential | Lifecycle |
|---|---|---|---|
| **1** on-behalf-of-user | nova → cinder/neutron for a user request | real user + password (App Cred would also work) | pod-lifecycle |
| **2a** autonomous, stateless, cross-project/`system` | periodic cleanup, agents, token validation | **real user + password** (App Cred insufficient) | **pod-lifecycle = credential lifecycle**; recreate to refresh |
| **2b** autonomous **and resource-creating** | **Octavia** amphora/port/SG creation | **real user + password** (same model) | same per-pod model; created resources are project-owned and persist across user churn (D5), reconciled by Octavia |

## The admin Application Credential

The admin App Cred is K-ORC's **only** credential and the only Application Credential anywhere
in the design.

* **Bootstrap:** created once from the admin **password** (held in OpenBao, used only for
  bootstrap/rotation), authenticating as admin (self-service trivially satisfied). The result
  flows K-ORC → PushSecret → OpenBao → ESO into the `k-orc-clouds-yaml` Secret that K-ORC
  mounts. See [K-ORC admin credential flow](#k-orc-admin-credential-flow).
* **It works even though App Creds don't work for workloads.** Verified against current
  Keystone policy: every operation K-ORC performs is reachable at **project scope** under
  `enforce_scope=True` (the default in recent 2024.x+ releases):

  | Operation | `scope_types` | check |
  |---|---|---|
  | `identity:create_user` | `['system','domain','project']` | `ADMIN_OR_DOMAIN_MANAGER` |
  | `identity:create_grant` / `revoke_grant` | `['system','domain','project']` | admin-or-domain-manager |
  | `identity:create_service` / `create_endpoint` | `['system','project']` | `RULE_ADMIN_REQUIRED` |
  | `identity:create_project` | `['system','domain','project']` | `ADMIN_OR_DOMAIN_MANAGER` |
  | `identity:create_domain` / `create_role` | `['system','project']` | `RULE_ADMIN_REQUIRED` |

  All include `project`, and `admin_required = 'role:admin or is_admin:1'` — **no
  `system_scope:all`**. So a **project-scoped admin App Cred carrying `role:admin` satisfies
  every K-ORC operation** — including service-catalog writes — even under `enforce_scope=True`.
* **Least privilege:** the admin App Cred is **`restricted`** (the default). Creating
  users/projects/grants/services/endpoints are *not* app-credential or trust operations, so
  restricting it (it cannot mint further app creds or trusts) does not block them. Optionally
  narrow further with `accessRules` to the identity and catalog endpoints.
* **Rotation (D2) — restricted + password-driven (chosen):** the rotation routine re-mints a
  fresh **restricted** admin App Cred using the admin **password** from OpenBao, then swaps the
  K-ORC Secret. The workload-facing posture stays unable to self-perpetuate, and this chains
  cleanly off the
  [admin-password rotation design](../../09-implementation/05-keystone-dependencies.md#admin-credential-rotation).
  The alternative (an *unrestricted* App Cred that mints its own successor) is simpler
  operationally but a leaked unrestricted credential can regenerate itself — rejected for
  blast radius. See [Credential Rotation](#credential-rotation).
* **No system-scoped admin needed.** The one classic `system_scope:all`-only operation —
  unified-limits `create_registered_limit` — **is not a K-ORC kind**, so it is out of scope by
  construction. K-ORC manages no resource that requires system scope; the project-scoped admin
  App Cred is sufficient on its own.
* **Invariant:** the admin App Cred (and the admin password) **MUST NOT** appear in any
  workload pod config or workload-mounted Secret.

## Per-pod service users

For every pod that needs OpenStack credentials, the `c5c3-operator` + K-ORC provision a
**dedicated real Keystone user**.

### Provisioning flow

1. The operator **generates a password** for the pod and writes it to OpenBao
   (`kv-v2/openstack/<service>/pods/<pod>/user`) and to a `password` Secret.
2. K-ORC reconciles a **`User`** CR (auth: admin App Cred) → creates `svc-<service>-<pod>`
   with that password as **input** (`User.passwordRef`), plus **`Role`/grant** CRs for exactly
   the roles that pod needs (`service`, `admin`, …).
3. ESO syncs the credential to a Secret mounted into **only that pod**; the operator renders
   it into the pod's auth config (see [Config rendering](#service-config-rendering-with-credentials)).
4. On **pod (or pod-identity) deletion**, a finalizer makes K-ORC **delete the Keystone user**
   → immediately revoking its tokens, role assignments, and any derived credentials.

### Granularity — hybrid (per-replica default, opt-in ephemeral)

Issue #30 left the meaning of "per pod" open. CobaltCore adopts a **hybrid** model:

* **Per-replica (default).** A user is bound to a **stable pod identity** —
  `svc-<service>-<ordinal>` for a StatefulSet, or `svc-<service>-<node>` for a per-node
  DaemonSet (e.g. nova-compute). The operator **pre-provisions** one user per replica slot
  *from the configured replica count*, so credentials exist before pods start (no admission
  webhook, no start-time race) and the total user count is bounded
  (`Σ replicas`). A crash-restart of a slot **reuses** that slot's user; rotation happens on
  *intentional* recreation (deploy / scale / `maxAge`). This slightly relaxes D4's "every
  crash-restart = a new credential" to "every **intentional** recreation = a new credential."

  > **Deployment note.** Per-replica-stable identity maps naturally to **StatefulSets** (stable
  > ordinals) and per-node **DaemonSets** (stable node identity). Control-plane workers that
  > require per-pod credentials are therefore deployed as StatefulSets; a service deployed as a
  > plain Deployment either runs as a StatefulSet when credentialed or selects ephemeral mode.

* **Ephemeral (opt-in, per service).** For high-security workloads, every pod instance — every
  restart, reschedule, crash-restart — gets a **brand-new** user + password, via an operator
  pod-watch + finalizer. This is the strongest realization of D4 (rotation = recreation) but
  carries higher Keystone user churn, a credential-must-exist-before-pod-start race, and
  heavier garbage collection. It is selected per service (`mode: Ephemeral`).

### The project invariant (D5)

All per-pod users of a service are members of **one stable service project** with the same
roles — only the *user* identity is ephemeral, never the *project*. Because authorization for
nearly all Nova/Neutron/Cinder/Octavia resources is **project-scoped, not user-scoped**, a
resource created by user *N* remains manageable by user *N+1* after *N* is deleted.

*Exception:* a few resources are **user**-owned (e.g. Nova keypairs) and do not transfer across
user churn. Services relying on user-owned objects must account for this; CobaltCore's
control-plane services do not depend on it for steady-state operation.

### Rotation = pod recreation (D4)

OpenStack services generally need a restart to pick up a changed password (oslo.config is read
at start / on SIGHUP; keystoneauth caches the auth plugin), so in-place rotation already implies
a restart — making **delete-pod → create-fresh-user** the simpler, stronger equivalent (it also
revokes the old credential immediately). Every deploy / rollout / reschedule / crash-restart
(ephemeral) or *intentional* recreation (per-replica) yields a brand-new user + password; **no
separate rotation machinery for those events.**

* **Long-lived pods** (controllers, StatefulSets running for weeks) don't churn → drive periodic
  refresh with a **`maxAge`** that triggers **rolling pod recreation**, not an in-place password
  change.

### Garbage collection (resolved: finalizer + sweeper)

* **Finalizer (primary):** the per-pod `User` CR (and its `Role`/grant CRs) carries a finalizer;
  deleting the pod-identity deletes the `User` CR, and K-ORC's own finalizer deletes the Keystone
  user before the CR is removed.
* **Sweeper (backstop):** a periodic c5c3-operator reconcile lists Keystone users carrying the
  c5c3-managed naming prefix / tag (`svc-<service>-…`) and deletes any with no corresponding live
  pod-identity or owner — covering the case where a finalizer was skipped (force-deleted pod,
  lost node). Orphan deletions are logged.

### Precondition — writable identity backend (resolved)

Per-pod *users* require a **writable (SQL) identity backend**. CobaltCore deploys Keystone with
its own MariaDB-backed SQL identity store, so this holds by default. Under a **read-only LDAP**
identity backend, dynamic user creation is impossible: service users for such a deployment must
live in a **SQL-backed domain** (e.g. the `Default` domain), and per-pod provisioning is
restricted to that domain. This is documented as a hard deployment precondition.

## Resource-creating services (e.g. Octavia)

Some service users **create long-lived resources that outlive any pod**. **Octavia** is the
example in our deployment: via `[service_auth]` it creates **amphora VMs, ports, security
groups** owned by the **Octavia service project**, running for the load balancer's lifetime
(days/weeks). These services follow the **same uniform per-pod model** (D3/D4) — **no special-case
treatment** — because the project invariant already makes it safe:

* **User deletion does NOT delete the resources.** Keystone user deletion does not cascade to
  Nova/Neutron/Cinder; those objects are **project-owned** and keep running.
* **They stay manageable by the next pod's user** because all per-pod users share one stable
  service project (D5). Octavia tracks amphorae by ID in its own DB and re-authenticates with the
  current pod's credential; its health-manager / failover reconciles anything left mid-build when
  a pod (and its user) is replaced.
* **Dangling `user_id`** on the resources is cosmetic for management but can skew **per-user**
  audit/quota; project-scoped (unified-limits) quota is unaffected.
* **In-flight operations** interrupted by a pod/user replacement are repaired by Octavia's own
  reconciliation — the same way an ordinary pod restart is handled. We **accept this and add no
  drain-gating**.

> The one failure mode that *would* force a stable user — services that create **Keystone trusts**
> and break when the trustor is deleted — does **not** apply here: CobaltCore **does not deploy
> Heat, Trove, Magnum** or other trust-based services, and **Octavia uses no trusts**. If such a
> service is ever introduced, revisit this section.

## Credential Types and Sources

| Secret Type | Source | Created By | Distributed By | Consumer |
| --- | --- | --- | --- | --- |
| Admin Password (root of trust) | OpenBao | Manual / CI-CD | ESO | Keystone Bootstrap; admin App Cred bootstrap/rotation |
| Admin Application Credential | Keystone | K-ORC (from admin password) | PushSecret + ESO | K-ORC Controller (`orc-system`) — **never a workload pod** |
| Per-Pod Service User Password | OpenBao | c5c3-operator (generated per pod) | ESO | exactly one workload pod |
| Service Users (Keystone) | Keystone | K-ORC (`User` CR, password as input) | — | the matching workload pod |
| Role Assignments / Grants | Keystone | K-ORC (`Role`/grant CRs) | — | the matching service user |
| Keystone Services / Endpoints | Keystone | K-ORC | — | Service Catalog |
| clouds.yaml (Compute) | c5c3-operator | c5c3-operator | ESO | Nova Compute |
| Ceph Auth Keys | Rook | Rook Operator | PushSecret + ESO | Cinder, Glance, Nova |
| Libvirt Ceph Secret | Hypervisor Node Agent | Hypervisor Node Agent | — | LibVirt |
| Infrastructure Secrets | Operators | MariaDB/RabbitMQ/Valkey Op. | c5c3-operator | OpenStack Services |

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
│  │  ├── kv-v2/bootstrap/keystone-admin   # Admin password (root of trust)  │  │
│  │  └── kv-v2/infrastructure/*           # DB/MQ/cache root credentials    │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              │ ESO ExternalSecret → K8s Secret                │
│                              ▼                                                │
│  PHASE 1: Keystone Bootstrap                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  Keystone Bootstrap Job creates (admin password via ESO):               │  │
│  │  • Admin User • Service Project • Admin/Service Roles • Default Domain  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  PHASE 2: Admin App Cred + K-ORC bring-up                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  c5c3-operator:                                                         │  │
│  │  • mints the restricted admin Application Credential from the admin pw  │  │
│  │  • PushSecret → OpenBao → ESO → k-orc-clouds-yaml (orc-system)          │  │
│  │  • imports bootstrap resources into K-ORC (unmanaged):                  │  │
│  │      Default Domain, Service Project, Roles                             │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  PHASE 3: Catalog + per-pod service users (c5c3-operator via K-ORC)           │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  c5c3-operator creates via K-ORC (managed), auth = admin App Cred:      │  │
│  │  • Keystone Service entries + Endpoints (public + internal)             │  │
│  │  • Per replica slot of each credentialed service:                       │  │
│  │      ┌─────────────────────────────────────────────────────────────┐    │  │
│  │      │ generate password → OpenBao + password Secret               │    │  │
│  │      │ K-ORC User  svc-<service>-<ordinal>  (passwordRef)          │    │  │
│  │      │ K-ORC Role/grant CRs (service project, configured roles)    │    │  │
│  │      └─────────────────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │                                                │
│                              ▼                                                │
│  PHASE 4: Config Rendering & Secret Sync                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  • per-pod password → ESO → Secret mounted into exactly one pod         │  │
│  │  • operator injects username/password via env (OS_KEYSTONE_AUTHTOKEN__*)│  │
│  │  • ESO synchronizes cross-cluster secrets (Hypervisor/Storage)          │  │
│  │  • Services start with their dedicated credential                       │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

The bootstrap chicken-and-egg is solved the same way as before — the Keystone Bootstrap Job
seeds the foundational identity objects directly via the admin password, those are imported into
K-ORC as `unmanaged` (read-only), and only then does K-ORC create dependent resources. The change
from the earlier design is that **Phase 3 mints per-pod real users (not per-service Application
Credentials)**, and the **only** Application Credential created is K-ORC's own admin credential in
Phase 2.

## Bootstrap Sequence Diagram

The following sequence diagram shows the credential bootstrap process from the first FluxCD
reconcile to the running OpenStack Control Plane:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              CREDENTIAL BOOTSTRAP SEQUENCE                                                  │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                             │
│  ACTORS:                                                                                                    │
│  [Git]  [FluxCD]  [OpenBao/ESO]  [MariaDB-Op]  [c5c3-Op]  [keystone-Op]  [K-ORC]  [Service-Ops]             │
│                                                                                                             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 0–1: GitOps bootstrap + infrastructure + Keystone                                                     │
│   FluxCD reads admin pw + infra creds from OpenBao via ESO → deploys operators                              │
│   c5c3-operator → MariaDB/RabbitMQ/Memcached CRs → Ready                                                    │
│   c5c3-operator → Keystone CR → keystone-operator deploys Keystone + runs Bootstrap Job                     │
│     (Admin user, Service project, Admin/Service roles, Default domain)                                      │
│                                                                                                             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 2: Admin Application Credential                                                                       │
│   c5c3-operator → K-ORC ApplicationCredential CR (admin, restricted)  ── auth: admin password               │
│   K-ORC → Keystone: create App Cred → writes K8s Secret                                                     │
│   PushSecret → OpenBao (kv-v2/openstack/admin/app-credential) → ESO → k-orc-clouds-yaml (orc-system)        │
│   c5c3-operator imports Domain/Project/Roles into K-ORC (unmanaged)                                         │
│                                                                                                             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 3: Catalog + per-pod service users   (K-ORC auth = admin App Cred)                                    │
│   c5c3-operator → K-ORC Service + Endpoint CRs (managed)                                                    │
│   for each credentialed service, for each replica slot i:                                                   │
│     c5c3-operator: generate password → OpenBao + password Secret                                            │
│     c5c3-operator → K-ORC User CR  svc-<service>-i  (passwordRef)                                           │
│     c5c3-operator → K-ORC Role/grant CRs (service project, roles)                                           │
│   K-ORC → Keystone: create users + grants                                                                   │
│                                                                                                             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ PHASE 4–5: Service deploy + cross-cluster sync                                                              │
│   ESO syncs each per-pod password into the one pod's Secret                                                 │
│   service operators deploy pods; each pod authenticates as its own svc-<service>-i                          │
│   ESO syncs Ceph/compute/OVN secrets to Hypervisor/Storage clusters                                         │
│                                                                                                             │
│ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ │
│ COMPLETE: ControlPlane CR Status = Ready                                                                    │
│   conditions: InfrastructureReady, KeystoneReady, AdminCredentialReady,                                     │
│               CatalogReady, ServiceUsersReady, CrossClusterSyncReady                                        │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Bootstrap Times (typical):**

| Phase | Duration | Description |
| --- | --- | --- |
| Phase 0: GitOps Bootstrap | \~1 min | FluxCD Reconcile, ESO Secret Sync |
| Phase 1: Infrastructure + Keystone | \~7–13 min | MariaDB Galera, RabbitMQ, Valkey, Keystone Deploy + Bootstrap Job |
| Phase 2: Admin App Cred + K-ORC | \~1–2 min | Mint admin App Cred, import bootstrap resources |
| Phase 3: Catalog + Service Users | \~1–3 min | Services/Endpoints + per-pod users (via K-ORC) |
| Phase 4–5: Services + Cross-Cluster Sync | \~6–10 min | Service pods start with dedicated credentials, ESO sync |
| **Total** | **\~16–29 min** | Complete Control Plane |

## Service User Configuration in ControlPlane CRD

The ControlPlane CR declares, per service, *what kind* of service user each pod gets — the
project, the roles, the granularity mode, and the optional `maxAge`. It does **not** hold any
password; passwords are generated by the operator and never appear in the spec.

```yaml
apiVersion: c5c3.io/v1alpha1
kind: ControlPlane
metadata:
  name: production
  namespace: openstack
spec:
  region: RegionOne

  # K-ORC's only credential: the admin Application Credential.
  korc:
    cloudCredentialsRef:
      cloudName: openstack
      secretName: k-orc-clouds-yaml          # ESO-managed, from OpenBao
    adminCredential:
      # Bootstrapped & rotated from the admin password (operator-only, never in a pod).
      passwordSecretRef:
        name: keystone-admin-credentials
        key: password
      applicationCredential:
        restricted: true                     # default; cannot mint app creds/trusts
        accessRules: []                      # optional: narrow to identity/catalog endpoints
        rotation:
          mode: PasswordDriven               # restricted + password-driven re-mint
          intervalDays: 90

  services:
    nova:
      enabled: true
      replicas:
        api: 3
        scheduler: 2
        conductor: 2
      serviceUser:                           # per-pod real user (D3)
        project: service                     # stable service project (D5)
        roles: [service, admin]
        mode: PerReplica                     # PerReplica (default) | Ephemeral | None
        maxAge: 720h                         # rolling recreation for long-lived pods (D4)
    neutron:
      enabled: true
      replicas: 3
      serviceUser:
        project: service
        roles: [service, admin]
        mode: PerReplica
    glance:
      enabled: true
      replicas: 3
      serviceUser:
        project: service
        roles: [service, admin]
        mode: PerReplica
    cinder:
      enabled: true
      replicas: { api: 3, scheduler: 2, volume: 2 }
      serviceUser:
        project: service
        roles: [service, admin]
        mode: PerReplica
    placement:
      enabled: true
      replicas: 3
      serviceUser:
        project: service
        roles: [service, admin]
        mode: PerReplica

status:
  identity:
    phase: Ready
    adminCredential:
      status: Ready
      credentialID: "aaa111..."
      restricted: true
      lastRotation: "2026-05-01T00:00:00Z"
    serviceUsers:
      nova:
        mode: PerReplica
        project: service
        desiredReplicas: 7
        readyUsers: 7                        # svc-nova-api-0..2, -scheduler-0..1, -conductor-0..1
      glance:
        mode: PerReplica
        project: service
        desiredReplicas: 3
        readyUsers: 3
```

> **See also:** [K-ORC section](../../03-components/01-control-plane/05-korc.md) for K-ORC
> architecture, CRD types, management policies, and deployment details;
> [C5C3 Operator](../../09-implementation/08-c5c3-operator.md#per-pod-service-user-reconciler)
> for the reconciler design and Go types.

## K-ORC admin credential flow

K-ORC requires a `clouds.yaml` credential for authenticating against the Keystone API. It uses
the **admin Application Credential** (the design's only App Cred), bootstrapped from the admin
password:

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    K-ORC ADMIN APPLICATION CREDENTIAL FLOW                    │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  1. OpenBao Secret (kv-v2/bootstrap/keystone-admin → admin password)          │
│     └──▶ ESO ExternalSecret → keystone-admin-credentials (K8s Secret)         │
│                                                                               │
│  2. c5c3-operator authenticates as admin (password) and creates a K-ORC       │
│     ApplicationCredential CR (restricted) for the admin user                  │
│     └──▶ K-ORC reconciles → Keystone returns credential ID + secret           │
│                                                                               │
│  3. K-ORC writes clouds.yaml to a Kubernetes Secret                           │
│     └──▶ Secret: k-orc-app-credential (namespace: openstack)                  │
│                                                                               │
│  4. PushSecret writes Secret to OpenBao                                       │
│     └──▶ kv-v2/openstack/admin/app-credential                                 │
│                                                                               │
│  5. ESO ExternalSecret reads from OpenBao                                     │
│     └──▶ Creates Secret: k-orc-clouds-yaml (namespace: orc-system)            │
│                                                                               │
│  6. K-ORC Deployment mounts the Secret as clouds.yaml                         │
│     (auth_type: v3applicationcredential)                                      │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

> **See also:** [K-ORC Credential Management](../../03-components/01-control-plane/05-korc.md)
> for the concrete PushSecret and ExternalSecret manifests that implement steps 4–5.

## Per-pod credential distribution

K-ORC creates **one real Keystone user per pod**, and the **password originates with the
`c5c3-operator`** (K-ORC takes it as input via `User.passwordRef`; *"if not specified, the user
is created without a password"*). Each per-pod password flows to exactly one pod through OpenBao
+ ESO. There are **no per-service Application Credentials** for workloads.

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│        PER-POD SERVICE USER DISTRIBUTION (operator → K-ORC → OpenBao → pod)   │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  CONTROL PLANE CLUSTER                                                        │
│  ┌──────────────────────┐     ┌──────────────────────┐                        │
│  │ c5c3-operator        │     │ K-ORC                │                        │
│  │                      │     │ (orc-system)         │                        │
│  │ per replica slot i:  │     │  auth: admin App Cred│                        │
│  │ 1 generate password  │     │                      │                        │
│  │ 2 write OpenBao +    │     │ reconciles:          │                        │
│  │   password Secret    │────▶│  User svc-<svc>-i    │                        │
│  │ 3 create User CR     │     │  (passwordRef)       │                        │
│  │   (passwordRef)      │     │  Role/grant CRs      │                        │
│  │ 4 create Role CRs    │     │  → Keystone          │                        │
│  └──────────────────────┘     └──────────┬───────────┘                        │
│                                          │                                    │
│   PushSecret: password Secret ──▶ kv-v2/openstack/<svc>/pods/<pod>/user       │
│                                          │                                    │
└──────────────────────────────────────────┼────────────────────────────────────┘
                                           │
                                           ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  OpenBao: kv-v2/openstack/<service>/pods/<pod>/user  → {username, password}   │
└──────────────────────────────────────────┬────────────────────────────────────┘
                                           │  ESO ExternalSecret (one per pod)
                                           ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE CLUSTER                                                        │
│  ExternalSecret → K8s Secret  svc-<service>-<pod>-keystone   (one pod only)   │
│      keys: username, password                                                 │
│                          │                                                    │
│                          ▼                                                    │
│  Pod env (NOT in the ConfigMap — CC-0080):                                    │
│      OS_KEYSTONE_AUTHTOKEN__USERNAME ← username                               │
│      OS_KEYSTONE_AUTHTOKEN__PASSWORD ← password                               │
│  Immutable ConfigMap holds only: auth_url, auth_type=password, domains,       │
│  project_name=service                                                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Concrete example — a Glance API replica's service user:**

```yaml
# 1. c5c3-operator generates the password and writes it to a Secret
#    (and pushes it to OpenBao via PushSecret).
apiVersion: v1
kind: Secret
metadata:
  name: svc-glance-api-0-password
  namespace: openstack
type: Opaque
stringData:
  password: <generated-by-operator>

---
# 2. c5c3-operator creates the K-ORC User CR (auth: admin App Cred).
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: User
metadata:
  name: svc-glance-api-0
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml      # the admin App Cred
  managementPolicy: managed
  resource:
    name: svc-glance-api-0
    domainRef: default
    passwordRef:                        # password is an INPUT to K-ORC
      name: svc-glance-api-0-password
      key: password

---
# 3. Role assignment in the stable service project (D5).
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Role
metadata:
  name: svc-glance-api-0-service
  namespace: openstack
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml
  managementPolicy: managed
  resource:
    # role assignment: user svc-glance-api-0 → role service → project service
    assignment:
      userRef: svc-glance-api-0
      roleName: service
      projectRef: service-project

---
# 4. ESO syncs the password from OpenBao into the one pod's Secret.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: svc-glance-api-0-keystone
  namespace: openstack
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-cluster-store
    kind: ClusterSecretStore
  target:
    name: svc-glance-api-0-keystone
    creationPolicy: Owner
  data:
    - secretKey: username
      remoteRef:
        key: kv-v2/data/openstack/glance/pods/glance-api-0/user
        property: username
    - secretKey: password
      remoteRef:
        key: kv-v2/data/openstack/glance/pods/glance-api-0/user
        property: password
```

The glance-operator renders the static `[keystone_authtoken]` into an immutable ConfigMap and
injects the per-pod `username`/`password` via the `OS_KEYSTONE_AUTHTOKEN__USERNAME` /
`OS_KEYSTONE_AUTHTOKEN__PASSWORD` environment variables from `svc-glance-api-0-keystone` — so the
credential never lands in a ConfigMap (CC-0080). The same pattern applies to all OpenStack service
operators. The exact field names (`User.resource.passwordRef`, `Role.resource.assignment`) follow
K-ORC's `api/v1alpha1` types; verify them against the pinned K-ORC version during implementation.

## Cross-Cluster Secret Synchronization

Credentials must be synchronized between clusters. This is done via OpenBao and the External
Secrets Operator (ESO):

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

> Nova-compute pods on the Hypervisor Cluster are themselves credentialed workloads: each
> compute node's pod gets its own per-node service user (`svc-nova-compute-<node>`, D3) following
> the same per-pod model, distributed to that node only.

## Ceph Keys Flow to Compute/Libvirt

The complete flow for Ceph credentials from Storage Cluster to the Libvirt daemon:

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CEPH SECRET FLOW TO HYPERVISOR                             │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  STORAGE CLUSTER                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  1. CephClient CRD (created by Rook Operator)                           │  │
│  │     spec.caps: mon "profile rbd", osd "profile rbd pool=volumes,…"      │  │
│  │  2. Rook Operator creates K8s Secret                                    │  │
│  │     rook-ceph-client-openstack-nova-compute: AQB…==                     │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                              │ PushSecret → OpenBao → ESO ExternalSecret      │
│                              ▼                                                │
│  HYPERVISOR CLUSTER                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  3. Secret arrives (ceph-client-nova): key + monitors                   │  │
│  │  4. Nova Compute DaemonSet mounts the keyring                           │  │
│  │  5. Hypervisor Node Agent creates the Libvirt Secret on each node       │  │
│  │       virsh secret-define / virsh secret-set-value                      │  │
│  │  6. Libvirt uses the secret for RBD access                              │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Service Config Rendering with Credentials

The c5c3-operator aggregates infrastructure secrets and renders OpenStack configuration files.
**Credentials are never rendered into the immutable ConfigMap (CC-0080)** — the database
connection URL goes into a derived `<name>-db-connection` Secret injected via
`OS_DATABASE__CONNECTION`, and the per-pod Keystone username/password are injected via
`OS_KEYSTONE_AUTHTOKEN__USERNAME` / `OS_KEYSTONE_AUTHTOKEN__PASSWORD` from the pod's
ESO-synced Secret. The ConfigMap holds only the non-secret, replica-invariant settings.

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CONFIG RENDERING (keystone_authtoken)                      │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Immutable ConfigMap (shared by all replicas):                                │
│      [keystone_authtoken]                                                     │
│      auth_url = https://keystone.openstack.svc:5000                           │
│      auth_type = password                                                     │
│      user_domain_name = Default                                               │
│      project_name = service                                                   │
│      project_domain_name = Default                                            │
│      # username / password intentionally absent                               │
│                                                                               │
│  Per-pod env (from svc-<service>-<pod>-keystone Secret):                      │
│      OS_KEYSTONE_AUTHTOKEN__USERNAME = svc-<service>-<pod>                    │
│      OS_KEYSTONE_AUTHTOKEN__PASSWORD = <generated>                            │
│                                                                               │
│  Result inside the pod (oslo.config merges env over file):                    │
│      [keystone_authtoken] username=svc-glance-api-0  password=•••             │
└───────────────────────────────────────────────────────────────────────────────┘
```

This keeps one immutable ConfigMap per service (content-hashed, CC-style) while giving **each
pod its own distinct identity** purely through env injection. Compute/storage credentials
(Ceph, RabbitMQ, DB) follow the existing aggregation + env-injection pattern.

## Credential Rotation

Rotation in CobaltCore is **recreation, not in-place mutation**, for workload credentials — and a
controlled re-mint for the single admin credential. Four distinct mechanisms exist; do not
conflate them.

**1. Per-pod service user rotation = pod recreation (D4).** There is **no in-place per-pod
password rotation**. A fresh credential is produced by recreating the pod-identity:

* **Per-replica mode:** any intentional recreation (deploy / image change / scale / `maxAge`
  expiry → rolling recreation) deletes the old `User` CR (finalizer revokes the Keystone user)
  and creates a new `svc-<service>-<ordinal>` with a freshly generated password.
* **Ephemeral mode:** every pod instance is a new user; recreation is automatic on any restart.
* **`maxAge`** drives periodic refresh of long-lived pods via rolling recreation, never an
  in-place password change.

```text
maxAge-driven rolling recreation (per-replica, long-lived pods):
  ┌────────────┬─────────────────┬────────────────────┬────────────────────┐
  │ slot ready │ maxAge reached  │ pod deleted        │ fresh pod + user   │
  │ (user N)   │ for slot        │ → User CR finalizer│ (user N+1, new pw) │
  │            │                 │   revokes user N   │                    │
  └────────────┴─────────────────┴────────────────────┴────────────────────┘
```

**2. Admin Application Credential rotation (restricted + password-driven, D2).** The
`c5c3-operator` re-mints a fresh **restricted** admin App Cred using the admin password from
OpenBao, then atomically swaps the K-ORC `clouds.yaml` Secret. This is the only Application
Credential rotation in the design and is driven by the
[`CredentialRotation`](#credential-rotation) CRD restricted to the admin credential:

```yaml
apiVersion: c5c3.io/v1alpha1
kind: CredentialRotation
metadata:
  name: admin-app-credential-rotation
  namespace: openstack
spec:
  target: adminApplicationCredential        # the ONLY supported target
  schedule:
    intervalDays: 90
    preRotationDays: 7                       # mint successor 7 days before expiry
  gracePeriodDays: 1                         # delete the old App Cred 1 day after swap
status:
  currentCredential:
    id: "abc123..."
    restricted: true
    createdAt: "2026-03-01T00:00:00Z"
    expiresAt: "2026-05-30T00:00:00Z"
  lastRotation: "2026-03-01T00:00:00Z"
  nextRotation: "2026-05-23T00:00:00Z"
```

**3. Keystone cryptographic-key rotation (built, keystone-operator).** Fernet token keys and
credential *encryption* keys rotate in place via the split-compute-write boundary (CC-0081);
unrelated to identity credentials. See
[Secret Management — Credential Rotation](../02-secret-management.md#credential-rotation).

**4. Admin password rotation (planned, keystone-operator).** The root-of-trust admin password is
rotated by re-running the idempotent Keystone bootstrap Job when ESO syncs a new password (see
[Admin Credential Rotation](../../09-implementation/05-keystone-dependencies.md#admin-credential-rotation)).
After the admin password rotates, the admin App Cred (mechanism 2) is re-minted from the new
password on its next cycle (or immediately, operator-triggered).

## Secret Aggregation CRD

For aggregating operator-generated infrastructure secrets (DB, RabbitMQ, Valkey, Ceph) into a
single mount, the `SecretAggregate` CRD remains useful and is unchanged by the credential model:

```yaml
apiVersion: c5c3.io/v1alpha1
kind: SecretAggregate
metadata:
  name: openstack-infrastructure
  namespace: openstack
spec:
  sources:
    - name: mariadb
      secretRef: { name: mariadb-root-credentials, namespace: openstack }
      keys:
        - { sourceKey: password, targetKey: MARIADB_PASSWORD }
        - { sourceKey: username, targetKey: MARIADB_USERNAME }
    - name: rabbitmq
      secretRef: { name: rabbitmq-default-user, namespace: openstack }
      keys:
        - { sourceKey: password, targetKey: RABBITMQ_PASSWORD }
    - name: valkey
      secretRef: { name: valkey-openstack-valkey-binding, namespace: openstack }
      keys:
        - { sourceKey: password, targetKey: VALKEY_PASSWORD }
  target:
    secretName: openstack-credentials
    namespace: openstack
status:
  conditions:
    - { type: Ready, status: "True" }
    - { type: AllSourcesAvailable, status: "True" }
```

> `SecretAggregate` aggregates **infrastructure** secrets. Per-pod Keystone credentials are
> **not** aggregated here — each is mounted into exactly one pod and injected via env.

## OpenBao path layout

| Path | Contents | Written by | Read by | Reaches a pod? |
|---|---|---|---|---|
| `kv-v2/bootstrap/keystone-admin` | admin password (root of trust) | CI-CD / admin-pw rotation | c5c3-operator, Keystone Bootstrap Job | **No** |
| `kv-v2/openstack/admin/app-credential` | K-ORC admin App Cred (`clouds.yaml`) | PushSecret (from K-ORC) | ESO → `orc-system` | **No** |
| `kv-v2/openstack/<service>/pods/<pod>/user` | per-pod `{username, password}` | PushSecret (from operator) | ESO → the one pod | **Yes** |
| `kv-v2/infrastructure/*` | DB / RabbitMQ / Valkey root creds | infra operators / CI-CD | c5c3-operator | indirectly |
| `kv-v2/ceph/*` | Ceph client keys | PushSecret (from Rook) | ESO → Nova/Cinder/Glance | yes (Ceph) |

OpenBao policies enforce the invariants: the `eso-hypervisor` / `eso-control-plane` policies grant
read only on the per-pod and Ceph/compute paths, while `kv-v2/openstack/admin/*` and
`kv-v2/bootstrap/*` are reachable only by the operator and the `orc-system` ESO binding — never by
a workload's ServiceAccount. See [Secret Management — Policies](../02-secret-management.md#policies-least-privilege).

## Resolved open design decisions

The open decisions from issue [#30](https://github.com/C5C3/C5C3/issues/30) are resolved as
follows; each is reflected in the model above.

| # | Decision | Resolution |
|---|---|---|
| 1 | **Granularity of "per pod"** | **Hybrid**: per-replica stable identity (`svc-<service>-<ordinal>`) is the default (pre-provisioned from replica count, no admission webhook, bounded user count); **ephemeral** is opt-in per service (`mode: Ephemeral`) for high-security workloads. |
| 2 | **Admin App Cred rotation mode** | **Restricted + password-driven re-mint** (re-mint from the admin password, swap the K-ORC Secret). Unrestricted self-rotation rejected for blast radius. |
| 3 | **System-scope residue** | **None required.** Verified: every K-ORC operation (`user`, `grant`, `project`, `role`, `domain`, `service`, `endpoint`) includes `project` in `scope_types` and checks `role:admin`. K-ORC exposes **no** `limit`/`registered_limit` kind, so the one classic `system_scope:all`-only operation is out of scope by construction. The project-scoped admin App Cred suffices alone. |
| 4 | **Identity backend precondition** | **Writable SQL identity backend required** (CobaltCore default). Under read-only LDAP, service users must live in a SQL-backed domain; documented as a hard precondition. |
| 5 | **Pod-deletion GC robustness** | **Finalizer (primary) + periodic sweeper (backstop)** keyed on the `svc-<service>-…` naming prefix / tag; orphan deletions logged. |
| 6 | **Re-bootstrap / lockout** | If the admin App Cred is lost/corrupted, the operator **re-mints it from the admin password**. If the admin password is lost, re-run the idempotent Keystone bootstrap Job to reset it. The admin password is the single recovery root and lives only in `kv-v2/bootstrap/keystone-admin`. |
| 7 | **Supported-config assumption** | The deployment **must keep `project` in `scope_types`** for the identity/catalog policies (the upstream default). A deployment hardened to system-scope-only for `create_user`/`create_service` would break the project-scoped admin App Cred approach and require a system-scoped admin — documented as a precondition. |

## Implementation Roadmap

The `c5c3-operator` is a stub today; this model is built incrementally in forge. CobaltCore goes
**straight to per-pod** (no interim shared-service-user phase). The detailed reconciler design,
CRD types, and RBAC live in
[C5C3 Operator — Per-pod service user reconciler](../../09-implementation/08-c5c3-operator.md#per-pod-service-user-reconciler).

| Phase | Scope | Delivers |
|---|---|---|
| **P0 — Foundations** | ControlPlane `korc.adminCredential` + per-service `serviceUser` types; `CredentialRotation` repurposed to `adminApplicationCredential`; CRD manifests + webhooks. | Schema for the whole model; K-ORC deployed with a manually-bootstrapped admin App Cred. |
| **P1 — Admin App Cred bootstrap** | Mint the restricted admin App Cred from the admin password; PushSecret → OpenBao → ESO → `k-orc-clouds-yaml`; import bootstrap resources (unmanaged); create Service/Endpoint CRs. | `AdminCredentialReady`, `CatalogReady`. K-ORC fully self-credentialed. |
| **P2 — Per-pod (per-replica) users + GC** | Per replica slot: generate password → OpenBao + Secret → K-ORC `User` (`passwordRef`) + `Role`/grant CRs → ESO → pod; env injection (`OS_KEYSTONE_AUTHTOKEN__*`); finalizer + sweeper GC; project invariant. | `ServiceUsersReady`. Workloads run on dedicated real users; **App Creds removed from workloads**. |
| **P3 — Rotation** | `maxAge`-driven rolling recreation for long-lived pods; admin App Cred password-driven re-mint via `CredentialRotation`. | Steady-state rotation with no in-place per-pod password change. |
| **P4 — Ephemeral mode (opt-in)** | `mode: Ephemeral`: operator pod-watch mints/deletes a user per pod instance, with the start-time provisioning guard and tightened sweeper. | Strongest D4 realization for high-security workloads. |

**Cross-cutting acceptance criteria** (mirroring the issue): the docs describe the K-ORC + per-pod
real-service-user model with the project invariant and the "admin App Cred / admin password never
in a pod" invariant; the admin App Cred is source-verified for project-scope identity + catalog
CRUD under `enforce_scope=True`, restricted, and rotated; rotation = pod recreation with `maxAge`
for long-lived pods and `CredentialRotation` retained only for the admin App Cred; the "why not
App Creds for workloads" rationale is kept; resource-creating services (Octavia) are documented
under the uniform per-pod model; and every open decision has a recorded resolution.

## Overall View: Credential Layers

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                    CREDENTIAL ARCHITECTURE LAYERS                             │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  LAYER 0: Admin password (root of trust)                                      │
│  ───────────────────────────────────────                                      │
│  • kv-v2/bootstrap/keystone-admin — operator-only, NEVER in a pod             │
│  • Used only to bootstrap/rotate the admin App Cred and the Keystone admin    │
│                                                                               │
│  LAYER 1: Admin Application Credential (K-ORC's only App Cred)                │
│  ─────────────────────────────────────────────────────────────                │
│  • project-scoped, restricted; covers ALL K-ORC ops (verified)                │
│  • bootstrapped from the admin password; password-driven re-mint rotation     │
│  • lives only in orc-system (clouds.yaml) — NEVER in a workload pod           │
│                                                                               │
│  LAYER 2: K-ORC-reconciled Keystone identity                                  │
│  ────────────────────────────────────────────                                 │
│  • Services + Endpoints (catalog)                                             │
│  • Per-pod real Users (password as input from the operator) + Role grants     │
│  • all per-pod users of a service share one stable service project (D5)       │
│                                                                               │
│  LAYER 3: Per-pod workload credential (the only credential in a pod)          │
│  ─────────────────────────────────────────────────────────────────            │
│  • kv-v2/openstack/<svc>/pods/<pod>/user → ESO → one pod                      │
│  • injected via OS_KEYSTONE_AUTHTOKEN__{USERNAME,PASSWORD} (CC-0080)          │
│  • lifetime = pod lifetime; rotation = recreation; finalizer + sweeper GC     │
│                                                                               │
│  LAYER 4: ESO + OpenBao cross-cluster sync                                    │
│  ─────────────────────────────────────────                                    │
│  • per-pod passwords, Ceph keys, nova-compute config → target clusters        │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```
