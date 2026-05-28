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
│  │        │              │                 │                            │   │
│  │        └──────────────┼─────────────────┘                            │   │
│  │                       │ all pass                                     │   │
│  │                       ▼                                              │   │
│  │              ┌──────────────┐                                        │   │
│  │              │  E2E Tests   │                                        │   │
│  │              │  (Chainsaw   │                                        │   │
│  │              │   + kind)    │                                        │   │
│  │              └──────────────┘                                        │   │
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
│  │                     │  (final)     │                                 │   │
│  │                     └──────┬───────┘                                 │   │
│  │                            │ pass                                   │    │
│  │                            ▼                                        │    │
│  │                   ┌──────────────┐                                   │   │
│  │                   │  Push Chart  │                                   │   │
│  │                   │  to GHCR OCI │                                   │   │
│  │                   └──────────────┘                                   │   │
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

## GitHub Actions Workflows

CI/CD is split across several workflows under `.github/workflows/`:

| Workflow | Purpose |
| --- | --- |
| `ci.yaml` (`name: CI`) | Main pipeline (~20+ jobs). A `changes` paths-filter job drives a dynamic per-operator matrix so jobs run only when relevant files change. |
| `build-images.yaml` | OpenStack **service/base/tempest** container build pipeline: hadolint, multi-arch `python-base`/`venv-builder`, SBOM (CycloneDX) + Grype scan + Sigstore/GitHub attestations, service×release matrix. |
| `verify-container-images.yaml` | Static verification of container-image config/scripts. |
| `check-base-image-updates.yaml` | Daily cron checking the `ubuntu:noble` digest; auto-triggers a rebuild. |
| `cleanup-images.yaml` | Daily cron pruning GHCR tags. |
| `deploy-docs.yaml` | VitePress build + GitHub Pages deploy. |

The `ci.yaml` job graph (illustrative — pinned action SHAs and `if:` gating omitted):

```text
changes ─┬─ lint, format-check (gofumpt v0.9.2), shellcheck, test-shell
         ├─ verify-invalid-cr-fixtures, chainsaw-lint, verify-codegen
         ├─ test (matrix: common|keystone|c5c3), test-integration, test-race
         ├─ govulncheck            (Go vulnerability scan)
         ├─ docs, helm-validate    (helm lint + template scenarios + helm-unittest)
         ├─ e2e-infra → build-e2e-images → e2e-operator
         │                                  ├─ e2e-chaos       (Chaos Mesh, non-blocking)
         │                                  ├─ e2e-prometheus  (kube-prometheus-stack)
         │                                  └─ tempest         (matrix: 2025.2, 2026.1)
         └─ build-and-push (per-platform, by-digest) → merge-operator-images
                                                       → helm-push → github-release
```

Pinned tool versions live in `ci.yaml`: `CONTROLLER_GEN_VERSION=v0.20.1`, `GOFUMPT_VERSION=v0.9.2`, `GOLANGCI_LINT_VERSION=v2.11.4` (govulncheck uses `@latest` intentionally). The Go version comes from `go.work` (1.26.3).

### Multi-arch image build

Operator images are built **multi-arch** (`linux/amd64` + `linux/arm64`): `build-and-push` builds each platform on a native runner and pushes **by digest**, then `merge-operator-images` assembles the manifest list with `docker/metadata-action` tags (`type=sha,format=long`, `latest` on the default branch, `type=semver` on tags). E2E images are built once by `build-e2e-images`, pushed to GHCR under run-scoped `e2e-${run_id}-*` tags, pulled by the E2E jobs, and pruned afterwards by `cleanup-e2e-tags` — not `kind load`ed inline.

> **Supply-chain note:** SBOM generation (CycloneDX), Grype vulnerability scanning with SARIF upload, and Sigstore/GitHub build attestations are produced by the **service-image** pipeline (`build-images.yaml`). The operator-image path currently emits OCI labels only.

## Operator Container Image

Each operator is built as a minimal container image using a multi-stage Dockerfile:

```dockerfile
# operators/keystone/Dockerfile
# ---------- Stage 1: builder ----------
FROM golang:1.26@sha256:6df14f4a... AS builder

WORKDIR /workspace

# Copy go.work and per-module manifests first for layer caching (CC-0017).
COPY go.work go.work.sum ./
COPY internal/common/go.mod internal/common/go.sum ./internal/common/
COPY operators/keystone/go.mod operators/keystone/go.sum ./operators/keystone/
COPY operators/c5c3/go.mod operators/c5c3/go.sum ./operators/c5c3/
RUN go mod download

# Copy source and build the static binary.
COPY internal/common/ ./internal/common/
COPY operators/keystone/ ./operators/keystone/
COPY operators/c5c3/ ./operators/c5c3/
WORKDIR /workspace/operators/keystone
RUN CGO_ENABLED=0 GOOS=linux go build -o manager main.go

# ---------- Stage 2: runtime ----------
FROM gcr.io/distroless/static:nonroot@sha256:963fa6c5...
WORKDIR /
COPY --from=builder /workspace/operators/keystone/manager .
LABEL org.opencontainers.image.title="keystone-operator" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="SAP SE"
USER 65532:65532
ENTRYPOINT ["/manager"]
```

Both base images are **digest-pinned** (CC-0017). The builder stage copies `go.mod`/`go.sum` for all three workspace modules and runs `go mod download` before copying source, so dependency layers cache across builds.

| Property | Value |
| --- | --- |
| **Base image** | `gcr.io/distroless/static:nonroot` (digest-pinned) |
| **Binary** | Statically linked Go binary (`CGO_ENABLED=0`) |
| **User** | Non-root (UID 65532) |
| **Architectures** | `linux/amd64` + `linux/arm64` (manifest list) |
| **Registry** | `ghcr.io/c5c3/<operator>-operator` |
| **Tags** | `sha-<long>`, `latest` (default branch), `v<semver>` (on tags) |

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
│  ├── values.schema.json             # JSON Schema for values (CC-0069)      │
│  ├── crds/                          # CRD manifests                         │
│  │   └── keystone.openstack.c5c3.io_keystones.yaml                          │
│  ├── tests/                         # helm-unittest suite                   │
│  └── templates/                                                             │
│      ├── deployment.yaml            # Operator Deployment                   │
│      ├── service.yaml               # Webhook/metrics Service               │
│      ├── serviceaccount.yaml                                                │
│      ├── clusterrole.yaml           # Cluster-scoped RBAC                   │
│      ├── clusterrolebinding.yaml                                            │
│      ├── role.yaml / rolebinding.yaml   # Namespace-scoped RBAC (CC-0043)   │
│      ├── certificate.yaml           # cert-manager webhook cert             │
│      ├── networkpolicy.yaml         # Opt-in operator NetworkPolicy (CC-0090)│
│      ├── servicemonitor.yaml        # Prometheus ServiceMonitor (CC-0089)   │
│      ├── webhook-configuration.yaml # Validating/Mutating webhooks          │
│      └── _helpers.tpl                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Chart.yaml** (chart `version` and `appVersion` are **not** kept in sync — CI overrides the chart version from the git tag at release time):

```yaml
apiVersion: v2
name: keystone-operator
description: A Helm chart for deploying the Keystone OpenStack operator
type: application
version: 0.3.0
appVersion: "0.1.0"
annotations:
  artifacthub.io/prerelease: "true"
  artifacthub.io/changes: |
    - kind: added
      description: JSON Schema validation for chart values (CC-0069)
    - kind: added
      description: Opt-in NetworkPolicy for operator pod egress/ingress (CC-0090)
```

**values.yaml** (validated against `values.schema.json`, CC-0069):

```yaml
image:
  repository: ghcr.io/c5c3/keystone-operator
  tag: ""               # defaults to .Chart.AppVersion when empty
  pullPolicy: IfNotPresent

replicas: 2

resources:
  limits:   { cpu: 500m, memory: 128Mi }
  requests: { cpu: 10m,  memory: 64Mi }

rbac:
  # CC-0043: namespace-scoped Role/RoleBinding instead of ClusterRole.
  # Requires webhook.enabled=false.
  namespaceScoped: false

leaderElection:
  enabled: true

webhook:
  enabled: true          # port 9443 is fixed in the Deployment template

metrics:
  port: 8080

# CC-0089: Prometheus ServiceMonitor (requires prometheus-operator CRDs).
monitoring:
  serviceMonitor:
    enabled: false
    interval: 30s

serviceAccount:
  create: true
  name: ""

# CC-0090: opt-in NetworkPolicy restricting operator pod ingress/egress.
networkPolicy:
  enabled: false
  kubeApiServer: { cidrs: [], ports: [] }
  dns: { enabled: true }
```

## CRD Packaging Strategy

| Strategy | Pros | Cons |
| --- | --- | --- |
| **`crds/` directory** (Helm built-in) | Simple, installed before templates | No templating, limited update control |
| **Templates with hooks** | Full templating, conditional logic | Complex lifecycle management |
| **Separate CRD chart** | Independent CRD lifecycle | Extra chart to manage |

**Decision:** CRDs are packaged in the `crds/` directory of the operator Helm chart. FluxCD's `install.crds: CreateReplace` and `upgrade.crds: CreateReplace` handles creation and updates. This is the simplest approach and aligns with the pattern used for infrastructure operators (see [Helm Deployment](../05-deployment/01-gitops-fluxcd/03-helm-deployment.md)).

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
  # CC-0105: the operator controller runs in its own keystone-system
  # Namespace; the Keystone CR and operator-managed payload (Deployment,
  # Secrets, HTTPRoute, NetworkPolicy) live in the openstack tenant Namespace.
  namespace: keystone-system
spec:
  interval: 30m
  dependsOn:
    - name: cert-manager
      namespace: cert-manager
    - name: mariadb-operator
      namespace: mariadb-system
    - name: memcached-operator
      namespace: memcached-system
    - name: external-secrets
      namespace: external-secrets
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
    leaderElection:
      enabled: true
    image:
      # latest until a versioned (v*) release publishes a semver image tag.
      tag: latest
  install:
    crds: CreateReplace
    createNamespace: true
    remediation:
      retries: 3
  upgrade:
    crds: CreateReplace
    remediation:
      retries: 3
```

`cert-manager` is listed first (it must be ready before the operator's webhook certificate is issued), and `external-secrets` is required so ESO can sync the operator's Secrets. See [Helm Deployment](../05-deployment/01-gitops-fluxcd/03-helm-deployment.md) for the full FluxCD deployment architecture and [Dependency Management](../05-deployment/01-gitops-fluxcd/02-dependency-management.md) for dependency ordering.

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

**Versioning:** Operator versions follow [Semantic Versioning](https://semver.org/). The chart `version` is overridden from the git tag (`CHART_VERSION=${GITHUB_REF_NAME#v}`) at `helm-push` time rather than tracked in lockstep with `appVersion` in source. FluxCD uses SemVer ranges (e.g., `>=0.1.0 <1.0.0`) to automatically pick up patch and minor releases. Until the first `v*` tag publishes a semver image, the deployed HelmRelease pins `image.tag: latest`.

## Container Image & Conformance Pipelines

Beyond operator images, CI runs several pipelines the operator path does not:

- **Service/base images** (`build-images.yaml`) — multi-arch `python-base`, `venv-builder`, per-service and Tempest images across the OpenStack release matrix (2025.2, 2026.1), each with **CycloneDX SBOM**, **Grype** scanning (SARIF upload), and **Sigstore/GitHub build attestations**.
- **Tempest** (`tempest` job) — API conformance against the deployed control plane, per release (see [Testing — Tempest](./06-testing.md#tempest-openstack-api-conformance)).
- **Chaos E2E** (`e2e-chaos`, non-blocking) — Chaos Mesh fault injection (see [Chaos E2E Testing](./10-chaos-e2e-testing.md)).
- **Prometheus E2E** (`e2e-prometheus`) — kube-prometheus-stack + ServiceMonitor validation.

For container image versioning of OpenStack service images (not operators), see [Container Images — Versioning](../08-container-images/02-versioning.md) and [Build Pipeline](../08-container-images/01-build-pipeline.md).
