# Container Images

CobaltCore builds its own OCI-compliant container images for all OpenStack services. These images are lightweight, reproducible, and support fast patching without repository forks.

## Design Goals

| Goal | Implementation |
| --- | --- |
| **Build specific versions** | Branch, tag, or commit SHA as build input |
| **Lightweight images** | Multi-stage builds, only runtime dependencies in the final image |
| **Fast builds** | `uv` instead of pip (10-100x faster), layer caching, bind mounts |
| **Fast patching** | `patches/<service>/<release>/` directory with `git apply`, no fork required |
| **Multi-release support** | A single C5C3 branch manages multiple OpenStack releases simultaneously |
| **Library patching** | Constraint overrides and patches at the dependency level |
| **Supply chain transparency** | Signed SBOM (CycloneDX) attested to each image via Sigstore |

## Image Hierarchy

```text
┌─────────────────────────────────────────────────────────────────┐
│                       Image Hierarchy                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ubuntu:noble (24.04 LTS)                                       │
│       │                                                         │
│       ├──▶ c5c3/python-base:3.12-noble                          │
│       │    ├── Python 3.12, runtime libraries                   │
│       │    ├── PATH=/var/lib/openstack/bin:$PATH                │
│       │    └── Service user (UID 42424)                         │
│       │         │                                               │
│       │         └──▶ c5c3/<service>  (final runtime image)      │
│       │              ├── COPY --from=build /var/lib/openstack   │
│       │              └── Service-specific system packages       │
│       │                                                         │
│       └──▶ c5c3/venv-builder:3.12-noble               │
│            ├── Build dependencies (gcc, python3-dev, libssl-dev)│
│            ├── uv (Python package manager)                      │
│            └── upper-constraints.txt                            │
│                 │                                               │
│                 └──▶ Build stage (discarded)                    │
│                      └── Compiles venv into                     │
│                         /var/lib/openstack                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key principle:** The venv builder contains all build dependencies (compilers, header files) but is **never** included in the final image. Only the compiled virtual environment (`/var/lib/openstack`) is copied via `COPY --from=build` into the lightweight runtime image.

## Comparison of Existing Approaches

The C5C3 strategy is based on an analysis of OpenStack LOCI and Vexxhost Atmosphere:

| Aspect | LOCI | Atmosphere | C5C3 |
| --- | --- | --- | --- |
| **Dockerfile structure** | Single generic Dockerfile for all services | Per-service repos with own Dockerfile | Per-service Dockerfile in monorepo |
| **Python installer** | pip + pre-built wheels | `uv` (Rust-based) | `uv` (Rust-based) |
| **Dependency strategy** | Separate requirements image with wheels | `upper-constraints.txt` + `uv` directly | `upper-constraints.txt` + `uv` directly |
| **Base image** | Ubuntu Jammy | Multi-distro (Ubuntu, Debian, Rocky) | Ubuntu Noble (24.04 LTS) |
| **Source code in build** | `git clone` inside Dockerfile | Build context (bind mount from CI) | Build context (bind mount from CI) |
| **Patching** | No built-in mechanism | `patches/` directory with `git apply` | `patches/` + library patches + constraint overrides |
| **Library patching** | Not supported | Not explicit | Constraint overrides + library patches |
| **Multi-arch** | Experimental | Native (amd64 + arm64) | Native (amd64 + arm64) |
| **CI/CD** | Zuul (OpenDev) | GitHub Actions + Depot.dev | GitHub Actions |
| **Versioning** | Build args (`PROJECT_REF`) | Branch-per-release + commit SHA pins | Own version scheme + per-release refs (branch, tag, or SHA) |
| **Automated updates** | None | Renovate Bot | Renovate Bot |

### Why Not LOCI?

- **No patching mechanism**: Patches require repository forks or child images
- **Slow builds**: pip + pre-built wheels instead of `uv`
- **Monolithic approach**: A single generic Dockerfile for all services prevents service-specific optimizations
- **No library patching**: Dependencies cannot be patched individually

### What We Adopt from Atmosphere

- **`uv` as package manager**: Dramatically faster builds
- **Build context pattern**: Source code is checked out via CI and passed as a build context, not cloned inside the Dockerfile
- **Structured patching**: `patches/` directory with `git format-patch` / `git apply`
- **Source reference pinning**: Reproducible builds through branch, tag, or commit SHA references

### What C5C3 Does Differently

- **Multi-release per branch**: A single C5C3 branch manages images for multiple OpenStack releases (e.g., 2025.2 and 2025.1), unlike Atmosphere which uses one branch per release
- **Release-scoped patches**: Patches are organized as `patches/<service>/<release>/`, allowing different patches per OpenStack release within the same C5C3 branch
- **Library patching**: Explicit support for patches at the dependency level (e.g., oslo.messaging, python-novaclient)
- **Constraint overrides**: Targeted version pin changes for individual libraries, scoped per release
- **Monorepo structure**: Dockerfiles live in the `c5c3/c5c3` monorepo, not in separate repos per service
- **Focus on Ubuntu Noble**: A single base image instead of multi-distro to reduce complexity

## Container Registry

```text
ghcr.io/c5c3/<service>:<tag>
```

**Tag schema:**

| Tag format | Example | Usage |
| --- | --- | --- |
| `<upstream-version>` | `28.0.0` | Release tag (default) |
| `<upstream-version>-p<N>` | `28.0.0-p1` | Release with patch revision |
| `<branch>` | `stable-2025.2` | Branch tracking (mutable) |
| `<short-sha>` | `a1b2c3d` | Commit-based (immutable) |

**Currently integrated services:**

| Component | Upstream Version | Image |
| --- | --- | --- |
| Keystone | 28.0.0 | `ghcr.io/c5c3/keystone:28.0.0` |
| Nova | 32.1.0 | `ghcr.io/c5c3/nova:32.1.0` |
| Neutron | 27.0.1 | `ghcr.io/c5c3/neutron:27.0.1` |
| Glance | 31.0.0 | `ghcr.io/c5c3/glance:31.0.0` |
| Cinder | 27.0.0 | `ghcr.io/c5c3/cinder:27.0.0` |
| Placement | 14.0.0 | `ghcr.io/c5c3/placement:14.0.0` |
| OVN | 24.03.4 | `ghcr.io/c5c3/ovn:24.03.4` |
| OVS | 3.4.1 | `ghcr.io/c5c3/ovs:3.4.1` |
| Tempest | 41.0.0 | `ghcr.io/c5c3/tempest:41.0.0` |
| Cortex | 0.5.0 | `ghcr.io/c5c3/cortex:0.5.0` |

> **Note:** OVN and OVS are built from C source and follow a separate build pipeline. Tempest and Cortex use their own build pipelines. The Python-based pipeline described here applies to the core OpenStack services (Keystone, Nova, Neutron, Glance, Cinder, Placement).
>
> **Note:** Infrastructure services (Memcached, MariaDB, RabbitMQ, Valkey) use upstream container images directly and are not built by C5C3. They are managed by their respective operators or StatefulSets (see [Infrastructure Service Operators](../03-components/01-control-plane.md#infrastructure-service-operators)).

## Further Reading

- [Build Pipeline](./01-build-pipeline.md) — Multi-stage builds, Dockerfile structure, GitHub Actions
- [Versioning](./02-versioning.md) — Branch strategy, tag schema, automated updates
- [Patching](./03-patching.md) — Service patches, library patches, constraint overrides
- [SBOM](./04-sbom.md) — Software Bill of Materials, signing, attestation, regulatory compliance
