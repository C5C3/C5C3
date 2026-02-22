import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'C5C3 - CobaltCore',
  description: 'A Kubernetes-native OpenStack distribution for operating Hosted Control Planes',
  base: '/C5C3/',
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
    ],
    sidebar: [
      { text: 'Introduction', link: '/01-introduction' },
      { text: 'Architecture Overview', link: '/02-architecture-overview' },
      {
        text: 'Core Components',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/03-components/' },
          { text: 'Control Plane', link: '/03-components/01-control-plane' },
          { text: 'Hypervisor', link: '/03-components/02-hypervisor' },
          { text: 'Management', link: '/03-components/03-management' },
          { text: 'Storage', link: '/03-components/04-storage' },
        ]
      },
      { text: 'CRDs', link: '/04-crds' },
      { text: 'Component Interaction', link: '/05-component-interaction' },
      { text: 'Hypervisor Lifecycle', link: '/06-hypervisor-lifecycle' },
      { text: 'High Availability', link: '/07-high-availability' },
      { text: 'Cortex Scheduling', link: '/08-cortex-scheduling' },
      { text: 'Storage Architecture', link: '/09-storage-architecture' },
      { text: 'Network Architecture', link: '/10-network-architecture' },
      {
        text: 'GitOps with FluxCD',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/11-gitops-fluxcd/' },
          { text: 'Credential Lifecycle', link: '/11-gitops-fluxcd/01-credential-lifecycle' },
          { text: 'Dependency Management', link: '/11-gitops-fluxcd/02-dependency-management' },
          { text: 'Helm Deployment', link: '/11-gitops-fluxcd/03-helm-deployment' },
          { text: 'Bootstrap', link: '/11-gitops-fluxcd/04-bootstrap' },
        ]
      },
      {
        text: 'Crossplane',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/12-crossplane/' },
          { text: 'Cluster Provisioning', link: '/12-crossplane/01-cluster-provisioning' },
          { text: 'OpenStack Cluster Provisioning', link: '/12-crossplane/02-openstack-provisioning' },
          { text: 'Operations', link: '/12-crossplane/03-operations' },
        ]
      },
      { text: 'Secret Management', link: '/13-secret-management' },
      { text: 'Upgrades', link: '/14-upgrades' },
      {
        text: 'Observability',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/15-observability/' },
          { text: 'Metrics', link: '/15-observability/01-metrics' },
          { text: 'Logging', link: '/15-observability/02-logging' },
          { text: 'Tracing', link: '/15-observability/03-tracing' },
          { text: 'Libvirt Telemetry', link: '/15-observability/04-libvirt-telemetry' },
        ]
      },
      { text: 'Brownfield Integration', link: '/16-brownfield-integration' },
      {
        text: 'Container Images',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/17-container-images/' },
          { text: 'Build Pipeline', link: '/17-container-images/01-build-pipeline' },
          { text: 'Versioning', link: '/17-container-images/02-versioning' },
          { text: 'Patching', link: '/17-container-images/03-patching' },
          { text: 'SBOM', link: '/17-container-images/04-sbom' },
        ]
      },
      {
        text: 'Service Configuration',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/18-service-configuration/' },
          { text: 'Config Generation', link: '/18-service-configuration/01-config-generation' },
          { text: 'Validation', link: '/18-service-configuration/02-validation' },
          { text: 'Customization', link: '/18-service-configuration/03-customization' },
          { text: 'Landscape', link: '/18-service-configuration/04-landscape' },
        ]
      },
      {
        text: 'Implementation',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/19-implementation/' },
          { text: 'Project Setup', link: '/19-implementation/01-project-setup' },
          { text: 'Shared Library', link: '/19-implementation/02-shared-library' },
          { text: 'CRD Implementation', link: '/19-implementation/03-crd-implementation' },
          { text: 'Keystone Reconciler', link: '/19-implementation/04-keystone-reconciler' },
          { text: 'Keystone Dependencies', link: '/19-implementation/05-keystone-dependencies' },
          { text: 'Testing', link: '/19-implementation/06-testing' },
          { text: 'CI/CD & Packaging', link: '/19-implementation/07-ci-cd-and-packaging' },
          { text: 'C5C3 Operator', link: '/19-implementation/08-c5c3-operator' },
          { text: 'OpenBao Deployment', link: '/19-implementation/09-openbao-deployment' },
        ]
      },
      {
        text: 'Appendix',
        collapsed: false,
        items: [
          { text: 'Related Projects', link: '/A1-related-projects' },
        ]
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/c5c3/c5c3' },
    ],
  },
})
