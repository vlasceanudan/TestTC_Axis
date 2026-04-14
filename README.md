# Trimble Connect Alignment Labeller

Static Vite app for labeling IFC and LandXML alignments inside the Trimble Connect 3D viewer.

## Local development

Install dependencies and run the dev server:

```bash
npm install
npm run dev
```

The local Trimble add-on manifest remains [manifest.json](manifest.json) and keeps its panel URL as `index.html` for development-time loading.

## GitHub Pages deployment

This repository includes a GitHub Actions workflow at [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml) that:

1. installs dependencies,
2. builds the app,
3. generates a hosted Trimble manifest for the deployed URL,
4. publishes `dist/` to GitHub Pages.

After the repository is pushed to GitHub and Pages is enabled, the hosted site URL is:

`https://<github-owner>.github.io/trimble-connect-add-on/`

If the repository name changes, replace `trimble-connect-add-on` with the actual repo name. If the repository itself is named `<github-owner>.github.io`, the site URL becomes:

`https://<github-owner>.github.io/`

Each deployment also publishes:

- the hosted app entrypoint: `.../index.html`
- the hosted tester manifest: `.../manifest.hosted.json`

The deployment job writes the exact URLs into the GitHub Actions job summary.

## Testing via GitHub Pages

Use the deployed GitHub Pages panel URL in Trimble Connect:

`https://<github-owner>.github.io/trimble-connect-add-on/index.html`

Testers should open the Trimble Connect 3D viewer, register that hosted URL as the add-on panel URL, and then load IFC or LandXML models before using the tool.

Detailed tester onboarding is documented in [docs/testing-github-pages.md](docs/testing-github-pages.md).

## Deployment verification

After a deployment completes, verify:

1. the GitHub Pages site loads without missing assets,
2. `manifest.hosted.json` is reachable from the deployed site,
3. the hosted panel opens inside Trimble Connect,
4. label placement and clipping work against loaded IFC or LandXML models.
