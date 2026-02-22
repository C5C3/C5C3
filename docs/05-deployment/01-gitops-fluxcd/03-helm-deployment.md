# Helm Deployment

## HelmRelease for Operators

Most operators are deployed via HelmRelease CRDs. For the deployment order and dependencies between these components, see [Dependency Management](./02-dependency-management.md).

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: mariadb-operator
  namespace: flux-system
spec:
  interval: 1h
  url: https://mariadb-operator.github.io/mariadb-operator

---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: mariadb-operator
  namespace: mariadb-system
spec:
  interval: 30m
  chart:
    spec:
      chart: mariadb-operator
      version: ">=0.30.0 <1.0.0"  # SemVer Range
      sourceRef:
        kind: HelmRepository
        name: mariadb-operator
        namespace: flux-system
  values:
    metrics:
      enabled: true
    webhook:
      enabled: true
  install:
    crds: CreateReplace
  upgrade:
    crds: CreateReplace
    remediation:
      retries: 3
```

## Git Repository Structure

```text
c5c3-gitops/
├── clusters/
│   ├── management/
│   │   ├── kustomization.yaml    # Root sync point
│   │   ├── flux-system/          # FluxCD self-management
│   │   ├── greenhouse/           # Kustomization → apps/greenhouse
│   │   └── aurora/               # Kustomization → apps/aurora-dashboard
│   ├── control-plane/
│   │   ├── kustomization.yaml
│   │   ├── infrastructure-operators/  # Kustomization → apps/infrastructure/operators
│   │   ├── c5c3-operator/        # Kustomization → apps/c5c3-operator
│   │   ├── control-plane-cr/     # Kustomization → apps/control-plane-cr
│   │   └── k-orc/               # Kustomization → apps/k-orc
│   ├── hypervisor/
│   │   ├── kustomization.yaml
│   │   ├── hypervisor-operator/
│   │   ├── labels-injector/      # Kustomization → apps/labels-injector
│   │   └── agents/               # DaemonSets
│   └── storage/
│       ├── kustomization.yaml
│       ├── rook-ceph/
│       ├── external-arbiter/
│       └── prysm/
├── apps/
│   ├── greenhouse/
│   │   ├── kustomization.yaml
│   │   ├── helmrelease.yaml
│   │   └── values/
│   ├── aurora-dashboard/
│   ├── openbao/                 # OpenBao Helm Chart + Config
│   ├── external-secrets/        # ESO Helm Chart + ClusterSecretStores
│   ├── infrastructure/
│   │   └── operators/            # Infrastructure Operators (Helm Charts)
│   │       ├── kustomization.yaml
│   │       ├── mariadb-operator.yaml   # HelmRelease
│   │       ├── valkey-operator.yaml    # HelmRelease
│   │       └── rabbitmq-operator.yaml  # HelmRelease
│   ├── c5c3-operator/            # c5c3-operator Helm Chart
│   │   ├── kustomization.yaml
│   │   ├── helmrelease.yaml      # HelmRelease for c5c3-operator
│   │   └── values/
│   │       └── values.yaml
│   ├── control-plane-cr/         # ControlPlane CRD Instance
│   │   ├── kustomization.yaml
│   │   └── controlplane.yaml     # ControlPlane CR (entire config)
│   ├── k-orc/                    # K-ORC Deployment (Control Plane Cluster)
│   │   ├── kustomization.yaml
│   │   └── helmrelease.yaml      # HelmRelease for K-ORC
│   ├── labels-injector/          # Deployment (Hypervisor Cluster)
│   │   ├── kustomization.yaml
│   │   └── helmrelease.yaml
│   ├── hypervisor-operator/
│   ├── kvm-node-agent/
│   ├── rook-ceph/
│   ├── external-arbiter-operator/
│   └── prysm/
└── infrastructure/
    ├── sources/
    │   ├── helm-repositories.yaml  # All HelmRepository CRDs
    │   └── git-repositories.yaml   # Additional GitRepository CRDs
    └── cluster-configs/
        ├── control-plane-kubeconfig.yaml  # ExternalSecret → kubeconfig from OpenBao
        ├── hypervisor-kubeconfig.yaml
        └── storage-kubeconfig.yaml
```

For details on OpenBao and ESO configuration referenced above, see [Secret Management](../02-secret-management.md). For the credential lifecycle of the kubeconfig secrets, see [Credential Lifecycle](./01-credential-lifecycle.md).
