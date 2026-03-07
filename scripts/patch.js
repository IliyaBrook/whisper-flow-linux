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
  // Original: helper.process=(0,i.spawn)(r,{stdio:[...],env:{...}})
  // For Linux: spawn(process.execPath, [r], {stdio:[...],env:{...}})

  // Match: helper.process=(0,i.spawn)(r,{stdio:["pipe","pipe","pipe","pipe"],env:{...}})
  // The env may have nested ternaries, so we find the second call's closing paren via balanced matching
  const spawnModuleMatch = code.match(/helper\.process=\(0,(\w+)\.spawn\)\(r,\{stdio:\["pipe","pipe","pipe","pipe"\]/);

  if (spawnModuleMatch) {
    const spawnModule = spawnModuleMatch[1];
    const marker = `(0,${spawnModule}.spawn)(r,{stdio:["pipe","pipe","pipe","pipe"]`;
    const markerIdx = code.indexOf(marker, spawnModuleMatch.index);

    // Find closing ) for the second call (r,{...}) by tracking balanced parens
    // Start from the second '(' — the args call
    const argsStart = markerIdx + `(0,${spawnModule}.spawn)`.length;
    let depth = 0;
    let end = argsStart;
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++;
      if (code[end] === ')') {
        depth--;
        if (depth === 0) { end++; break; }
      }
    }

    // fullSpawnExpr includes both parts: (0,i.spawn)(r,{...})
    const assignStart = spawnModuleMatch.index + 'helper.process='.length;
    const fullSpawnExpr = code.slice(assignStart, end);

    // Extract the options object from the args call
    const argsCallStr = code.slice(argsStart, end); // (r,{stdio:[...],env:{...}})
    const optsStr = argsCallStr.slice(argsCallStr.indexOf(',') + 1, argsCallStr.lastIndexOf(')'));

    // For Linux helper:
    // 1. ELECTRON_RUN_AS_NODE=1 makes Electron binary act as Node.js
    // 2. ...process.env inherits DISPLAY, PATH, HOME, XDG_SESSION_TYPE etc.
    //    Without this, the helper can't connect to X11/Wayland (xinput fails)
    const linuxOptsStr = optsStr.replace(/env:\{/, 'env:{...process.env,ELECTRON_RUN_AS_NODE:"1",UV_THREADPOOL_SIZE:"16",');
    const linuxSpawn = `(0,${spawnModule}.spawn)(process.execPath,[r],${linuxOptsStr})`;
    const replacement = `helper.process="linux"===process.platform?${linuxSpawn}:${fullSpawnExpr}`;

    code = code.slice(0, spawnModuleMatch.index) + replacement + code.slice(end);
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

  // ---- Patch 5: Disable macOS "Applications folder" check ----
  // The app checks if it's in /Applications on macOS. On Linux this always
  // fails and shows a blocking dialog. Add a Linux platform guard.
  // Find the Applications folder check near "Move Flow to Applications folder" string
  const appsFolderIdx = code.indexOf('Move Flow to Applications folder');
  if (appsFolderIdx !== -1) {
    // Search backwards for the if-condition
    const searchRegion = code.slice(Math.max(0, appsFolderIdx - 500), appsFolderIdx);
    const condMatch = searchRegion.match(/if\("production"===(\w+)\.(\w+)&&!(\w+)\)/);
    if (condMatch) {
      const original = `if("production"===${condMatch[1]}.${condMatch[2]}&&!${condMatch[3]})`;
      const patched = `if("production"===${condMatch[1]}.${condMatch[2]}&&"linux"!==process.platform&&!${condMatch[3]})`;
      code = code.replace(original, patched);
      console.log('  Patched Applications folder check: skip on Linux');
    } else {
      console.warn('  WARNING: Found "Move Flow to Applications folder" but could not match condition');
    }
  } else {
    console.warn('  WARNING: Could not find Applications folder check');
  }

  // ---- Patch 6: macOS system permissions check ----
  // getMediaAccessStatus is macOS-only. On Linux, skip and return "granted".
  // Original: if(c.H8)return Promise.resolve(!0) — only skips on Windows.
  // Add Linux guard so it also skips on Linux.
  const mediaAccessPattern = /if\((\w+)\.H8\)return Promise\.resolve\(!0\);switch\((\w+)\)\{case (\w+)\.\$\.MICROPHONE:return Promise\.resolve\("granted"===(\w+)\.systemPreferences\.getMediaAccessStatus/;
  const mediaAccessMatch = code.match(mediaAccessPattern);
  if (mediaAccessMatch) {
    const winVar = mediaAccessMatch[1];
    const original = `if(${winVar}.H8)return Promise.resolve(!0)`;
    const patched = `if(${winVar}.H8||"linux"===process.platform)return Promise.resolve(!0)`;
    code = code.replace(original, patched);
    console.log('  Patched media access check: skip on Linux (macOS-only API)');
  } else {
    console.warn('  WARNING: Could not find getMediaAccessStatus pattern');
  }

  // ---- Patch 7: mac-ca module ----
  // Similar to win-ca, mac-ca loads macOS certificate store
  const macCaPattern = /require\("mac-ca"\)/g;
  if (code.match(macCaPattern)) {
    code = code.replace(macCaPattern, '({})');
    console.log('  Patched mac-ca: replaced with no-op');
  }

  // ---- Patch 8: Protocol handler — enable single-instance and argv scanning on Linux ----
  // The original code gates requestSingleInstanceLock() and second-instance behind
  // b.H8 (isWindows). On Linux, protocol URLs are passed via argv to a second instance,
  // so we need the same logic. Change b.H8 to (b.H8||"linux"===process.platform).
  const protocolPattern = /,([a-z])\.H8\)\{if\(!n\.app\.requestSingleInstanceLock\(\)\)/;
  const protocolMatch = code.match(protocolPattern);
  if (protocolMatch) {
    const platformVar = protocolMatch[1];
    const oldCheck = `,${platformVar}.H8){if(!n.app.requestSingleInstanceLock())`;
    const newCheck = `,${platformVar}.H8||"linux"===process.platform){if(!n.app.requestSingleInstanceLock())`;
    code = code.replace(oldCheck, newCheck);
    console.log('  Patched protocol handler: enabled single-instance lock on Linux');
  } else {
    console.warn('  WARNING: Could not find protocol handler platform check');
  }

  // ---- Patch 9: Tray menu — fix macOS accelerators for Linux ----
  // Menu items use "Command+Q", "Command+/", "Command+," which are macOS-specific.
  // On Linux, "Command" maps to Super key which is usually not what users expect.
  // Replace with "Ctrl" equivalents on Linux via a runtime check.
  // Simpler approach: just replace the hardcoded "Command+" strings.
  const commandAccelCount = (code.match(/accelerator:"Command\+/g) || []).length;
  if (commandAccelCount > 0) {
    code = code.replace(/accelerator:"Command\+/g, 'accelerator:"CommandOrControl+');
    console.log(`  Patched ${commandAccelCount} tray/menu accelerators: Command+ → CommandOrControl+`);
  }

  // ---- Patch 10: Tray icon — add Linux icon support ----
  // Original: i.tD?"TrayIconMac@2x.png":"TrayIconWindows.png"
  // On Linux, use the Windows icon (it works fine) but add a click handler
  // to show context menu (some Linux DEs only fire click, not right-click).
  const trayClickPattern = 'r.setToolTip("Wispr Flow");const s=await b();return r.setContextMenu(s),r';
  if (code.includes(trayClickPattern)) {
    const trayClickReplacement = 'r.setToolTip("Wispr Flow");const s=await b();r.setContextMenu(s),r.on("click",()=>{r.popUpContextMenu(s)});return r';
    code = code.replace(trayClickPattern, trayClickReplacement);
    console.log('  Patched tray: added click handler for Linux context menu');
  } else {
    console.warn('  WARNING: Could not find tray click pattern for Linux fix');
  }

  // ---- Patch 11: Enable DevTools when WISPR_DEBUG=1 ----
  // devTools is gated behind "development"===u.M0 (NODE_ENV check).
  // Add env var check so run-debug can open DevTools.
  const devToolsCount = (code.match(/devTools:"development"===/g) || []).length;
  if (devToolsCount > 0) {
    code = code.replace(
      /devTools:"development"===/g,
      'devTools:"1"===process.env.WISPR_DEBUG||"development"==='
    );
    console.log(`  Patched ${devToolsCount} devTools gates: enabled via WISPR_DEBUG=1`);
  }

  // ---- Patch 12: Frame fix wrapper entry point ----
  // Instead of fragile regex patches for frame:false, we use a wrapper that
  // monkey-patches BrowserWindow at runtime (like figma-linux and claude-desktop).
  // The wrapper is injected via a new entry point that loads before the main bundle.
  // (See injectFrameFixWrapper() below)

  // ---- Patch 13: Auto-open DevTools in debug mode ----
  // When WISPR_DEBUG=1, open DevTools on the hub window after creation.
  // Use unique hub-specific pattern to avoid matching scratchpad or other windows.
  const hubCrashedPattern = 'r.webContents.on("render-process-gone",(e,t)=>{o().error("Hub window crashed:",t)})';
  if (code.includes(hubCrashedPattern)) {
    code = code.replace(
      hubCrashedPattern,
      '"1"===process.env.WISPR_DEBUG&&r.webContents.on("dom-ready",()=>{r.webContents.openDevTools({mode:"detach"})}),' + hubCrashedPattern
    );
    console.log('  Patched hub window: auto-open DevTools when WISPR_DEBUG=1');
  } else {
    console.warn('  WARNING: Could not find hub window crash pattern for DevTools injection');
  }

  // ---- Write patched bundle ----
  fs.writeFileSync(MAIN_BUNDLE, code);
  const newSize = code.length;
  console.log(`  Bundle size: ${originalSize} → ${newSize} (${newSize > originalSize ? '+' : ''}${newSize - originalSize} bytes)`);
}

function injectFrameFixWrapper() {
  console.log('Injecting frame-fix wrapper as entry point...');

  const wrapperSrc = path.join(__dirname, 'frame-fix-wrapper.js');
  const wrapperDest = path.join(ASAR_DIR, 'frame-fix-wrapper.js');
  const entryDest = path.join(ASAR_DIR, 'frame-fix-entry.js');

  // Copy wrapper module
  fs.copyFileSync(wrapperSrc, wrapperDest);
  console.log(`  Copied frame-fix-wrapper.js`);

  // Create entry point that loads wrapper then original main
  const entryCode = `require('./frame-fix-wrapper');\nrequire('./.webpack/main');\n`;
  fs.writeFileSync(entryDest, entryCode);
  console.log(`  Created frame-fix-entry.js`);

  // Update package.json to use new entry point
  const pkgPath = path.join(ASAR_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const oldMain = pkg.main;
  pkg.main = './frame-fix-entry';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log(`  Updated package.json main: ${oldMain} → ${pkg.main}`);
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
  injectFrameFixWrapper();
  console.log('');
  copyLinuxHelper();
  console.log('');
  removeWindowsBinaries();
  console.log('');
  patchPackageJson();
  console.log('\n=== Patching complete ===');
}

main();
