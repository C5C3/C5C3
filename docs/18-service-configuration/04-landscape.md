# Configuration Landscape

This page compares CobaltCore's configuration approach with four major OpenStack deployment tools and one general-purpose configuration management platform. The goal is to document architectural trade-offs and explain which ideas C5C3 adopts, adapts, or avoids.

## Challenge Framework

Any OpenStack configuration system must address these challenges:

| Challenge | Description |
| --- | --- |
| **Config Generation** | How are INI config files produced from higher-level input? |
| **Secret Management** | How are credentials injected without exposing them in source control? |
| **Validation** | When and how are configuration errors detected? |
| **Customization** | How do operators apply site-specific or tuning overrides? |
| **Multi-Node Config** | How do per-node differences (IP addresses, host names) get handled? |
| **Config Drift** | How is divergence between desired and actual configuration detected? |
| **Upgrade Migration** | How does configuration change when upgrading OpenStack releases? |

***

## YAOOK

[YAOOK](https://yaook.cloud/) (Yet Another OpenStack on Kubernetes) is developed within the [ALASCA](https://alasca.cloud) ecosystem. It uses **CUE** as its configuration language and defines a layered architecture for config generation.

### YAOOK Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       YAOOK CONFIG ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CUE Source Layers (merged via CUE unification):                            │
│                                                                             │
│  ┌─────────────────┐                                                        │
│  │ SpecLayer       │  User-facing: desired service config                   │
│  │ (from CR spec)  │  e.g. database host, replicas, cache                   │
│  └────────┬────────┘                                                        │
│           │ unify                                                           │
│  ┌────────▼────────┐                                                        │
│  │ SecretInjection │  Injects credentials from K8s Secrets                  │
│  │ Layer           │  into config data structures                           │
│  └────────┬────────┘                                                        │
│           │ unify                                                           │
│  ┌────────▼────────┐                                                        │
│  │ ConfigSecret    │  Final merged config → K8s Secret                      │
│  │ Layer           │  (not ConfigMap — YAOOK stores config in Secrets)      │
│  └────────┬────────┘                                                        │
│           │                                                                 │
│           ▼                                                                 │
│  K8s Secret (immutable, copy-on-write)                                      │
│  Mounted into pod as /etc/<service>/<service>.conf                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### YAOOK Characteristics

| Aspect | Detail |
| --- | --- |
| **Config language** | CUE — a constraint-based data language. Merging is commutative and conflict-rejecting (if two layers set the same field to different values, it is an error, not a silent override) |
| **Config storage** | Kubernetes Secrets (not ConfigMaps) — enables treating config as sensitive data |
| **Immutability** | Copy-on-write: a config change creates a new K8s Secret, old one is retained for rollback |
| **Per-node config** | `configTemplates` with Go template expressions evaluated per node |
| **Validation** | CUE schema validation + metadata-derived checks from oslo.config option definitions |
| **Operators** | State-machine-based Python operators (not reconciliation-loop style) |

### YAOOK Strengths and Limitations

| Strengths | Limitations |
| --- | --- |
| CUE unification prevents silent override conflicts | CUE has a steep learning curve |
| Immutable Secrets with history enable reliable rollback | State-machine operators are more complex than reconciliation loops |
| Config-as-Secret treats all config as potentially sensitive | Smaller community and ecosystem compared to Helm-based approaches |

***

## Kolla-Ansible

[Kolla-Ansible](https://docs.openstack.org/kolla-ansible/) is the most widely deployed OpenStack lifecycle management tool. It uses **Ansible + Jinja2 templates** for configuration and **INI merge** for combining configuration layers.

### Kolla-Ansible Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    KOLLA-ANSIBLE CONFIG ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Configuration Hierarchy (last-write-wins):                                 │
│                                                                             │
│  ┌──────────────────┐                                                       │
│  │ globals.yml      │  Site-wide settings (IPs, passwords, features)        │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│  ┌────────▼─────────┐                                                       │
│  │ Jinja2 Templates │  Per-service .conf.j2 templates                       │
│  │ (per service)    │  Reference globals.yml variables                      │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│  ┌────────▼─────────┐                                                       │
│  │ INI Merge        │  merge_configs.py (Python ConfigParser)               │
│  │                  │  Merges: base template + globals overrides            │
│  │                  │        + host-specific overrides                      │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  Final .conf file deployed to /etc/kolla/<service>/                         │
│  via Docker volume mount or file copy                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Kolla-Ansible Characteristics

| Aspect | Detail |
| --- | --- |
| **Config language** | Jinja2 templates rendering INI files |
| **Merge strategy** | Python ConfigParser merge — last-write-wins. If multiple sources set the same key, the last one applied wins silently |
| **Override hierarchy** | `globals.yml` → service-specific variables → host-specific overrides → `<service>.conf` manual overrides |
| **Validation** | `kolla-ansible validate-config` runs `oslo-config-validator` against rendered configs (post-render check) |
| **Secret handling** | `ansible-vault` encrypted variables in `passwords.yml`, decrypted at deploy time and merged into templates |
| **Config strategy** | `KOLLA_CONFIG_STRATEGY` — `COPY_ALWAYS` (overwrite on deploy) or `COPY_ONCE` (keep manual changes) |

### Kolla-Ansible Strengths and Limitations

| Strengths | Limitations |
| --- | --- |
| Mature, widely deployed, battle-tested | Jinja2 + INI merge is error-prone (silent overrides, whitespace issues) |
| `oslo-config-validator` integration for post-render validation | No declarative desired-state — Ansible is imperative |
| Flexible override hierarchy for multi-environment | Config drift between runs is possible with `COPY_ONCE` |
| Large community and documentation | Not Kubernetes-native — requires separate adoption of K8s patterns |

***

## OpenStack K8s Operators (Red Hat)

[OpenStack K8s Operators](https://github.com/openstack-k8s-operators) are Red Hat's Kubernetes-native approach, developed for RHOSO (Red Hat OpenStack Services on OpenShift). Each service has a Go-based operator with CRD-driven configuration.

### Red Hat Architecture

The architecture uses a **CRD fields + customServiceConfig** pattern:

```yaml
apiVersion: nova.openstack.org/v1beta1
kind: Nova
metadata:
  name: nova
spec:
  # Structured CRD fields for common settings
  apiDatabaseInstance: openstack
  cellDatabaseInstance: openstack
  keystoneInstance: keystone

  # Raw INI passthrough for anything not covered by CRD fields
  customServiceConfig: |
    [DEFAULT]
    debug = true
    api_workers = 8
```

### Red Hat Characteristics

| Aspect | Detail |
| --- | --- |
| **Config language** | Go templates inside operators |
| **CRD fields** | Typed fields for common settings (database, keystoneInstance, transport) |
| **Raw escape hatch** | `customServiceConfig` — raw INI string appended after operator-generated config |
| **Merge pattern** | `.conf.d/` directory: operator writes `00-config.conf`, user `customServiceConfig` becomes `01-custom.conf`. oslo.config reads both, last-file-wins per option |
| **Validation** | OpenAPI v3.0 schema for CRD fields + CEL validation rules |
| **Secret handling** | K8s Secrets referenced in CRD fields, created by operators or external tools |
| **Migration tool** | `os-diff` — compares TripleO (legacy) configs with operator-generated configs to assist migration |

### Red Hat Strengths and Limitations

| Strengths | Limitations |
| --- | --- |
| CRD fields provide typed, validated config for common settings | `customServiceConfig` bypasses all validation (raw INI) |
| `.conf.d/` pattern cleanly separates operator and user config | Operators must maintain CRD field parity with upstream config options |
| CEL validation rules enable cross-field checks in the CRD | Complex multi-operator dependency graph |
| `os-diff` tool eases migration from TripleO | Tightly coupled to OpenShift platform |

***

## Vexxhost Atmosphere

[Atmosphere](https://github.com/vexxhost/atmosphere) is Vexxhost's opinionated OpenStack distribution built on **Helm charts** (primarily OpenStack-Helm) with Ansible orchestration.

### Atmosphere Characteristics

| Aspect | Detail |
| --- | --- |
| **Config language** | Go templates (via Helm / OpenStack-Helm charts) |
| **Config source** | Helm `values.yaml` — service configuration is expressed as Helm values |
| **Merge strategy** | Helm value merging (deep merge of YAML). OpenStack-Helm charts have a `conf:` section that maps to INI config |
| **Validation** | Implicit — template logic checks some conditions, but no explicit schema validation |
| **Secret handling** | K8s Secrets generated by Helm charts or Ansible |
| **Override pattern** | Helm value overrides (`--set`, `-f custom-values.yaml`) |
| **Deployment** | Ansible orchestrates Helm deployments in dependency order |

**Helm values to INI mapping (OpenStack-Helm pattern):**

```yaml
# values.yaml
conf:
  nova:
    DEFAULT:
      debug: true
      api_workers: 8
    database:
      connection: mysql+pymysql://nova:password@mariadb/nova
```

The Helm chart template iterates over the `conf.nova` map and renders it as an INI file.

### Atmosphere Strengths and Limitations

| Strengths | Limitations |
| --- | --- |
| Leverages established OpenStack-Helm charts | No typed config validation — any YAML key is accepted in `conf:` |
| Familiar Helm workflow for Kubernetes operators | Ansible + Helm layering adds complexity |
| Actively maintained with regular upstream tracking | Config errors only surface at runtime |
| Supports multiple Linux distributions | Less opinionated about secret management |

***

## ConfigHub

[ConfigHub](https://www.confighub.com/) is a SaaS configuration management platform (not specific to OpenStack) that treats **Configuration as Data**. It is included here not as a deployment tool but as an informative conceptual comparison.

### ConfigHub Characteristics

| Aspect | Detail |
| --- | --- |
| **Config source** | Structured YAML/JSON stored in a centralized data store |
| **Validation** | JSON Schema + custom validation functions |
| **Secret handling** | External — workers pull secrets at deploy time |
| **Revision history** | Full version history of all configuration changes |
| **Distribution** | Workers on target hosts pull configuration from the central store |

### Relevance to C5C3

ConfigHub's model has conceptual parallels to CobaltCore:

| ConfigHub Concept | C5C3 Equivalent |
| --- | --- |
| Structured data store | CRDs in etcd (typed fields) |
| JSON Schema validation | OpenAPI v3.0 CRD schema |
| Revision history | GitOps (FluxCD) version history |
| Workers pull config | Operators reconcile and generate ConfigMaps |
| Centralized secret store | OpenBao (centralized, versioned) |

The "Configuration as Data" principle — that configuration should be structured, validated, versioned, and distributed through a well-defined pipeline — is the philosophical foundation of C5C3's CRD-driven approach.

***

## Comprehensive Comparison

| Challenge | C5C3 | YAOOK | Kolla-Ansible | Red Hat K8s Operators | Atmosphere |
| --- | --- | --- | --- | --- | --- |
| **Config Generation** | Go operator renders from CRD fields | CUE unification of layers | Jinja2 templates + INI merge | Go operator + customServiceConfig | Helm/Go templates |
| **Secret Management** | OpenBao + ESO (fully separated) | SecretInjectionLayer (CUE) | ansible-vault (merged at deploy) | K8s Secrets (CRD refs) | K8s Secrets (Helm) |
| **Validation** | OpenAPI + operator checks + runtime | CUE schema + metadata-derived | oslo-config-validator (post-render) | OpenAPI + CEL + runtime | Implicit (template logic) |
| **Customization** | Structured CRD (override planned) | CUE merging (open, composable) | globals.yml + file overrides | customServiceConfig (raw INI) | Helm value overrides |
| **Multi-Node Config** | Env vars (Downward API) + shared ConfigMap | configTemplates (Go templates per node) | Host-specific vars in inventory | Per-node CRs or DaemonSet env | Helm per-node values |
| **Config Drift** | GitOps + operator reconciliation (continuous) | Operator reconciliation | Only on playbook re-run | Operator reconciliation | Helm diff on upgrade |
| **Upgrade Migration** | Operator embeds per-release defaults | CUE schema per release | Template changes per release | Operator + `os-diff` tool | Chart updates per release |

***

## What C5C3 Adopts

| Source | Adopted Concept | C5C3 Implementation |
| --- | --- | --- |
| **YAOOK** | Immutable config artifacts | Hash-named ConfigMaps (new config = new ConfigMap, old retained for rollback) |
| **YAOOK** | Schema awareness from oslo.config metadata | Operator-embedded defaults derived from upstream oslo.config option definitions |
| **Red Hat K8s Operators** | CRD-driven, typed fields | v1alpha1 CRDs with OpenAPI schema for all service configuration |
| **Red Hat K8s Operators** | Per-service Go operators | Independent operator per OpenStack service (keystone-operator, nova-operator, ...) |
| **oslo ecosystem** | Metadata-driven config schemas | Operators know valid options, types, and defaults from oslo.config metadata |
| **ConfigHub** | "Configuration as Data" principle | CRDs as structured, validated, versioned configuration stored in etcd |

## What C5C3 Does Differently

| Difference | Detail |
| --- | --- |
| **Go operators (not CUE/Jinja2/Helm)** | Config rendering is Go code inside operators — no external template language. This keeps the rendering logic close to the reconciliation logic and avoids template debugging |
| **Secrets fully separated via OpenBao + ESO** | Unlike YAOOK (config-in-Secrets), Kolla (vault-merged), or Red Hat (Secrets-in-CRD-refs), C5C3 stores all secrets in OpenBao and syncs them via ESO. Operators read K8s Secrets but never manage credential lifecycle |
| **Structured-first (no raw INI passthrough in v1alpha1)** | Unlike Red Hat's `customServiceConfig`, C5C3 v1alpha1 does not include a raw INI escape hatch. All configuration goes through typed CRD fields. Override mechanisms are a planned extension (see [Customization](./03-customization.md)) |
| **ConfigMap-based (not Secret-based)** | Unlike YAOOK which stores config in K8s Secrets, C5C3 uses ConfigMaps for non-sensitive configuration. Credentials flow separately through the ESO secret pipeline |
| **Single operator per service** | Each service has exactly one operator. No meta-operators, no shared controller runtime, no operator-of-operators pattern. The c5c3-operator handles orchestration but does not generate service configs |
