# web/ — Spyglass documentation site

A [Docusaurus](https://docusaurus.io) site. The documentation lives alongside it
in [`docs/`](./docs) (the standard Docusaurus location), so the site is
self-contained and ready to publish.

## Local development

```bash
cd web
pnpm install        # or npm install
pnpm start          # dev server with hot reload at http://localhost:3000
pnpm build          # static build into web/build
pnpm serve          # serve the production build locally
```

Add a Markdown file under `docs/` (with `sidebar_position` frontmatter) and it
shows up in the sidebar automatically.

## Publishing

`.github/workflows/docs.yml` builds this site and deploys it to GitHub Pages on
every push to `main`. Update `url`, `baseUrl`, `organizationName`, and
`projectName` in `docusaurus.config.js` to match where you publish.
