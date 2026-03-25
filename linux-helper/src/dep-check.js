/**
 * Runtime dependency checker for Linux Helper
 * Detects display server and checks that all required tools are installed.
 * Returns a structured report so the Electron side can show a user-friendly dialog.
 */

const { execSync } = require('child_process');

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect real session type (X11 or Wayland)
 */
function detectSessionType() {
  const xdg = process.env.XDG_SESSION_TYPE || '';
  if (xdg === 'wayland') return 'wayland';
  if (xdg === 'x11') return 'x11';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'unknown';
}

/**
 * Detect desktop environment
 */
function detectDesktop() {
  const de = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (de.includes('kde') || de.includes('plasma')) return 'KDE';
  if (de.includes('gnome')) return 'GNOME';
  if (de.includes('xfce')) return 'XFCE';
  if (de.includes('hyprland')) return 'Hyprland';
  if (de.includes('sway')) return 'Sway';
  return de || 'unknown';
}

/**
 * Detect package manager for install hints
 */
function detectPackageManager() {
  try {
    const osRelease = require('fs').readFileSync('/etc/os-release', 'utf8');
    const idLine = osRelease.match(/^ID=(.+)$/m);
    const idLikeLine = osRelease.match(/^ID_LIKE=(.+)$/m);
    const id = (idLine ? idLine[1].replace(/"/g, '') : '').toLowerCase();
    const idLike = (idLikeLine ? idLikeLine[1].replace(/"/g, '') : '').toLowerCase();
    const combined = `${id} ${idLike}`;

    if (combined.match(/debian|ubuntu|mint|pop|neon/)) return 'apt';
    if (combined.match(/fedora|rhel|centos|rocky|alma/)) return 'dnf';
    if (combined.match(/arch|manjaro|endeavour/)) return 'pacman';
    if (combined.match(/opensuse|suse/)) return 'zypper';
  } catch { /* ignore */ }

  if (commandExists('apt-get')) return 'apt';
  if (commandExists('dnf')) return 'dnf';
  if (commandExists('pacman')) return 'pacman';
  if (commandExists('zypper')) return 'zypper';
  return 'unknown';
}

/**
 * Check if user is in the 'input' group (needed for ydotool/evdev)
 */
function isUserInInputGroup() {
  try {
    // Use `id -Gn <username>` to check the system group database,
    // not the current process groups. This way the check is correct
    // even if the user added themselves to the group without re-logging.
    const username = require('os').userInfo().username;
    const groups = execSync(`id -Gn ${username}`, { stdio: 'pipe', encoding: 'utf8' }).trim();
    return groups.split(/\s+/).includes('input');
  } catch {
    return false;
  }
}

/**
 * Generate install command for missing packages
 */
function getInstallCommand(pkgManager, packages) {
  const pkgMap = {
    apt: {
      xdotool: 'xdotool',
      xclip: 'xclip',
      xsel: 'xsel',
      ydotool: 'ydotool',
      'wl-copy': 'wl-clipboard',
      'wl-paste': 'wl-clipboard',
      python3: 'python3',
    },
    dnf: {
      xdotool: 'xdotool',
      xclip: 'xclip',
      xsel: 'xsel',
      ydotool: 'ydotool',
      'wl-copy': 'wl-clipboard',
      'wl-paste': 'wl-clipboard',
      python3: 'python3',
    },
    pacman: {
      xdotool: 'xdotool',
      xclip: 'xclip',
      xsel: 'xsel',
      ydotool: 'ydotool',
      'wl-copy': 'wl-clipboard',
      'wl-paste': 'wl-clipboard',
      python3: 'python3',
    },
    zypper: {
      xdotool: 'xdotool',
      xclip: 'xclip',
      xsel: 'xsel',
      ydotool: 'ydotool',
      'wl-copy': 'wl-clipboard',
      'wl-paste': 'wl-clipboard',
      python3: 'python3',
    },
  };

  const map = pkgMap[pkgManager] || {};
  const pkgNames = [...new Set(packages.map(cmd => map[cmd] || cmd))];

  switch (pkgManager) {
    case 'apt': return `sudo apt install ${pkgNames.join(' ')}`;
    case 'dnf': return `sudo dnf install ${pkgNames.join(' ')}`;
    case 'pacman': return `sudo pacman -S ${pkgNames.join(' ')}`;
    case 'zypper': return `sudo zypper install ${pkgNames.join(' ')}`;
    default: return pkgNames.join(', ');
  }
}

/**
 * Run full dependency check.
 *
 * @returns {{ ok: boolean, session: string, desktop: string, missing: Array<{tool: string, reason: string}>, warnings: string[], fixCommands: string[], installCommand: string }}
 */
function checkDependencies() {
  const session = detectSessionType();
  const desktop = detectDesktop();
  const pkgManager = detectPackageManager();

  const missing = [];
  const warnings = [];
  const missingPackages = [];
  const fixCommands = []; // actionable shell commands to fix issues

  // --- Common: python3 is needed for uinput Ctrl+V script (primary paste method) ---
  const hasPython3 = commandExists('python3');

  if (session === 'x11') {
    // --- X11 dependencies ---

    // Clipboard: xclip or xsel (no built-in CLI tool for X11 selections)
    if (!commandExists('xclip') && !commandExists('xsel')) {
      missing.push({ tool: 'xclip', reason: 'Required for clipboard operations on X11' });
      missingPackages.push('xclip');
    }

    // Key simulation: xdotool is the primary tool for X11
    if (!commandExists('xdotool')) {
      missing.push({ tool: 'xdotool', reason: 'Required for text insertion and window management on X11' });
      missingPackages.push('xdotool');
    }
  } else if (session === 'wayland') {
    // --- Wayland dependencies ---

    // Clipboard
    if (!commandExists('wl-copy') || !commandExists('wl-paste')) {
      // If using XWayland mode, xclip will work too
      if (!commandExists('xclip') && !commandExists('xsel')) {
        missing.push({ tool: 'wl-copy', reason: 'Required on Wayland for clipboard operations' });
        missingPackages.push('wl-copy');
      }
    }

    // Key simulation: python3 (uinput) is primary, ydotool is fallback
    if (!hasPython3 && !commandExists('ydotool')) {
      missing.push({ tool: 'python3', reason: 'Required on Wayland for input simulation (uinput Ctrl+V script). Alternatively install ydotool.' });
      missingPackages.push('python3');
    } else if (!commandExists('ydotool')) {
      warnings.push('ydotool is not installed. The app will use uinput (python3) for key simulation. Install ydotool as a fallback.');
    }

    // Input group check
    if (!isUserInInputGroup()) {
      const username = require('os').userInfo().username;
      warnings.push(`User "${username}" is not in the "input" group. Required for input simulation and global hotkeys on Wayland. Log out and back in after fixing.`);
      fixCommands.push(`sudo usermod -aG input ${username}`);
    }
  } else {
    warnings.push(`Could not detect display server (XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE || ''}, DISPLAY=${process.env.DISPLAY || ''}, WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY || ''}). Some features may not work.`);
  }

  const installCommand = missingPackages.length > 0
    ? getInstallCommand(pkgManager, missingPackages)
    : '';

  return {
    ok: missing.length === 0,
    session,
    desktop,
    missing,
    warnings,
    fixCommands,
    installCommand,
  };
}

module.exports = { checkDependencies, detectSessionType, detectDesktop, commandExists };
