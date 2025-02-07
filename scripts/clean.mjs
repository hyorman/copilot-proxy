import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const removableDirectories = new Set(['node_modules', 'out']);
const removableFiles = new Set(['tsconfig.tsbuildinfo']);
const skippedDirectories = new Set(['.git']);
const dryRun = process.argv.includes('--dry-run');

const removedDirectories = [];
const removedFiles = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isFile() && removableFiles.has(entry.name)) {
      removedFiles.push(path.relative(rootDir, entryPath) || '.');

      if (!dryRun) {
        await rm(entryPath, { force: true });
      }

      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    if (skippedDirectories.has(entry.name)) {
      continue;
    }

    if (removableDirectories.has(entry.name)) {
      removedDirectories.push(path.relative(rootDir, entryPath) || '.');

      if (!dryRun) {
        await rm(entryPath, { recursive: true, force: true });
      }

      continue;
    }

    await walk(entryPath);
  }
}

await walk(rootDir);

if (removedDirectories.length === 0 && removedFiles.length === 0) {
  console.log(`No matching directories found under ${rootDir}`);
  process.exit(0);
}

const action = dryRun ? 'Would remove' : 'Removed';

for (const directory of removedDirectories.sort()) {
  console.log(`${action}: ${directory}`);
}

for (const file of removedFiles.sort()) {
  console.log(`${action}: ${file}`);
}