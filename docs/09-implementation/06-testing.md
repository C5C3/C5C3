# Testing

CobaltCore operators are tested across several levels: unit tests for pure business logic, integration tests with envtest for reconciler behavior, end-to-end tests with Chainsaw for full-stack validation, Tempest for OpenStack API conformance, and a dedicated [Chaos Mesh suite](./10-chaos-e2e-testing.md) for resilience. This page documents the testing strategy, tooling, and test scenarios for the Keystone Operator.

## Testing Pyramid

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TESTING PYRAMID                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                          ┌───────────┐                                      │
│                         ╱             ╲    Tempest API conformance +         │
│                        ╱  E2E + Chaos  ╲   Chaos Mesh (ch. 10).              │
│                       ╱   + Tempest     ╲  Chainsaw (YAML), kind cluster,    │
│                      ╱  ~40+ scenarios   ╲ slow, highest confidence          │
│                     ╱─────────────────────╲                                 │
│                    ╱                       ╲                                │
│                   ╱   Integration Tests     ╲   envtest (API server +       │
│                  ╱   (envtest, build tag)    ╲  etcd, no kubelet)           │
│                 ╱     + testutil simulators   ╲ Medium speed                │
│                ╱───────────────────────────────╲                            │
│               ╱                                 ╲                           │
│              ╱         Unit Tests                ╲  go test, table-driven,  │
│             ╱       (+ shell unit tests)          ╲ race-checked. Fast.     │
│            ╱───────────────────────────────────────╲                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Unit Tests

Unit tests cover pure functions and business logic in the shared library and operator-specific code. They do not require a Kubernetes cluster or API server.

**What to unit test:**

* INI config rendering (`internal/common/config/`)
* Condition management logic (`internal/common/conditions/`)
* Connection string assembly
* Fernet key secret structure generation
* Plugin config rendering (`internal/common/plugins/`)
* Validation webhook logic

**Table-driven test pattern:**

```go
func TestRenderINI(t *testing.T) {
    tests := []struct {
        name     string
        sections map[string]map[string]string
        expected string
    }{
        {
            name: "single section",
            sections: map[string]map[string]string{
                "database": {"connection": "mysql+pymysql://USERNAME:PASSWORD@HOST/DB"},
            },
            expected: "[database]\nconnection = mysql+pymysql://USERNAME:PASSWORD@HOST/DB\n",
        },
        {
            name: "multiple sections sorted",
            sections: map[string]map[string]string{
                "cache":    {"backend": "dogpile.cache.pymemcache"},
                "database": {"connection": "mysql+pymysql://USERNAME:PASSWORD@HOST/DB"},
            },
            expected: "[cache]\nbackend = dogpile.cache.pymemcache\n\n" +
                "[database]\nconnection = mysql+pymysql://USERNAME:PASSWORD@HOST/DB\n",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result := config.RenderINI(tt.sections)
            if result != tt.expected {
                t.Errorf("expected %q, got %q", tt.expected, result)
            }
        })
    }
}
```

**Coverage target:** 80%+ for `internal/common/` packages, 70%+ for operator-specific logic. Coverage is measured via `go test -coverprofile` and reported to Codecov in the [CI pipeline](./07-ci-cd-and-packaging.md#cicd-pipeline). `make test-common` and `make test-operator OPERATOR=<svc>` run the legs independently for the CI matrix.

**Race detection:** `make test-race` runs the full suite with the Go race detector (`-race`); CI passes `RACE_FLAGS="-count=1"` to disable test caching, because race conditions are non-deterministic and cached results would mask them. Operator code is heavily concurrent (reconcilers, watches, informer caches), so this catches data races unit tests otherwise miss.

**Shell unit tests:** Helper scripts under `hack/`, `deploy/`, and the docs tooling are unit-tested with bash assertions in `tests/unit/` (run via `make test-shell`, using `tests/lib/assertions.sh`). `make shellcheck` lints them and `make chainsaw-lint` lints all Chainsaw YAML.

## Test Support Library (`internal/common/testutil`)

Rather than hand-rolling envtest scaffolding per package, operators reuse a shared test-support framework (CC-0002) under `internal/common/testutil/`:

| Subpackage | Purpose |
| --- | --- |
| `assertions/` | Gomega-style helpers — `AssertCondition`, `EventuallyCondition`, `AssertResourceExists`, … |
| `builders/` | Fluent builders for test CRs and Kubernetes resources (e.g. a Secret builder) |
| `envtest/` | Shared envtest bootstrap (`setup.go`) used by every integration test |
| `fake_crds/` | Minimal CRD manifests for third-party resources (cert-manager, external-secrets, mariadb, memcached, rabbitmq) registered in envtest |
| `simulators/` | Simulate external controllers that do not run in envtest — `SimulateMariaDBReady`, `SimulateExternalSecretSync`, `SimulateJobComplete`, `SimulateCertificateReady`, … |

Integration tests should use these helpers instead of re-implementing setup, secret creation, or status simulation.

## Integration Tests (envtest)

Integration tests are guarded by a `//go:build integration` build tag and run via `make test-integration` (or `make test-integration-common` for `internal/common` alone). Both download Kubernetes API-server/etcd binaries for the pinned `ENVTEST_K8S_VERSION=1.35` via `setup-envtest`.

Integration tests use controller-runtime's `envtest` package, which runs a real Kubernetes API server and etcd process locally — without kubelet, scheduler, or controller manager. This allows testing reconciler logic against a real API server.

**Setup:**

```go
func TestMain(m *testing.M) {
    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "..", "config", "crd", "bases"),
        },
    }

    cfg, err := testEnv.Start()
    // ... register scheme, create client ...

    code := m.Run()
    testEnv.Stop()
    os.Exit(code)
}
```

**Simulating ESO secrets:** Since ESO does not run in envtest, the test setup pre-creates the Kubernetes Secrets that ESO would normally provide:

```go
func createPrerequisiteSecrets(ctx context.Context, client client.Client) {
    // Simulate ESO-synced database credentials
    dbSecret := &corev1.Secret{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "keystone-db-credentials",
            Namespace: "openstack",
        },
        Data: map[string][]byte{
            "username": []byte("keystone"),
            "password": []byte("test-password"),
        },
    }
    client.Create(ctx, dbSecret)

    // Simulate ESO-synced admin credentials
    adminSecret := &corev1.Secret{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "keystone-admin-credentials",
            Namespace: "openstack",
        },
        Data: map[string][]byte{
            "password": []byte("admin-test-password"),
        },
    }
    client.Create(ctx, adminSecret)
}
```

**Reconciler integration test example:**

```go
func TestKeystoneReconciler_CreatesDeployment(t *testing.T) {
    ctx := context.Background()
    createPrerequisiteSecrets(ctx, k8sClient)

    keystone := &keystonev1alpha1.Keystone{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-keystone",
            Namespace: "openstack",
        },
        Spec: keystonev1alpha1.KeystoneSpec{
            Replicas: 1,
            Image:    commonv1.ImageSpec{Repository: "ghcr.io/c5c3/keystone", Tag: "28.0.0"},
            Database: commonv1.DatabaseSpec{
                Database:  "keystone",
                SecretRef: commonv1.SecretRefSpec{Name: "keystone-db-credentials", Key: "password"},
            },
            Cache: commonv1.CacheSpec{
                Backend: "dogpile.cache.pymemcache",
                Servers: []string{"memcached-0.memcached:11211"},
            },
            Bootstrap: keystonev1alpha1.BootstrapSpec{
                AdminPasswordSecretRef: commonv1.SecretRefSpec{
                    Name: "keystone-admin-credentials", Key: "password"},
            },
        },
    }
    Expect(k8sClient.Create(ctx, keystone)).To(Succeed())

    // Wait for the reconciler to create a Deployment
    Eventually(func() bool {
        dep := &appsv1.Deployment{}
        err := k8sClient.Get(ctx, types.NamespacedName{
            Name: "keystone-api", Namespace: "openstack"}, dep)
        return err == nil
    }, 30*time.Second, time.Second).Should(BeTrue())
}
```

## E2E Tests with Chainsaw

[Chainsaw](https://kyverno.github.io/chainsaw/) provides declarative, YAML-based end-to-end testing for Kubernetes operators. Tests run against a real cluster (kind) with all dependencies deployed.

**Advantages over custom Go E2E:**

| Aspect | Chainsaw | Custom Go E2E |
| --- | --- | --- |
| **Test definition** | Declarative YAML | Imperative Go code |
| **Learning curve** | Low (YAML + kubectl concepts) | Higher (Go + client-go) |
| **Resource lifecycle** | Automatic cleanup per test | Manual cleanup required |
| **Assertions** | Built-in resource matching | Custom assertion logic |
| **Parallelism** | Built-in namespace isolation | Manual namespace management |
| **Reporting** | JUnit XML output | Custom reporting |

### Chainsaw Test Structure

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CHAINSAW TEST LAYOUT                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  tests/e2e/                                                                 │
│  ├── chainsaw-config.yaml           # Global Chainsaw configuration         │
│  ├── keystone/                      # ~40 keystone scenario dirs            │
│  │   ├── basic-deployment/                                                  │
│  │   │   ├── chainsaw-test.yaml     # Test definition                       │
│  │   │   ├── 00-prerequisites.yaml  # ESO-simulated Secrets                 │
│  │   │   ├── 01-keystone-cr.yaml    # Keystone CR to apply                  │
│  │   │   └── 02-assertions.yaml     # Expected state assertions             │
│  │   ├── database-tls/  httproute/  healthcheck/  trust-flush/             │
│  │   ├── policy-validation/  logging/  uwsgi/  graceful-shutdown/          │
│  │   ├── release-upgrade/  schema-drift-detection/  prometheus-stack/      │
│  │   └── ... (~40 total)                                                    │
│  ├── keystone-operator/             # operator-level (e.g. network-policy)  │
│  ├── infrastructure/                # chaos-mesh-health, flux-web-health,   │
│  │                                  #   infra-stack-health                  │
│  └── c5c3/                                                                  │
│                                                                             │
│  tests/e2e-chaos/   Chaos Mesh suite (ch. 10)                               │
│  tests/tempest/     Tempest config per release (keystone-2025-2, -2026-1)  │
│  tests/unit/        Shell-script unit tests                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Chainsaw Test Example

```yaml
# tests/e2e/keystone/basic-deployment/chainsaw-test.yaml
apiVersion: chainsaw.kyverno.io/v1alpha1
kind: Test
metadata:
  name: keystone-basic-deployment
spec:
  steps:
    # Step 0: Create prerequisite secrets (simulating ESO)
    - name: Create prerequisite secrets
      try:
        - apply:
            file: 00-prerequisites.yaml

    # Step 1: Apply Keystone CR
    - name: Deploy Keystone
      try:
        - apply:
            file: 01-keystone-cr.yaml

    # Step 2: Assert expected state
    - name: Verify Keystone is ready
      try:
        - assert:
            file: 02-assertions.yaml
      timeout: 120s
```

**Prerequisite Secrets** (`00-prerequisites.yaml`) — these simulate the Secrets that ESO would normally create from OpenBao:

```yaml
# tests/e2e/keystone/basic-deployment/00-prerequisites.yaml
apiVersion: v1
kind: Secret
metadata:
  name: keystone-db-credentials
stringData:
  username: keystone
  password: test-db-password
---
apiVersion: v1
kind: Secret
metadata:
  name: keystone-admin-credentials
stringData:
  password: test-admin-password
```

**Assertions** (`02-assertions.yaml`):

```yaml
# tests/e2e/keystone/basic-deployment/02-assertions.yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: keystone
status:
  conditions:
    - type: Ready
      status: "True"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keystone-api
status:
  readyReplicas: 3
```

### Test Scenarios

The Keystone suite has grown to ~40 scenario directories (47 Chainsaw suites in total across `keystone/`, `keystone-operator/`, `infrastructure/`, and `c5c3/`). The table below is illustrative, not exhaustive:

| Scenario | Description | Validates |
| --- | --- | --- |
| **Basic Deployment** | Apply Keystone CR, verify full readiness | Happy path, all sub-reconcilers |
| **Brownfield Database** | Apply CR with external database host/port | Brownfield mode, no MariaDB CRs created |
| **Database TLS** | Apply CR with `database.tls`, verify client cert | DatabaseTLSReady, cert-manager Certificate |
| **ConfigMap No Secrets** | Inspect rendered ConfigMap | DB password not present in config (CC-0080) |
| **Credential / Fernet Rotation** | Trigger rotation via staging Secret | CronJob, validate+apply, in-place rotation |
| **Policy Validation** | Apply invalid policyOverrides | oslopolicy-validator gates Deployment |
| **HTTPRoute / Gateway** | Apply CR with `spec.gateway` | HTTPRouteReady, endpoint derivation |
| **HealthCheck** | Verify active API probe | KeystoneAPIReady condition |
| **Trust Flush** | Verify trust_flush CronJob | TrustFlushReady condition |
| **Graceful Shutdown / Rolling Update** | Roll the Deployment | Zero-downtime, preStop/terminationGrace |
| **Release Upgrade / Schema Drift** | Bump release | UpgradePhase, InstalledRelease status |
| **Logging / uWSGI / Topology Spread / Priority Class** | Apply respective spec fields | Field-specific rendering |
| **Invalid CR** | Apply CRs violating webhook rules | Webhook rejection (generated fixtures) |
| **Deletion Cleanup** | Delete Keystone CR | Owner refs + OpenBao finalizer purge |
| **Network Policy / Autoscaling / Scale / Resources** | Apply respective spec fields | Corresponding condition/lifecycle |
| **Prometheus Stack** | Deploy with kube-prometheus-stack | ServiceMonitor + metrics (CC-0100) |

## Tempest (OpenStack API Conformance)

Beyond reconciler-focused E2E, `make tempest-test SERVICE=keystone` runs upstream **Tempest** against a deployed Keystone to validate real OpenStack API behavior (CC-0035). Tempest configuration is versioned per OpenStack release under `tests/tempest/` (`keystone-2025-2`, `keystone-2026-1`), each with its own `tempest.conf` and include/exclude test lists; `tests/tempest/test_retry_helpers.py` adds flaky-test retry handling. Test git refs come from `releases/<release>/test-refs.yaml`.

## Invalid-CR Fixture Generation

The `invalid-cr` scenario uses generated fixtures: `tests/e2e/keystone/invalid-cr/_generate.py` emits the numbered invalid-CR manifests, and `make verify-invalid-cr-fixtures` (`_generate.py --check`) fails CI if the committed fixtures drift from the generator (CC-0094).

## CI Test Execution

Tests are executed by the single `ci.yaml` workflow, which gates jobs on a `changes` paths-filter and splits the test matrix into `common` / `keystone` / `c5c3` legs (`test`, `test-integration`), plus `test-race`. E2E infrastructure is provisioned via a composite action and images are built centrally and pulled by GHCR run-scoped tags — not `kind load` inline. For the full CI/CD pipeline including image builds and Helm packaging, see [CI/CD & Packaging](./07-ci-cd-and-packaging.md).

```yaml
# .github/workflows/ci.yaml (illustrative — the real workflow is far larger)
jobs:
  test:                         # matrix: common, keystone, c5c3
    strategy:
      matrix:
        module: [common, keystone, c5c3]
    steps:
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.work   # Go 1.26.3
      - run: make test-${{ matrix.module == 'common' && 'common' || 'operator OPERATOR='matrix.module }}
      - uses: codecov/codecov-action@v6

  test-integration:            # envtest, integration build tag
    steps: [ setup-go, run: make test-integration ]

  e2e-operator:
    needs: [build-e2e-images, e2e-infra]
    steps:
      - uses: ./.github/actions/setup-e2e-infra
      - run: ./hack/ci-deploy-operator.sh keystone
      - run: make e2e OPERATOR=keystone

  e2e-prometheus:  # opt-in kube-prometheus-stack suite
  e2e-chaos:       # Chaos Mesh suite, see ch. 10 (non-blocking)
  tempest:         # matrix over OpenStack releases (2025.2, 2026.1)
```

Unit, integration, race, and lint jobs run on every PR (subject to path filters). E2E, Tempest, chaos, and Prometheus suites run against a kind cluster with the operator and its dependencies deployed. The chaos suite is documented in [Chaos E2E Testing](./10-chaos-e2e-testing.md).
