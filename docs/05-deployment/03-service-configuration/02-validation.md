# Validation

Configuration validation in CobaltCore operates across three layers, each catching different classes of errors at progressively later stages. Together, they provide defense-in-depth against misconfigurations. For the config generation pipeline that precedes validation, see [Config Generation](./01-config-generation.md).

## Validation Layers

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       VALIDATION LAYERS                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │  Layer 3: RUNTIME VALIDATION                                          │  │
│  │  oslo.config parsing, service startup checks, readiness probes        │  │
│  │                                                                       │  │
│  │  ┌───────────────────────────────────────────────────────────────┐    │  │
│  │  │                                                               │    │  │
│  │  │  Layer 2: OPERATOR RECONCILIATION                             │    │  │
│  │  │  Secret checks, connectivity, cross-resource, semantic rules  │    │  │
│  │  │                                                               │    │  │
│  │  │  ┌───────────────────────────────────────────────────────┐    │    │  │
│  │  │  │                                                       │    │    │  │
│  │  │  │  Layer 1: API SERVER                                  │    │    │  │
│  │  │  │  OpenAPI schema, types, required fields, enums        │    │    │  │
│  │  │  │                                                       │    │    │  │
│  │  │  └───────────────────────────────────────────────────────┘    │    │  │
│  │  │                                                               │    │  │
│  │  └───────────────────────────────────────────────────────────────┘    │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Layer 1: API Server

When a user or GitOps tool applies a Service CR, the Kubernetes API server validates it against the CRD's OpenAPI v3.0 schema before persisting it to etcd. This is the fastest feedback loop — invalid resources are rejected immediately.

**What Layer 1 catches:**

| Check | Example |
| --- | --- |
| **Type validation** | `replicas: "three"` rejected (expected integer) |
| **Required fields** | Missing `spec.image.repository` rejected |
| **Enum constraints** | `cache.backend: redis` rejected if not in allowed values |
| **Format validation** | `spec.database.port: 99999` rejected (out of range) |
| **Structural rules** | Unknown fields rejected (with `x-kubernetes-preserve-unknown-fields: false`) |

**Error reporting:** Immediate rejection by `kubectl apply` or the API client:

```text
$ kubectl apply -f nova.yaml
The Nova "nova" is invalid:
  spec.database.port: Invalid value: 99999: spec.database.port in body
  should be less than or equal to 65535
```

**CEL validation rules (not yet implemented in C5C3).** Kubernetes supports Common Expression Language (CEL) rules in CRDs (stable since 1.29) for cross-field validation. Examples that could be expressed:

- If `storage.backend` is `rbd`, then `storage.rbdPool` must be set
- If `replicas.api` is greater than 1, then `cache.backend` should be set (warn)
- `apiDatabase` is required only for Nova (not other services)

## Layer 2: Operator Reconciliation

After a CR passes API server validation, the Service Operator performs deeper semantic validation during reconciliation. These checks require runtime context that the API server schema cannot express.

**What Layer 2 catches:**

| Check | Description |
| --- | --- |
| **Secret existence** | Referenced K8s Secrets must exist and contain expected keys (see [Secret Management](../02-secret-management.md)) |
| **Connectivity validation** | Database host must be resolvable, RabbitMQ endpoint must be reachable |
| **Cross-resource validation** | Keystone must be `Ready` before Nova can configure auth |
| **Dependency readiness** | Infrastructure services (MariaDB, RabbitMQ, Valkey) must be operational |
| **Semantic checks** | Ceph pool name must match the configured Ceph cluster, OVN connection format must be valid |

**Status conditions:** Operators report validation results as conditions on the Service CR:

| Condition | Status | Reason | Description |
| --- | --- | --- | --- |
| `DatabaseReady` | True/False | `SecretFound` / `SecretMissing` | Database credentials available and connection verified |
| `MessagingReady` | True/False | `Connected` / `ConnectionFailed` | RabbitMQ endpoint reachable |
| `KeystoneAuthReady` | True/False | `CredentialValid` / `CredentialExpired` | Application credential valid |
| `CephConnected` | True/False | `PoolAccessible` / `PoolNotFound` | Ceph RBD pool accessible |
| `OVNConnected` | True/False | `Connected` / `Unreachable` | OVN NB/SB database reachable |
| `ConfigReady` | True/False | `Rendered` / `DependencyNotMet` | Configuration successfully rendered |
| `Ready` | True/False | `AllChecksPass` / `ConfigError` | Overall service readiness |

**Error reporting:** Conditions are visible via `kubectl describe` and can be monitored by Prometheus:

```text
$ kubectl describe nova nova -n openstack
Status:
  Conditions:
    Type:    DatabaseReady
    Status:  False
    Reason:  SecretMissing
    Message: Secret "nova-db-credentials" not found in namespace "openstack"

    Type:    ConfigReady
    Status:  False
    Reason:  DependencyNotMet
    Message: Cannot render config: database credentials unavailable
```

The operator re-checks on every reconciliation cycle. Once the missing secret appears (e.g., ESO syncs from OpenBao), the condition transitions to `True` and config generation proceeds.

## Layer 3: Runtime

After the ConfigMap is mounted and the pod starts, OpenStack's oslo.config library parses the INI file. This is the final validation layer — it catches issues that only manifest at service startup.

**What Layer 3 catches:**

| Check | Description |
| --- | --- |
| **Unknown options** | oslo.config warns about unrecognized config keys (logged, not fatal) |
| **Deprecated options** | oslo.config logs deprecation warnings for renamed/removed options |
| **Connection failures** | Database or messaging connection fails after config is parsed |
| **Permission errors** | Keystone auth fails due to expired/invalid credentials |
| **Missing dependencies** | Required Python modules not available for configured backend |

**Error reporting:** Pod logs and Kubernetes events:

```text
$ kubectl logs nova-api-7f8b9c-x4k2j -n openstack
ERROR oslo_db.sqlalchemy.engines [-] Database connection failed:
  OperationalError: (pymysql.err.OperationalError)
  (2003, "Can't connect to MySQL server on 'maxscale.mariadb-system.svc'")
```

**CrashLoopBackOff detection:** If oslo.config parsing fails fatally (e.g., missing required option, invalid value type), the pod exits with a non-zero code. Kubernetes restarts it, and after repeated failures, the pod enters `CrashLoopBackOff`. This is visible via:

- `kubectl get pods` — pod status shows `CrashLoopBackOff`
- Readiness probe fails — Service endpoints are not updated
- Operator conditions remain `Ready: False`

## oslo-config-validator Integration (Design Concept)

OpenStack provides `oslo-config-validator`, a tool that validates a config file against the service's registered oslo.config options and their metadata (types, ranges, deprecated names). This can catch errors before the service attempts to start.

**Concept: Init container approach**

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Pod                                                                 │
│                                                                      │
│  ┌──────────────────────────────────┐                                │
│  │  Init Container: config-validator│                                │
│  │  Command: oslo-config-validator  │                                │
│  │    --config-file /etc/nova/      │                                │
│  │      nova.conf                   │                                │
│  │                                  │                                │
│  │  Exit 0 → proceed to main        │                                │
│  │  Exit 1 → pod fails, CRB         │                                │
│  └──────────────────┬───────────────┘                                │
│                     │                                                │
│                     ▼ (only if validator passes)                     │
│  ┌──────────────────────────────────┐                                │
│  │  Main Container: nova-api        │                                │
│  │  (starts normally)               │                                │
│  └──────────────────────────────────┘                                │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Trade-offs:**

| Pro | Con |
| --- | --- |
| Catches invalid/deprecated options before service starts | Adds startup latency (oslo-config-validator must load all registered options) |
| Clear error messages in init container logs | Requires the validator tool in the container image |
| Prevents CrashLoopBackOff from config errors | Cannot validate connectivity (only syntax/schema) |

> **Note:** oslo-config-validator integration is a design concept. The current implementation relies on Layers 1-3 described above.

## Validation Flow Timeline

The full validation timeline from `kubectl apply` to a running, healthy service:

```text
kubectl apply
     │
     ▼
┌─────────────┐
│ API Server  │──▶ Schema violation? ──▶ REJECTED (immediate)
│ (Layer 1)   │
└──────┬──────┘
       │ CR persisted to etcd
       ▼
┌─────────────┐
│ Operator    │──▶ Secret missing?    ──▶ Condition: DatabaseReady=False
│ Reconcile   │──▶ Dependency not met?──▶ Condition: ConfigReady=False
│ (Layer 2)   │──▶ All checks pass    ──▶ Render ConfigMap
└──────┬──────┘
       │ ConfigMap created, Deployment updated
       ▼
┌─────────────┐
│ Pod Start   │──▶ oslo.config error? ──▶ CrashLoopBackOff (pod logs)
│ (Layer 3)   │──▶ Connection fail?   ──▶ Readiness probe fails
│             │──▶ All OK             ──▶ Ready
└──────┬──────┘
       │
       ▼
   Service healthy
   Condition: Ready=True
```

## Error Reporting Summary

| Layer | When | Feedback Mechanism | Latency |
| --- | --- | --- | --- |
| **Layer 1: API Server** | On `kubectl apply` | CLI error, API response | Immediate |
| **Layer 2: Operator** | During reconciliation | CR status conditions, events | Seconds |
| **Layer 3: Runtime** | On pod startup | Pod logs, CrashLoopBackOff, readiness probes | Seconds to minutes |
