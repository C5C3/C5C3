# SBOM (Software Bill of Materials)

Every container image is published with a signed SBOM that lists all included software components — both Python packages and system packages. This enables vulnerability tracking, regulatory compliance, and supply chain transparency.

## Design Goals

| Goal | Implementation |
| --- | --- |
| **Complete inventory** | Both OS packages (apt) and Python packages (uv/pip) in a single SBOM |
| **Accurate Python dependencies** | Generated from `uv` lock data, not heuristic scanning |
| **Patch traceability** | CycloneDX pedigree metadata for patched components |
| **Signed attestation** | Sigstore-signed, stored as OCI artifact alongside the image in GHCR |
| **Regulatory readiness** | EU Cyber Resilience Act (CRA) and CISA minimum elements |

## SBOM Format

CobaltCore uses **CycloneDX 1.5** (JSON) as the SBOM format.

| Aspect | CycloneDX | SPDX |
| --- | --- | --- |
| **Focus** | Application security | License compliance |
| **Patch tracking** | Native pedigree mechanism | Not supported natively |
| **Syft support** | Full CycloneDX 1.5 JSON output | Full SPDX output |
| **Tooling maturity** | Syft, cdxgen, cyclonedx-cli | Syft, Trivy |
| **Regulatory acceptance** | BSI TR-03183, CISA, EU CRA | ISO 5962, CISA, EU CRA |

**Why CycloneDX over SPDX:**

- CycloneDX's pedigree mechanism represents C5C3's three-level patching (service patches, library patches, constraint overrides) — SPDX has no native equivalent
- Syft produces accurate CycloneDX 1.5 output from the final image, capturing both OS and Python packages
- CycloneDX focuses on vulnerability tracking and patch documentation, which matches the primary use case of container image supply chain security

## SBOM Generation Pipeline

```text
┌─────────────────────────────────────────────────────────────────┐
│                    SBOM Generation Pipeline                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Build image                                                 │
│     └── docker buildx build → ghcr.io/c5c3/<service>:<tag>      │
│                                                                 │
│  2. Generate SBOM                                               │
│     └── Syft scans the final image                              │
│         ├── OS packages (apt/dpkg metadata)                     │
│         ├── Python packages (dist-info in /var/lib/openstack)   │
│         └── Output: CycloneDX 1.5 JSON                          │
│                                                                 │
│  3. Enrich SBOM (if patches are active)                         │
│     └── Add pedigree metadata for patched components            │
│         ├── Service patches → component pedigree                │
│         ├── Library patches → component pedigree                │
│         └── Constraint overrides → version annotation           │
│                                                                 │
│  4. Attest and sign                                             │
│     └── actions/attest-sbom                                     │
│         ├── Signs with Sigstore (keyless, OIDC-bound)           │
│         ├── Stores attestation in GHCR as OCI artifact          │
│         └── Verifiable via gh attestation verify                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## SBOM Content

The SBOM captures everything deployed in the final runtime image:

| Category | Source | Package URL format | Example |
| --- | --- | --- | --- |
| **OS packages** | dpkg/apt metadata | `pkg:deb/ubuntu/<name>@<version>` | `pkg:deb/ubuntu/libpq5@16.6-0ubuntu0.24.04.1` |
| **Python packages** | dist-info in `/var/lib/openstack` | `pkg:pypi/<name>@<version>` | `pkg:pypi/nova@32.1.0` |

**What is included:**
- All runtime system packages installed via `apt-get` in the final stage
- All Python packages in the virtual environment (`/var/lib/openstack`)
- Package versions, hashes, and license information

**What is not included:**
- Build dependencies (gcc, python3-dev, libssl-dev) — these exist only in the builder stage and are not present in the final image

### Multi-Stage Build Accuracy

The multi-stage build (see [Build Pipeline — Multi-Stage Build Architecture](./01-build-pipeline.md#multi-stage-build-architecture)) does not compromise SBOM accuracy:

```text
Stage 1 (Builder)                    Stage 2 (Runtime)
┌────────────────────────┐           ┌────────────────────────┐
│ gcc, python3-dev, ...  │           │ libpq5, libxml2, ...   │ ← Scanned (apt)
│ uv, build-essential    │           │                        │
│                        │  COPY     │ /var/lib/openstack/    │
│ /var/lib/openstack/    │ ───────▶  │   dist-info/ metadata  │ ← Scanned (Python)
│   compiled packages    │           │   site-packages/       │
└────────────────────────┘           └────────────────────────┘
     Not in SBOM                          In SBOM ✓
```

Syft detects Python packages in the copied virtual environment because `COPY --from=build` preserves the `dist-info` metadata directories that contain package names, versions, and license information.

## Patch Traceability in SBOM

When patches are applied (see [Patching](./03-patching.md)), the SBOM is enriched with CycloneDX pedigree metadata. This records what was patched, why, and with what.

### Pedigree for Service Patches (Level 1)

```json
{
  "type": "library",
  "name": "nova",
  "version": "32.1.0",
  "purl": "pkg:pypi/nova@32.1.0",
  "pedigree": {
    "patches": [
      {
        "type": "backport",
        "diff": {
          "url": "https://github.com/c5c3/forge/blob/stable/1.0/patches/nova/2025.2/0001-fix-live-migration-timeout-handling.patch"
        },
        "resolves": [
          {
            "type": "defect",
            "id": "LP#2099999",
            "source": {
              "name": "Launchpad",
              "url": "https://bugs.launchpad.net/nova/+bug/2099999"
            }
          }
        ]
      }
    ]
  }
}
```

### Pedigree for Library Patches (Level 2)

```json
{
  "type": "library",
  "name": "oslo.messaging",
  "version": "14.9.0",
  "purl": "pkg:pypi/oslo.messaging@14.9.0",
  "pedigree": {
    "patches": [
      {
        "type": "backport",
        "diff": {
          "url": "https://github.com/c5c3/forge/blob/stable/1.0/patches/oslo.messaging/2025.2/0001-fix-rabbit-reconnect-on-connection-reset.patch"
        }
      }
    ]
  }
}
```

### Constraint Override Annotation (Level 3)

When a constraint override changes a package version (e.g., for a CVE fix), the SBOM component includes a property annotation:

```json
{
  "type": "library",
  "name": "cryptography",
  "version": "44.0.1",
  "purl": "pkg:pypi/cryptography@44.0.1",
  "properties": [
    {
      "name": "c5c3:constraint-override",
      "value": "Upgraded from 44.0.0 via overrides/constraints.txt (CVE-2025-XXXX)"
    }
  ]
}
```

## GitHub Actions Integration

SBOM generation is integrated into the image build workflow as additional steps after the image push. A new SBOM is generated and attested for every image that is pushed to the registry:

```yaml
- name: Build and Push
  id: push
  uses: docker/build-push-action@v6
  with:
    context: .
    file: images/${{ matrix.service }}/Dockerfile
    build-contexts: |
      ${{ matrix.service }}=src/${{ matrix.service }}
    platforms: linux/amd64,linux/arm64
    push: ${{ github.event_name != 'pull_request' }}
    tags: |
      ghcr.io/c5c3/${{ matrix.service }}:${{ env.VERSION }}
    cache-from: type=gha
    cache-to: type=gha,mode=max
    provenance: mode=max

# Generate SBOM from the final image
- name: Generate SBOM
  if: github.event_name != 'pull_request'
  uses: anchore/sbom-action@v0
  with:
    image: ghcr.io/c5c3/${{ matrix.service }}@${{ steps.push.outputs.digest }}
    format: cyclonedx-json
    output-file: sbom.cyclonedx.json

# Sign and attach SBOM as OCI attestation
- name: Attest SBOM
  if: github.event_name != 'pull_request'
  uses: actions/attest-sbom@v2
  with:
    subject-name: ghcr.io/c5c3/${{ matrix.service }}
    subject-digest: ${{ steps.push.outputs.digest }}
    sbom-path: sbom.cyclonedx.json
    push-to-registry: true
```

**Key properties:**

- **`anchore/sbom-action`**: Runs Syft against the pushed image, producing a CycloneDX 1.5 JSON file
- **`actions/attest-sbom`**: Signs the SBOM with Sigstore (keyless, bound to the GitHub Actions OIDC identity) and stores the attestation as an OCI referrer artifact in GHCR
- **`provenance: mode=max`**: Generates SLSA provenance attestation alongside the SBOM
- **No SBOM on PRs**: Pull requests only build, they do not generate or attest SBOMs

### Required Workflow Permissions

```yaml
permissions:
  contents: read
  packages: write
  id-token: write       # Sigstore OIDC signing
  attestations: write   # GitHub Attestations API
```

## Verification

Consumers can verify the SBOM attestation before deploying an image:

```bash
# Verify via GitHub CLI
gh attestation verify \
  oci://ghcr.io/c5c3/keystone:28.0.0 \
  --owner c5c3

# Verify via cosign (cross-platform)
cosign verify-attestation \
  --type cyclonedx \
  --certificate-identity-regexp "https://github.com/c5c3/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/c5c3/keystone@sha256:abc123...

# Extract SBOM content
cosign verify-attestation \
  --type cyclonedx \
  --certificate-identity-regexp "https://github.com/c5c3/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/c5c3/keystone@sha256:abc123... \
  | jq -r '.payload' | base64 -d | jq '.predicate'
```

## SBOM Tools

| Tool | Role | Input | Output |
| --- | --- | --- | --- |
| **Syft** (Anchore) | Primary SBOM generator | Final container image | CycloneDX 1.5 JSON |
| **actions/attest-sbom** | Signing and attestation | SBOM file + image digest | Signed OCI attestation in GHCR |
| **cosign** (Sigstore) | Verification | Image reference | Attestation validation |
| **Grype** (Anchore) | Vulnerability scanning | SBOM or image | Vulnerability report |

### Why Syft

Syft is used as the primary generator because it:
- Scans both OS packages (dpkg) and Python packages (dist-info) in a single pass
- Produces CycloneDX and SPDX output
- Operates as static analysis on the final image (fast, no runtime required)
- Correctly detects packages in virtual environments copied via `COPY --from`

## Regulatory Context

### EU Cyber Resilience Act (CRA)

| Milestone | Date | Requirement |
| --- | --- | --- |
| Vulnerability reporting | September 11, 2026 | Report actively exploited vulnerabilities within 24h/72h |
| SBOM obligation | December 11, 2027 | Machine-readable SBOM as part of technical documentation |

The CRA requires SBOMs for products with digital elements placed on the EU market. Open source software that is not commercially distributed is exempt. BSI TR-03183 recommends CycloneDX 1.4+ or SPDX 2.3+ as formats.

### CISA Minimum Elements (2025)

The CISA minimum SBOM elements that C5C3 SBOMs satisfy:

| Element | C5C3 Coverage |
| --- | --- |
| Component name and version | Package name + version from metadata |
| Component hash | SHA-256 from Syft analysis |
| License information | License field from dist-info/dpkg metadata |
| Unique identifier | Package URL (purl) for all components |
| Dependency relationships | Dependency graph from Syft |
| SBOM author and tool | `anchore/syft` with version |
| Generation timestamp | ISO 8601 timestamp in SBOM metadata |

### Vulnerability Scanning

SBOMs enable continuous vulnerability scanning without re-scanning images:

```bash
# Scan image directly
grype ghcr.io/c5c3/keystone:28.0.0

# Scan from SBOM (faster, offline)
grype sbom:sbom.cyclonedx.json
```

Grype matches SBOM components against vulnerability databases (NVD, GitHub Advisory Database, OSV) and reports affected packages with severity ratings.
