# Dependency Management

FluxCD enables the definition of dependencies between Kustomizations:

```text
┌───────────────────────────────────────────────────────────────────┐
│                 Control Plane Deployment Order                    │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. Infrastructure Operators (Base)                               │
│     ┌─────────────┐   ┌─────────────┐   ┌─────────────┐           │
│     │  MariaDB    │   │  Valkey     │   │  RabbitMQ   │           │
│     │  Operator   │   │  Operator   │   │  Operator   │           │
│     └──────┬──────┘   └──────┬──────┘   └──────┬──────┘           │
│            │                 │                 │                  │
│            └─────────────────┼─────────────────┘                  │
│                              │                                    │
│                              ▼                                    │
│  2. c5c3-operator (Helm Chart)                                    │
│     ┌─────────────────────────────────────────────────────────┐   │
│     │  c5c3-operator Manager (deployed via FluxCD HelmRelease)│   │
│     └──────────────────────────┬──────────────────────────────┘   │
│                                │                                  │
│                                ▼                                  │
│  3. ControlPlane CRD (managed by c5c3-operator)                   │
│     ┌─────────────────────────────────────────────────────────┐   │
│     │                    ControlPlane CR                      │   │
│     │  (defines entire Control Plane configuration)           │   │
│     └──────────────────────────┬──────────────────────────────┘   │
│                                │                                  │
│         c5c3-operator automatically creates:                      │
│                                │                                  │
│     ┌──────────────────────────┼──────────────────────────────┐   │
│     │                          │                              │   │
│     ▼                          ▼                              ▼   │
│  ┌─────────────┐  ┌────────────────────────┐  ┌─────────────┐     │
│  │Infrastructure  │   OpenStack Services   │  │  CobaltCore │     │
│  │   CRs       │  │                        │  │             │     │
│  │             │  │  Keystone → Nova →     │  │   Cortex    │     │
│  │ MariaDB CR  │  │  Neutron → Glance →    │  │   (opt.)    │     │
│  │ RabbitMQ CR │  │  Cinder → Placement    │  │   K-ORC     │     │
│  │ Valkey CR   │  │                        │  │   Bootstrap │     │
│  │ Memcached CR│  │                        │  │             │     │
│  └─────────────┘  └────────────────────────┘  └─────────────┘     │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

> **Note:** The c5c3-operator orchestrates the entire deployment order:
>
> 1. Creates Infrastructure CRs (MariaDB, RabbitMQ, Valkey, Memcached) -- external Operators provision
> 2. Waits for Infrastructure readiness
> 3. Creates Service CRs -- dedicated Service Operators deploy OpenStack Services
> 4. Coordinates [Credential Lifecycle Management](./01-credential-lifecycle.md)
> 5. Configures K-ORC Integration
>
> FluxCD must ensure that **Infrastructure Operators** and **Service Operators** are ready before the c5c3-operator is deployed.

**Example Dependency Chain:**

```yaml
# 1. Infrastructure Operators (parallel, no dependencies)
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure-operators
  namespace: flux-system
spec:
  interval: 10m
  path: ./apps/infrastructure/operators
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  kubeConfig:
    secretRef:
      name: control-plane-kubeconfig
  # no dependsOn - base

---
# 2. c5c3-operator (waits for Infrastructure Operators)
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: c5c3-operator
  namespace: flux-system
spec:
  interval: 10m
  path: ./apps/c5c3-operator
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  kubeConfig:
    secretRef:
      name: control-plane-kubeconfig
  dependsOn:
    - name: infrastructure-operators

---
# 3. ControlPlane CR (waits for c5c3-operator)
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: control-plane-cr
  namespace: flux-system
spec:
  interval: 10m
  path: ./apps/control-plane-cr
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  kubeConfig:
    secretRef:
      name: control-plane-kubeconfig
  dependsOn:
    - name: c5c3-operator
  # Contains: ControlPlane CR
  # c5c3-operator automatically creates:
  # - Infrastructure CRs (MariaDB, RabbitMQ, Valkey, Memcached) → Operators
  # - OpenStack Services (Keystone, Nova, Neutron, Glance, etc.)
  # - Cortex
  # - K-ORC Bootstrap Resources

---
# 4. Labels Injector (runs in Hypervisor Cluster)
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: labels-injector
  namespace: flux-system
spec:
  interval: 10m
  path: ./apps/labels-injector
  sourceRef:
    kind: GitRepository
    name: c5c3-gitops
  kubeConfig:
    secretRef:
      name: hypervisor-kubeconfig
  dependsOn:
    - name: hypervisor-apps  # Requires Hypervisor Cluster
```
