# Container Images

CobaltCore builds its own OCI-compliant container images for all OpenStack services. These images are lightweight, reproducible, and support fast patching without repository forks.

## Design Goals

| Goal | Implementation |
| --- | --- |
| **Build specific versions** | Branch, tag, or commit SHA as build input (see [Versioning](./02-versioning.md#source-references)) |
| **Lightweight images** | [Multi-stage builds](./01-build-pipeline.md#multi-stage-build-architecture), only runtime dependencies in the final image |
| **Fast builds** | `uv` instead of pip, layer caching, bind mounts (see [Build Pipeline](./01-build-pipeline.md#build-performance)) |
| **Fast patching** | `patches/<service>/<release>/` directory with `git apply`, no fork required (see [Patching](./03-patching.md)) |
| **Multi-release support** | A single C5C3 branch manages multiple OpenStack releases simultaneously |
| **Library patching** | Constraint overrides and patches at the dependency level (see [Patching — Library Patches](./03-patching.md#level-2-library-patches)) |
| **Supply chain transparency** | Signed SBOM (CycloneDX) attested to each image via Sigstore (see [SBOM](./04-sbom.md)) |

## Image Hierarchy

```text
┌─────────────────────────────────────────────────────────────────┐
│                       Image Hierarchy                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ubuntu:noble (24.04 LTS)                                       │
│       │                                                         │
│       ├──▶ c5c3/python-base:latest                              │
│       │    ├── Python 3.12, runtime libraries                   │
│       │    ├── PATH=/var/lib/openstack/bin:$PATH                │
│       │    └── openstack user (UID/GID 42424, shared)           │
│       │         │                                               │
│       │         └──▶ c5c3/<service>  (final runtime image)      │
│       │              ├── COPY --from=build /var/lib/openstack   │
│       │              └── Service-specific system packages       │
│       │                                                         │
│       └──▶ c5c3/venv-builder:latest                             │
│            ├── Build dependencies (gcc, python3-dev, libssl-dev)│
│            ├── uv 0.10.9 (Python package manager)               │
│            └── Common pre-installed packages (no constraints)   │
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
- **Monorepo structure**: Dockerfiles live in the `c5c3/forge` monorepo, not in separate repos per service
- **Focus on Ubuntu Noble**: A single base image instead of multi-distro to reduce complexity

## Container Registry

```text
ghcr.io/c5c3/<service>:<tag>
```

**Tag schema (service images):**

| Tag format | Example | Property | Usage |
| --- | --- | --- | --- |
| `<version>-p<N>-<branch>-<sha>` | `28.0.0-p0-main-a1b2c3d` | Immutable | Primary tag — always pushed |
| `<upstream-version>` | `28.0.0` | Mutable | Pushed on `main` branch only (see [Versioning](./02-versioning.md#tag-schema)) |
| `<short-sha>` | `a1b2c3d` | Immutable | Always pushed |

**Tag schema (base images):**

| Tag format | Example | Property | Usage |
| --- | --- | --- | --- |
| `latest` | `python-base:latest` | Mutable | Points to the most recent build |
| `<commit-sha>` | `python-base:<sha>` | Immutable | Full commit SHA, pushed alongside `latest` |

**Currently integrated services:**

| Component | Upstream Version | Image | Status |
| --- | --- | --- | --- |
| Keystone | 28.0.0 | `ghcr.io/c5c3/keystone:28.0.0` | Built by CI |
| Nova | — | `ghcr.io/c5c3/nova` | Dockerfile exists, not yet in build matrix |
| Neutron | — | `ghcr.io/c5c3/neutron` | Dockerfile exists, not yet in build matrix |
| Glance | — | `ghcr.io/c5c3/glance` | Dockerfile exists, not yet in build matrix |
| Cinder | — | `ghcr.io/c5c3/cinder` | Dockerfile exists, not yet in build matrix |
| Placement | — | `ghcr.io/c5c3/placement` | Dockerfile exists, not yet in build matrix |

> **Note:** Infrastructure services (Memcached, MariaDB, RabbitMQ, Valkey) use upstream container images directly and are not built by C5C3. They are managed by their respective operators (see [Infrastructure Service Operators](../03-components/01-control-plane/06-infrastructure-operators.md)).
>
> **Note:** OVN and OVS require a separate C-source build pipeline that has not yet been implemented.

## Further Reading

- [Build Pipeline](./01-build-pipeline.md) — Multi-stage builds, Dockerfile structure, GitHub Actions
- [Versioning](./02-versioning.md) — Branch strategy, tag schema, automated updates
- [Patching](./03-patching.md) — Service patches, library patches, constraint overrides
- [SBOM](./04-sbom.md) — Software Bill of Materials, signing, attestation, regulatory compliance
