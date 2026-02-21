# Service Configuration

CobaltCore manages OpenStack service configurations — files like `nova.conf`, `keystone.conf`, and `neutron.conf` — entirely through the operator reconciliation loop. CRD fields are the primary interface for expressing configuration intent. Operators translate these structured fields into INI config files, assemble them into Kubernetes ConfigMaps, and mount them into service pods.

This section documents how configuration is generated, validated, customized, and how C5C3's approach compares to other OpenStack deployment tools.

## Design Principles

| Principle | Description |
| --- | --- |
| **Structured over Raw** | CRD fields provide typed, validated configuration instead of raw INI strings |
| **Secrets Separated** | Credentials never appear in CRDs or ConfigMaps — they flow through OpenBao and ESO (see [Secret Management](../13-secret-management.md)) |
| **Immutable ConfigMaps** | Each config change produces a new hash-named ConfigMap, enabling clean rollbacks and triggering rolling restarts |
| **Operator-Owned Defaults** | Sensible per-release defaults are embedded in operator code — operators know which defaults are appropriate for each OpenStack release |
| **Escape Hatches Available** | Design provisions exist for config overrides beyond CRD fields (see [Customization](./03-customization.md)) |

## Configuration Flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CONFIGURATION FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐                                                           │
│  │ ControlPlane │  User / GitOps applies ControlPlane CR                    │
│  │ CR           │  (desired OpenStack release, service settings)            │
│  └──────┬───────┘                                                           │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────┐                                                           │
│  │ c5c3-operator│  Creates / updates per-service CRs                        │
│  │              │  (Nova CR, Keystone CR, Neutron CR, ...)                  │
│  └──────┬───────┘                                                           │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Service Operator (e.g. nova-operator)                                │   │
│  │                                                                      │   │
│  │  1. Read CRD spec fields (database, messaging, keystone, cache, ..)  │   │
│  │  2. Read referenced K8s Secrets (credentials from ESO/OpenBao)       │   │
│  │  3. Merge with operator-embedded defaults for the target release     │   │
│  │  4. Render INI config file(s) from structured data                   │   │
│  │  5. Create ConfigMap with content-hash name                          │   │
│  │  6. Update Deployment/DaemonSet to reference new ConfigMap           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Pod                                                                  │   │
│  │  /etc/<service>/<service>.conf  ◀── volume mount from ConfigMap      │   │
│  │  Secrets mounted separately (TLS certs, Ceph keys)                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Comparison Summary

| Aspect | C5C3 | YAOOK | Kolla-Ansible | Red Hat K8s Operators | Atmosphere |
| --- | --- | --- | --- | --- | --- |
| **Config Source** | CRD fields (typed) | CUE layers | globals.yml + Jinja2 | CRD fields + customServiceConfig | Helm values |
| **Config Language** | Go templates (operator) | CUE | Jinja2 + INI merge | Go templates | Go templates (OpenStack-Helm) |
| **Validation** | OpenAPI schema + operator checks | CUE schema + metadata | oslo-config-validator | OpenAPI + CEL | Implicit (template logic) |
| **Secret Handling** | OpenBao + ESO (fully separated) | SecretInjectionLayer | ansible-vault + merge | K8s Secrets in CRD refs | K8s Secrets |
| **Custom Config** | Structured CRD (raw override planned) | CUE merging (open) | globals.yml + overrides | customServiceConfig (raw INI) | Helm value overrides |
| **Update Strategy** | Immutable ConfigMap + rolling restart | Immutable Secrets + reconcile | Reconfigure playbook | ConfigMap + rolling restart | Helm upgrade |

For a deep comparison, see [Configuration Landscape](./04-landscape.md).

## Further Reading

- [Config Generation](./01-config-generation.md) — CRD-to-INI pipeline, ConfigMap structure, secret injection
- [Validation](./02-validation.md) — Three validation layers (API Server, Operator, Runtime)
- [Customization](./03-customization.md) — Structured vs raw trade-off, override design options
- [Configuration Landscape](./04-landscape.md) — Deep comparison with YAOOK, Kolla, Red Hat K8s Operators, Atmosphere, ConfigHub
