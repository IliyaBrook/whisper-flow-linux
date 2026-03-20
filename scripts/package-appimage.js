#!/usr/bin/env node
/**
 * Package Wispr Flow for Linux as AppImage
 * Uses appimagetool to create a portable AppImage.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const APP_DIR = path.join(TMP_DIR, 'app');
const ASAR_DIR = path.join(APP_DIR, 'asar-content');
const BUILD_DIR = path.join(__dirname, '..', 'build');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const LAUNCHER_SH = path.join(__dirname, 'launcher-common.sh');
const RUNTIME_DEPS_SH = path.join(__dirname, 'runtime-deps.sh');

function getMetadata() {
  const metaPath = path.join(APP_DIR, 'metadata.json');
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function ensureAppImageTool() {
  const toolPath = path.join(TMP_DIR, 'appimagetool');
  if (fs.existsSync(toolPath)) {
    return toolPath;
  }

  console.log('Downloading appimagetool...');
  const url = 'https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage';
  execSync(`curl -L -o "${toolPath}" "${url}" --progress-bar --max-time 120`, { stdio: 'inherit' });
  execSync(`chmod +x "${toolPath}"`, { stdio: 'pipe' });
  return toolPath;
}

function ensureRuntimeDependencies() {
  console.log('Checking runtime dependencies...');
  execSync(`bash "${RUNTIME_DEPS_SH}" check`, { stdio: 'inherit' });
}

function assembleApp(metadata) {
  console.log('Assembling application from patched sources...');

  const electronDir = path.join(TMP_DIR, 'electron');
  const appDir = path.join(BUILD_DIR, 'wispr-flow');

  if (!fs.existsSync(electronDir) || !fs.existsSync(path.join(electronDir, 'electron'))) {
    // Download Electron if not cached
    const version = metadata.electronVersion;
    const electronZip = path.join(TMP_DIR, `electron-v${version}-linux-x64.zip`);
    if (!fs.existsSync(electronZip)) {
      console.log(`  Downloading Electron v${version}...`);
      const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-linux-x64.zip`;
      execSync(`curl -L -o "${electronZip}" "${url}" --progress-bar --max-time 300`, { stdio: 'inherit' });
    }
    if (fs.existsSync(electronDir)) fs.rmSync(electronDir, { recursive: true });
    fs.mkdirSync(electronDir, { recursive: true });
    execSync(`7z x "${electronZip}" -o"${electronDir}" -y`, { stdio: 'pipe' });
  }

  // Clean and recreate app dir
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true });
  }
  fs.mkdirSync(appDir, { recursive: true });

  // Copy Electron runtime
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

  // Pack app.asar from patched sources
  console.log('  Packing app.asar from patched sources...');
  execSync(`npx asar pack "${ASAR_DIR}" "${path.join(resourcesDir, 'app.asar')}"`, { stdio: 'pipe' });

  // Copy non-asar resources (assets, migrations, linux-helper)
  const srcResources = path.join(APP_DIR, 'resources');
  if (fs.existsSync(srcResources)) {
    for (const item of fs.readdirSync(srcResources)) {
      const src = path.join(srcResources, item);
      const dest = path.join(resourcesDir, item);
      execSync(`cp -r "${src}" "${dest}"`, { stdio: 'pipe' });
    }
  }

  execSync(`chmod +x "${appBin}"`, { stdio: 'pipe' });
  console.log(`  App assembled at: ${appDir}`);
  return appDir;
}

function buildAppImage(metadata) {
  console.log('Building AppImage...');

  const version = metadata.appVersion;
  const appImageDir = path.join(BUILD_DIR, 'AppDir');
  const appDir = path.join(BUILD_DIR, 'wispr-flow');

  if (!fs.existsSync(appDir)) {
    console.error('Application not assembled. assembleApp() should have been called first.');
    process.exit(1);
  }

  if (fs.existsSync(appImageDir)) {
    fs.rmSync(appImageDir, { recursive: true });
  }
  fs.mkdirSync(appImageDir, { recursive: true });

  // Copy app files
  execSync(`cp -r "${appDir}/"* "${appImageDir}/"`, { stdio: 'pipe' });

  // Copy launcher-common.sh into AppDir
  fs.copyFileSync(LAUNCHER_SH, path.join(appImageDir, 'launcher-common.sh'));

  // Create AppRun script
  const appRun = `#!/usr/bin/env bash

# Find the location of the AppRun script
appdir=$(dirname "$(readlink -f "$0")")
appimage_path="$(readlink -f "$0")"
# If launched from mounted AppImage, APPIMAGE env var points to the actual .AppImage file
[[ -n $APPIMAGE ]] && appimage_path="$APPIMAGE"

# Source shared launcher library
source "$appdir/launcher-common.sh"

# Setup logging and environment
setup_logging || exit 1
setup_electron_env

# Register wispr-flow:// URL scheme (non-blocking, errors are non-fatal)
integrate_desktop "$appdir" "$appimage_path" 2>/dev/null || true

# Detect display backend
detect_display_backend

# Log startup info
log_message '--- Wispr Flow AppImage Start ---'
log_message "Timestamp: $(date)"
log_message "Arguments: $@"
log_message "APPDIR: $appdir"
log_message "APPIMAGE: $appimage_path"

# Build electron args (appimage mode adds --no-sandbox)
build_electron_args 'appimage'

# Change to HOME to avoid CWD permission issues in FUSE mount
cd "$HOME" || exit 1

# Execute
log_message "Executing: $appdir/wispr-flow \${electron_args[*]} $*"
if [[ \${WISPR_DEBUG:-0} == 1 ]]; then
	"$appdir/wispr-flow" "\${electron_args[@]}" "$@" 2>&1 | tee -a "$log_file"
else
	exec "$appdir/wispr-flow" "\${electron_args[@]}" "$@" >> "$log_file" 2>&1
fi
`;
  fs.writeFileSync(path.join(appImageDir, 'AppRun'), appRun);
  execSync(`chmod +x "${path.join(appImageDir, 'AppRun')}"`, { stdio: 'pipe' });

  // Create .desktop file in AppDir root
  const desktop = `[Desktop Entry]
Name=Wispr Flow
Exec=wispr-flow %U
Icon=wispr-flow
Type=Application
Categories=Utility;Accessibility;
MimeType=x-scheme-handler/wispr-flow;
`;
  fs.writeFileSync(path.join(appImageDir, 'wispr-flow.desktop'), desktop);

  // Copy app icon — use the actual Wispr Flow logo, not random app logos
  const iconDest = path.join(appImageDir, 'wispr-flow.png');
  const logoPath = path.join(APP_DIR, 'resources', 'assets', 'logos', 'wispr-logo.png');

  if (fs.existsSync(logoPath)) {
    fs.copyFileSync(logoPath, iconDest);
    console.log(`  Icon: ${logoPath}`);
  } else {
    // Fallback: extract 256x256 from setupIcon.ico if available
    const icoPath = path.join(__dirname, '..', 'tmp', 'extracted', 'setupIcon.ico');
    if (fs.existsSync(icoPath)) {
      try {
        const { execSync } = require('child_process');
        execSync(`convert "${icoPath}[1]" "${iconDest}"`, { stdio: 'ignore' });
        console.log(`  Icon: extracted from setupIcon.ico`);
      } catch {
        console.warn('  No icon found, using placeholder');
        const minPng = Buffer.from(
          '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f86f00000001010000050f1c450000000049454e44ae426082',
          'hex'
        );
        fs.writeFileSync(iconDest, minPng);
      }
    }
  }

  // Build AppImage
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const appImageFile = path.join(DIST_DIR, `Wispr_Flow-${version}-x86_64.AppImage`);

  const appImageTool = ensureAppImageTool();

  try {
    execSync(
      `ARCH=x86_64 "${appImageTool}" --appimage-extract-and-run "${appImageDir}" "${appImageFile}"`,
      { stdio: 'inherit', env: { ...process.env, ARCH: 'x86_64' } }
    );
  } catch {
    // appimagetool might need FUSE, try with --appimage-extract-and-run
    console.log('  Retrying with extracted appimagetool...');
    const extractedTool = path.join(TMP_DIR, 'appimagetool-extracted');
    if (!fs.existsSync(extractedTool)) {
      execSync(`cd "${TMP_DIR}" && "${appImageTool}" --appimage-extract`, { stdio: 'pipe' });
      fs.renameSync(path.join(TMP_DIR, 'squashfs-root'), extractedTool);
    }
    execSync(
      `ARCH=x86_64 "${extractedTool}/AppRun" "${appImageDir}" "${appImageFile}"`,
      { stdio: 'inherit' }
    );
  }

  execSync(`chmod +x "${appImageFile}"`, { stdio: 'pipe' });

  const size = fs.statSync(appImageFile).size;
  console.log(`\n  AppImage: ${appImageFile}`);
  console.log(`  Size: ${(size / 1024 / 1024).toFixed(1)} MB`);

  return appImageFile;
}

function main() {
  console.log('=== Packaging Wispr Flow as AppImage ===\n');
  ensureRuntimeDependencies();
  console.log('');

  const metadata = getMetadata();
  console.log(`App version: ${metadata.appVersion}\n`);

  // Always re-assemble from patched sources to ensure latest patches are included
  assembleApp(metadata);
  console.log('');

  const appImageFile = buildAppImage(metadata);

  console.log('\n=== AppImage build complete ===');
  console.log(`\nRun with: ${appImageFile}`);
}

main();
