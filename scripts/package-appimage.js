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
const BUILD_DIR = path.join(__dirname, '..', 'build');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const LAUNCHER_SH = path.join(__dirname, 'launcher-common.sh');

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

function buildAppImage(metadata) {
  console.log('Building AppImage...');

  const version = metadata.appVersion;
  const appImageDir = path.join(BUILD_DIR, 'AppDir');
  const appDir = path.join(BUILD_DIR, 'wispr-flow');

  if (!fs.existsSync(appDir)) {
    console.error('Application not assembled. Run package-deb first or assemble manually.');
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

# --- Desktop Integration for wispr-flow:// URL scheme ---
integrate_desktop() {
	local desktop_dir="\${XDG_DATA_HOME:-\$HOME/.local/share}/applications"
	local icon_dir="\${XDG_DATA_HOME:-\$HOME/.local/share}/icons/hicolor/256x256/apps"
	local desktop_file="\$desktop_dir/wispr-flow-appimage.desktop"

	mkdir -p "\$desktop_dir" "\$icon_dir" 2>/dev/null

	# Copy icon if available
	local icon_src="\$appdir/wispr-flow.png"
	local icon_dest="\$icon_dir/wispr-flow.png"
	if [[ -f \$icon_src ]]; then
		if [[ ! -f \$icon_dest ]] || ! cmp -s "\$icon_src" "\$icon_dest"; then
			cp "\$icon_src" "\$icon_dest" 2>/dev/null
		fi
	fi

	# Create/update .desktop file if AppImage path changed or file doesn't exist
	local current_exec=''
	[[ -f \$desktop_file ]] && current_exec=\\$(grep '^Exec=' "\$desktop_file" 2>/dev/null | head -1)

	if [[ ! -f \$desktop_file ]] || [[ \$current_exec != "Exec=\\"\${appimage_path}\\" %U" ]]; then
		cat > "\$desktop_file" << DESKTOP
[Desktop Entry]
Name=Wispr Flow
Exec="\${appimage_path}" %U
Icon=wispr-flow
Type=Application
Terminal=false
Categories=Utility;Accessibility;
Comment=Voice-typing made perfect (AppImage)
MimeType=x-scheme-handler/wispr-flow;
StartupWMClass=Wispr Flow
DESKTOP
		log_message "Desktop file created/updated: \$desktop_file"
	fi

	# Update MIME database
	update-desktop-database "\$desktop_dir" 2>/dev/null || true
	xdg-mime default wispr-flow-appimage.desktop x-scheme-handler/wispr-flow 2>/dev/null || true
}

# Run desktop integration (non-blocking, errors are non-fatal)
integrate_desktop 2>/dev/null || true

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

  // Copy/create icon
  const iconDest = path.join(appImageDir, 'wispr-flow.png');
  const iconSources = [
    path.join(APP_DIR, 'resources', 'assets', 'icons'),
    path.join(APP_DIR, 'resources', 'assets', 'appLogos'),
  ];

  let iconFound = false;
  for (const iconDir of iconSources) {
    if (fs.existsSync(iconDir)) {
      const pngs = fs.readdirSync(iconDir).filter(f => f.endsWith('.png'));
      if (pngs.length > 0) {
        const icon = pngs.sort((a, b) => {
          const sizeA = fs.statSync(path.join(iconDir, a)).size;
          const sizeB = fs.statSync(path.join(iconDir, b)).size;
          return sizeB - sizeA;
        })[0];
        fs.copyFileSync(path.join(iconDir, icon), iconDest);
        iconFound = true;
        break;
      }
    }
  }

  if (!iconFound) {
    // Create a minimal 1x1 PNG as placeholder
    console.warn('  No icon found, using placeholder');
    // Minimal PNG (1x1 blue pixel)
    const minPng = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f86f00000001010000050f1c450000000049454e44ae426082',
      'hex'
    );
    fs.writeFileSync(iconDest, minPng);
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

  const metadata = getMetadata();
  console.log(`App version: ${metadata.appVersion}\n`);

  const appImageFile = buildAppImage(metadata);

  console.log('\n=== AppImage build complete ===');
  console.log(`\nRun with: ${appImageFile}`);
}

main();
