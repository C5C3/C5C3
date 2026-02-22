# Testing

CobaltCore operators are tested across three levels: unit tests for pure business logic, integration tests with envtest for reconciler behavior, and end-to-end tests with Chainsaw for full-stack validation. This page documents the testing strategy, tooling, and test scenarios for the Keystone Operator.

## Testing Pyramid

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TESTING PYRAMID                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                          ┌───────────┐                                      │
│                         ╱             ╲                                     │
│                        ╱   E2E Tests   ╲       Chainsaw (YAML-based)        │
│                       ╱  (Chainsaw)     ╲      Real cluster (kind)          │
│                      ╱   ~10 scenarios   ╲     Slow, high confidence        │
│                     ╱─────────────────────╲                                 │
│                    ╱                       ╲                                │
│                   ╱   Integration Tests     ╲   envtest (API server +       │
│                  ╱   (envtest)               ╲  etcd, no kubelet)           │
│                 ╱    ~20-30 test cases        ╲ Medium speed                │
│                ╱───────────────────────────────╲                            │
│               ╱                                 ╲                           │
│              ╱         Unit Tests                ╲  go test, table-driven   │
│             ╱          ~50-100 test cases         ╲ Fast, isolated          │
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

**Coverage target:** 80%+ for `internal/common/` packages, 70%+ for operator-specific logic. Coverage is measured via `go test -coverprofile` and reported to Codecov in the [CI pipeline](./07-ci-cd-and-packaging.md#cicd-pipeline).

## Integration Tests (envtest)

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
│  └── keystone/                                                              │
│      ├── basic-deployment/                                                  │
│      │   ├── chainsaw-test.yaml     # Test definition                       │
│      │   ├── 00-prerequisites.yaml  # ESO-simulated Secrets                 │
│      │   ├── 01-keystone-cr.yaml    # Keystone CR to apply                  │
│      │   └── 02-assertions.yaml     # Expected state assertions             │
│      ├── fernet-rotation/                                                   │
│      │   ├── chainsaw-test.yaml                                             │
│      │   └── ...                                                            │
│      ├── missing-secret/                                                    │
│      │   ├── chainsaw-test.yaml                                             │
│      │   └── ...                                                            │
│      └── scale/                                                             │
│          ├── chainsaw-test.yaml                                             │
│          └── ...                                                            │
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

| Scenario | Description | Validates |
| --- | --- | --- |
| **Basic Deployment** | Apply Keystone CR, verify full readiness | Happy path, all sub-reconcilers |
| **Image Upgrade** | Change `spec.image.tag`, verify rolling update | Deployment update, no downtime |
| **Fernet Rotation** | Trigger rotation, verify key count and restart | CronJob, Secret update, rolling restart |
| **Database Failure** | Delete MariaDB Database CR, verify requeue | Error handling, condition degradation |
| **Missing ESO Secret** | Apply Keystone CR without prerequisite Secrets | SecretsReady=False, requeue behavior |
| **Invalid CR** | Apply CR with invalid cron expression | Webhook rejection |
| **Scale Up/Down** | Change `spec.replicas`, verify pod count | Deployment scaling |
| **Deletion** | Delete Keystone CR, verify cleanup | Owner references, garbage collection |

## CI Test Execution

Tests are executed in GitHub Actions with separate jobs per test level. For the full CI/CD pipeline including image builds and Helm packaging, see [CI/CD & Packaging](./07-ci-cd-and-packaging.md).

```yaml
# .github/workflows/test.yaml (simplified)
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - run: make test
      - uses: codecov/codecov-action@v4

  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - run: make test-integration

  e2e-tests:
    runs-on: ubuntu-latest
    needs: [unit-tests, integration-tests]
    steps:
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - uses: helm/kind-action@v1
      - name: Install dependencies
        run: |
          # Install MariaDB Operator, Memcached Operator, cert-manager
          make install-test-deps
      - name: Deploy operator
        run: |
          make docker-build OPERATOR=keystone
          kind load docker-image ghcr.io/c5c3/keystone-operator:dev
          make deploy OPERATOR=keystone
      - name: Run Chainsaw tests
        run: make e2e OPERATOR=keystone
```

Unit and integration tests run on every PR. E2E tests run after unit and integration tests pass, using a kind cluster with the operator and its dependencies deployed.
