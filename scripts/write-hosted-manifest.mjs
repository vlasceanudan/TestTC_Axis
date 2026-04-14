import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const manifestPath = path.join(projectRoot, "manifest.json");

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizeUrl(value) {
  return `${trimTrailingSlash(value)}/`;
}

function inferHostedSiteUrl() {
  const explicitUrl = process.env.HOSTED_APP_URL?.trim();
  if (explicitUrl) {
    return normalizeUrl(explicitUrl);
  }

  const pagesUrl = process.env.GITHUB_PAGES_URL?.trim();
  if (pagesUrl) {
    return normalizeUrl(pagesUrl);
  }

  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository || !repository.includes("/")) {
    return "https://<github-username>.github.io/trimble-connect-add-on/";
  }

  const [owner, repo] = repository.split("/", 2);
  if (!owner || !repo) {
    return "https://<github-username>.github.io/trimble-connect-add-on/";
  }

  if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${owner}.github.io/`;
  }

  return `https://${owner}.github.io/${repo}/`;
}

function buildPanelUrl(siteUrl) {
  if (siteUrl.includes("<") || siteUrl.includes(">")) {
    return `${siteUrl}index.html`;
  }

  return new URL("index.html", siteUrl).toString();
}

const siteUrl = inferHostedSiteUrl();
const panelUrl = buildPanelUrl(siteUrl);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const hostedManifest = {
  ...manifest,
  extension: {
    ...manifest.extension,
    panel: {
      ...manifest.extension?.panel,
      url: panelUrl,
    },
  },
};

await mkdir(distDir, { recursive: true });
await writeFile(
  path.join(distDir, "manifest.hosted.json"),
  `${JSON.stringify(hostedManifest, null, 2)}\n`,
  "utf8"
);
await writeFile(path.join(distDir, "hosted-site-url.txt"), `${siteUrl}\n`, "utf8");
await writeFile(path.join(distDir, "hosted-panel-url.txt"), `${panelUrl}\n`, "utf8");

console.log(`Hosted site URL: ${siteUrl}`);
console.log(`Hosted panel URL: ${panelUrl}`);
