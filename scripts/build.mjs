import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(projectRoot, 'dist');
const staticEntries = ['404.html', 'index.html', 'robots.txt', 'sitemap.xml', 'auth', 'css', 'js'];

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

for (const entry of staticEntries) {
  await cp(resolve(projectRoot, entry), resolve(outputDirectory, entry), { recursive: true });
}

const pageNames = await readdir(resolve(projectRoot, 'pages'));

for (const pageName of pageNames.filter((name) => name.endsWith('.html'))) {
  await cp(resolve(projectRoot, 'pages', pageName), resolve(outputDirectory, pageName));
}

await build({
  bundle: true,
  entryPoints: [resolve(projectRoot, 'src', 'client', 'auth.ts')],
  format: 'iife',
  legalComments: 'none',
  minify: true,
  outfile: resolve(outputDirectory, 'js', 'auth.js'),
  platform: 'browser',
  sourcemap: false,
  target: ['es2022'],
});

await build({
  bundle: true,
  entryPoints: [resolve(projectRoot, 'src', 'client', 'rewrite.ts')],
  format: 'iife',
  legalComments: 'none',
  minify: true,
  outfile: resolve(outputDirectory, 'js', 'rewrite.js'),
  platform: 'browser',
  sourcemap: false,
  target: ['es2022'],
});
