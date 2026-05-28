# Chaos E2E Testing

CobaltCore operators must tolerate infrastructure failures gracefully — detecting degradation, reporting accurate status conditions, and recovering autonomously when dependencies return. This document defines the chaos E2E test strategy, tooling, and test scenarios.

## Motivation

The existing E2E tests (see [Testing](./06-testing.md)) validate happy-path reconciliation: resources are created, conditions converge to `Ready=True`, and owned resources match expected state. Chaos tests close the remaining confidence gap by validating operator behavior **during and after** infrastructure failures:

* Does the operator detect a MariaDB outage and set `DatabaseReady=False` within a reasonable time window?
* Does the operator recover without manual intervention when the dependency returns?
* Does the operator survive slow degradation (e.g., 10s latency on every database query) without hanging indefinitely?
* Do CronJob failures (Fernet rotation, credential rotation) surface as condition updates?

## Tool Selection: Chaos Mesh

### Evaluation Summary

| Tool | CRD-Native | kind Support | Resource Footprint | Chainsaw Integration | Maintenance | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Chaos Mesh** | Yes (all experiments are K8s CRDs) | Officially supported | ~250m CPU / 512Mi RAM (no dashboard) | Native (`apply`/`assert` CRDs) | CNCF Incubating, active releases | **Selected** |
| Litmus Chaos | Partial (Argo Workflows underneath) | Yes, with caveats | ~2-3GB (MongoDB required) | Poor (Argo indirection) | CNCF Incubating, active | Too heavy for CI |
| Krkn | No (Python CLI) | Yes | Minimal in-cluster | Poor (requires `script:`) | CNCF Sandbox, active | No CRD integration |
| Chaos Toolkit | No (JSON/YAML files, own format) | Yes | Minimal in-cluster | Poor (requires `script:`) | Active | Delegates to Chaos Mesh for network faults anyway |
| Toxiproxy | No (HTTP API) | Yes | Minimal | Poor (requires `script:` + `curl`) | Active | Better fit for Go integration tests, not E2E |
| PowerfulSeal | No (YAML policies) | Yes | Minimal | Poor | Abandoned (last release 2021) | Do not use |

### Why Chaos Mesh

1. **CRD-native** — experiments are standard Kubernetes CRDs (`chaos-mesh.org/v1alpha1`). Chainsaw can `apply` a `PodChaos` or `NetworkChaos` CR just like any other resource, then `assert` the operator's status conditions. No `script:` workarounds needed.

2. **Comprehensive fault types** — pod kill, network partition, network latency/loss/corruption, I/O faults, CPU/memory stress, DNS faults, HTTP faults, time skew. Covers both hard failures and the slow degradation patterns highlighted in the issue comments.

3. **Lightweight CI footprint** — with `dashboard.create=false` and `dnsServer.create=false`, Chaos Mesh runs as a controller-manager Deployment + DaemonSet consuming ~250m CPU / 512Mi RAM. Fits within the 7GB / 2 vCPU CI runner alongside kind, operators, and infrastructure.

4. **Precise targeting** — rich selector system (label selectors, namespace selectors, expression selectors) allows targeting specific infrastructure pods (MariaDB, Memcached, OpenBao) without affecting the operator itself.

5. **Time-bounded experiments** — all experiments support a `duration` field. Faults are automatically reverted, preventing stuck CI runs.

6. **GitHub Actions support** — official `chaos-mesh/chaos-mesh-action` installs Chaos Mesh into a kind cluster.

### Complementary: Toxiproxy for Integration Tests <Badge type="info" text="planned" />

> Not yet wired into forge — there is no Toxiproxy dependency or `database_resilience_test.go` today. The following is a proposed complement.

For scenarios requiring fine-grained TCP-level fault injection (slow connections, partial reads,
connection resets), Toxiproxy's Go client (`github.com/Shopify/toxiproxy/v2/client`) can be used
in envtest-level integration tests. This addresses the slow degradation patterns (e.g., MariaDB
responding with 10s latency) more precisely than Chaos Mesh's `NetworkChaos`, because Toxiproxy
can be placed between the operator and the dependency within the test process itself. This is not
part of the E2E test suite but complements it at the integration test level.

## Infrastructure Setup

### Chaos Mesh Installation

Chaos Mesh is **opt-in** and installed via a FluxCD `HelmRelease` kustomize overlay (`deploy/kind/chaos-mesh/` — `release.yaml`, `source.yaml`, `namespace.yaml`, `kustomization.yaml`), applied by `hack/deploy-infra.sh` only when `WITH_CHAOS_MESH=true`:

```bash
# Opt in to Chaos Mesh; default Quick Start / production overlays omit it.
WITH_CHAOS_MESH=true make deploy-infra
# deploy-infra.sh then runs: kubectl apply -k deploy/kind/chaos-mesh
```

The overlay's `release.yaml` pins `version: ">=2.6.0 <3.0.0"` and `dependsOn: cert-manager`; it does not set the resource/dashboard `--set` overrides shown in older drafts. For NetworkChaos, `deploy-infra.sh` also loads the required kernel modules (`ip_set`, `xt_set`, `sch_netem`).

> The default flag is `WITH_CHAOS_MESH=false` (opt-in). There is no `SKIP_CHAOS_MESH` flag.

### kind Cluster Configuration

The existing single-node kind cluster (`hack/kind-config.yaml`) works with Chaos Mesh. The chaos-daemon DaemonSet runs on the single control-plane node. No additional nodes are required.

### CI Pipeline Integration

Chaos E2E tests run as a **separate GitHub Actions job** that depends on the standard E2E tests passing:

```yaml
e2e-chaos:
  # Split into two matrix legs: Pod faults run on a Blacksmith runner; Network
  # faults need a runner whose kernel exposes ip_set/xt_set/sch_netem, so they
  # run on stock ubuntu-24.04 (CC-0047).
  strategy:
    matrix:
      include:
        - suite: pod
          runner: blacksmith-4vcpu-ubuntu-2404
        - suite: network
          runner: ubuntu-24.04
  runs-on: ${{ matrix.runner }}
  needs: [changes, lint, shellcheck, test, test-integration, verify-codegen, chainsaw-lint, build-e2e-images]
  # Non-blocking: chaos is informational and must not gate merges (CC-0054).
  continue-on-error: true
  # Runs when Go / chaos-test files change, or on PRs labeled run-chaos.
  steps:
    - uses: ./.github/actions/setup-e2e-infra   # WITH_CHAOS_MESH=true
    - run: ./hack/ci-deploy-operator.sh keystone
    - run: chainsaw test --config tests/e2e-chaos/chainsaw-config.yaml <explicit test_dirs for ${{ matrix.suite }}>
```

**Trigger policy:** the `e2e-operator` dependency was intentionally removed (CC-0049) so chaos runs in parallel; it is `continue-on-error: true` (non-blocking, CC-0054) and triggered by change-detection or the `run-chaos` label. Setup uses the `setup-e2e-infra` composite action + GHCR image load — not `chaos-mesh/chaos-mesh-action`.

### Makefile Target

```makefile
.PHONY: e2e-chaos
e2e-chaos: ## Run chaos E2E tests (requires Chaos Mesh in cluster)
	@kubectl cluster-info >/dev/null 2>&1 || { echo "no reachable cluster"; exit 1; }
	@kubectl get ns chaos-mesh >/dev/null 2>&1 || { \
	  echo "chaos-mesh namespace missing — run WITH_CHAOS_MESH=true make deploy-infra"; exit 1; }
	chainsaw test --config tests/e2e-chaos/chainsaw-config.yaml tests/e2e-chaos/
```

The target takes no `OPERATOR` variable; report format/path are configured in `chainsaw-config.yaml`.

## Test Directory Layout

Scenarios live **flat** directly under `tests/e2e-chaos/` (no per-operator `keystone/` level), with shared helper scripts alongside. The `chaos-mesh-health` test lives in the standard e2e tree under `tests/e2e/infrastructure/`.

```text
tests/e2e-chaos/
├── chainsaw-config.yaml                    # Chaos-specific Chainsaw config
├── diagnostics.sh                          # Shared baseline/chaos catch-block helper
├── unseal-openbao.sh
├── mariadb-pod-kill/
│   ├── chainsaw-test.yaml
│   ├── 00-keystone-cr.yaml
│   └── 01-podchaos-kill-mariadb.yaml
├── mariadb-network-latency/
├── mariadb-network-partition/
├── memcached-pod-kill/
├── openbao-pod-kill/
├── operator-pod-crash/                     # mode: one (single-pod recovery, CC-0048)
├── operator-pod-kill/                      # mode: all (leader re-election, CC-0066)
├── api-pod-kill-pdb/
└── cronjob-rotation-failure/

tests/e2e/infrastructure/chaos-mesh-health/  # health check, standard e2e tree
```

> Directory names align with forge: `api-pod-kill-pdb` (not `-with-pdb`), `cronjob-rotation-failure` (not `cronjob-failure`), and **two** operator-failure tests. The `cert-manager-pod-kill`, `memcached-network-partition`, and `multi-dependency-failure` directories below in the scenario catalog are **planned, not yet implemented**.

### Chainsaw Configuration for Chaos Tests

```yaml
# tests/e2e-chaos/chainsaw-config.yaml
apiVersion: chainsaw.kyverno.io/v1alpha2
kind: Configuration
metadata:
  name: cloud-operator-e2e-chaos
spec:
  timeouts:
    apply: 30s
    assert: 300s       # 5m — chaos recovery is slower than happy-path
    cleanup: 120s      # Chaos CRs need cleanup time
    delete: 30s        # matches happy-path; deliberately not relaxed
    error: 30s
    exec: 30s
  execution:
    parallel: 1         # Serial — prevents cross-test interference on shared infra
    failFast: true
  cleanup:
    skipDelete: false
  report:
    format: JUNIT-TEST
    path: _output/reports
```

## Test Scenarios

### Category 1: Infrastructure Pod Failures

These scenarios validate operator recovery when infrastructure pods crash and restart.

#### SC-CHAOS-001: MariaDB Pod Kill

**Objective:** Operator detects MariaDB outage, sets `DatabaseReady=False`, and recovers when MariaDB returns.

```yaml
# tests/e2e-chaos/keystone/mariadb-pod-kill/01-podchaos-kill-mariadb.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-mariadb
  namespace: openstack
spec:
  action: pod-kill
  mode: one
  selector:
    namespaces:
      - openstack
    labelSelectors:
      app.kubernetes.io/name: mariadb
  gracePeriod: 0
```

```yaml
# tests/e2e-chaos/keystone/mariadb-pod-kill/chainsaw-test.yaml
apiVersion: chainsaw.kyverno.io/v1alpha1
kind: Test
metadata:
  name: keystone-mariadb-pod-kill
spec:
  namespace: openstack
  timeouts:
    assert: 5m
  steps:
    # ── Step 0: Deploy Keystone and wait for Ready ──
    - name: Deploy Keystone
      try:
        - apply:
            file: 00-keystone-cr.yaml
        - assert:
            resource:
              apiVersion: keystone.openstack.c5c3.io/v1alpha1
              kind: Keystone
              metadata:
                name: keystone-chaos-db
              status:
                (conditions[?type == 'Ready']):
                  - status: "True"
                    reason: AllReady

    # ── Step 1: Kill MariaDB pod ──
    - name: Inject chaos - kill MariaDB
      try:
        - apply:
            file: 01-podchaos-kill-mariadb.yaml

    # ── Step 2: Assert operator detects failure ──
    - name: Verify degraded state detected
      try:
        - assert:
            resource:
              apiVersion: keystone.openstack.c5c3.io/v1alpha1
              kind: Keystone
              metadata:
                name: keystone-chaos-db
              status:
                (conditions[?type == 'DatabaseReady']):
                  - status: "False"
      catch:
        - script:
            content: |
              echo "=== Keystone status ==="
              kubectl get keystone -n $NAMESPACE -o yaml 2>&1 || true
              echo "=== MariaDB pods ==="
              kubectl get pods -n $NAMESPACE -l app.kubernetes.io/name=mariadb -o wide 2>&1 || true
              echo "=== Events ==="
              kubectl get events -n $NAMESPACE --sort-by='.lastTimestamp' 2>&1 | tail -30 || true

    # ── Step 3: Wait for MariaDB recovery and assert operator recovery ──
    - name: Verify full recovery
      try:
        - assert:
            resource:
              apiVersion: keystone.openstack.c5c3.io/v1alpha1
              kind: Keystone
              metadata:
                name: keystone-chaos-db
              status:
                (conditions[?type == 'Ready']):
                  - status: "True"
                    reason: AllReady
      catch:
        - script:
            content: |
              echo "=== All pod logs ==="
              for pod in $(kubectl get pods -n $NAMESPACE -o name 2>/dev/null); do
                echo "--- $pod ---"
                kubectl logs -n $NAMESPACE "$pod" --all-containers --tail=60 2>&1 || true
              done
              echo "=== Events ==="
              kubectl get events -n $NAMESPACE --sort-by='.lastTimestamp' 2>&1 | tail -30 || true

    # ── Step 4: Cleanup chaos CR ──
    - name: Remove chaos experiment
      try:
        - delete:
            ref:
              apiVersion: chaos-mesh.org/v1alpha1
              kind: PodChaos
              name: kill-mariadb
              namespace: openstack
```

#### SC-CHAOS-002: Memcached Pod Kill

**Objective:** Operator continues to function when Memcached is unavailable (cache is non-critical). Keystone API remains reachable. Operator recovers cache connectivity when Memcached returns.

**Key difference from MariaDB:** Memcached failure should not set `Ready=False` — it is a performance degradation, not a functional failure. The test asserts that `Ready` stays `True` while Memcached is down.

#### SC-CHAOS-003: OpenBao Pod Kill

**Objective:** ESO ExternalSecrets temporarily fail to sync. Operator tolerates this because it reads Kubernetes Secrets (not OpenBao directly). Already-synced Secrets remain available. When OpenBao returns, ExternalSecrets resume syncing.

#### SC-CHAOS-004: cert-manager Pod Kill <Badge type="info" text="planned" />

**Objective:** Certificate renewals are delayed but existing TLS Secrets remain valid. Operator continues to serve traffic with existing certificates. When cert-manager returns, pending renewals complete.

#### SC-CHAOS-005: Operator Pod Kill (Self-Healing)

Forge implements this as **two** distinct tests, and the operator runs in its own `keystone-system` namespace (CC-0105), targeted cross-namespace from the `openstack`-namespaced PodChaos:

* `operator-pod-crash/` — `mode: one` kills a single operator pod; verifies the Deployment restarts it and reconciliation resumes (CC-0048).
* `operator-pod-kill/` — `mode: all` kills every operator pod to force **leader re-election**, then a follow-up step patches `spec.replicas` (1→2) to prove the new leader can reconcile spec changes after failover (CC-0066).

No user-visible state regression — the Keystone CR status remains consistent across both.

### Category 2: Network Fault Injection

These scenarios validate operator behavior under network degradation — the harder class of failures highlighted in the issue comments.

#### SC-CHAOS-006: MariaDB Network Partition

**Objective:** Operator detects that MariaDB is unreachable (TCP connection refused) and sets `DatabaseReady=False`. Recovers when partition is lifted.

```yaml
# tests/e2e-chaos/keystone/mariadb-network-partition/01-networkchaos-partition.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: partition-mariadb
  namespace: openstack
spec:
  action: partition
  mode: all
  selector:
    namespaces:
      - openstack
    labelSelectors:
      app.kubernetes.io/name: keystone
  direction: to
  target:
    mode: all
    selector:
      namespaces:
        - openstack
      labelSelectors:
        app.kubernetes.io/name: mariadb
  duration: "120s"
```

#### SC-CHAOS-007: MariaDB Network Latency (Slow Degradation)

**Objective:** Validate that the operator does not hang indefinitely when MariaDB responds with extreme latency. The operator should either timeout and retry, or degrade gracefully — but not block the reconciliation loop.

This addresses the specific concern from the issue comments: *"our operator handled hard disconnects fine but hung indefinitely on slow connections."*

```yaml
# tests/e2e-chaos/keystone/mariadb-network-latency/01-networkchaos-latency.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: latency-mariadb
  namespace: openstack
spec:
  action: delay
  mode: all
  selector:
    namespaces:
      - openstack
    labelSelectors:
      app.kubernetes.io/name: keystone
  direction: to
  target:
    mode: all
    selector:
      namespaces:
        - openstack
      labelSelectors:
        app.kubernetes.io/name: mariadb
  delay:
    latency: "10s"
    jitter: "2s"
    correlation: "100"
  duration: "180s"
```

**Assertions:** During the latency injection, the test verifies:
1. The reconciler does not hang (operator pod remains `Running`, not stuck in a blocking call)
2. Condition updates continue to be processed (the operator is not deadlocked)
3. After the latency injection ends, the operator recovers to `Ready=True`

#### SC-CHAOS-008: Memcached Network Partition <Badge type="info" text="planned" />

**Objective:** Keystone API remains functional without cache. Performance degrades but availability is maintained. `Ready` condition stays `True`.

### Category 3: Service Availability Under Chaos

#### SC-CHAOS-009: API Pod Kill with PDB

**Objective:** Killing one Keystone API pod while a `PodDisruptionBudget` is in place. The PDB ensures minimum availability. The Deployment controller recreates the killed pod. The operator status reflects the temporary unavailability and recovery.

```yaml
# PodChaos targeting one Keystone API pod
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-keystone-api
  namespace: openstack
spec:
  action: pod-kill
  mode: one
  selector:
    namespaces:
      - openstack
    labelSelectors:
      app.kubernetes.io/name: keystone
      app.kubernetes.io/component: api
```

**Assertions:**
1. During the kill: `(availableReplicas >= \`1\`)` remains true (PDB protects minimum availability)
2. After recovery: `Ready=True` and replica count matches spec

#### SC-CHAOS-010: CronJob Rotation Failure (resilience, not degradation)

**Objective:** A transient failure of the Fernet rotation Job must **not** degrade Keystone. Because the existing fernet keys remain valid and projected in-place, killing the rotation Job leaves `FernetKeysReady=True` and `Ready=True` — the operator does not flip the condition False on a single failed rotation.

> The implemented test (`tests/e2e-chaos/cronjob-rotation-failure/`) asserts the **opposite** of an earlier draft: it injects a `PodChaos` `pod-failure` on the rotation Job and verifies status **stays** `True` (assert timeout 5m), rather than expecting a bounded-60s flip to `False`.

```yaml
# Inject a pod-failure on the rotation Job, then assert status is maintained
- name: Verify rotation failure does not degrade Keystone
  try:
    - apply:
        file: 01-podchaos-fail-rotation.yaml   # action: pod-failure on the rotate Job
    - assert:
        resource:
          apiVersion: keystone.openstack.c5c3.io/v1alpha1
          kind: Keystone
          metadata:
            name: keystone-chaos-cron
          status:
            (conditions[?type == 'FernetKeysReady']):
              - status: "True"
            (conditions[?type == 'Ready']):
              - status: "True"
```

The CronJob triggered is `keystone-chaos-cron-fernet-rotate`.

### Category 4: Multi-Dependency Failures

#### SC-CHAOS-011: Simultaneous MariaDB + Memcached Failure <Badge type="info" text="planned" />

**Objective:** When both database and cache fail simultaneously, the operator reports all affected conditions accurately and recovers both when services return. Tests that the operator does not mask one failure behind another.

```yaml
# Apply two chaos CRs simultaneously
- name: Kill MariaDB and Memcached
  try:
    - apply:
        file: 01-podchaos-kill-mariadb.yaml
    - apply:
        file: 02-podchaos-kill-memcached.yaml
- name: Verify multiple degraded conditions
  try:
    - assert:
        resource:
          apiVersion: keystone.openstack.c5c3.io/v1alpha1
          kind: Keystone
          metadata:
            name: keystone-chaos-multi
          status:
            (conditions[?type == 'DatabaseReady']):
              - status: "False"
            (conditions[?type == 'Ready']):
              - status: "False"
```

### Category 5: Infrastructure Component Resilience <Badge type="info" text="planned" />

These scenarios test the infrastructure stack itself, not just the operators. Neither is implemented in forge yet.

#### SC-CHAOS-012: FluxCD Controller Restart <Badge type="info" text="planned" />

**Objective:** FluxCD HelmRelease reconciliation resumes after the Flux controllers are killed. Existing HelmReleases remain deployed. New changes are reconciled when Flux recovers.

#### SC-CHAOS-013: ESO Controller Restart <Badge type="info" text="planned" />

**Objective:** ExternalSecrets continue to serve cached Secrets during ESO controller outage. When ESO recovers, Secret sync resumes. Operators are unaffected because they read Kubernetes Secrets, not ESO directly.

## Scenario Matrix

Implemented today: SC-CHAOS-001/002/003 (pod kills), 005 (both operator variants), 006/007 (network partition/latency), 009 (API pod kill + PDB), 010 (rotation-failure resilience). Planned: SC-CHAOS-004, 008, 011, 012, 013.

| ID | Scenario | Chaos Type | Target | Expected Operator Behavior | Timeout |
| --- | --- | --- | --- | --- | --- |
| SC-CHAOS-001 | MariaDB pod kill | `PodChaos` | mariadb | `DatabaseReady=False` → recovery → `Ready=True` | 5m |
| SC-CHAOS-002 | Memcached pod kill | `PodChaos` | memcached | `Ready` stays `True` (cache non-critical) | 3m |
| SC-CHAOS-003 | OpenBao pod kill | `PodChaos` | openbao | Existing Secrets retained, ESO paused, recovery | 5m |
| SC-CHAOS-004 | cert-manager pod kill | `PodChaos` | cert-manager | Existing TLS valid, renewals delayed, recovery | 5m |
| SC-CHAOS-005 | Operator pod kill | `PodChaos` | keystone-operator | Deployment restarts operator, reconciliation resumes | 3m |
| SC-CHAOS-006 | MariaDB network partition | `NetworkChaos` (partition) | mariadb | `DatabaseReady=False` → recovery → `Ready=True` | 5m |
| SC-CHAOS-007 | MariaDB network latency | `NetworkChaos` (delay 10s) | mariadb | No hang, graceful degradation, recovery | 5m |
| SC-CHAOS-008 | Memcached network partition | `NetworkChaos` (partition) | memcached | `Ready` stays `True`, performance degrades | 3m |
| SC-CHAOS-009 | API pod kill with PDB | `PodChaos` | keystone-api | PDB protects min availability, recovery | 3m |
| SC-CHAOS-010 | CronJob failure reporting | `NetworkChaos` + manual Job | mariadb | Condition update within 60s, not just "eventually" | 2m |
| SC-CHAOS-011 | Multi-dependency failure | `PodChaos` (2x) | mariadb + memcached | All conditions accurate, full recovery | 5m |
| SC-CHAOS-012 | FluxCD controller restart | `PodChaos` | flux-system | HelmReleases retained, reconciliation resumes | 5m |
| SC-CHAOS-013 | ESO controller restart | `PodChaos` | external-secrets | Cached Secrets retained, sync resumes | 5m |

## Test Conventions

### Naming

* CR names: `keystone-chaos-<scenario>` (e.g., `keystone-chaos-db`, `keystone-chaos-net`)
* Chaos CR names: `<action>-<target>` (e.g., `kill-mariadb`, `partition-mariadb`, `latency-mariadb`)
* Test directories: `<target>-<fault-type>` (e.g., `mariadb-pod-kill`, `mariadb-network-latency`)

### Timeouts

* Default assert timeout: 5m (chaos recovery is slower than happy-path)
* Bounded condition checks (SC-CHAOS-010): 60s — verifies timely reporting
* Chaos `duration` field: always set, never unbounded

### Catch Blocks

Every assert step includes a catch block with diagnostic output (same pattern as existing E2E tests). Chaos tests additionally collect:

```yaml
catch:
  - script:
      content: |
        echo "=== Chaos Mesh experiments ==="
        kubectl get podchaos,networkchaos -n $NAMESPACE -o wide 2>&1 || true
        echo "=== Chaos experiment status ==="
        kubectl get podchaos,networkchaos -n $NAMESPACE -o yaml 2>&1 || true
        # ... standard pod/event/configmap diagnostics ...
```

### Cleanup

Chainsaw's automatic cleanup removes chaos CRs at test end. Additionally, each test includes an explicit cleanup step to remove chaos experiments before asserting recovery — this ensures the fault is actually lifted.

### Parallelism

Chaos tests run **serially** (`parallel: 1`) because chaos experiments affect shared infrastructure components and concurrent faults would interfere with each other. CI splits the suite across two runners by fault class (Pod vs Network) rather than running tests concurrently on one cluster.

### Shared catch helper

Catch blocks call the shared `tests/e2e-chaos/diagnostics.sh` (with `baseline` / `chaos` modes) rather than duplicating inline diagnostic scripts per test.

## Implementation Phases

### Phase 1: Foundation

* Install Chaos Mesh in CI pipeline (`hack/deploy-infra.sh`)
* Add `e2e-chaos` Makefile target
* Add `e2e-chaos` GitHub Actions job (gated behind label)
* Implement `chaos-mesh-health` infrastructure test
* Implement SC-CHAOS-001 (MariaDB pod kill) and SC-CHAOS-005 (operator pod kill) as reference tests

### Phase 2: Network Faults

* Implement SC-CHAOS-006 (MariaDB network partition)
* Implement SC-CHAOS-007 (MariaDB network latency / slow degradation)
* Implement SC-CHAOS-008 (Memcached network partition)
* Validate operator timeout/retry behavior — fix any hanging reconcilers

### Phase 3: Full Coverage

* Implement SC-CHAOS-002 through SC-CHAOS-004 (Memcached, OpenBao, cert-manager pod kills)
* Implement SC-CHAOS-009 (API pod kill with PDB)
* Implement SC-CHAOS-010 (CronJob failure reporting with bounded timeout)
* Implement SC-CHAOS-011 (multi-dependency failure)

### Phase 4: Infrastructure Resilience

* Implement SC-CHAOS-012 (FluxCD controller restart)
* Implement SC-CHAOS-013 (ESO controller restart)
* Extend to additional operators (Glance, Nova, Neutron, Cinder, Placement) as they are implemented

## Integration Test Complement: Toxiproxy <Badge type="info" text="planned" />

> Proposed, not yet implemented in forge.

For TCP-level slow degradation testing (the scenario where MariaDB responds but with extreme latency), Toxiproxy can be added as a Go dependency for envtest-level integration tests:

```go
// internal/common/database/database_resilience_test.go
func TestDatabaseSyncWithSlowConnection(t *testing.T) {
    proxy, _ := toxiClient.CreateProxy("mariadb", "localhost:13306", "mariadb:3306")
    proxy.AddToxic("latency", "latency", "", 1, toxiproxy.Attributes{"latency": 10000})
    defer proxy.Delete()

    // Run db_sync with the slow proxy — verify it times out, not hangs
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    err := database.RunSync(ctx, proxyConnectionString)
    assert.ErrorIs(t, err, context.DeadlineExceeded)
}
```

This catches the slow-connection hang bug at the integration test level, faster and more precisely than E2E. The E2E chaos test (SC-CHAOS-007) validates the same scenario from the outside, confirming operator-level behavior in a real cluster.
