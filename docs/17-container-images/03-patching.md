# Patching

CobaltCore supports three patch levels to quickly apply changes to OpenStack services and their dependencies without requiring repository forks. Patches are organized per OpenStack release, so a single C5C3 branch can carry patches for multiple releases simultaneously.

## Patch Levels

```text
┌─────────────────────────────────────────────────────────────────┐
│                      Three Patch Levels                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Level 1: Service Patches                                       │
│  ────────────────────────                                       │
│  patches/<service>/<release>/*.patch                            │
│  → Patches on the OpenStack service code                        │
│  → Bugfixes, security fixes, cherry-picks                       │
│  → Applied via: git apply                                       │
│                                                                 │
│  Level 2: Library Patches                                       │
│  ────────────────────────                                       │
│  patches/<library>/<release>/*.patch                            │
│  → Patches on Python dependencies                               │
│  → e.g., oslo.messaging, python-novaclient, keystoneauth1       │
│  → Applied via: git apply on checked-out library code           │
│                                                                 │
│  Level 3: Constraint Overrides                                  │
│  ────────────────────────────                                   │
│  overrides/<release>/constraints.txt                            │
│  → Overrides version pins from upper-constraints.txt            │
│  → e.g., newer cryptography version, patched library            │
│  → Applied via: sed on upper-constraints.txt before build       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Level 1: Service Patches

Service patches are fixes directly on the OpenStack service code (e.g., Nova, Neutron, Keystone).

### Directory Structure

Patches are grouped by service and then by OpenStack release branch:

```text
patches/
├── nova/
│   ├── 2025.2/
│   │   ├── 0001-fix-live-migration-timeout-handling.patch
│   │   └── 0002-add-missing-qemu-img-format-check.patch
│   └── 2025.1/
│       └── 0001-fix-parallel-live-migration.patch
├── neutron/
│   ├── 2025.2/
│   │   ├── 0001-fix-ovn-mtu-in-external-ids.patch
│   │   └── 0002-fix-ha-chassis-group-assignment.patch
│   └── 2025.1/
├── cinder/
│   └── 2025.2/
│       └── 0001-fix-rbd-direct-import-for-encrypted-volumes.patch
├── keystone/
│   └── 2025.2/
├── glance/
│   └── 2025.2/
└── placement/
    └── 2025.2/
```

Empty directories (e.g., `keystone/2025.2/`) indicate that no patches are active for that release. Patches are applied in alphabetical order (`0001-*`, `0002-*`, ...).

A patch may exist for one release but not another — a fix that is needed in 2025.1 may already be merged upstream in 2025.2. This per-release organization prevents applying irrelevant patches.

### Creating a Patch

Check out the upstream repo at the same ref that is configured in the CI workflow (see [Source References](./02-versioning.md#source-references)) — this can be a branch, tag, or commit SHA:

```bash
# 1. Check out the OpenStack repo at the configured ref
git clone https://opendev.org/openstack/nova
cd nova
git checkout stable/2025.2          # or: 32.1.0 (tag) or a1b2c3d... (SHA)

# 2. Implement the fix
vim nova/compute/manager.py

# 3. Create a commit
git add -A
git commit -m "fix: handle live migration timeout correctly

When a live migration exceeds the configured timeout, the migration
should be aborted gracefully instead of leaving the instance in ERROR.

Closes-Bug: #2099999"

# 4. Export the patch into the release-specific directory
git format-patch -1 HEAD -o /path/to/c5c3/patches/nova/2025.2/

# 5. Verify the patch applies cleanly
git stash && git apply --check /path/to/c5c3/patches/nova/2025.2/0001-*.patch

# Result: patches/nova/2025.2/0001-fix-handle-live-migration-timeout-correctly.patch
```

### Patch Format

Patches are stored in `git format-patch` format. This includes commit metadata (author, date, message) and enables proper attribution:

```diff
From a1b2c3d4e5f6 Mon Sep 17 00:00:00 2001
From: Developer Name <developer@example.com>
Date: Mon, 10 Feb 2025 14:30:00 +0100
Subject: [PATCH] fix: handle live migration timeout correctly

When a live migration exceeds the configured timeout, the migration
should be aborted gracefully instead of leaving the instance in ERROR.

Closes-Bug: #2099999
---
 nova/compute/manager.py | 12 +++++++++---
 1 file changed, 9 insertions(+), 3 deletions(-)

diff --git a/nova/compute/manager.py b/nova/compute/manager.py
index abc1234..def5678 100644
--- a/nova/compute/manager.py
+++ b/nova/compute/manager.py
@@ -1234,8 +1234,14 @@ class ComputeManager(manager.Manager):
      def _check_live_migration_timeout(self, context, instance, migration):
-         if migration.status == 'running':
-             raise exception.MigrationTimeout()
+         if migration.status == 'running' and self._is_timeout_exceeded(migration):
+             LOG.warning('Live migration timeout exceeded for instance %s, '
+                         'aborting migration gracefully', instance.uuid)
+             self._abort_migration(context, instance, migration)
```

### Application in the CI Pipeline

The CI pipeline resolves the ref from `source-refs.yaml` and uses `matrix.release` to select the correct patch directory (see [Build Pipeline](./01-build-pipeline.md#github-actions-workflow)):

```yaml
- name: Resolve Source Ref
  id: resolve
  run: |
    ref=$(yq '."${{ matrix.service }}"' releases/${{ matrix.release }}/source-refs.yaml)
    echo "ref=${ref}" >> "$GITHUB_OUTPUT"

- name: Checkout OpenStack Source
  uses: actions/checkout@v4
  with:
    repository: openstack/${{ matrix.service }}
    ref: ${{ steps.resolve.outputs.ref }}
    path: src/${{ matrix.service }}

- name: Apply Patches
  if: hashFiles(format('patches/{0}/{1}/*.patch', matrix.service, matrix.release)) != ''
  run: |
    git -C src/${{ matrix.service }} apply --verbose \
      patches/${{ matrix.service }}/${{ matrix.release }}/*
```

## Level 2: Library Patches

Library patches enable fixes on Python dependencies without waiting for a new upstream release.

### Library Patch Use Cases

- **Security fix** in a dependency that has no release yet
- **Bugfix** in oslo.messaging that is critical for production
- **Compatibility fix** between a library and the OpenStack service

### Library Patch Directory Structure

Library patches follow the same `<component>/<release>/` structure as service patches:

```text
patches/
├── nova/
│   └── 2025.2/
│       └── ...                         # Service patches (Level 1)
├── keystonemiddleware/
│   ├── 2025.2/
│   │   └── 0001-fix-audit-middleware-crash.patch
│   └── 2025.1/
│       └── 0001-fix-audit-middleware-crash.patch
├── oslo.messaging/
│   └── 2025.2/
│       └── 0001-fix-rabbit-reconnect-on-connection-reset.patch
├── python-novaclient/
│   └── 2025.2/
│       └── 0001-fix-microversion-negotiation.patch
└── keystoneauth1/
    └── 2025.2/
        └── 0001-fix-token-refresh-race-condition.patch
```

A library patch may apply to multiple releases. In this case, the patch file exists in both release directories. The patches may differ if the upstream code diverges between releases or if different versions of the library are used.

### Workflow

The checkout step uses the same ref that is configured for the component in the CI workflow (see [Source References](./02-versioning.md#source-references)). This can be a branch, tag, or commit SHA — the same applies to services and libraries:

```bash
# Example A: Library referenced by branch (keystonemiddleware)
git clone https://opendev.org/openstack/keystonemiddleware
cd keystonemiddleware
git checkout stable/2025.2          # ← branch (as configured in CI)

# Example B: Library referenced by tag (oslo.messaging)
git clone https://opendev.org/openstack/oslo.messaging
cd oslo.messaging
git checkout 14.9.0                 # ← tag (as configured in CI)

# Then: implement fix, commit, export patch
vim keystonemiddleware/auth_token/_auth.py
git add -A
git commit -m "fix: handle audit middleware crash on missing project_id"
git format-patch -1 HEAD -o /path/to/c5c3/patches/keystonemiddleware/2025.2/
```

### CI Integration

Library refs are configured in the same `source-refs.yaml` as services (see [Source References](./02-versioning.md#source-references)). The ref can be a branch, tag, or commit SHA:

```yaml
- name: Resolve keystonemiddleware Ref
  if: hashFiles(format('patches/keystonemiddleware/{0}/*.patch', matrix.release)) != ''
  id: keystonemiddleware-ref
  run: |
    ref=$(yq '.keystonemiddleware' releases/${{ matrix.release }}/source-refs.yaml)
    echo "ref=${ref}" >> "$GITHUB_OUTPUT"

- name: Checkout keystonemiddleware
  if: hashFiles(format('patches/keystonemiddleware/{0}/*.patch', matrix.release)) != ''
  uses: actions/checkout@v4
  with:
    repository: openstack/keystonemiddleware
    ref: ${{ steps.keystonemiddleware-ref.outputs.ref }}
    path: src/keystonemiddleware

- name: Apply keystonemiddleware Patches
  if: hashFiles(format('patches/keystonemiddleware/{0}/*.patch', matrix.release)) != ''
  run: |
    git -C src/keystonemiddleware apply --verbose \
      ${{ github.workspace }}/patches/keystonemiddleware/${{ matrix.release }}/*
```

In the Dockerfile, the patched library is included as an additional build context and installed before the service:

```dockerfile
FROM ghcr.io/c5c3/venv-builder:3.12-noble AS build

# Install patched library (before the service)
RUN --mount=type=bind,from=keystonemiddleware,source=/,target=/src/keystonemiddleware,readwrite \
    uv pip install \
      --constraint /upper-constraints.txt \
      /src/keystonemiddleware

# Then install the service
RUN --mount=type=bind,from=keystone,source=/,target=/src/keystone,readwrite \
    uv pip install \
      --constraint /upper-constraints.txt \
      /src/keystone
```

## Level 3: Constraint Overrides

Constraint overrides allow selectively overriding individual version pins from `upper-constraints.txt` without replacing the entire file. Overrides are organized per OpenStack release.

### Constraint Override Use Cases

- **Newer library version** (e.g., security fix in cryptography)
- **Older library version** pinned (e.g., compatibility issue)
- **Remove library** from constraints (e.g., when installed from patched source)

### File: `overrides/<release>/constraints.txt`

```text
# overrides/2025.2/constraints.txt

# Newer cryptography version due to CVE-2025-XXXX
cryptography===44.0.1

# Remove oslo.messaging from constraints (installed from patched source)
# Format: package name prefixed with - → removed from upper-constraints.txt
-oslo.messaging
```

Different releases may have different overrides:

```text
overrides/
├── 2025.2/
│   └── constraints.txt    # cryptography upgrade + oslo.messaging removal
└── 2025.1/
    └── constraints.txt    # only oslo.messaging removal (cryptography ok)
```

### Application During Build

The override file is merged into `upper-constraints.txt` before the build:

```bash
#!/bin/bash
# scripts/apply-constraint-overrides.sh

RELEASE="${1:?Usage: $0 <release>}"
CONSTRAINTS="upper-constraints.txt"
OVERRIDES="overrides/${RELEASE}/constraints.txt"

if [ ! -f "$OVERRIDES" ]; then
  exit 0
fi

while IFS= read -r line; do
  # Skip comments and blank lines
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue

  if [[ "$line" =~ ^- ]]; then
    # Remove package from constraints
    package="${line#-}"
    sed -i "/^${package}===/d" "$CONSTRAINTS"
    echo "Removed constraint: $package"
  else
    # Override constraint
    package=$(echo "$line" | cut -d'=' -f1)
    sed -i "s/^${package}===.*$/${line}/" "$CONSTRAINTS"
    echo "Updated constraint: $line"
  fi
done < "$OVERRIDES"
```

## Patch Lifecycle

```text
┌─────────────────────────────────────────────────────────────────┐
│                      Patch Lifecycle                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Problem identified                                          │
│     └── Bug, security issue, incompatibility                    │
│                                                                 │
│  2. Develop fix                                                 │
│     ├── Check out upstream repo at target release               │
│     ├── Implement fix                                           │
│     └── Create git format-patch                                 │
│                                                                 │
│  3. Integrate patch                                             │
│     ├── Place patch in patches/<component>/<release>/           │
│     ├── Repeat for other affected releases if needed            │
│     ├── Add constraint override if needed                       │
│     └── Commit + PR                                             │
│                                                                 │
│  4. CI builds new image                                         │
│     ├── Patches are applied (release-specific)                  │
│     ├── Image is built and tested                               │
│     └── Patched image is pushed                                 │
│                                                                 │
│  5. Update deployment                                           │
│     └── Update image tag in CRD (or digest pin)                 │
│                                                                 │
│  6. Track upstream fix                                          │
│     ├── Submit fix upstream (if not already done)               │
│     ├── When merged upstream: remove patch after                │
│     │   next constraint/commit update                           │
│     └── Clean up patch directory                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Patched components are tracked in the SBOM via CycloneDX pedigree metadata (see [SBOM — Patch Traceability](./04-sbom.md#patch-traceability-in-sbom)).

## Fast Patching (Workflow)

The entire process from fix to patched image in production:

```bash
# 1. Create patch (5 minutes)
git clone https://opendev.org/openstack/neutron
cd neutron && git checkout stable/2025.2
# ... implement fix ...
git format-patch -1 HEAD -o ../c5c3/patches/neutron/2025.2/

# 2. Commit patch (1 minute)
cd ../c5c3
git add patches/neutron/2025.2/0003-fix-critical-bug.patch
git commit -m "fix(neutron): backport critical MTU fix for 2025.2"
git push

# 3. CI builds new image (10-15 minutes)
# → Automatically via GitHub Actions

# 4. Update deployment (1 minute)
# → Image tag update in the GitOps repository
# → FluxCD rolls out the update
```

**Total time from fix to production: approximately 20 minutes** (with a prepared CI pipeline).

## Patch Management

### List Patches

```bash
# Show all active patches across all releases
find patches/ -name "*.patch" -type f | sort

# Show patches for a specific service and release
ls patches/nova/2025.2/

# Show which releases have patches for a service
find patches/nova/ -name "*.patch" -type f | sed 's|patches/nova/||;s|/.*||' | sort -u
```

### Remove Patch (After Upstream Merge)

```bash
# Remove the patch for a specific release
rm patches/neutron/2025.2/0001-fix-ovn-mtu-in-external-ids.patch

# Check if the same patch exists for other releases
ls patches/neutron/*/0001-fix-ovn-mtu-in-external-ids.patch

# Renumber remaining patches (optional)
cd patches/neutron/2025.2/
ls *.patch | sort | nl -nrz -w4 | while read num file; do
  mv "$file" "$(echo $file | sed "s/^[0-9]*/$(printf '%04d' $num)/")"
done

# Commit
git add -A patches/neutron/
git commit -m "chore(neutron): remove upstream-merged MTU patch for 2025.2"
```

### Patch Conflict on Upstream Update

When a commit SHA update causes a patch to no longer apply cleanly:

1. **Check if the patch is still needed** — the fix may already have been merged upstream
2. **Recreate the patch** against the new commit
3. **Replace the old patch** and re-trigger CI

```bash
# Test patch against new state
git clone https://opendev.org/openstack/nova
cd nova && git checkout <new-commit-sha>
git apply --check ../c5c3/patches/nova/2025.2/0001-fix.patch

# On failure: recreate the patch
git apply ../c5c3/patches/nova/2025.2/0001-fix.patch --3way
# ... resolve conflicts ...
git format-patch -1 HEAD -o ../c5c3/patches/nova/2025.2/
```
