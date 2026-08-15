import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(projectRoot, 'dist');
const staticEntries = ['404.html', 'index.html', 'robots.txt', 'sitemap.xml', 'css', 'js'];

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

for (const entry of staticEntries) {
  await cp(resolve(projectRoot, entry), resolve(outputDirectory, entry), { recursive: true });
}

const pageNames = await readdir(resolve(projectRoot, 'pages'));

for (const pageName of pageNames.filter((name) => name.endsWith('.html'))) {
  await cp(resolve(projectRoot, 'pages', pageName), resolve(outputDirectory, pageName));
}
