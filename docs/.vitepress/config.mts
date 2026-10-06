import { defineConfig, type HeadConfig } from 'vitepress';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The application version is read from the root package.json, never typed here.
const app = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));

export const REPO = 'https://github.com/nasimuddin-dev/testpion';
const SITE = 'https://nasimuddin-dev.github.io/testpion/';
const BASE = '/testpion/';
const SOCIAL_IMAGE = `${SITE}images/social-preview.jpg`;

/** Page URL (clean URLs) for a source file such as `mcp/tools.md`. */
function pageUrl(relativePath: string) {
  const path = relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
  return SITE + path;
}

const titleCase = (s: string) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** schema.org data, limited to facts about the product (no ratings, prices or counts). */
function structuredData(relativePath: string, title: string, description: string) {
  if (relativePath === 'index.md') {
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'TestPion',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Windows 10, Windows 11, macOS 12 or later, Linux',
        softwareVersion: app.version,
        description,
        url: SITE,
        downloadUrl: `${REPO}/releases/latest`,
        screenshot: SOCIAL_IMAGE,
      },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'TestPion', url: SITE },
    ];
  }
  const parts = relativePath.replace(/(^|\/)index\.md$/, '').replace(/\.md$/, '').split('/').filter(Boolean);
  const crumbs = [{ name: 'Home', item: SITE }];
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    crumbs.push({ name: last ? title : titleCase(p), item: SITE + parts.slice(0, i + 1).join('/') + (last ? '' : '/') });
  });
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })),
    },
  ];
}

const docsSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Your first request', link: '/getting-started/first-request' },
      { text: 'Examples workspace', link: '/getting-started/examples' },
      { text: 'Workspaces', link: '/getting-started/workspaces' },
      { text: 'Keep your workspace in git', link: '/getting-started/git' },
      { text: 'Your first AI test', link: '/getting-started/first-ai-test' },
    ],
  },
  {
    text: 'Install',
    items: [
      { text: 'Windows', link: '/installation/windows' },
      { text: 'macOS', link: '/installation/macos' },
      { text: 'Linux', link: '/installation/linux' },
      { text: 'CLI', link: '/installation/cli' },
    ],
  },
  {
    text: 'API Testing',
    items: [
      { text: 'REST & HTTP', link: '/api-testing/rest' },
      { text: 'Authentication', link: '/api-testing/authentication' },
      { text: 'Environments & Variables', link: '/api-testing/environments' },
      { text: 'Cookies', link: '/api-testing/cookies' },
      { text: 'WebSocket', link: '/api-testing/websocket' },
      { text: 'gRPC', link: '/api-testing/grpc' },
      { text: 'Mock Servers', link: '/api-testing/mock-servers' },
      { text: 'Record Traffic', link: '/api-testing/recording' },
      { text: 'HTTP Debugger', link: '/api-testing/http-debugger' },
      { text: 'Collections & Import', link: '/api-testing/collections' },
    ],
  },
  {
    text: 'GraphQL',
    items: [
      { text: 'Overview', link: '/graphql/overview' },
      { text: 'Schema Explorer', link: '/graphql/schema-explorer' },
      { text: 'Subscriptions', link: '/graphql/subscriptions' },
      { text: 'Testing', link: '/graphql/testing' },
      { text: 'Mock Server', link: '/graphql/mocking' },
    ],
  },
  {
    text: 'MCP',
    items: [
      { text: 'Overview', link: '/mcp/overview' },
      { text: 'Connecting', link: '/mcp/connecting' },
      { text: 'Tools', link: '/mcp/tools' },
      { text: 'Resources & Prompts', link: '/mcp/resources' },
      { text: 'Elicitation & Sampling', link: '/mcp/client-features' },
      { text: 'Debugging', link: '/mcp/debugging' },
      { text: 'Mock Server', link: '/mcp/mocking' },
    ],
  },
  {
    text: 'AI Testing',
    items: [
      { text: 'Overview', link: '/ai-testing/overview' },
      { text: 'Prompts', link: '/ai-testing/prompts' },
      { text: 'Evaluations', link: '/ai-testing/evaluations' },
      { text: 'RAG', link: '/ai-testing/rag' },
      { text: 'Agents', link: '/ai-testing/agents' },
      { text: 'Safety', link: '/ai-testing/safety' },
      { text: 'Use from AI agents (MCP)', link: '/ai-testing/mcp-server' },
    ],
  },
  {
    text: 'Test Runner',
    items: [
      { text: 'Overview', link: '/test-runner/overview' },
      { text: 'Assertions', link: '/test-runner/assertions' },
      { text: 'Datasets', link: '/test-runner/datasets' },
      { text: 'CI/CD', link: '/test-runner/ci-cd' },
      { text: 'Integration testing', link: '/test-runner/integration-testing' },
      { text: 'Monitors', link: '/test-runner/monitors' },
      { text: 'Traces & OpenTelemetry', link: '/test-runner/traces' },
    ],
  },
  {
    text: 'Performance',
    items: [
      { text: 'Load Testing', link: '/performance/load-testing' },
      { text: 'Benchmarks', link: '/performance/benchmarks' },
    ],
  },
  {
    text: 'Security',
    items: [
      { text: 'Secrets', link: '/security/secrets' },
      { text: 'API Security Checks', link: '/security/api-security' },
      { text: 'Privacy & Redaction', link: '/security/privacy' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'CLI', link: '/cli/reference' },
      { text: 'Architecture', link: '/architecture/overview' },
      { text: 'Design', link: '/architecture/design' },
      { text: 'Execution Engine', link: '/architecture/execution-engine' },
      { text: 'Plugin System', link: '/architecture/plugin-system' },
      { text: 'Development', link: '/contributing/development' },
      { text: 'Contributor Notes', link: '/contributing/architecture' },
    ],
  },
];

const DOC_SECTIONS = ['getting-started', 'installation', 'api-testing', 'graphql', 'mcp', 'ai-testing', 'test-runner', 'performance', 'security', 'cli', 'architecture', 'contributing'];

export default defineConfig({
  lang: 'en-US',
  title: 'TestPion',
  titleTemplate: ':title | TestPion',
  description: 'TestPion is a local-first desktop app and CLI for testing and debugging REST, GraphQL and MCP servers, LLM APIs, RAG pipelines and AI agents on Windows, macOS and Linux.',
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  markdown: { theme: { light: 'github-light-high-contrast', dark: 'github-dark' } },
  sitemap: { hostname: SITE, transformItems: (items) => items.filter((i) => !/(^|\/)404$/.test(i.url)) },
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: `${BASE}icon-192.png` }],
    ['link', { rel: 'icon', href: `${BASE}favicon.ico`, sizes: '48x48' }],
    ['link', { rel: 'apple-touch-icon', href: `${BASE}apple-touch-icon.png` }],
    ['link', { rel: 'manifest', href: `${BASE}site.webmanifest` }],
    ['meta', { name: 'theme-color', content: '#0c1440' }],
    ['meta', { property: 'og:site_name', content: 'TestPion' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:image', content: SOCIAL_IMAGE }],
    ['meta', { property: 'og:image:alt', content: 'TestPion — Connect every protocol' }],
    ['meta', { property: 'og:image:width', content: '1280' }],
    ['meta', { property: 'og:image:height', content: '640' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: SOCIAL_IMAGE }],
  ],
  transformHead({ pageData, title, description }) {
    if (pageData.isNotFound) return [['meta', { name: 'robots', content: 'noindex' }]];
    const url = pageUrl(pageData.relativePath);
    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
    ];
    for (const data of structuredData(pageData.relativePath, pageData.title, description)) head.push(['script', { type: 'application/ld+json' }, JSON.stringify(data)]);
    return head;
  },
  themeConfig: {
    // the TestPion wordmark replaces the icon + text title (on a navy badge in light mode, see custom.css)
    logo: { src: '/wordmark-nav.png', alt: 'TestPion' },
    siteTitle: false,
    nav: [
      { text: 'Download', link: '/download' },
      { text: 'Features', link: '/features' },
      { text: 'Documentation', link: '/getting-started/installation', activeMatch: `^/(${DOC_SECTIONS.join('|')})/` },
      { text: 'FAQ', link: '/faq' },
      { text: 'Changelog', link: '/changelog' },
      { text: 'Roadmap', link: '/roadmap' },
      {
        text: `v${app.version}`,
        items: [
          { text: 'Release notes', link: '/changelog' },
          { text: 'All releases on GitHub', link: `${REPO}/releases` },
        ],
      },
    ],
    sidebar: Object.fromEntries(DOC_SECTIONS.map((s) => [`/${s}/`, docsSidebar])),
    socialLinks: [{ icon: 'github', link: REPO, ariaLabel: 'TestPion on GitHub' }],
    editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: {
      message: `TestPion ${app.version} · MIT License · <a href="${REPO}">GitHub</a> · <a href="${REPO}/issues">Issues</a> · <a href="${REPO}/releases">Releases</a>`,
    },
  },
});
