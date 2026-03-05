#!/usr/bin/env node
/**
 * Rebuild native Node.js modules for Linux
 * Currently only sqlite3 needs rebuilding (the only real .node native module)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const APP_DIR = path.join(TMP_DIR, 'app');
const ASAR_DIR = path.join(APP_DIR, 'asar-content');

function getMetadata() {
  const metaPath = path.join(APP_DIR, 'metadata.json');
  if (!fs.existsSync(metaPath)) {
    console.error('metadata.json not found. Run extract first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function rebuildSqlite3(electronVersion) {
  console.log('Rebuilding sqlite3 for Linux...');

  const sqliteNodePath = path.join(
    ASAR_DIR, '.webpack', 'main', 'native_modules', 'build', 'Release', 'node_sqlite3.node'
  );

  if (!fs.existsSync(sqliteNodePath)) {
    console.warn('sqlite3 native module not found, skipping');
    return;
  }

  // Create a temporary directory to build sqlite3
  const buildDir = path.join(TMP_DIR, 'sqlite3-build');
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });

  // Get the electron ABI version
  // Electron 39.x uses Node 22.x ABI
  const electronMajor = parseInt(electronVersion.split('.')[0], 10);

  console.log(`  Electron version: ${electronVersion}`);

  // Install sqlite3 and rebuild for electron
  try {
    execSync('npm init -y', { cwd: buildDir, stdio: 'pipe' });

    // Install sqlite3 with the same version used by the app
    // sqlite3 ^5.1.7 as per original package.json
    execSync('npm install sqlite3@5.1.7', {
      cwd: buildDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_target: electronVersion,
        npm_config_disturl: 'https://electronjs.org/headers',
        npm_config_runtime: 'electron',
        npm_config_build_from_source: 'true',
      }
    });

    // Find the built .node file
    const builtNodeFile = findFile(buildDir, 'node_sqlite3.node');
    if (builtNodeFile) {
      fs.copyFileSync(builtNodeFile, sqliteNodePath);
      console.log(`  Replaced sqlite3 native module: ${builtNodeFile}`);
    } else {
      // Try alternative: use @electron/rebuild
      console.log('  Trying @electron/rebuild...');
      execSync(`npx @electron/rebuild -v ${electronVersion} -m ${buildDir}`, {
        cwd: buildDir,
        stdio: 'inherit',
      });

      const rebuiltFile = findFile(buildDir, 'node_sqlite3.node');
      if (rebuiltFile) {
        fs.copyFileSync(rebuiltFile, sqliteNodePath);
        console.log(`  Replaced sqlite3 native module via @electron/rebuild`);
      } else {
        console.error('  ERROR: Could not find rebuilt sqlite3 native module');
      }
    }
  } catch (err) {
    console.error(`  sqlite3 rebuild failed: ${err.message}`);
    console.log('  Trying prebuilt binary...');

    // Fallback: try to download prebuilt
    try {
      execSync('npm install sqlite3@5.1.7 --build-from-source=false', {
        cwd: buildDir,
        stdio: 'inherit'
      });
      const prebuiltFile = findFile(buildDir, 'node_sqlite3.node');
      if (prebuiltFile) {
        fs.copyFileSync(prebuiltFile, sqliteNodePath);
        console.log(`  Used prebuilt sqlite3: ${prebuiltFile}`);
      }
    } catch (err2) {
      console.error(`  Prebuilt fallback also failed: ${err2.message}`);
    }
  }

  // Cleanup
  // fs.rmSync(buildDir, { recursive: true });
}

function findFile(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findFile(fullPath, filename);
      if (found) return found;
    }
  }
  return null;
}

function main() {
  console.log('=== Rebuilding native modules for Linux ===\n');

  const metadata = getMetadata();
  const electronVersion = metadata.electronVersion;

  if (!electronVersion) {
    console.error('Cannot determine Electron version from metadata');
    process.exit(1);
  }

  rebuildSqlite3(electronVersion);

  console.log('\n=== Native module rebuild complete ===');
}

main();
