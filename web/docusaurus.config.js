// @ts-check
// Docusaurus config for the Spyglass docs site. The docs live in web/docs.
// Update `url`, `baseUrl`, and the org/project names to match where you publish.

const { themes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Spyglass',
  tagline: 'A small, domain-agnostic Cube-style semantic layer.',
  favicon: 'img/favicon.ico',

  // Set these to your published site. For GitHub Pages this is normally
  // https://<org>.github.io and /<repo>/.
  url: 'https://spyglass-dev.github.io',
  baseUrl: '/spyglass/',

  organizationName: 'spyglass-dev', // GitHub org/user
  projectName: 'spyglass', // repo name
  trailingSlash: false,

  onBrokenLinks: 'warn',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          // Docs live in web/docs (the standard Docusaurus location).
          routeBasePath: '/',
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl:
            'https://github.com/spyglass-dev/spyglass/tree/main/web/docs/',
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: 'Spyglass',
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docs',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'https://github.com/spyglass-dev/spyglass',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Introduction', to: '/' },
              { label: 'Getting started', to: '/getting-started' },
              { label: 'Cube format', to: '/cube-format' },
            ],
          },
          {
            title: 'Ecosystem',
            items: [
              { label: 'Cube (the format)', href: 'https://github.com/cube-js/cube' },
              { label: 'distri', href: 'https://github.com/distri-ai/distri' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'GitHub', href: 'https://github.com/spyglass-dev/spyglass' },
              { label: 'License', href: 'https://github.com/spyglass-dev/spyglass/blob/main/LICENSE.md' },
            ],
          },
        ],
        copyright: `Spyglass — Apache-2.0 licensed.`,
      },
      prism: {
        theme: themes.github,
        darkTheme: themes.dracula,
        additionalLanguages: ['rust', 'bash', 'toml', 'yaml', 'json'],
      },
    }),
};

module.exports = config;
