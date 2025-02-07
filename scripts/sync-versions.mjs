import fs from 'fs';
import path from 'path';

const root = process.cwd();
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { version, workspaces } = rootPkg;

const workspacePackageNames = new Set();

for (const ws of workspaces) {
  const pkgPath = path.join(root, ws, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  workspacePackageNames.add(pkg.name);
}

function syncWorkspaceDependencies(dependencyGroup) {
  if (!dependencyGroup) {
    return;
  }

  for (const dependencyName of Object.keys(dependencyGroup)) {
    if (workspacePackageNames.has(dependencyName)) {
      dependencyGroup[dependencyName] = `^${version}`;
    }
  }
}

for (const ws of workspaces) {
  const pkgPath = path.join(root, ws, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  syncWorkspaceDependencies(pkg.dependencies);
  syncWorkspaceDependencies(pkg.devDependencies);
  syncWorkspaceDependencies(pkg.peerDependencies);
  syncWorkspaceDependencies(pkg.optionalDependencies);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Updated ${ws}/package.json → ${version}`);
}
