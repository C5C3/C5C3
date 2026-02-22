# Customization

CobaltCore's CRD-driven configuration approach prioritizes type safety and validation. This page discusses the trade-offs between structured and raw configuration, documents current CRD coverage, and presents design options for configuration overrides. For the config generation pipeline, see [Config Generation](./01-config-generation.md).

## Structured vs Raw

Every configuration system must balance safety against flexibility. C5C3's v1alpha1 CRDs lean toward the structured side — each configurable aspect has a typed CRD field.

| Aspect | Structured (CRD fields) | Raw (INI passthrough) |
| --- | --- | --- |
| **Type Safety** | Enforced by OpenAPI schema | No type checking — any string accepted |
| **Validation** | API server + operator validation (see [Validation](./02-validation.md)) | Only runtime validation (oslo.config) |
| **Documentation** | CRD field descriptions are self-documenting | User must know oslo.config option names |
| **Upgrade Safety** | Operator can migrate field names across releases | Raw INI may reference deprecated options |
| **Flexibility** | Limited to fields the CRD exposes | Full access to any oslo.config option |
| **Discovery** | `kubectl explain nova.spec` shows all fields | User must consult OpenStack docs |

**C5C3's position:** Structured fields for all common configuration, with design provisions for escape hatches when advanced tuning is required.

## Current CRD Coverage

The v1alpha1 CRDs cover the following configuration aspects per service:

| Config Aspect | Keystone | Nova | Neutron | Glance | Cinder | Placement |
| --- | --- | --- | --- | --- | --- | --- |
| **Database** | clusterRef/host | Main + API + Cell0 | clusterRef/host | clusterRef/host | clusterRef/host | clusterRef/host |
| **Messaging** | — | clusterRef/hosts | clusterRef/hosts | — | clusterRef/hosts | — |
| **Keystone Auth** | (self) | appCredentialRef | appCredentialRef | appCredentialRef | appCredentialRef | appCredentialRef |
| **Cache** | Backend, host, port | Backend, host, port | Backend, host, port | Backend, host, port | Backend, host, port | Backend, host, port |
| **Storage Backend** | — | RBD pool, user, secretRef | — | RBD pool, user, secretRef | RBD + multi-backend | — |
| **ML2/Network** | — | — | Type/mechanism drivers, OVN | — | — | — |
| **Image** | Repository, tag | Repository, tag | Repository, tag | Repository, tag | Repository, tag | Repository, tag |
| **Replicas** | Count | API, scheduler, conductor | Count | Count | API, scheduler, volume | Count |

**What is not (yet) CRD-configurable:**

- oslo.log verbosity levels and format
- oslo.policy custom rules
- API rate limiting (`oslo_limit`)
- WSGI worker counts (currently derived from replicas)
- Advanced oslo.messaging tuning (prefetch count, heartbeat)
- Vendor-specific backend options (e.g., NetApp, Pure Storage for Cinder)
- Scheduler filter configuration (e.g., Cinder `scheduler_default_filters`, Nova `enabled_filters`)

## Config Override Design Options

The following options are design concepts for extending configuration beyond CRD fields. They are documented here for architectural completeness. **None of these options are implemented in the current v1alpha1 CRDs.**

### Option A: configOverrides Field

A structured YAML field that maps to INI sections and keys:

```yaml
apiVersion: openstack.c5c3.io/v1alpha1
kind: Nova
metadata:
  name: nova
spec:
  # ... standard CRD fields ...
  configOverrides:
    nova.conf:
      DEFAULT:
        debug: "true"
        api_workers: "8"
      oslo_messaging_rabbit:
        heartbeat_timeout_threshold: "120"
    logging.conf:
      logger_nova:
        level: DEBUG
```

| Pro | Con |
| --- | --- |
| Structured YAML — API server validates the shape | Cannot validate individual oslo.config option names/values at apply time |
| Clear mapping to INI sections | Adds complexity to CRD schema |
| Operator can warn on known-dangerous overrides | Operator must decide merge precedence |

### Option B: Raw INI Passthrough

A string field containing raw INI content, appended after operator-generated config:

```yaml
apiVersion: openstack.c5c3.io/v1alpha1
kind: Nova
metadata:
  name: nova
spec:
  # ... standard CRD fields ...
  customConfig: |
    [DEFAULT]
    debug = true
    api_workers = 8

    [oslo_messaging_rabbit]
    heartbeat_timeout_threshold = 120
```

| Pro | Con |
| --- | --- |
| Maximum flexibility — any oslo.config option | No validation until runtime |
| Familiar to operators who know OpenStack INI files | Can override safety-critical settings |
| Simple to implement | Difficult to audit/diff in GitOps |

### Option C: Config.d Pattern

Operator writes the main `.conf` file. Users provide additional `.conf.d/` files via separate ConfigMaps:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nova-custom-overrides
  namespace: openstack
  labels:
    c5c3.io/config-overlay: nova
data:
  99-custom.conf: |
    [DEFAULT]
    debug = true
    api_workers = 8
```

The operator mounts both:
- `/etc/nova/nova.conf` — operator-generated (from CRD)
- `/etc/nova/nova.conf.d/99-custom.conf` — user-provided

oslo.config reads `.conf.d/` files after the main config, so user values take precedence for duplicated keys.

| Pro | Con |
| --- | --- |
| Clean separation between operator-managed and user-managed config | Requires oslo.config `--config-dir` support (all OpenStack services support this) |
| User ConfigMap is independently versioned in GitOps | Merge semantics less obvious (last-file-wins per option) |
| Operator-managed settings cannot be accidentally overridden if listed as `immutable` | Additional ConfigMap to manage |

### Recommended Approach

The following is a design recommendation, not a committed implementation plan. A combination is likely optimal:

1. **Operator-managed, safety-critical settings** (connection strings, auth, secret paths) are always generated from CRD fields and cannot be overridden
2. **Tuning parameters** (worker counts, timeouts, debug flags) can be overridden via `configOverrides` (Option A) or `.conf.d/` (Option C)
3. **Last-resort raw INI** (Option B) exists for scenarios where no CRD field or override path covers the needed option

The operator should log warnings when overrides conflict with operator-generated values and reject overrides to known-dangerous settings (e.g., overriding `connection` to point at a different database).

## Interaction with Container Image Patching

Some configuration needs can be addressed either through config overrides or through container image patching. Choosing the right mechanism matters:

| Need | Config Override | Image Patch |
| --- | --- | --- |
| Tune a timeout or worker count | Config override (fast, no rebuild) | Not appropriate |
| Enable a debug flag | Config override | Not appropriate |
| Fix a bug in OpenStack code | Not possible via config | Image patch (see [Patching](../../08-container-images/03-patching.md)) |
| Add a custom oslo.policy rule | Config override (policy.yaml) | Not appropriate |
| Add a vendor driver/plugin | Not possible via config | Image patch (add dependency) |

**Rule of thumb:** If the change is a runtime setting that oslo.config reads, use a config override. If the change requires modifying Python code or adding packages, use image patching.

## Per-Service Configuration Patterns

### Neutron ML2: Deep CRD Configuration

Neutron's ML2 plugin has a complex configuration surface. The CRD exposes it as a nested structure:

```yaml
spec:
  ml2:
    typeDrivers:
      - geneve
      - flat
    mechanismDrivers:
      - ovn
    tenantNetworkTypes:
      - geneve
    ovn:
      ovnNbConnection: tcp:ovn-nb.ovn-system.svc:6641
      ovnSbConnection: tcp:ovn-sb.ovn-system.svc:6642
```

This maps directly to `[ml2]` and `[ovn]` sections in `ml2_conf.ini`. The operator validates that mechanism drivers match the configured type drivers (e.g., `ovn` requires `geneve`). For the full Neutron CRD-to-INI mapping, see [Config Generation — Neutron](./01-config-generation.md#neutron-crd-to-neutronconf--ml2_confini).

### Cinder: Dynamic Backend Generation

Cinder supports multiple storage backends, each with its own configuration section. The CRD models this as a list:

```yaml
spec:
  backends:
    - name: rbd-ssd
      backend: rbd
      rbdPool: volumes-ssd
      rbdUser: cinder
      cephSecretRef:
        name: ceph-client-cinder
    - name: rbd-hdd
      backend: rbd
      rbdPool: volumes-hdd
      rbdUser: cinder
      cephSecretRef:
        name: ceph-client-cinder
```

The operator generates a `[rbd-ssd]` and `[rbd-hdd]` section in `cinder.conf`, plus sets `enabled_backends = rbd-ssd,rbd-hdd` in `[DEFAULT]`. Adding or removing a backend triggers a new ConfigMap and rolling restart.
