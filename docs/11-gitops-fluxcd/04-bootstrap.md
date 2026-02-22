# Bootstrap

## Advantages of FluxCD Integration

| Advantage                  | Description                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| **Single Source of Truth** | All cluster configurations in one Git repository                                             |
| **Audit Trail**            | Git history documents all changes                                                            |
| **Rollback**               | `git revert` for quick recovery (details see [Upgrade & Lifecycle](../14-upgrades.md))       |
| **Multi-Cluster**          | Centralized management of all 4+ clusters                                                    |
| **Drift Detection**        | Automatic correction for manual changes                                                      |
| **Secret Management**      | OpenBao + ESO for centralized secret management                                              |
| **Dependency Management**  | Ordered deployments via `dependsOn`                                                          |
| **Progressive Delivery**   | SemVer ranges for controlled upgrades (details see [Upgrade & Lifecycle](../14-upgrades.md)) |

## Bootstrap Process

The bootstrap uses the **Flux Operator** instead of the imperative `flux bootstrap` command. The operator is installed as a Helm Chart and then manages FluxCD declaratively via the `FluxInstance` CRD.

```bash
# 1. Install Flux Operator Helm Chart
helm install flux-operator oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator \
  --namespace flux-system \
  --create-namespace

# 2. Create FluxInstance (configure GitOps sync)
kubectl apply -f - <<EOF
apiVersion: fluxcd.controlplane.io/v1
kind: FluxInstance
metadata:
  name: flux
  namespace: flux-system
spec:
  distribution:
    version: "2.x"
    registry: ghcr.io/fluxcd
  components:
    - source-controller
    - kustomize-controller
    - helm-controller
    - notification-controller
  cluster:
    networkPolicy: true
  sync:
    kind: GitRepository
    url: ssh://git@github.com/c5c3/c5c3-gitops.git
    ref: refs/heads/main
    path: clusters/management
    pullSecret: flux-system
EOF

# 3. Add SSH deploy key for Git repository
kubectl create secret generic flux-system \
  --namespace flux-system \
  --from-file=identity=./deploy-key \
  --from-file=identity.pub=./deploy-key.pub \
  --from-file=known_hosts=./known_hosts

# 4. Check FluxInstance status
kubectl -n flux-system get fluxinstance flux

# 5. OpenBao + ESO are deployed via FluxCD Kustomization (from apps/external-secrets/ and apps/openbao/).
# Initialize OpenBao and write bootstrap secrets.
# See: Secret Management documentation for OpenBao initialization details.
# ESO ClusterSecretStores are deployed via FluxCD Kustomization from the Git repository.

# 6. Add kubeconfig secrets for remote clusters (initial manual step;
#    long-term management via ExternalSecrets in infrastructure/cluster-configs/)
kubectl create secret generic control-plane-kubeconfig \
  --namespace=flux-system \
  --from-file=value=~/.kube/control-plane.yaml

kubectl create secret generic hypervisor-kubeconfig \
  --namespace=flux-system \
  --from-file=value=~/.kube/hypervisor.yaml

kubectl create secret generic storage-kubeconfig \
  --namespace=flux-system \
  --from-file=value=~/.kube/storage.yaml
```

<!-- TODO: Add concrete OpenBao initialization commands (bao operator init, unseal, kv put) or link to a runbook -->

See [Secret Management](../13-secret-management.md) for OpenBao initialization and bootstrap secret configuration. After the FluxCD bootstrap completes, the [Credential Lifecycle](./01-credential-lifecycle.md) takes over with Keystone bootstrapping, service user creation, and cross-cluster secret synchronization.

## FluxReport

After bootstrap, the Flux Operator automatically generates a `FluxReport` resource that represents the status of the entire Flux installation:

```bash
kubectl -n flux-system get fluxreport flux -o yaml
```

The `FluxReport` provides:

* **Installation Status**: Version, distribution, controller readiness
* **Reconciler Statistics**: Running, failed, and suspended resources per type
* **Sync Status**: Currently applied revision and source details
* **Prometheus Metrics**: `flux_instance_info` and `flux_resource_info`
