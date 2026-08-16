import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');
const binaryExtensions = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.webp',
]);
const secretPatterns = [
  ['API key', /\bsk-[A-Za-z0-9_-]{16,}\b/u],
  ['Stripe secret key', /\b(?:r|s)k_(?:live|test)_[A-Za-z0-9]{16,}\b/u],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{16,}\b/u],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u],
  ['JWT', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/u],
  ['Private key', /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u],
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard'], {
  cwd: projectRoot,
});
const repositoryFiles = stdout
  .split('\n')
  .filter(Boolean)
  .map((filePath) => resolve(projectRoot, filePath));
const deploymentFiles = await collectFiles(resolve(projectRoot, 'dist'));
const filesToScan = [...new Set([...repositoryFiles, ...deploymentFiles])];
const findings = [];

for (const filePath of filesToScan) {
  if (binaryExtensions.has(extname(filePath).toLowerCase())) {
    continue;
  }

  const contents = await readFile(filePath, 'utf8').catch(() => null);

  if (contents === null || contents.includes('\0')) {
    continue;
  }

  for (const [patternName, pattern] of secretPatterns) {
    if (pattern.test(contents)) {
      findings.push(`${relative(projectRoot, filePath)}: ${patternName}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secrets detected:');
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${filesToScan.length} files checked).`);
}
