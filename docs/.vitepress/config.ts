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
      {
        text: 'Architecture Deep Dives',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/04-architecture/' },
          { text: 'CRDs', link: '/04-architecture/01-crds' },
          { text: 'Component Interaction', link: '/04-architecture/02-component-interaction' },
          { text: 'Hypervisor Lifecycle', link: '/04-architecture/03-hypervisor-lifecycle' },
          { text: 'High Availability', link: '/04-architecture/04-high-availability' },
          { text: 'Cortex Scheduling', link: '/04-architecture/05-cortex-scheduling' },
          { text: 'Storage Architecture', link: '/04-architecture/06-storage' },
          { text: 'Network Architecture', link: '/04-architecture/07-network' },
        ]
      },
      {
        text: 'Deployment',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/05-deployment/' },
          {
            text: 'GitOps with FluxCD',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/05-deployment/01-gitops-fluxcd/' },
              { text: 'Credential Lifecycle', link: '/05-deployment/01-gitops-fluxcd/01-credential-lifecycle' },
              { text: 'Dependency Management', link: '/05-deployment/01-gitops-fluxcd/02-dependency-management' },
              { text: 'Helm Deployment', link: '/05-deployment/01-gitops-fluxcd/03-helm-deployment' },
              { text: 'Bootstrap', link: '/05-deployment/01-gitops-fluxcd/04-bootstrap' },
            ]
          },
          { text: 'Secret Management', link: '/05-deployment/02-secret-management' },
          {
            text: 'Service Configuration',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/05-deployment/03-service-configuration/' },
              { text: 'Config Generation', link: '/05-deployment/03-service-configuration/01-config-generation' },
              { text: 'Validation', link: '/05-deployment/03-service-configuration/02-validation' },
              { text: 'Customization', link: '/05-deployment/03-service-configuration/03-customization' },
              { text: 'Landscape', link: '/05-deployment/03-service-configuration/04-landscape' },
            ]
          },
        ]
      },
      {
        text: 'Operations',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/06-operations/' },
          { text: 'Upgrades', link: '/06-operations/01-upgrades' },
          {
            text: 'Observability',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/06-operations/02-observability/' },
              { text: 'Metrics', link: '/06-operations/02-observability/01-metrics' },
              { text: 'Logging', link: '/06-operations/02-observability/02-logging' },
              { text: 'Tracing', link: '/06-operations/02-observability/03-tracing' },
              { text: 'Libvirt Telemetry', link: '/06-operations/02-observability/04-libvirt-telemetry' },
            ]
          },
          { text: 'Brownfield Integration', link: '/06-operations/03-brownfield-integration' },
        ]
      },
      {
        text: 'Crossplane',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/07-crossplane/' },
          { text: 'Cluster Provisioning', link: '/07-crossplane/01-cluster-provisioning' },
          { text: 'OpenStack Cluster Provisioning', link: '/07-crossplane/02-openstack-provisioning' },
          { text: 'Operations', link: '/07-crossplane/03-operations' },
        ]
      },
      {
        text: 'Container Images',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/08-container-images/' },
          { text: 'Build Pipeline', link: '/08-container-images/01-build-pipeline' },
          { text: 'Versioning', link: '/08-container-images/02-versioning' },
          { text: 'Patching', link: '/08-container-images/03-patching' },
          { text: 'SBOM', link: '/08-container-images/04-sbom' },
        ]
      },
      {
        text: 'Implementation',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/09-implementation/' },
          { text: 'Project Setup', link: '/09-implementation/01-project-setup' },
          { text: 'Shared Library', link: '/09-implementation/02-shared-library' },
          { text: 'CRD Implementation', link: '/09-implementation/03-crd-implementation' },
          { text: 'Keystone Reconciler', link: '/09-implementation/04-keystone-reconciler' },
          { text: 'Keystone Dependencies', link: '/09-implementation/05-keystone-dependencies' },
          { text: 'Testing', link: '/09-implementation/06-testing' },
          { text: 'CI/CD & Packaging', link: '/09-implementation/07-ci-cd-and-packaging' },
          { text: 'C5C3 Operator', link: '/09-implementation/08-c5c3-operator' },
          { text: 'OpenBao Deployment', link: '/09-implementation/09-openbao-deployment' },
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
