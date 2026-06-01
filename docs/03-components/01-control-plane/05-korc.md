# OpenStack Resource Controller (K-ORC)

**Repository:** `github.com/k-orc/openstack-resource-controller`
**Runs in:** Control Plane Cluster (Deployment)

K-ORC (Kubernetes OpenStack Resource Controller) enables **declarative management of OpenStack resources via Kubernetes CRDs**. It follows the Infrastructure-as-Code pattern and integrates seamlessly into GitOps workflows.

**Supported OpenStack Services (in CobaltCore):**

| Service                 | Resources                                                                    |
| ----------------------- | ---------------------------------------------------------------------------- |
| **Keystone** (Identity) | Domain, Project, Role, Group, Service, Endpoint, User, ApplicationCredential |

**Architecture:**

```text
┌───────────────────────────────────────────────────────────────────┐
│                    K-ORC (Control Plane Cluster)                  │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    K-ORC Manager Pod                        │  │
│  │                    (orc-system Namespace)                   │  │
│  │                                                             │  │
│  │  Reconciliation Controllers:                                │  │
│  │  └── Keystone: Domain, Project, Role, Group, Service,       │  │
│  │               Endpoint, User, ApplicationCredential         │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│                              │ Gophercloud SDK                    │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │             Keystone Identity API                           │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Key Features:**

* **8 CRD types** for declarative Keystone resource management
* **Management Policies**: `managed` (full lifecycle) or `unmanaged` (read-only import)
* **Import existing resources** via filters (Name, Tags, ID)
* **Credential Management** via `clouds.yaml` in Kubernetes Secrets
* **Dependency Management**: Automatic ordering (e.g., Network before Subnet)
* **Finalizers**: Safe deletion with cleanup in OpenStack

**Credential Management for K-ORC:**

K-ORC requires a `clouds.yaml` secret for authentication against OpenStack APIs. In CobaltCore
(issue [#30](https://github.com/C5C3/C5C3/issues/30)) this is a **single restricted, project-scoped
admin Application Credential** — the *only* App Cred in the design. The c5c3-operator mints it from
the admin password (used only to bootstrap/rotate), K-ORC writes the result to a Kubernetes Secret,
a PushSecret writes it to OpenBao, and ESO provides it back as `k-orc-clouds-yaml` in `orc-system`:

> **Why a project-scoped admin App Cred is enough.** Every operation K-ORC performs (`user`,
> `grant`, `project`, `role`, `domain`, `service`, `endpoint`) includes `project` in its policy
> `scope_types` and checks `role:admin`, so it succeeds at project scope even under
> `enforce_scope=True`. K-ORC exposes no `limit`/`registered_limit` kind, so the one classic
> `system_scope:all`-only operation is out of reach by construction — no system-scoped admin is
> needed. K-ORC authenticates **per resource** via `cloudCredentialsRef`, so the same admin App
> Cred secret is referenced by every CR it reconciles.

```yaml
# PushSecret: K-ORC Application Credential → OpenBao
# Watches the Secret written by K-ORC and pushes it to OpenBao
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: k-orc-app-credential
  namespace: openstack
spec:
  secretStoreRefs:
    - name: openbao-cluster-store
      kind: ClusterSecretStore
  selector:
    secret:
      name: k-orc-app-credential  # Written by K-ORC
  data:
    - match:
        secretKey: clouds.yaml
        remoteRef:
          remoteKey: kv-v2/data/openstack/admin/app-credential
          property: clouds.yaml

---
# ExternalSecret: OpenBao → k-orc-clouds-yaml in orc-system
# Reads the Application Credential from OpenBao and creates the
# Secret that K-ORC mounts as clouds.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: k-orc-clouds-yaml
  namespace: orc-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-cluster-store
    kind: ClusterSecretStore
  target:
    name: k-orc-clouds-yaml
    creationPolicy: Owner  # ESO owns the lifecycle of this Secret
  data:
    - secretKey: clouds.yaml
      remoteRef:
        key: kv-v2/data/openstack/admin/app-credential
        property: clouds.yaml
```

The resulting Kubernetes Secret in `orc-system` (created and managed by ESO):

```yaml
# Auto-generated by ESO — do not edit manually
apiVersion: v1
kind: Secret
metadata:
  name: k-orc-clouds-yaml
  namespace: orc-system
  # Owned by ExternalSecret (ESO manages lifecycle)
  ownerReferences:
    - apiVersion: external-secrets.io/v1beta1
      kind: ExternalSecret
      name: k-orc-clouds-yaml
type: Opaque
data:
  clouds.yaml: |
    clouds:
      openstack:
        auth_type: v3applicationcredential
        auth:
          auth_url: https://identity.example.com
          application_credential_id: "abc123..."
          application_credential_secret: "xyz789..."
        region_name: RegionOne
```

**Example: Create Keystone Project:**

```yaml
apiVersion: openstack.k-orc.cloud/v1alpha1
kind: Project
metadata:
  name: customer-project
spec:
  cloudCredentialsRef:
    cloudName: openstack
    secretName: k-orc-clouds-yaml  # References generated secret
  managementPolicy: managed
  resource:
    description: "Customer project"
    enabled: true
    tags: ["customer-a", "production"]
```

> **Note:** The `cloudCredentialsRef.secretName` references the admin App Cred provided via the
> path K-ORC → PushSecret → OpenBao → ESO. That admin App Cred is rotated (restricted +
> password-driven re-mint) via the `CredentialRotation` CRD; **workload** service users are not
> rotated this way — they rotate by pod recreation. See
> [Credential Lifecycle](../../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md#credential-rotation).

**Use Cases in CobaltCore:**

* Declarative management of Keystone services, endpoints, and users
* Provisioning of **per-pod real Keystone service users** (password supplied as input by the
  c5c3-operator via `User.passwordRef`) — one dedicated user per workload pod
* Bootstrapping K-ORC's single admin Application Credential (the only App Cred in the design)
* Declarative management of Keystone domains, projects, and roles
* GitOps integration for Identity-as-Code
* Multi-tenant setup with reproducible configurations

**Management Policies:**

* **`managed`**: K-ORC creates, updates, and deletes the OpenStack resource (full lifecycle).
  Finalizers prevent Kubernetes deletion until the OpenStack resource is removed.
  Use for: All bootstrap resources, new service registrations.

* **`unmanaged`**: K-ORC imports an existing OpenStack resource as read-only via filters (name, tags, ID).
  K-ORC does not modify or delete the resource. Status reflects the external state.
  Use for: Brownfield deployments (see [Brownfield Integration](../../06-operations/03-brownfield-integration.md)), shared resources managed by other tools.

**Deployment (HelmRelease):**

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: k-orc
  namespace: flux-system
spec:
  interval: 1h
  url: https://k-orc.github.io/openstack-resource-controller

---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: openstack-resource-controller
  namespace: orc-system
spec:
  interval: 30m
  chart:
    spec:
      chart: openstack-resource-controller
      version: ">=0.1.0"
      sourceRef:
        kind: HelmRepository
        name: k-orc
        namespace: flux-system
  values:
    # clouds.yaml Secret — provided via OpenBao + ESO
    globalCloudConfig:
      secretName: k-orc-clouds-yaml  # Created by ExternalSecret from OpenBao
  install:
    crds: CreateReplace
  upgrade:
    crds: CreateReplace
```

**Bootstrap Resources (Chicken-and-Egg Problem):**

The Keystone Bootstrap Job creates foundational resources (Admin User, Default Domain,
Service Project, Roles) directly via the Keystone API — before K-ORC has credentials.
These resources must be **imported into K-ORC** (`managementPolicy: unmanaged`) so that
K-ORC can reference them when creating dependent resources (Services, Endpoints, Users).

When `spec.korc.bootstrapResources` is configured in the ControlPlane CR, the c5c3-operator
creates K-ORC CRs with `managementPolicy: unmanaged` to import existing bootstrap resources:

* **domains**: Default domain (created by Keystone Bootstrap Job)
* **projects**: Service project, admin project (created by Keystone Bootstrap Job)

Only after these imports are visible in K-ORC can the c5c3-operator create new resources
(Services, Endpoints, and per-pod Service Users) with `managementPolicy: managed`. The single
admin Application Credential is minted earlier — it is what K-ORC authenticates with.

**Troubleshooting:**

Common issues and diagnostic commands:

| Issue | Diagnostic | Resolution |
| ----- | ---------- | ---------- |
| K-ORC cannot reach Keystone | `kubectl logs -n orc-system -l app=openstack-resource-controller` | Verify `clouds.yaml` secret and Keystone endpoint |
| `clouds.yaml` secret missing | `kubectl get secret k-orc-clouds-yaml -n orc-system` | Check ESO/PushSecret pipeline |
| Service already exists | Check K-ORC CRD status conditions | Use `managementPolicy: unmanaged` to import |
| CRD stuck in Creating | `kubectl describe <crd-kind> <name> -n openstack` | Check dependency ordering and Keystone availability |

## Further Reading

* [C5C3 Operator](./01-c5c3-operator.md) — Creates K-ORC CRs for service catalog management
* [Service Operators](./02-service-operators.md) — Services whose credentials K-ORC manages
* [Credential Lifecycle](../../05-deployment/01-gitops-fluxcd/01-credential-lifecycle.md) — Full credential flow including K-ORC
* [Brownfield Integration](../../06-operations/03-brownfield-integration.md) — Using `unmanaged` policy for existing resources
