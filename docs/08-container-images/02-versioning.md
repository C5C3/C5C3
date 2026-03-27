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

Refs are configured per component and per OpenStack release in `releases/<version>/source-refs.yaml`. The current file only contains the services that are in the build matrix — additional services and library entries are added as they are onboarded:

```yaml
# releases/2025.2/source-refs.yaml (current state)
keystone: "28.0.0"    # tag
```

As additional services are added to the build matrix, they are listed here:

```yaml
# releases/2025.2/source-refs.yaml (future state, illustrative)

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

### Service Images

Each service image build produces three tags:

| Tag | Example | Property | Usage |
| --- | --- | --- | --- |
| **Composite** | `28.0.0-p0-main-a1b2c3d` | Immutable | Primary identifier — always pushed. Encodes version, patch count, branch, and commit SHA |
| **Upstream version** | `28.0.0` | Mutable | Pushed on `main` branch only. Used in CRD image references |
| **Short SHA** | `a1b2c3d` | Immutable | Always pushed. Useful for debugging |
| **Digest** | `sha256:abc123...` | Immutable | Maximum reproducibility |

**Composite tag format:** `<version>-p<patch-count>-<branch>-<short-sha>`

- `<version>` — the source ref from `source-refs.yaml` (e.g. `28.0.0`)
- `<patch-count>` — number of `.patch` files in `patches/<service>/<release>/` (e.g. `p0` when no patches are active)
- `<branch>` — the C5C3 branch with `/` replaced by `-` (e.g. `main`, `stable-1-0`)
- `<short-sha>` — first 7 characters of the commit SHA

**The upstream version tag** (e.g. `keystone:28.0.0`) is restricted to the `main` branch to prevent silent overwrites across branches. Builds from `stable/**` branches are identifiable via the composite tag's branch component.

```text
# Examples for a Keystone build from main with 0 patches:
ghcr.io/c5c3/keystone:28.0.0-p0-main-a1b2c3d   ← composite (immutable)
ghcr.io/c5c3/keystone:28.0.0                    ← version (main only, mutable)
ghcr.io/c5c3/keystone:a1b2c3d                   ← short SHA (immutable)

# After adding one patch:
ghcr.io/c5c3/keystone:28.0.0-p1-main-b2c3d4e   ← composite reflects patch count
ghcr.io/c5c3/keystone:28.0.0                    ← updated to point to patched build
```

### Base Images

Base images (`python-base`, `venv-builder`) use a simpler tag scheme:

| Tag | Example | Property |
| --- | --- | --- |
| `latest` | `python-base:latest` | Mutable |
| `<commit-sha>` | `python-base:abc123...` (full SHA) | Immutable |

## Adding a New OpenStack Release

Currently only `releases/2025.2/` is configured. When a new OpenStack release is published (e.g., 2026.1), it is added to the existing C5C3 branch:

1. **Add constraints**: Create `releases/2026.1/upper-constraints.txt` from `openstack/requirements` branch `stable/2026.1`
2. **Add source refs**: Create `releases/2026.1/source-refs.yaml` with refs for each service
3. **Add extra packages**: Create `releases/2026.1/extra-packages.yaml` with per-service pip extras and apt packages
4. **Add to build matrix**: Include `"2026.1"` in the `release` matrix (see [Build Pipeline — Workflow](./01-build-pipeline.md#workflow))
5. **Create patch directories**: Add empty `patches/<service>/2026.1/` directories if needed
6. **Build & test**: CI builds all images, Tempest tests run
7. **Update CRDs**: Image tags in the ControlPlane/Service CRDs for new deployments (see [CRDs](../04-architecture/01-crds.md))

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
│  3. Add extra packages                                         │
│     # Create releases/2026.1/extra-packages.yaml               │
│     # with pip_extras, pip_packages, apt_packages per service  │
│                                                                │
│  4. Add to build matrix                                        │
│     release: ["2026.1", "2025.2"]                              │
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
2. Remove `releases/<version>/` directory (upper-constraints.txt, source-refs.yaml, extra-packages.yaml)
3. Remove `patches/<service>/<version>/` directories
4. Remove `overrides/<version>/constraints.txt` if present

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
