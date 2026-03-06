#!/usr/bin/env node
/**
 * Patch Wispr Flow for Linux compatibility:
 * 1. Patch main process webpack bundle for Linux helper path
 * 2. Remove Windows-specific native modules (crypt32/win-ca)
 * 3. Adjust platform checks where needed
 * 4. Copy Linux helper into resources
 */

const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const APP_DIR = path.join(TMP_DIR, 'app');
const ASAR_DIR = path.join(APP_DIR, 'asar-content');
const HELPER_SRC = path.join(__dirname, '..', 'linux-helper');
const MAIN_BUNDLE = path.join(ASAR_DIR, '.webpack', 'main', 'index.js');

function patchMainBundle() {
  console.log('Patching main webpack bundle...');

  if (!fs.existsSync(MAIN_BUNDLE)) {
    console.error(`Main bundle not found: ${MAIN_BUNDLE}`);
    process.exit(1);
  }

  let code = fs.readFileSync(MAIN_BUNDLE, 'utf8');
  const originalSize = code.length;

  // ---- Patch 1: Helper path for Linux ----
  // Original Windows: `${O.ZI}\\Release\\Wispr Flow Helper.exe`
  // Original Mac: `${O.ZI}/swift-helper-app-dist/Wispr Flow.app/Contents/MacOS/Wispr Flow`
  // We need to add a Linux branch that points to our Node.js helper

  // The helper launch code checks u.tD (isMac) and falls through to Windows
  // We need to intercept and add Linux support

  // Pattern: Running packaged Windows Helper service
  const winHelperPattern = /(\w+)\.info\("Running packaged Windows Helper service"\),`\$\{(\w+)\.(\w+)\}\\\\Release\\\\Wispr Flow Helper\.exe`/;
  const winHelperMatch = code.match(winHelperPattern);

  if (winHelperMatch) {
    const logFn = winHelperMatch[1];
    const pathModule = winHelperMatch[2];
    const pathProp = winHelperMatch[3];
    console.log(`  Found Windows helper path pattern (log=${logFn}, path=${pathModule}.${pathProp})`);

    // Replace the entire helper path selection block
    // We need to find the full ternary and add Linux before Windows
    // The structure is: u.tD ? <mac_path> : <isDevHelper> ? <dev_win_path> : <prod_win_path>
    // We want: u.tD ? <mac_path> : "linux" === process.platform ? <linux_path> : <original_win_logic>

    // Find the broader context
    const helperPathRegex = /(const r=)(.*?isHelperProcessRunningManually.*?"Running packaged Windows Helper service"\),`\$\{(\w+)\.(\w+)\}\\\\Release\\\\Wispr Flow Helper\.exe`)/s;
    const fullMatch = code.match(helperPathRegex);

    if (fullMatch) {
      const varDecl = fullMatch[1]; // "const r="
      const originalExpr = fullMatch[2];
      const pMod = fullMatch[3];
      const pProp = fullMatch[4];

      // Insert Linux check right after "const r="
      // Linux helper is a Node.js script, launched via node
      const linuxPath = `"linux"===process.platform?(${logFn}.info("Running Linux Helper service"),\`\${${pMod}.${pProp}}/linux-helper/main.js\`):`;

      const patched = varDecl + linuxPath + originalExpr;
      code = code.replace(fullMatch[0], patched);
      console.log('  Patched helper path: added Linux branch');
    }
  } else {
    console.warn('  WARNING: Could not find Windows helper path pattern');
    console.warn('  Attempting alternative patch strategy...');

    // Alternative: search for the string pattern directly
    const altPattern = /`\$\{(\w+)\.(\w+)\}\\\\Release\\\\Wispr Flow Helper\.exe`/;
    const altMatch = code.match(altPattern);
    if (altMatch) {
      const pMod = altMatch[1];
      const pProp = altMatch[2];
      // Replace Windows path with Linux path when on Linux
      const replacement = `("linux"===process.platform?\`\${${pMod}.${pProp}}/linux-helper/main.js\`:\`\${${pMod}.${pProp}}\\\\Release\\\\Wispr Flow Helper.exe\`)`;
      code = code.replace(altMatch[0], replacement);
      console.log('  Applied alternative helper path patch');
    }
  }

  // ---- Patch 2: Helper spawn - use node for Linux helper ----
  // Original: (0,i.spawn)(r, {stdio: ["pipe","pipe","pipe","pipe"], env: {...}})
  // For Linux: spawn("node", [r], {stdio: ...}) since our helper is a .js file

  const spawnPattern = /helper\.process=\(0,(\w+)\.spawn\)\(r,\{stdio:\["pipe","pipe","pipe","pipe"\]/;
  const spawnMatch = code.match(spawnPattern);

  if (spawnMatch) {
    const spawnModule = spawnMatch[1];
    code = code.replace(
      spawnMatch[0],
      `helper.process="linux"===process.platform?(0,${spawnModule}.spawn)(process.execPath,[r],{stdio:["pipe","pipe","pipe","pipe"]`
    );
    console.log('  Patched helper spawn: use node to run .js helper on Linux');
  } else {
    console.warn('  WARNING: Could not find helper spawn pattern');
  }

  // ---- Patch 3: Remove win-ca (crypt32) module loading ----
  // The crypt32 .node files are Windows DLLs. On Linux we use system CAs.
  // Replace require("win-ca") or the crypt32 loading with a no-op

  // The webpack require for crypt32 modules
  const crypt32Pattern = /module\.exports\s*=\s*__non_webpack_require__\(__webpack_require__\.ab\s*\+\s*"lib\/crypt32-(x64|ia32)\.node"\)/g;
  code = code.replace(crypt32Pattern, 'module.exports = {}');
  console.log('  Patched crypt32/win-ca: replaced with no-op');

  // ---- Patch 4: Electron squirrel startup ----
  // electron-squirrel-startup returns true on Windows during install events
  // On Linux this should always return false
  const squirrelPattern = /require\("electron-squirrel-startup"\)/g;
  if (code.match(squirrelPattern)) {
    code = code.replace(squirrelPattern, 'false');
    console.log('  Patched electron-squirrel-startup: always false');
  }

  // ---- Patch 5: Auto-update ----
  // Disable Squirrel auto-updater on Linux (it's Windows-only)
  // We'll handle updates differently on Linux

  // ---- Patch 6: mac-ca module ----
  // Similar to win-ca, mac-ca loads macOS certificate store
  const macCaPattern = /require\("mac-ca"\)/g;
  if (code.match(macCaPattern)) {
    code = code.replace(macCaPattern, '({})');
    console.log('  Patched mac-ca: replaced with no-op');
  }

  // ---- Write patched bundle ----
  fs.writeFileSync(MAIN_BUNDLE, code);
  const newSize = code.length;
  console.log(`  Bundle size: ${originalSize} → ${newSize} (${newSize > originalSize ? '+' : ''}${newSize - originalSize} bytes)`);
}

function copyLinuxHelper() {
  console.log('Copying Linux Helper into app resources...');

  const destHelperDir = path.join(APP_DIR, 'resources', 'linux-helper');
  if (fs.existsSync(destHelperDir)) {
    fs.rmSync(destHelperDir, { recursive: true });
  }

  // Copy the entire linux-helper directory
  copyDirSync(HELPER_SRC, destHelperDir);
  console.log(`  Copied to: ${destHelperDir}`);
}

function removeWindowsBinaries() {
  console.log('Removing Windows-specific binaries...');

  const webpackMain = path.join(ASAR_DIR, '.webpack', 'main');

  // Remove Windows native modules
  const filesToRemove = [
    path.join(webpackMain, 'native_modules', 'lib', 'crypt32-x64.node'),
    path.join(webpackMain, 'native_modules', 'lib', 'crypt32-ia32.node'),
  ];

  for (const file of filesToRemove) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`  Removed: ${path.basename(file)}`);
    }
  }

  // Remove Windows helper from resources
  const releaseDir = path.join(APP_DIR, 'resources', 'Release');
  if (fs.existsSync(releaseDir)) {
    fs.rmSync(releaseDir, { recursive: true });
    console.log('  Removed: Release/ (Windows helper binaries)');
  }
}

function patchPackageJson() {
  console.log('Patching package.json...');

  const pkgPath = path.join(ASAR_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  // Update product name to indicate Linux version
  pkg.productName = 'Wispr Flow';
  pkg.description = 'Voice-typing made perfect - Linux';

  // Remove Windows-specific dependencies references
  // (they're bundled in webpack anyway, but clean up)

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log(`  Version: ${pkg.version}`);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  console.log('=== Patching Wispr Flow for Linux ===\n');

  if (!fs.existsSync(ASAR_DIR)) {
    console.error('App not extracted. Run "npm run extract" first.');
    process.exit(1);
  }

  patchMainBundle();
  console.log('');
  copyLinuxHelper();
  console.log('');
  removeWindowsBinaries();
  console.log('');
  patchPackageJson();
  console.log('\n=== Patching complete ===');
}

main();
