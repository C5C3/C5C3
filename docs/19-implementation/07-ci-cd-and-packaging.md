# CI/CD & Packaging

This page documents the CI/CD pipeline, operator container images, Helm chart packaging, and FluxCD integration for CobaltCore operators. For test-level details (unit, integration, E2E), see [Testing](./06-testing.md).

## CI/CD Pipeline

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CI/CD PIPELINE                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Pull Request                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────┐                   │    │
│  │  │  Lint    │  │  Unit Tests  │  │  Integration │                   │    │
│  │  │ (golangci│  │  (go test)   │  │  Tests       │                   │    │
│  │  │  -lint)  │  │              │  │  (envtest)   │                   │    │
│  │  └──────────┘  └──────────────┘  └──────────────┘                   │    │
│  │        │              │                 │                            │    │
│  │        └──────────────┼─────────────────┘                            │    │
│  │                       │ all pass                                     │    │
│  │                       ▼                                              │    │
│  │              ┌──────────────┐                                        │    │
│  │              │  E2E Tests   │                                        │    │
│  │              │  (Chainsaw   │                                        │    │
│  │              │   + kind)    │                                        │    │
│  │              └──────────────┘                                        │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Merge to main                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │    │
│  │  │  Build       │  │  Push Image  │  │  Package     │               │    │
│  │  │  Operator    │  │  to GHCR     │  │  Helm Chart  │               │    │
│  │  │  Image       │  │              │  │              │               │    │
│  │  └──────┬───────┘  └──────────────┘  └──────┬───────┘               │    │
│  │         │                                    │                      │    │
│  │         │           ┌──────────────┐         │                      │    │
│  │         └──────────▶│  E2E Tests   │◀────────┘                      │    │
│  │                     │  (final)     │                                 │    │
│  │                     └──────┬───────┘                                 │    │
│  │                            │ pass                                   │    │
│  │                            ▼                                        │    │
│  │                   ┌──────────────┐                                   │    │
│  │                   │  Push Chart  │                                   │    │
│  │                   │  to GHCR OCI │                                   │    │
│  │                   └──────────────┘                                   │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Tag (vX.Y.Z)                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │    │
│  │  │  Build +     │  │  Push Chart  │  │  GitHub      │               │    │
│  │  │  Push Image  │  │  (versioned) │  │  Release     │               │    │
│  │  │  (versioned) │  │              │  │              │               │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## GitHub Actions Workflow

```yaml
# .github/workflows/ci.yaml
name: CI

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_PREFIX: ghcr.io/c5c3

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - uses: golangci/golangci-lint-action@v6
        with:
          version: v1.61

  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        operator: [keystone, glance, placement, nova, neutron, cinder, c5c3]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - name: Unit tests
        run: make test OPERATOR=${{ matrix.operator }}
      - name: Integration tests
        run: make test-integration OPERATOR=${{ matrix.operator }}
      - uses: codecov/codecov-action@v4

  e2e:
    runs-on: ubuntu-latest
    needs: [lint, test]
    strategy:
      matrix:
        operator: [keystone]  # Expand as operators are implemented
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - uses: helm/kind-action@v1
      - name: Build and load operator image
        run: |
          make docker-build OPERATOR=${{ matrix.operator }}
          kind load docker-image ${{ env.IMAGE_PREFIX }}/${{ matrix.operator }}-operator:dev
      - name: Install test dependencies
        run: make install-test-deps
      - name: Deploy operator
        run: make deploy OPERATOR=${{ matrix.operator }}
      - name: Run E2E tests
        run: make e2e OPERATOR=${{ matrix.operator }}

  build-and-push:
    runs-on: ubuntu-latest
    needs: [e2e]
    if: github.event_name == 'push'
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        operator: [keystone]  # Expand as operators are implemented
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: operators/${{ matrix.operator }}/Dockerfile
          push: true
          tags: |
            ${{ env.IMAGE_PREFIX }}/${{ matrix.operator }}-operator:${{ github.sha }}
            ${{ env.IMAGE_PREFIX }}/${{ matrix.operator }}-operator:latest

  helm-push:
    runs-on: ubuntu-latest
    needs: [e2e]
    if: github.event_name == 'push'
    permissions:
      packages: write
    strategy:
      matrix:
        operator: [keystone]
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-helm@v4
      - name: Package and push Helm chart
        run: |
          helm package operators/${{ matrix.operator }}/helm/${{ matrix.operator }}-operator
          helm push ${{ matrix.operator }}-operator-*.tgz oci://${{ env.REGISTRY }}/c5c3/charts
```

## Operator Container Image

Each operator is built as a minimal container image using a multi-stage Dockerfile:

```dockerfile
# operators/keystone/Dockerfile
FROM golang:1.23 AS builder

WORKDIR /workspace

# Copy workspace files
COPY go.work go.work
COPY internal/common/ internal/common/
COPY operators/keystone/ operators/keystone/

# Build
WORKDIR /workspace/operators/keystone
RUN CGO_ENABLED=0 GOOS=linux go build -a -o manager main.go

# Runtime
FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /workspace/operators/keystone/manager .
USER 65532:65532

ENTRYPOINT ["/manager"]
```

| Property | Value |
| --- | --- |
| **Base image** | `gcr.io/distroless/static:nonroot` |
| **Binary** | Statically linked Go binary (`CGO_ENABLED=0`) |
| **User** | Non-root (UID 65532) |
| **Registry** | `ghcr.io/c5c3/<operator>-operator` |
| **Tags** | `latest`, `<commit-sha>`, `v<semver>` |

## Helm Chart Structure

Each operator ships with a Helm chart for deployment:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       HELM CHART LAYOUT                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  operators/keystone/helm/keystone-operator/                                 │
│  ├── Chart.yaml                                                             │
│  ├── values.yaml                                                            │
│  ├── crds/                          # CRD manifests                         │
│  │   └── keystone.openstack.c5c3.io_keystones.yaml                         │
│  └── templates/                                                             │
│      ├── deployment.yaml            # Operator Deployment                   │
│      ├── service.yaml               # Webhook Service                       │
│      ├── serviceaccount.yaml                                                │
│      ├── clusterrole.yaml           # Generated RBAC                        │
│      ├── clusterrolebinding.yaml                                            │
│      ├── webhook-configuration.yaml # Validating/Mutating webhooks          │
│      └── _helpers.tpl                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Chart.yaml:**

```yaml
apiVersion: v2
name: keystone-operator
description: CobaltCore Keystone Operator for managing OpenStack Identity Service
type: application
version: 0.1.0       # Chart version (SemVer)
appVersion: "0.1.0"  # Operator version
```

**values.yaml:**

```yaml
# Operator image
image:
  repository: ghcr.io/c5c3/keystone-operator
  tag: ""  # Defaults to appVersion
  pullPolicy: IfNotPresent

# Operator replicas (leader election ensures only one active)
replicas: 2

# Resource limits
resources:
  limits:
    cpu: 500m
    memory: 128Mi
  requests:
    cpu: 10m
    memory: 64Mi

# Leader election
leaderElection:
  enabled: true

# Webhook configuration
webhook:
  enabled: true
  port: 9443

# Metrics
metrics:
  enabled: true
  port: 8080

# ServiceAccount
serviceAccount:
  create: true
  name: ""
  annotations: {}
```

## CRD Packaging Strategy

| Strategy | Pros | Cons |
| --- | --- | --- |
| **`crds/` directory** (Helm built-in) | Simple, installed before templates | No templating, limited update control |
| **Templates with hooks** | Full templating, conditional logic | Complex lifecycle management |
| **Separate CRD chart** | Independent CRD lifecycle | Extra chart to manage |

**Decision:** CRDs are packaged in the `crds/` directory of the operator Helm chart. FluxCD's `install.crds: CreateReplace` and `upgrade.crds: CreateReplace` handles creation and updates. This is the simplest approach and aligns with the pattern used for infrastructure operators (see [Helm Deployment](../11-gitops-fluxcd/03-helm-deployment.md)).

## FluxCD Integration

Operators are deployed via FluxCD HelmRelease CRs:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: c5c3-charts
  namespace: flux-system
spec:
  type: oci
  interval: 1h
  url: oci://ghcr.io/c5c3/charts

---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: keystone-operator
  namespace: openstack
spec:
  interval: 30m
  chart:
    spec:
      chart: keystone-operator
      version: ">=0.1.0 <1.0.0"
      sourceRef:
        kind: HelmRepository
        name: c5c3-charts
        namespace: flux-system
  values:
    replicas: 2
    metrics:
      enabled: true
  install:
    crds: CreateReplace
  upgrade:
    crds: CreateReplace
    remediation:
      retries: 3
  dependsOn:
    - name: mariadb-operator
      namespace: mariadb-system
    - name: memcached-operator
      namespace: memcached-system
    - name: cert-manager
      namespace: cert-manager
```

The `dependsOn` field ensures infrastructure operators are deployed before service operators. See [Helm Deployment](../11-gitops-fluxcd/03-helm-deployment.md) for the full FluxCD deployment architecture and [Dependency Management](../11-gitops-fluxcd/02-dependency-management.md) for dependency ordering.

## Release Process

| Step | Action | Artifact |
| --- | --- | --- |
| 1. Version bump | Update `Chart.yaml` version + `appVersion` | — |
| 2. Tag | `git tag v0.1.0` | Git tag |
| 3. CI builds | GitHub Actions builds operator image + Helm chart | `ghcr.io/c5c3/keystone-operator:v0.1.0` |
| 4. Push image | Docker push to GHCR | Container image |
| 5. Push chart | `helm push` to GHCR OCI registry | `oci://ghcr.io/c5c3/charts/keystone-operator:0.1.0` |
| 6. GitHub Release | Auto-generated release notes | Release page |
| 7. FluxCD detects | HelmRepository polls, reconciles HelmRelease | Operator upgraded in cluster |

**Versioning:** Operator versions follow [Semantic Versioning](https://semver.org/). Chart version and appVersion are kept in sync. FluxCD uses SemVer ranges (e.g., `>=0.1.0 <1.0.0`) to automatically pick up patch and minor releases.

For container image versioning of OpenStack service images (not operators), see [Container Images — Versioning](../17-container-images/02-versioning.md). The CI pipeline pattern is consistent with the container image build pipeline documented in [Build Pipeline](../17-container-images/01-build-pipeline.md).
