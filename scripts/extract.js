#!/usr/bin/env node
/**
 * Extract Wispr Flow from Windows Squirrel installer:
 * 1. Extract .exe with 7z -> get .nupkg
 * 2. Extract .nupkg (zip) -> get Electron app files
 * 3. Extract app.asar -> get application code
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const EXE_PATH = path.join(TMP_DIR, 'wispr-flow-setup.exe');
const EXTRACTED_DIR = path.join(TMP_DIR, 'extracted');
const NUPKG_DIR = path.join(TMP_DIR, 'nupkg-content');
const APP_DIR = path.join(TMP_DIR, 'app');

function findNupkg(dir) {
  const files = fs.readdirSync(dir);
  return files.find(f => f.endsWith('.nupkg'));
}

function getAppVersion() {
  const pkgPath = path.join(APP_DIR, 'asar-content', 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version;
  }
  return null;
}

function getElectronVersion() {
  const pkgPath = path.join(APP_DIR, 'asar-content', 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.devDependencies && pkg.devDependencies.electron) {
      return pkg.devDependencies.electron;
    }
  }
  return null;
}

function main() {
  if (!fs.existsSync(EXE_PATH)) {
    console.error('Installer not found. Run "npm run download" first.');
    process.exit(1);
  }

  // Step 1: Extract Squirrel installer
  console.log('Step 1: Extracting Squirrel installer...');
  if (fs.existsSync(EXTRACTED_DIR)) {
    fs.rmSync(EXTRACTED_DIR, { recursive: true });
  }
  fs.mkdirSync(EXTRACTED_DIR, { recursive: true });
  execSync(`7z x "${EXE_PATH}" -o"${EXTRACTED_DIR}" -y`, { stdio: 'pipe' });

  const nupkgFile = findNupkg(EXTRACTED_DIR);
  if (!nupkgFile) {
    console.error('No .nupkg file found in extracted installer');
    process.exit(1);
  }
  console.log(`  Found: ${nupkgFile}`);

  // Step 2: Extract nupkg (it's a zip file)
  console.log('Step 2: Extracting nupkg...');
  if (fs.existsSync(NUPKG_DIR)) {
    fs.rmSync(NUPKG_DIR, { recursive: true });
  }
  fs.mkdirSync(NUPKG_DIR, { recursive: true });
  execSync(`7z x "${path.join(EXTRACTED_DIR, nupkgFile)}" -o"${NUPKG_DIR}" -y`, { stdio: 'pipe' });

  const appFilesDir = path.join(NUPKG_DIR, 'lib', 'net45');
  if (!fs.existsSync(appFilesDir)) {
    console.error('Expected app files not found in nupkg');
    process.exit(1);
  }

  // Step 3: Extract app.asar
  console.log('Step 3: Extracting app.asar...');
  const asarPath = path.join(appFilesDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.error('app.asar not found');
    process.exit(1);
  }

  if (fs.existsSync(APP_DIR)) {
    fs.rmSync(APP_DIR, { recursive: true });
  }
  fs.mkdirSync(APP_DIR, { recursive: true });

  const asarContentDir = path.join(APP_DIR, 'asar-content');
  execSync(`npx asar extract "${asarPath}" "${asarContentDir}"`, { stdio: 'pipe' });

  // Copy non-asar resources
  const resourcesDir = path.join(appFilesDir, 'resources');
  const destResourcesDir = path.join(APP_DIR, 'resources');
  fs.mkdirSync(destResourcesDir, { recursive: true });

  for (const item of fs.readdirSync(resourcesDir)) {
    if (item === 'app.asar') continue;
    const src = path.join(resourcesDir, item);
    const dest = path.join(destResourcesDir, item);
    execSync(`cp -r "${src}" "${dest}"`);
  }

  const version = getAppVersion();
  const electronVersion = getElectronVersion();

  // Save metadata
  const metadata = {
    appVersion: version,
    electronVersion: electronVersion,
    extractedAt: new Date().toISOString(),
    nupkgFile: nupkgFile
  };
  fs.writeFileSync(path.join(APP_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));

  console.log(`\nExtraction complete!`);
  console.log(`  App version: ${version}`);
  console.log(`  Electron version: ${electronVersion}`);
  console.log(`  App dir: ${APP_DIR}`);
}

main();
