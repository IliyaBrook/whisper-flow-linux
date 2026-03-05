#!/usr/bin/env node
/**
 * Package Wispr Flow for Linux as .deb
 * Downloads matching Electron binary for Linux, combines with patched app,
 * and creates a .deb package.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const APP_DIR = path.join(TMP_DIR, 'app');
const ASAR_DIR = path.join(APP_DIR, 'asar-content');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const BUILD_DIR = path.join(__dirname, '..', 'build');

function getMetadata() {
  const metaPath = path.join(APP_DIR, 'metadata.json');
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function downloadElectron(version) {
  const electronDir = path.join(TMP_DIR, 'electron');
  const electronZip = path.join(TMP_DIR, `electron-v${version}-linux-x64.zip`);

  if (fs.existsSync(electronDir) && fs.existsSync(path.join(electronDir, 'electron'))) {
    console.log('Electron already downloaded, skipping...');
    return electronDir;
  }

  console.log(`Downloading Electron v${version} for Linux x64...`);
  const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-linux-x64.zip`;

  execSync(`curl -L -o "${electronZip}" "${url}" --progress-bar --max-time 300`, {
    stdio: 'inherit'
  });

  if (fs.existsSync(electronDir)) {
    fs.rmSync(electronDir, { recursive: true });
  }
  fs.mkdirSync(electronDir, { recursive: true });

  execSync(`7z x "${electronZip}" -o"${electronDir}" -y`, { stdio: 'pipe' });

  console.log(`  Electron extracted to: ${electronDir}`);
  return electronDir;
}

function assembleApp(electronDir, metadata) {
  console.log('Assembling Linux application...');

  const appDir = path.join(BUILD_DIR, 'wispr-flow');
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true });
  }
  fs.mkdirSync(appDir, { recursive: true });

  // Copy Electron runtime
  console.log('  Copying Electron runtime...');
  execSync(`cp -r "${electronDir}/"* "${appDir}/"`, { stdio: 'pipe' });

  // Rename electron binary
  const electronBin = path.join(appDir, 'electron');
  const appBin = path.join(appDir, 'wispr-flow');
  if (fs.existsSync(electronBin)) {
    fs.renameSync(electronBin, appBin);
  }

  // Replace resources
  const resourcesDir = path.join(appDir, 'resources');
  if (fs.existsSync(resourcesDir)) {
    fs.rmSync(resourcesDir, { recursive: true });
  }
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Pack app.asar from our patched sources
  console.log('  Packing app.asar...');
  execSync(`npx asar pack "${ASAR_DIR}" "${path.join(resourcesDir, 'app.asar')}"`, {
    stdio: 'pipe'
  });

  // Copy non-asar resources (assets, migrations, linux-helper)
  const srcResources = path.join(APP_DIR, 'resources');
  if (fs.existsSync(srcResources)) {
    for (const item of fs.readdirSync(srcResources)) {
      const src = path.join(srcResources, item);
      const dest = path.join(resourcesDir, item);
      execSync(`cp -r "${src}" "${dest}"`, { stdio: 'pipe' });
    }
  }

  // Make binary executable
  execSync(`chmod +x "${appBin}"`, { stdio: 'pipe' });

  console.log(`  App assembled at: ${appDir}`);
  return appDir;
}

function createDesktopFile(version) {
  return `[Desktop Entry]
Name=Wispr Flow
Comment=Voice-typing made perfect
Exec=/opt/wispr-flow/wispr-flow %U
Icon=wispr-flow
Type=Application
Categories=Utility;Accessibility;
Keywords=voice;typing;dictation;speech;
StartupWMClass=Wispr Flow
MimeType=x-scheme-handler/wispr-flow;
`;
}

function buildDeb(appDir, metadata) {
  console.log('Building .deb package...');

  const version = metadata.appVersion;
  const debDir = path.join(BUILD_DIR, 'deb');

  if (fs.existsSync(debDir)) {
    fs.rmSync(debDir, { recursive: true });
  }

  // Create deb structure
  const dirs = [
    path.join(debDir, 'DEBIAN'),
    path.join(debDir, 'opt', 'wispr-flow'),
    path.join(debDir, 'usr', 'share', 'applications'),
    path.join(debDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps'),
    path.join(debDir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps'),
    path.join(debDir, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps'),
    path.join(debDir, 'usr', 'bin'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Copy application files
  execSync(`cp -r "${appDir}/"* "${path.join(debDir, 'opt', 'wispr-flow')}/"`, { stdio: 'pipe' });

  // Create symlink for /usr/bin
  fs.symlinkSync('/opt/wispr-flow/wispr-flow', path.join(debDir, 'usr', 'bin', 'wispr-flow'));

  // Create .desktop file
  fs.writeFileSync(
    path.join(debDir, 'usr', 'share', 'applications', 'wispr-flow.desktop'),
    createDesktopFile(version)
  );

  // Copy icon if available
  const iconSources = [
    path.join(APP_DIR, 'resources', 'assets', 'icons'),
    path.join(APP_DIR, 'resources', 'assets', 'appLogos'),
  ];

  for (const iconDir of iconSources) {
    if (fs.existsSync(iconDir)) {
      const pngs = fs.readdirSync(iconDir).filter(f => f.endsWith('.png'));
      if (pngs.length > 0) {
        // Use the largest icon
        const icon = pngs.sort((a, b) => {
          const sizeA = fs.statSync(path.join(iconDir, a)).size;
          const sizeB = fs.statSync(path.join(iconDir, b)).size;
          return sizeB - sizeA;
        })[0];
        fs.copyFileSync(
          path.join(iconDir, icon),
          path.join(debDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'wispr-flow.png')
        );
        console.log(`  Icon: ${icon}`);
        break;
      }
    }
  }

  // Calculate installed size
  const installedSize = parseInt(
    execSync(`du -sk "${debDir}" | cut -f1`, { encoding: 'utf8' }).trim(),
    10
  );

  // Create control file
  const control = `Package: wispr-flow
Version: ${version}
Section: utils
Priority: optional
Architecture: amd64
Installed-Size: ${installedSize}
Depends: libgtk-3-0 | libgtk-4-1, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libsecret-1-0, xdotool, xclip
Recommends: libappindicator3-1, gconf2, python3-gi
Maintainer: Wispr Flow Linux <community@wisprflow.ai>
Homepage: https://wisprflow.ai
Description: Wispr Flow - Voice-typing made perfect
 Wispr Flow is a voice typing application that uses AI to
 transcribe your speech into text with high accuracy.
 This is an unofficial Linux port of the Windows version.
`;

  fs.writeFileSync(path.join(debDir, 'DEBIAN', 'control'), control);

  // Create postinst script
  const postinst = `#!/bin/bash
set -e

# Update icon cache
if [ -x /usr/bin/gtk-update-icon-cache ]; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor/ 2>/dev/null || true
fi

# Update desktop database
if [ -x /usr/bin/update-desktop-database ]; then
    update-desktop-database /usr/share/applications/ 2>/dev/null || true
fi

# Set sandbox permissions
chmod 4755 /opt/wispr-flow/chrome-sandbox 2>/dev/null || true

echo "Wispr Flow installed successfully!"
echo "Required tools: xdotool, xclip (install: sudo apt install xdotool xclip)"
echo "For Wayland: wl-clipboard, ydotool (install: sudo apt install wl-clipboard ydotool)"
`;

  fs.writeFileSync(path.join(debDir, 'DEBIAN', 'postinst'), postinst);
  execSync(`chmod 755 "${path.join(debDir, 'DEBIAN', 'postinst')}"`, { stdio: 'pipe' });

  // Build the deb
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const debFile = path.join(DIST_DIR, `wispr-flow_${version}_amd64.deb`);

  execSync(`dpkg-deb --build "${debDir}" "${debFile}"`, { stdio: 'inherit' });

  const debSize = fs.statSync(debFile).size;
  console.log(`\n  Package: ${debFile}`);
  console.log(`  Size: ${(debSize / 1024 / 1024).toFixed(1)} MB`);

  return debFile;
}

function main() {
  console.log('=== Packaging Wispr Flow for Linux (.deb) ===\n');

  if (!fs.existsSync(ASAR_DIR)) {
    console.error('App not extracted. Run the extract and patch steps first.');
    process.exit(1);
  }

  const metadata = getMetadata();
  console.log(`App version: ${metadata.appVersion}`);
  console.log(`Electron version: ${metadata.electronVersion}\n`);

  const electronDir = downloadElectron(metadata.electronVersion);
  console.log('');

  const appDir = assembleApp(electronDir, metadata);
  console.log('');

  const debFile = buildDeb(appDir, metadata);

  console.log('\n=== Packaging complete ===');
  console.log(`\nInstall with: sudo dpkg -i ${debFile}`);
  console.log('Then run: wispr-flow');
}

main();
