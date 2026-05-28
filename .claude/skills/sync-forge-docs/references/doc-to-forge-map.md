<!-- Mapping of C5C3 doc files/topics to the forge paths that are their source of truth. -->
<!-- Forge root = $FORGE (fresh shallow clone of github.com/C5C3/forge, branch main). -->

# Doc ↔ forge source-of-truth map

Use this to scope a sync run and to know *where in forge* to verify a given doc. Paths are relative to the
forge clone root. When forge layout has changed, trust the live tree over this table and update the table.

## Implementation guide (`docs/09-implementation/`) — tightest coupling

| Doc | Topic | Verify against (in forge) |
|---|---|---|
| `01-project-setup.md` | Go workspace, monorepo layout, Makefile, prereqs | `go.work`, top-level tree, `Makefile`, `hack/`, `.golangci.yml` |
| `02-shared-library.md` | `internal/common/` packages & types | `internal/common/*/` (conditions, config, database, deployment, job, secrets, plugins, policy, tls, types, bootstrap, testutil) |
| `03-crd-implementation.md` | CRD Go types, kubebuilder markers, webhooks, versioning | `operators/*/api/v1alpha1/*_types.go`, webhook files, `config/crd` |
| `04-keystone-reconciler.md` | Sub-reconciler pattern, flow, controller setup, RBAC | `operators/keystone/internal/controller/keystone_controller.go`, `reconcile_*.go`, RBAC markers |
| `05-keystone-dependencies.md` | OpenBao/ESO secrets, MariaDB/Memcached, Fernet, bootstrap | `operators/keystone/internal/controller/reconcile_secrets.go`, `reconcile_database.go`, `reconcile_fernet.go`, `reconcile_bootstrap.go`, `internal/common/secrets`, `internal/common/bootstrap` |
| `06-testing.md` | unit / envtest / Chainsaw E2E | `operators/*/internal/controller/*_test.go`, `integration_test.go`, envtest setup, `tests/` or per-operator e2e, `Makefile` test targets |
| `07-ci-cd-and-packaging.md` | GH Actions, Dockerfile, Helm, FluxCD, release | `.github/workflows/`, `images/`, `operators/*/helm/`, `releases/`, `Makefile` (`docker-build`, `helm-package`) |
| `08-c5c3-operator.md` | ControlPlane CRD, orchestration reconciler | `operators/c5c3/api/v1alpha1/*_types.go`, `operators/c5c3/internal/controller/*` |
| `09-openbao-deployment.md` | OpenBao deploy, init, secret engines, auth, policies | `deploy/`, OpenBao manifests/scripts, `internal/common/secrets`, `hack/` |
| `10-chaos-e2e-testing.md` | Chaos Mesh E2E concept | E2E test dirs, chaos manifests under `tests/`/`deploy/` (likely still concept/planned — confirm) |
| `index.md` | chapter overview, keystone-first strategy | cross-check operator list & strategy against `operators/` |

## Architecture & component chapters — where new fundamental concepts must be woven in

| Doc area | Topic | Forge signals to watch |
|---|---|---|
| `docs/02-architecture-overview.md` | overall topology, principles | new operators, new CRDs, new cross-cutting mechanisms |
| `docs/03-components/` | control plane / hypervisor / storage / mgmt | per-service controllers, what each operator actually reconciles |
| `docs/04-architecture/` | CRDs, HA, networking, storage deep dives | `*_types.go`, `reconcile_hpa.go`, `reconcile_networkpolicy.go`, `reconcile_httproute.go`, TLS/cert flows |
| `docs/05-deployment/` | GitOps, secrets, service config | `internal/common/config` (INI rendering), `reconcile_config.go`, immutable ConfigMap hashing, ESO/PushSecret |
| `docs/06-operations/` | upgrades, observability, brownfield | rollout logic in controllers, health checks (`reconcile_healthcheck.go`), instrumentation (`instrumentation.go`), credential rotation |
| `docs/07-crossplane/` | consumer/tenant provisioning | Crossplane-related manifests/operators if present |
| `docs/08-container-images/` | build pipeline, versioning, patching, SBOM | `images/`, Dockerfiles, `.github/workflows/`, `.grype.yaml`, SBOM steps |
| `CLAUDE.md` (this repo) | tech-stack versions, operator list, API groups, commands | `go.work` (Go version), `operators/`, group markers, `Makefile` — keep every repeated fact consistent |

## Topic → file shortcuts (for argument-scoped runs)

- `keystone` → `04-keystone-reconciler.md`, `05-keystone-dependencies.md`
- `crds` / `crd` → `03-crd-implementation.md`, `docs/04-architecture/01-crds.md`
- `testing` / `e2e` → `06-testing.md`, `10-chaos-e2e-testing.md`
- `ci` / `packaging` / `helm` → `07-ci-cd-and-packaging.md`, `docs/08-container-images/`
- `secrets` / `openbao` / `eso` → `05-keystone-dependencies.md`, `09-openbao-deployment.md`, `docs/05-deployment/02-secret-management.md`
- `orchestration` / `controlplane` → `08-c5c3-operator.md`
- `shared library` / `common` → `02-shared-library.md`
- `versions` / `tech stack` → `CLAUDE.md`, `01-project-setup.md`
