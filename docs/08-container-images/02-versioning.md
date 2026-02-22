# Versioning

C5C3 has its own version scheme and branch model, independent of OpenStack releases. A single C5C3 branch can build and manage images for multiple OpenStack releases simultaneously.

## Branch Strategy

```text
┌─────────────────────────────────────────────────────────────────┐
│                       Branch Model                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  C5C3 Branches              Managed OpenStack Releases          │
│  ──────────────              ─────────────────────────          │
│                                                                 │
│  main ─────────────▶        2025.2 (Flamingo)                   │
│    │  Development            2025.1 (Epoxy)                     │
│    │                                                            │
│    ├── stable/1.0 ─▶        2025.2 (Flamingo)                   │
│    │  Production             2025.1 (Epoxy)                     │
│    │                         2024.2 (Dalmatian)                 │
│    │                                                            │
│    └── stable/2.0 ─▶        2026.1 (next release)               │
│       Future                 2025.2 (Flamingo)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key difference from other approaches:** C5C3 branches are **not** mapped 1:1 to OpenStack releases. A production branch like `stable/1.0` can carry Dockerfiles, patches, and constraints for multiple OpenStack releases at the same time. This allows operators to manage upgrades and multi-version deployments from a single C5C3 branch.

Each C5C3 branch contains:
- **Dockerfiles** that are release-independent (inputs come via build contexts)
- **`releases/<version>/upper-constraints.txt`** for each managed OpenStack release
- **`patches/<component>/<release>/`** with release-specific patches (see [Patching](./03-patching.md))
- **`overrides/<release>/constraints.txt`** with release-specific constraint overrides (see [Constraint Overrides](./03-patching.md#level-3-constraint-overrides))
- **`releases/<version>/source-refs.yaml`** with pinned source references per component and release

## Source References

Each component (OpenStack service or library) is referenced via a git ref in the CI workflow (see [Build Pipeline — GitHub Actions Workflow](./01-build-pipeline.md#github-actions-workflow)). A ref can be a **branch**, a **tag**, or a **commit SHA** — the choice depends on the use case:

| Reference type | Example | Trade-off |
| --- | --- | --- |
| **Commit SHA** | `a1b2c3d4e5f6...` | Maximum reproducibility — same input always produces the same image. No unexpected changes. |
| **Tag** | `28.0.0` | Reproducible and human-readable. Tied to a specific upstream release. |
| **Branch** | `stable/2025.2` | Always builds the latest state of the branch. Useful for tracking upstream fixes automatically, but builds are not reproducible across time. |

All three types work identically in the CI pipeline — `git checkout` handles branches, tags, and SHAs transparently. The ref type is a per-component, per-release decision.

### Configuration

Refs are configured per component and per OpenStack release in `releases/<version>/source-refs.yaml`:

```yaml
# releases/2025.2/source-refs.yaml

# Services
keystone: "28.0.0"                                            # tag
nova: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"             # commit SHA
neutron: "stable/2025.2"                                      # branch
glance: "31.0.0"                                              # tag
cinder: "27.0.0"                                              # tag
placement: "14.0.0"                                           # tag

# Libraries (only entries needed when patches are active)
keystonemiddleware: "stable/2025.2"                           # branch
oslo.messaging: "14.9.0"                                      # tag
```

This file is the single source of truth for what version of each component is built for a given OpenStack release. The same ref format applies uniformly to OpenStack services and libraries — the CI pipeline reads the ref via `yq`, checks out the repository, applies release-specific patches if present, and passes the source as a build context. Adding a new component is a one-line addition.

### Choosing a Reference Type

- **Commit SHA** is recommended for production when maximum reproducibility is required. Renovate Bot can automatically track and update SHAs (see [Automated Dependency Updates](#automated-dependency-updates-renovate)).
- **Tag** is useful when building against a specific upstream release (e.g., `28.0.0`). Tags are immutable and human-readable but may not include post-release fixes.
- **Branch** is useful during development or when you want to automatically pick up upstream fixes on the stable branch. Builds from branches are not exactly reproducible since new commits appear over time.

## Tag Schema

Each image receives multiple tags. Since C5C3 builds images for multiple OpenStack releases, the upstream version already identifies the release (e.g., Keystone 28.0.0 belongs to 2025.2, Keystone 27.0.0 to 2025.1):

| Tag | Example | Property | Usage |
| --- | --- | --- | --- |
| **Upstream version** | `28.0.0` | Mutable (updated on patch revision) | CRD reference, default tag |
| **Version + patch revision** | `28.0.0-p1` | Immutable | When patches are applied to a release (see [Patching](./03-patching.md)) |
| **Branch** | `stable-1.0` | Mutable (points to latest build) | Tracking, not for production |
| **Commit SHA** | `a1b2c3d` | Immutable | Debugging, exact reference |
| **Digest** | `sha256:abc123...` | Immutable | Maximum reproducibility |

**Patch revision (`-pN`):**

When patches are applied to an existing release (e.g., a bugfix backport on Keystone 28.0.0), the patch revision is incremented:

```text
ghcr.io/c5c3/keystone:28.0.0      ← Original release
ghcr.io/c5c3/keystone:28.0.0-p1   ← With one C5C3 patch
ghcr.io/c5c3/keystone:28.0.0-p2   ← With two C5C3 patches
```

The `28.0.0` tag is updated to point to the latest patch level, so existing deployments automatically receive the patches on the next pull.

## Adding a New OpenStack Release

When a new OpenStack release is published (e.g., 2026.1), it is added to the existing C5C3 branch:

1. **Add constraints**: Create `releases/2026.1/upper-constraints.txt` from `openstack/requirements` branch `stable/2026.1`
2. **Add source refs**: Create `releases/2026.1/source-refs.yaml` with refs for each service
3. **Add to build matrix**: Include `"2026.1"` in the `release` matrix (see [Build Pipeline — Workflow](./01-build-pipeline.md#workflow))
4. **Create patch directories**: Add empty `patches/<service>/2026.1/` directories
5. **Build & test**: CI builds all images, Tempest tests run
6. **Update CRDs**: Image tags in the ControlPlane/Service CRDs for new deployments (see [CRDs](../04-architecture/01-crds.md))

```text
┌────────────────────────────────────────────────────────────────┐
│               Adding a New OpenStack Release                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  1. Add constraints                                            │
│     mkdir releases/2026.1                                      │
│     curl -o releases/2026.1/upper-constraints.txt \            │
│       https://releases.openstack.org/.../upper-constraints.txt │
│                                                                │
│  2. Add source refs                                            │
│     # Create releases/2026.1/source-refs.yaml with refs        │
│                                                                │
│  3. Add to build matrix                                        │
│     release: ["2026.1", "2025.2", "2025.1"]                    │
│                                                                │
│  4. Create patch directories                                   │
│     mkdir -p patches/{keystone,nova,...}/2026.1                 │
│                                                                │
│  5. Build & test                                               │
│     # CI builds all images, Tempest tests run                  │
│                                                                │
│  6. Update CRDs                                                │
│     image.tag: "28.0.0" → "29.0.0"                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Removing an OpenStack Release

When an OpenStack release reaches end-of-life:

1. Remove from the build matrix
2. Remove `releases/<version>/upper-constraints.txt`
3. Remove `patches/<service>/<version>/` directories
4. Remove `overrides/<version>/constraints.txt`
5. Remove `releases/<version>/source-refs.yaml`

## Automated Dependency Updates (Renovate)

Renovate Bot automatically tracks updates per OpenStack release:

| What | How | Auto-merge |
| --- | --- | --- |
| **Upstream commit SHAs** | Custom regex manager on `source-refs.yaml` files | Yes (after CI success) |
| **Base image digests** | Docker digest pinning in Dockerfiles | Yes |
| **Python package versions** | PyPI version tracking | No (review required) |
| **GitHub Actions versions** | Standard Renovate manager | Yes |

**Renovate configuration (excerpt):**

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "customManagers": [
    {
      "customType": "regex",
      "fileMatch": ["releases/.*/source-refs\\.yaml$"],
      "matchStrings": [
        "(?<depName>[\\w.-]+):\\s*\"(?<currentDigest>[a-f0-9]{40})\"\\s*#\\s*(?<currentValue>stable/\\S+|master)"
      ],
      "datasourceTemplate": "git-refs",
      "packageNameTemplate": "https://opendev.org/openstack/{{{depName}}}"
    }
  ],
  "packageRules": [
    {
      "matchManagers": ["custom.regex"],
      "automerge": true,
      "groupName": "OpenStack upstream refs"
    },
    {
      "matchManagers": ["dockerfile"],
      "matchUpdateTypes": ["digest"],
      "automerge": true,
      "groupName": "Base image digests"
    }
  ]
}
```
