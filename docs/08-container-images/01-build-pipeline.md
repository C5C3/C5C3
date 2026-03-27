# Build Pipeline

Container images are built as multi-stage builds. The build process strictly separates build dependencies (compilers, header files) from runtime dependencies. A single CI pipeline builds images for multiple OpenStack releases in parallel.

## Multi-Stage Build Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         Multi-Stage Build                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Stage 1: Build (venv-builder)                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  FROM venv-builder  (passed as docker-image:// build context)     │  │
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
│  │  │  uv pip install --prefix /var/lib/openstack                 │  │  │
│  │  │    --constraint /tmp/upper-constraints.txt                  │  │  │
│  │  │    /tmp/<service>[extras]                                   │  │  │
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
│  │  FROM python-base  (passed as docker-image:// build context)      │  │
│  │                                                                   │  │
│  │  ┌───────────────────────────┐  ┌─────────────────────────────┐   │  │
│  │  │ Runtime system packages   │  │ /var/lib/openstack          │   │  │
│  │  │ (apt: libpq5, libxml2,    │  │ (copied from build stage)   │   │  │
│  │  │  libldap2, libsasl2-2)    │  │                             │   │  │
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

The runtime base image for all OpenStack services. All service images inherit this image and the `openstack` user it defines.

```dockerfile
FROM ubuntu:noble

ENV PATH=/var/lib/openstack/bin:$PATH
ENV LANG=C.UTF-8

# Runtime dependencies shared by all services
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    netbase \
    python3 \
    sudo \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Shared service user (UID/GID 42424) — all service images run as this user.
# DEVIATION: Architecture doc shows per-service users (e.g. keystone/nova).
# A shared user reduces image layers and complexity; services are separated
# by Kubernetes namespace and RBAC, not by OS user.
RUN groupadd -g 42424 openstack && \
    useradd -u 42424 -g 42424 -M -d /var/lib/openstack -s /usr/sbin/nologin openstack

LABEL org.opencontainers.image.title="python-base" \
      org.opencontainers.image.description="Python runtime base image for OpenStack services" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="SAP SE"
```

### venv-builder

The build image with all compilation tools. In CI, `python-base` is passed as a named `docker-image://` build context — the Dockerfile references it as `FROM python-base`.

```dockerfile
FROM python-base

# Install uv (fast Python package manager, pinned via Renovate)
COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /bin/

# Build dependencies
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    libffi-dev \
    libldap2-dev \
    libpq-dev \
    libsasl2-dev \
    libssl-dev \
    python3-dev \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Prepare virtual environment
RUN python3 -m venv /var/lib/openstack

# Common base packages for all services.
# No --constraint here: venv-builder is release-independent.
# Constraints are applied per-service in the service Dockerfiles.
RUN uv pip install --prefix /var/lib/openstack \
    cryptography \
    pymemcache \
    pymysql \
    python-memcached \
    uwsgi

LABEL org.opencontainers.image.title="venv-builder" \
      org.opencontainers.image.description="Python virtualenv builder image for OpenStack services" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="SAP SE"
```

## Service Dockerfile (Example: Keystone)

In CI, both `python-base` and `venv-builder` are passed as `docker-image://` named build contexts referencing their digest from the preceding `build-base-images` job.

```dockerfile
# ---------- Stage 1: build ----------
FROM venv-builder AS build

# Comma-separated Python extras (e.g. "ldap,oauth1").
# Passed by CI from releases/<release>/extra-packages.yaml.
ARG PIP_EXTRAS=""
# Space-separated additional pip packages to install alongside the service.
ARG PIP_PACKAGES=""

# Install Keystone and extras into the shared virtualenv.
# Named build contexts supply the source tree and constraints file:
#   --build-context keystone=<path-to-keystone-source>
#   --build-context upper-constraints=releases/<release>/
RUN --mount=type=bind,from=upper-constraints,source=upper-constraints.txt,target=/tmp/upper-constraints.txt \
    --mount=type=bind,from=keystone,target=/tmp/keystone,readwrite \
    PKG="/tmp/keystone" && \
    if [ -n "$PIP_EXTRAS" ]; then PKG="${PKG}[${PIP_EXTRAS}]"; fi && \
    uv pip install --prefix /var/lib/openstack \
        --constraint /tmp/upper-constraints.txt \
        "$PKG" $PIP_PACKAGES

# Generate the WSGI entry-point script that uWSGI loads at runtime.
# PBR registers this as a wsgi_scripts entry point, but uv's --prefix
# install mode does not generate entry-point scripts, so we create it manually.
RUN printf '#!/var/lib/openstack/bin/python\n\
from keystone.server.wsgi import initialize_public_application\n\
application = initialize_public_application()\n' \
    > /var/lib/openstack/bin/keystone-wsgi-public && \
    chmod +x /var/lib/openstack/bin/keystone-wsgi-public

# ---------- Stage 2: runtime ----------
FROM python-base

# DEVIATION: Uses the generic 'openstack' user (UID/GID 42424) from python-base
# instead of a per-service user. See python-base/Dockerfile for rationale.

# Space-separated runtime system packages (e.g. "libapache2-mod-wsgi-py3 libldap2 ...").
# Passed by CI from releases/<release>/extra-packages.yaml.
ARG EXTRA_APT_PACKAGES=""

COPY --from=build --link /var/lib/openstack /var/lib/openstack

# Install runtime system packages. Guard: skip when EXTRA_APT_PACKAGES is empty
# (e.g. local build without --build-arg). CI always provides packages.
RUN if [ -n "${EXTRA_APT_PACKAGES}" ]; then \
    DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get install -y --no-install-recommends ${EXTRA_APT_PACKAGES} && \
    rm -rf /var/lib/apt/lists/*; \
    fi

LABEL org.opencontainers.image.title="keystone" \
      org.opencontainers.image.description="OpenStack keystone service" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="SAP SE"

USER openstack
```

**Key details:**

- `--mount=type=bind,from=keystone`: Source code is bind-mounted as a build context, not copied into the image
- `--mount=type=bind,from=upper-constraints`: The release-specific `upper-constraints.txt` is passed as a named build context at path `releases/<release>/`
- `--link`: Enables parallel layer extraction and layer deduplication
- `ARG PIP_EXTRAS` / `ARG PIP_PACKAGES` / `ARG EXTRA_APT_PACKAGES`: All service-specific packages are injected via build args from `extra-packages.yaml` — no hardcoded package lists
- WSGI entry-point is generated manually because `uv pip install --prefix` does not create entry-point scripts
- The Dockerfile is **release-independent**: the same Dockerfile builds any OpenStack release — the release-specific inputs (source code, constraints, packages) come from the CI pipeline via build contexts and build args

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

### Per-Service Packages (extra-packages.yaml)

System packages and additional Python packages are declared per service in `releases/<release>/extra-packages.yaml`. The CI workflow reads this file and passes the values as build args to the service Dockerfile:

```yaml
# releases/2025.2/extra-packages.yaml
keystone:
  pip_extras:
    - ldap
    - oauth1
  pip_packages: []
  apt_packages:
    - libapache2-mod-wsgi-py3
    - libldap2
    - libsasl2-2
    - libxml2
```

| Field | Maps to | Dockerfile ARG |
| --- | --- | --- |
| `pip_extras` | `keystone[ldap,oauth1]` — installed as Python extras | `PIP_EXTRAS` |
| `pip_packages` | Additional pip packages alongside the service | `PIP_PACKAGES` |
| `apt_packages` | Runtime system packages installed via apt in the final image | `EXTRA_APT_PACKAGES` |

Adding a new service or new packages is a one-line change in `extra-packages.yaml` with no Dockerfile modification required.

## GitHub Actions Workflow

The build pipeline consists of four sequential jobs:

```text
build-base-images → verify-base-images → build-service-images → verify-service-images
```

Each job feeds the next via outputs (base image digests are pinned by digest across all downstream jobs).

### Triggers

The workflow only runs when container-image-related files change:

```yaml
on:
  push:
    branches: [main, stable/**]
    paths: [images/**, releases/**, patches/**, scripts/**,
            tests/container-images/**, .github/workflows/build-images.yaml]
  pull_request:
    paths: [...]  # same path filter
```

A concurrency group cancels in-progress PR runs when new commits are pushed.

### Job: build-base-images

Builds `python-base` and `venv-builder`, then for each image: generates a CycloneDX SBOM (Syft), scans for vulnerabilities (Grype/SARIF), attests the SBOM to GHCR, and signs the image with cosign.

```yaml
build-base-images:
  permissions:
    packages: write
    id-token: write       # Sigstore OIDC for SBOM attestation + cosign
    attestations: write   # GitHub Attestations API
    security-events: write # SARIF upload to GitHub Security tab
  outputs:
    python-base-image: ghcr.io/<owner>/python-base@<digest>
    venv-builder-image: ghcr.io/<owner>/venv-builder@<digest>
  steps:
    # Fork PRs are rejected: base images must be pushed, which requires
    # packages:write. Fork PRs only receive a read-only GITHUB_TOKEN.
    - name: Reject fork PRs
      if: github.event_name == 'pull_request' && fork
      run: exit 1

    - uses: actions/checkout@...
    - uses: docker/setup-buildx-action@...
    - uses: docker/login-action@...
    - uses: sigstore/cosign-installer@...

    - name: Build and push python-base
      id: build-python-base
      uses: docker/build-push-action@...
      with:
        context: images/python-base
        platforms: linux/amd64,linux/arm64
        push: true
        tags: |
          ghcr.io/<owner>/python-base:latest
          ghcr.io/<owner>/python-base:${{ github.sha }}

    # Supply chain steps for python-base (repeated for venv-builder):
    - name: Generate SBOM          # anchore/sbom-action → CycloneDX JSON
    - name: Scan for vulns (SBOM)  # anchore/scan-action → SARIF (non-PR)
    - name: Scan for vulns (image) # anchore/scan-action → SARIF (PR only)
    - name: Upload SARIF           # github/codeql-action/upload-sarif
    - name: Attest SBOM            # actions/attest (GitHub Attestations API)
    - name: Sign image             # cosign sign --yes <image>@<digest>

    - name: Build and push venv-builder
      uses: docker/build-push-action@...
      with:
        context: images/venv-builder
        build-contexts: |
          python-base=docker-image://ghcr.io/<owner>/python-base@<digest>
        # ... same supply chain steps as python-base
```

### Job: verify-base-images

Pulls both base images by digest and runs the verification scripts:

```yaml
verify-base-images:
  needs: [build-base-images]
  steps:
    - name: Verify python-base image
      run: bash tests/container-images/verify_python_base.sh "$PYTHON_BASE_IMAGE"
    - name: Verify venv-builder image
      run: bash tests/container-images/verify_venv_builder.sh "$VENV_BUILDER_IMAGE"
```

### Job: build-service-images

Builds service images after the base images have been verified. The matrix currently covers Keystone only:

```yaml
build-service-images:
  needs: [build-base-images, verify-base-images]
  strategy:
    matrix:
      service: [keystone]
      release: ["2025.2"]
  steps:
    - name: Resolve source ref
      run: |
        ref=$(yq ".$service" releases/$release/source-refs.yaml)
        echo "ref=$ref" >> "$GITHUB_OUTPUT"

    - name: Checkout OpenStack source
      uses: actions/checkout@...
      with:
        repository: openstack/${{ matrix.service }}
        ref: ${{ steps.source-ref.outputs.ref }}
        path: src/${{ matrix.service }}

    - name: Apply patches
      if: hashFiles('patches/<service>/<release>/*.patch') != ''
      run: git -C src/${{ matrix.service }} apply patches/.../*.patch

    - name: Apply constraint overrides
      run: scripts/apply-constraint-overrides.sh ${{ matrix.release }}

    - name: Resolve extra packages
      # Reads pip_extras, pip_packages, apt_packages from extra-packages.yaml
      run: |
        pip_extras=$(yq -r ".$service.pip_extras // [] | join(\",\")" $EXTRAS_FILE)
        pip_packages=$(yq -r ".$service.pip_packages // [] | join(\" \")" $EXTRAS_FILE)
        apt_packages=$(yq -r ".$service.apt_packages // [] | join(\" \")" $EXTRAS_FILE)

    - name: Derive tags
      # Composite: <version>-p<patch-count>-<branch>-<short-sha>   (always pushed)
      # Version:   <version>                                         (main branch only)
      # SHA:       <short-sha>                                       (always pushed)

    - name: Build service image
      uses: docker/build-push-action@...
      with:
        context: images/${{ matrix.service }}
        build-args: |
          PIP_EXTRAS=${{ steps.extra-pkgs.outputs.pip-extras }}
          PIP_PACKAGES=${{ steps.extra-pkgs.outputs.pip-packages }}
          EXTRA_APT_PACKAGES=${{ steps.extra-pkgs.outputs.apt-packages }}
        build-contexts: |
          python-base=docker-image://<python-base-digest>
          venv-builder=docker-image://<venv-builder-digest>
          ${{ matrix.service }}=src/${{ matrix.service }}
          upper-constraints=releases/${{ matrix.release }}/
        platforms: linux/amd64 (PR) or linux/amd64,linux/arm64 (push)
        load: ${{ github.event_name == 'pull_request' }}
        push: ${{ github.event_name != 'pull_request' }}

    # PR: verify image locally (load, not push)
    - name: Verify service image (PR)
      if: github.event_name == 'pull_request'
      run: bash tests/container-images/verify_${{ matrix.service }}.sh "$IMAGE_REF"

    # Non-PR: same supply chain steps as base images (SBOM, Grype, attest, sign)
```

### Job: verify-service-images

Pulls the pushed service image by composite tag and re-runs the verification script (non-PR only):

```yaml
verify-service-images:
  if: github.event_name != 'pull_request'
  needs: [build-service-images]
  strategy:
    matrix:
      service: [keystone]
      release: ["2025.2"]
  steps:
    - name: Pull and verify service image
      run: |
        docker pull "$IMAGE_REF"
        bash tests/container-images/verify_${{ matrix.service }}.sh "$IMAGE_REF"
```

**Key properties of the full workflow:**

- **All actions are SHA-pinned** — no floating version tags (`@v4`, `@v6` etc. are not used)
- **Base image digests flow downstream**: `build-base-images` outputs exact digests; all service builds reference base images by digest, not by mutable tag
- **Separate supply chain per image**: SBOM, Grype scan, GitHub Attestation, and cosign signing are applied individually to `python-base`, `venv-builder`, and each service image
- **PRs build amd64 only** and load images locally for verification — no push; non-PR builds are multi-arch (`linux/amd64,linux/arm64`) and push to GHCR
- **Version tag restricted to `main`**: The mutable `<version>` tag (e.g. `keystone:28.0.0`) is only pushed on the `main` branch to prevent cross-branch overwrites
- **Fork PRs rejected**: External fork PRs cannot push base images to GHCR and fail fast with a clear error
- **path-based trigger**: The workflow only runs when container-image-related files change, not on every commit

## Build Performance

| Optimization | Effect |
| --- | --- |
| `uv` instead of pip | Significantly faster dependency resolution and installation (benchmarks show 10-100x improvement depending on workload) |
| `--mount=type=bind` | Source code is not copied into layers, reduces image size |
| `COPY --from=build --link` | Parallel layer extraction, layer deduplication |
| Shared base images | `python-base` and `venv-builder` are cached and shared across services and releases |
| GitHub Actions cache (scoped) | Layer cache persisted across builds, scoped per image to avoid cache pollution |
| Native multi-arch on push | BuildKit builds amd64 and arm64 natively; PRs skip arm64 to reduce build time |

## Directory Structure in the Monorepo

```text
c5c3/forge/
├── images/
│   ├── python-base/
│   │   └── Dockerfile
│   ├── venv-builder/
│   │   └── Dockerfile
│   └── keystone/
│       └── Dockerfile          # Release-independent (inputs via build args + contexts)
├── releases/
│   └── 2025.2/
│       ├── source-refs.yaml        # Git refs for all components (this release)
│       ├── upper-constraints.txt   # Python dependency pins for this release
│       └── extra-packages.yaml     # Per-service pip extras, pip packages, apt packages
├── patches/
│   └── <service>/<release>/*.patch # Applied before build if present (none active yet)
├── overrides/
│   └── <release>/constraints.txt   # Constraint overrides (none active yet)
├── scripts/
│   └── apply-constraint-overrides.sh
├── tests/
│   └── container-images/
│       ├── verify_python_base.sh
│       ├── verify_venv_builder.sh
│       ├── verify_keystone.sh
│       ├── verify_build_images_workflow.sh
│       ├── verify_deviation_comments.sh
│       ├── verify_release_config.sh
│       └── verify_spdx_headers.sh
└── .github/
    └── workflows/
        ├── build-images.yaml
        └── verify-container-images.yaml
```

The `patches/` and `overrides/` directories contain no active entries yet — the directory structure and CI wiring are in place but no patches or constraint overrides have been needed so far.

## OVN/OVS Build Pipeline

> **TODO:** OVN and OVS are built from C source and follow a separate build pipeline that is not based on the Python/uv workflow described above. Documentation for this pipeline will be added in a future revision.
