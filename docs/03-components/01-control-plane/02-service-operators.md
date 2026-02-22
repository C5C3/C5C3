# Service Operators

Each core OpenStack service is managed by a dedicated operator running in the Control Plane Cluster. The [c5c3-operator](./01-c5c3-operator.md) creates the corresponding Custom Resources; the service operators reconcile them into running deployments.

## Keystone Operator

**Repository:** `github.com/c5c3/c5c3/operators/keystone`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **keystone-operator** manages the Keystone Identity Service. Creation of service users and application credentials is done via K-ORC. For the reconciler architecture, sub-reconciler pattern, and dependency flow, see [Keystone Reconciler](../../09-implementation/04-keystone-reconciler.md) and [Keystone Dependencies](../../09-implementation/05-keystone-dependencies.md).

**Provided CRDs:**

| CRD        | API Group                             | Description                 |
| ---------- | ------------------------------------- | --------------------------- |
| `Keystone` | `keystone.openstack.c5c3.io/v1alpha1` | Keystone Service Deployment |

**Keystone CRD:**

```yaml
apiVersion: keystone.openstack.c5c3.io/v1alpha1
kind: Keystone
metadata:
  name: keystone
  namespace: openstack
spec:
  replicas: 3

  image:
    repository: ghcr.io/c5c3/keystone
    tag: "28.0.0"

  database:
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    # host: external-db.example.com  # Brownfield alternative
    # port: 3306
    database: keystone
    secretRef:
      name: keystone-db-credentials

  cache:
    clusterRef:
      name: memcached              # Managed: references Memcached CR
    # servers:                      # Brownfield alternative
    #   - external-mc:11211
    backend: dogpile.cache.pymemcache

  fernet:
    # Fernet Key Rotation
    rotationSchedule: "0 0 * * 0"  # Weekly
    maxActiveKeys: 3

  federation:
    enabled: false

  bootstrap:
    adminUser: admin
    adminPasswordSecretRef:
      name: keystone-admin-credentials
      key: password
    region: RegionOne

status:
  conditions:
    - type: Ready
      status: "True"
    - type: DatabaseReady
      status: "True"
    - type: FernetKeysReady
      status: "True"
  endpoint: https://keystone.openstack.svc.cluster.local:5000
```

> **Note:** The `image.tag` field accepts upstream version tags (e.g., `28.0.0`), patch revision tags (e.g., `28.0.0-p1`), branch tags (e.g., `stable-2025.2`), and commit SHA tags (e.g., `a1b2c3d`). For the full tag schema and versioning details, see [Container Images — Tag Schema](../../08-container-images/02-versioning.md#tag-schema).
>
> **Note:** Service users, application credentials, Keystone services, and endpoints are
> not managed by the keystone-operator, but via K-ORC CRs (see [K-ORC](./05-korc.md)).


## Glance Operator

**Repository:** `github.com/c5c3/c5c3/operators/glance`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **glance-operator** manages the Glance Image Service with Ceph RBD backend.

**Provided CRDs:**

| CRD      | API Group                           | Description               |
| -------- | ----------------------------------- | ------------------------- |
| `Glance` | `glance.openstack.c5c3.io/v1alpha1` | Glance Service Deployment |

**Glance CRD:**

```yaml
apiVersion: glance.openstack.c5c3.io/v1alpha1
kind: Glance
metadata:
  name: glance
  namespace: openstack
spec:
  replicas: 2

  image:
    repository: ghcr.io/c5c3/glance
    tag: "31.0.0"

  database:
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    # host: external-db.example.com  # Brownfield alternative
    database: glance
    secretRef:
      name: glance-db-credentials

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: glance-keystone-credentials  # Created by ExternalSecret

  storage:
    backend: rbd
    rbd:
      pool: images
      cephSecretRef:
        name: glance-ceph-credentials
      # Reference to CephClient for keys
      cephClientRef:
        name: glance
        namespace: rook-ceph

  # Dependencies via Conditions
  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: DatabaseReady
      status: "True"
    - type: CephConnected
      status: "True"
  endpoint: https://glance.openstack.svc.cluster.local:9292
```


## Placement Operator

**Repository:** `github.com/c5c3/c5c3/operators/placement`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **placement-operator** manages the Placement Service for resource inventory and allocation.

**Provided CRDs:**

| CRD         | API Group                              | Description                  |
| ----------- | -------------------------------------- | ---------------------------- |
| `Placement` | `placement.openstack.c5c3.io/v1alpha1` | Placement Service Deployment |

**Placement CRD:**

```yaml
apiVersion: placement.openstack.c5c3.io/v1alpha1
kind: Placement
metadata:
  name: placement
  namespace: openstack
spec:
  replicas: 2

  image:
    repository: ghcr.io/c5c3/placement
    tag: "14.0.0"

  database:
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    # host: external-db.example.com  # Brownfield alternative
    database: placement
    secretRef:
      name: placement-db-credentials

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: placement-keystone-credentials  # Created by ExternalSecret

  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
  endpoint: https://placement.openstack.svc.cluster.local:8778
```


## Nova Operator

**Repository:** `github.com/c5c3/c5c3/operators/nova`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **nova-operator** manages the Nova Compute Control Plane (API, Scheduler, Conductor).

**Provided CRDs:**

| CRD    | API Group                         | Description             |
| ------ | --------------------------------- | ----------------------- |
| `Nova` | `nova.openstack.c5c3.io/v1alpha1` | Nova Service Deployment |

**Nova CRD:**

```yaml
apiVersion: nova.openstack.c5c3.io/v1alpha1
kind: Nova
metadata:
  name: nova
  namespace: openstack
spec:
  api:
    replicas: 3
  scheduler:
    replicas: 2
    # Optional: Cortex External Scheduler
    externalScheduler:
      enabled: false
      endpoint: https://cortex.openstack.svc.cluster.local:8080
  conductor:
    replicas: 2

  image:
    repository: ghcr.io/c5c3/nova
    tag: "32.1.0"

  database:
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    # host: external-db.example.com  # Brownfield alternative
    # port: 3306
    database: nova
    apiDatabase: nova_api
    cellDatabase: nova_cell0
    secretRef:
      name: nova-db-credentials

  messaging:
    clusterRef:
      name: rabbitmq               # Managed: references RabbitMQ CR
    # hosts:                        # Brownfield alternative
    #   - external-rmq:5672
    secretRef:
      name: nova-rabbitmq-credentials

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: nova-keystone-credentials  # Created by ExternalSecret

  # Service-to-Service Authentication
  serviceAuth:
    placementServiceUserRef:
      name: placement
    neutronServiceUserRef:
      name: neutron
    glanceServiceUserRef:
      name: glance
    cinderServiceUserRef:
      name: cinder

  cells:
    - name: cell1
      # Hypervisor Cluster Mapping
      computeRef:
        name: hypervisor-cell1

  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready
    - kind: Placement
      name: placement
      condition: Ready
    - kind: Glance
      name: glance
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: APIReady
      status: "True"
    - type: SchedulerReady
      status: "True"
    - type: ConductorReady
      status: "True"
  endpoint: https://nova.openstack.svc.cluster.local:8774
  cells:
    - name: cell1
      status: Ready
      computeNodes: 42
```


## Neutron Operator

**Repository:** `github.com/c5c3/c5c3/operators/neutron`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **neutron-operator** manages the Neutron Networking Control Plane with OVN integration.

**Provided CRDs:**

| CRD       | API Group                            | Description                |
| --------- | ------------------------------------ | -------------------------- |
| `Neutron` | `neutron.openstack.c5c3.io/v1alpha1` | Neutron Service Deployment |

**Neutron CRD:**

```yaml
apiVersion: neutron.openstack.c5c3.io/v1alpha1
kind: Neutron
metadata:
  name: neutron
  namespace: openstack
spec:
  api:
    replicas: 3

  image:
    repository: ghcr.io/c5c3/neutron
    tag: "27.0.1"

  database:
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    # host: external-db.example.com  # Brownfield alternative
    database: neutron
    secretRef:
      name: neutron-db-credentials

  messaging:
    clusterRef:
      name: rabbitmq               # Managed: references RabbitMQ CR
    # hosts:                        # Brownfield alternative
    #   - external-rmq:5672
    secretRef:
      name: neutron-rabbitmq-credentials

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: neutron-keystone-credentials  # Created by ExternalSecret

  # OVN Backend Configuration
  ovn:
    enabled: true
    # OVN Northbound/Southbound Cluster (runs in Control Plane Cluster)
    nbConnection: tcp:ovn-nb.ovn-system:6641
    sbConnection: tcp:ovn-sb.ovn-system:6642

  # ML2 Plugin Configuration
  ml2:
    typeDrivers:
      - geneve
      - vlan
      - flat
    tenantNetworkTypes:
      - geneve
    mechanismDrivers:
      - ovn
    extensionDrivers:
      - port_security

  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: OVNConnected
      status: "True"
  endpoint: https://neutron.openstack.svc.cluster.local:9696
```


## Cinder Operator

**Repository:** `github.com/c5c3/c5c3/operators/cinder`
**Runs in:** Control Plane Cluster (Deployment)
**Namespace:** `openstack`

The **cinder-operator** manages the Cinder Block Storage Control Plane with Ceph RBD backend.

**Provided CRDs:**

| CRD      | API Group                           | Description               |
| -------- | ----------------------------------- | ------------------------- |
| `Cinder` | `cinder.openstack.c5c3.io/v1alpha1` | Cinder Service Deployment |

**Cinder CRD:**

```yaml
apiVersion: cinder.openstack.c5c3.io/v1alpha1
kind: Cinder
metadata:
  name: cinder
  namespace: openstack
spec:
  api:
    replicas: 2
  scheduler:
    replicas: 2

  image:
    repository: ghcr.io/c5c3/cinder
    tag: "27.0.0"

  database:
    clusterRef:
      name: mariadb                # Managed: references MariaDB CR
    # host: external-db.example.com  # Brownfield alternative
    database: cinder
    secretRef:
      name: cinder-db-credentials

  messaging:
    clusterRef:
      name: rabbitmq               # Managed: references RabbitMQ CR
    # hosts:                        # Brownfield alternative
    #   - external-rmq:5672
    secretRef:
      name: cinder-rabbitmq-credentials

  keystone:
    authUrl: https://keystone.openstack.svc.cluster.local:5000/v3
    # Application Credential from K-ORC via OpenBao + ESO
    appCredentialRef:
      secretName: cinder-keystone-credentials  # Created by ExternalSecret

  # Ceph RBD Backend
  backends:
    - name: ceph-rbd
      driver: cinder.volume.drivers.rbd.RBDDriver
      rbd:
        pool: volumes
        cephSecretRef:
          name: cinder-ceph-credentials
        cephClientRef:
          name: cinder
          namespace: rook-ceph

  # Default Volume Type
  defaultVolumeType: ceph-rbd

  dependsOn:
    - kind: Keystone
      name: keystone
      condition: Ready

status:
  conditions:
    - type: Ready
      status: "True"
    - type: CephConnected
      status: "True"
  endpoint: https://cinder.openstack.svc.cluster.local:8776
  backends:
    - name: ceph-rbd
      status: Ready
      availableCapacityGb: 10240
```

## Further Reading

* [C5C3 Operator](./01-c5c3-operator.md) — Creates and manages all service CRs
* [OVN Operator](./03-ovn-operator.md) — SDN backend used by Neutron
* [K-ORC](./05-korc.md) — Manages Keystone service catalog entries
* [Infrastructure Operators](./06-infrastructure-operators.md) — MariaDB, RabbitMQ, Valkey, Memcached backends
* [CRD Definitions](../../04-architecture/01-crds.md)
