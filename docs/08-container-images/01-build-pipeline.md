# Build Pipeline

Container images are built as multi-stage builds. The build process strictly separates build dependencies (compilers, header files) from runtime dependencies. A single CI pipeline builds images for multiple OpenStack releases in parallel.

## Multi-Stage Build Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         Multi-Stage Build                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Stage 1: Build (venv-builder)                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  FROM ghcr.io/c5c3/venv-builder:3.12-noble              │  │
│  │                                                                   │  │
│  │  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────────┐   │  │
│  │  │ uv (Astral) │  │ upper-constraints│  │ Build dependencies  │   │  │
│  │  │             │  │ .txt             │  │ gcc, python3-dev,   │   │  │
│  │  │ Rust-based  │  │ (version pins)   │  │ libssl-dev, etc.    │   │  │
│  │  └──────┬──────┘  └────────┬─────────┘  └─────────┬───────────┘   │  │
│  │         │                  │                      │               │  │
│  │         └──────────────────┼──────────────────────┘               │  │
│  │                            │                                      │  │
│  │                            ▼                                      │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │  uv pip install                                             │  │  │
│  │  │    --constraint /upper-constraints.txt                      │  │  │
│  │  │    /src/<service>                                           │  │  │
│  │  │    <extra-packages>                                         │  │  │
│  │  │                                                             │  │  │
│  │  │  → Compiled into /var/lib/openstack (virtual environment)   │  │  │
│  │  └─────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                            │                                            │
│                            │ COPY --from=build --link                   │
│                            │ /var/lib/openstack → /var/lib/openstack    │
│                            │                                            │
│  Stage 2: Runtime (python-base)                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  FROM ghcr.io/c5c3/python-base:3.12-noble                         │  │
│  │                                                                   │  │
│  │  ┌───────────────────────────┐  ┌─────────────────────────────┐   │  │
│  │  │ Runtime system packages   │  │ /var/lib/openstack          │   │  │
│  │  │ (apt: libpq5, libxml2,    │  │ (copied from build stage)   │   │  │
│  │  │  ceph-common, etc.)       │  │                             │   │  │
│  │  └───────────────────────────┘  └─────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  No gcc, no python3-dev, no pip/uv                                │  │
│  │  → Lightweight image, minimal attack surface                      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Base Images

### python-base

The runtime base image for all OpenStack services:

```dockerfile
FROM ubuntu:noble

ENV PATH=/var/lib/openstack/bin:$PATH
ENV LANG=C.UTF-8

# Runtime dependencies shared by all services
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    netbase \
    python3 \
    sudo \
    tzdata \
    && rm -rf /var/lib/apt/lists/*
```

### venv-builder

The build image with all compilation tools:

```dockerfile
FROM ghcr.io/c5c3/python-base:3.12-noble

# Install uv (fast Python package manager, pinned via Renovate)
COPY --from=ghcr.io/astral-sh/uv:0.6.3 /uv /uvx /bin/

# Build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    libffi-dev \
    libpq-dev \
    libssl-dev \
    python3-dev \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Prepare virtual environment
RUN python3 -m venv /var/lib/openstack

# upper-constraints.txt is passed per release via build context
# Common base packages for all services
RUN uv pip install --prefix /var/lib/openstack \
    cryptography \
    pymysql \
    python-memcached \
    uwsgi
```

## Service Dockerfile (Example: Keystone)

```dockerfile
# ─── Stage 1: Build ─────────────────────────────────────────────
FROM ghcr.io/c5c3/venv-builder:3.12-noble AS build

# upper-constraints.txt is passed as a build context (release-specific)
RUN --mount=type=bind,from=upper-constraints,source=/upper-constraints.txt,target=/upper-constraints.txt \
    --mount=type=bind,from=keystone,source=/,target=/src/keystone,readwrite \
    uv pip install \
      --constraint /upper-constraints.txt \
      /src/keystone

# ─── Stage 2: Runtime ───────────────────────────────────────────
FROM ghcr.io/c5c3/python-base:3.12-noble

# Service user
RUN groupadd -g 42424 keystone && \
    useradd -u 42424 -g 42424 -M -d /var/lib/keystone -s /usr/sbin/nologin keystone

# Runtime system packages (only what Keystone needs at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libapache2-mod-wsgi-py3 \
    libldap-2.5-0 \
    libsasl2-2 \
    libxml2 \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from build stage
COPY --from=build --link /var/lib/openstack /var/lib/openstack
```

**Key details:**

- `--mount=type=bind,from=keystone`: Source code is bind-mounted as a build context, not copied into the image
- `--mount=type=bind,from=upper-constraints`: The release-specific `upper-constraints.txt` is passed as a named build context
- `--link`: Enables parallel layer extraction and layer deduplication
- No `git clone` in the Dockerfile: Source code is checked out by the CI pipeline and passed as a named context
- The Dockerfile is **release-independent**: The same Dockerfile builds any OpenStack release — the release-specific inputs (source code, constraints, patches) come from the CI pipeline via build contexts

## Dependency Management

### Python Dependencies (upper-constraints.txt)

Each OpenStack release has its own `upper-constraints.txt` from `openstack/requirements`. This pins all transitive Python dependencies to exact versions and guarantees reproducible builds:

```text
# Excerpt from releases/2025.2/upper-constraints.txt
oslo.config===9.7.0
oslo.messaging===14.9.0
oslo.db===16.1.0
keystoneauth1===5.10.0
python-keystoneclient===5.6.0
cryptography===44.0.0
```

Service-specific constraints can be overridden per release (see [Patching — Constraint Overrides](./03-patching.md#level-3-constraint-overrides)).

### System Dependencies (bindep)

System packages are declared per service via `bindep.txt`. The `bindep` tool resolves package names for the target distribution:

```text
# bindep.txt example
libpq-dev       [platform:dpkg build]
libpq5          [platform:dpkg]
libssl-dev      [platform:dpkg build]
libvirt-dev     [platform:dpkg nova build]
libvirt0        [platform:dpkg nova]
ceph-common     [platform:dpkg glance cinder nova]
open-iscsi      [platform:dpkg cinder lvm]
```

Profiles (`build`, `nova`, `glance`, etc.) control which packages are installed in which build phase.

## GitHub Actions Workflow

The build matrix spans both services and OpenStack releases. Each combination (service x release) produces a separate image.

### Source References File

Each release has a `source-refs.yaml` that defines the git ref for every component. The ref can be a branch, tag, or commit SHA (see [Source References](./02-versioning.md#source-references)):

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

This file is the single source of truth for what version of each component is built for a given OpenStack release. Adding a new component (service or library) is a one-line addition.

### Workflow

```yaml
name: Build OpenStack Images
on:
  push:
    branches: [main, stable/**]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: [keystone, nova, neutron, glance, cinder, placement]
        release: ["2025.2", "2025.1"]
    steps:
      - name: Checkout C5C3
        uses: actions/checkout@v4

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

      # Apply release-specific patches if present
      - name: Apply Patches
        if: hashFiles(format('patches/{0}/{1}/*.patch', matrix.service, matrix.release)) != ''
        run: |
          git -C src/${{ matrix.service }} apply --verbose \
            patches/${{ matrix.service }}/${{ matrix.release }}/*

      # Apply release-specific constraint overrides
      - name: Apply Constraint Overrides
        run: |
          cp releases/${{ matrix.release }}/upper-constraints.txt upper-constraints.txt
          scripts/apply-constraint-overrides.sh ${{ matrix.release }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # <!-- TODO: Add a step that derives VERSION from source-refs.yaml or upstream tag -->
      - name: Build and Push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: images/${{ matrix.service }}/Dockerfile
          build-contexts: |
            ${{ matrix.service }}=src/${{ matrix.service }}
            upper-constraints=.
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: |
            ghcr.io/c5c3/${{ matrix.service }}:${{ env.VERSION }}
            ghcr.io/c5c3/${{ matrix.service }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

**Key properties:**

- **`source-refs.yaml` per release**: All component refs (services and libraries) live in one file per OpenStack release
- **Matrix build**: All combinations of service x release are built in parallel
- **Ref resolution via `yq`**: The workflow reads the ref from `source-refs.yaml` — works for branches, tags, and SHAs
- **Release-specific patches**: Patches are selected from `patches/<service>/<release>/`
- **Release-specific constraints**: Each release has its own `upper-constraints.txt` and optional overrides
- **Named build contexts**: Source code and constraints are passed via `--build-context`, not cloned in the Dockerfile
- **Multi-arch**: `linux/amd64` and `linux/arm64` in a single build (native arm64 runners recommended to avoid QEMU emulation overhead)
- **Patching before build**: Patches are applied to the checked-out source code before the Docker build starts
- **No pushes on PRs**: Pull requests only build, they do not push

## Build Performance

| Optimization | Effect |
| --- | --- |
| `uv` instead of pip | Significantly faster dependency resolution and installation (benchmarks show 10-100x improvement depending on workload) |
| `--mount=type=bind` | Source code is not copied into layers, reduces image size |
| `COPY --from=build --link` | Parallel layer extraction, layer deduplication |
| Shared base images | `python-base` and `venv-builder` are cached and shared across releases |
| GitHub Actions cache | Layer cache persisted across builds |
| Native multi-arch | BuildKit builds amd64 and arm64 natively when using architecture-specific runners |

## Directory Structure in the Monorepo

```text
c5c3/c5c3/
├── images/
│   ├── python-base/
│   │   └── Dockerfile
│   ├── venv-builder/
│   │   └── Dockerfile
│   ├── keystone/
│   │   └── Dockerfile           # Release-independent (inputs via build context)
│   ├── nova/
│   │   └── Dockerfile
│   ├── neutron/
│   │   └── Dockerfile
│   ├── glance/
│   │   └── Dockerfile
│   ├── cinder/
│   │   └── Dockerfile
│   └── placement/
│       └── Dockerfile
├── releases/
│   ├── 2025.2/
│   │   ├── source-refs.yaml        # Git refs for all components (this release)
│   │   └── upper-constraints.txt
│   └── 2025.1/
│       ├── source-refs.yaml
│       └── upper-constraints.txt
├── patches/
│   ├── nova/
│   │   ├── 2025.2/
│   │   │   └── *.patch
│   │   └── 2025.1/
│   │       └── *.patch
│   ├── neutron/
│   │   └── 2025.2/
│   │       └── *.patch
│   └── oslo.messaging/
│       └── 2025.2/
│           └── *.patch
├── overrides/
│   ├── 2025.2/
│   │   └── constraints.txt
│   └── 2025.1/
│       └── constraints.txt
├── scripts/
│   └── apply-constraint-overrides.sh
└── .github/
    └── workflows/
        └── build-images.yaml
```

## OVN/OVS Build Pipeline

> **TODO:** OVN and OVS are built from C source and follow a separate build pipeline that is not based on the Python/uv workflow described above. Documentation for this pipeline will be added in a future revision.
