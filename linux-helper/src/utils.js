/**
 * Display server utilities for Linux Helper (X11 & Wayland)
 * Handles: window focus, app info, key simulation, clipboard, text paste
 */

const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Detect display server (X11 or Wayland)
 */
function getDisplayServer() {
  // Launcher sets WISPR_DISPLAY_BACKEND=x11 when using XWayland mode on Wayland,
  // so the helper uses X11 tools (xdotool/xclip) which work via XWayland.
  const override = process.env.WISPR_DISPLAY_BACKEND;
  if (override === 'x11' || override === 'wayland') return override;

  const xdgSession = process.env.XDG_SESSION_TYPE || '';
  if (xdgSession === 'wayland') return 'wayland';
  if (xdgSession === 'x11') return 'x11';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'unknown';
}

const displayServer = getDisplayServer();

/**
 * Detect the REAL session type (ignoring WISPR_DISPLAY_BACKEND override).
 * On Wayland+XWayland, the override makes displayServer='x11' so that
 * clipboard/window tools use X11 tools. But for INPUT SIMULATION we must
 * know the real compositor, because xdotool's XTest requests through
 * XWayland trigger KDE Plasma's "Remote Control" permission dialog.
 */
function getRealSessionType() {
  const xdg = process.env.XDG_SESSION_TYPE || '';
  if (xdg === 'wayland') return 'wayland';
  if (xdg === 'x11') return 'x11';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'unknown';
}

const realSessionType = getRealSessionType();

/** True when running on a Wayland compositor, even in XWayland mode */
function isRealWayland() {
  return realSessionType === 'wayland';
}

function isNativeWaylandBackend() {
  return displayServer === 'wayland';
}

// Path to the uinput Ctrl+V script
const path = require('path');
const UINPUT_SCRIPT = path.join(__dirname, 'uinput-ctrl-v.py');

if (realSessionType !== displayServer) {
  console.log(`[utils] Real session: ${realSessionType}, helper backend: ${displayServer} — input simulation will use uinput/ydotool to avoid compositor permission dialogs`);
}

/**
 * Check if a command exists
 */
function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Cache tool availability
const tools = {
  xdotool: commandExists('xdotool'),
  xprop: commandExists('xprop'),
  xclip: commandExists('xclip'),
  xsel: commandExists('xsel'),
  wlCopy: commandExists('wl-copy'),
  wlPaste: commandExists('wl-paste'),
  ydotool: commandExists('ydotool'),
  xwininfo: commandExists('xwininfo'),
  wmctrl: commandExists('wmctrl'),
  dbusSend: commandExists('dbus-send'),
};

// ============================================================
// Active Window / App Info
// ============================================================

/**
 * Get active window info: { windowId, appName, pid, title, wmClass }
 */
async function getActiveWindowInfo() {
  if (displayServer === 'x11') {
    return getActiveWindowInfoX11();
  } else if (displayServer === 'wayland') {
    return getActiveWindowInfoWayland();
  }
  return { windowId: '', appName: '', pid: 0, title: '', wmClass: '', url: '' };
}

async function getActiveWindowInfoX11() {
  const result = { windowId: '', appName: '', pid: 0, title: '', wmClass: '', url: '' };
  try {
    if (tools.xdotool) {
      result.windowId = (await execAsync('xdotool getactivewindow')).stdout.trim();

      result.title = (await execAsync(`xdotool getactivewindow getwindowname`)).stdout.trim();

      try {
        const pid = (await execAsync(`xdotool getactivewindow getwindowpid`)).stdout.trim();
        result.pid = parseInt(pid, 10) || 0;
      } catch { /* XWayland windows may not have PID */ }
    }

    if (tools.xprop && result.windowId) {
      try {
        const classInfo = (await execAsync(
          `xprop -id ${result.windowId} WM_CLASS`
        )).stdout.trim();
        // WM_CLASS(STRING) = "instance", "class"
        const match = classInfo.match(/WM_CLASS\(STRING\)\s*=\s*"([^"]*)",\s*"([^"]*)"/);
        if (match) {
          result.wmClass = match[2]; // class name
          result.appName = match[2];
        }
      } catch { /* ignore */ }
    }

    // Try to get process name from /proc if we have PID
    if (result.pid > 0 && !result.appName) {
      try {
        const fs = require('fs');
        result.appName = fs.readFileSync(`/proc/${result.pid}/comm`, 'utf8').trim();
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.error(`getActiveWindowInfoX11 error: ${err.message}`);
  }
  return result;
}

async function getActiveWindowInfoWayland() {
  const result = { windowId: '', appName: '', pid: 0, title: '', wmClass: '', url: '' };
  try {
    // Try hyprctl for Hyprland
    try {
      const { stdout } = await execAsync('hyprctl activewindow -j');
      const info = JSON.parse(stdout);
      result.windowId = String(info.address || '');
      result.title = info.title || '';
      result.appName = info.class || '';
      result.wmClass = info.class || '';
      result.pid = info.pid || 0;
      return result;
    } catch { /* not Hyprland */ }

    // Try swaymsg for Sway
    try {
      const { stdout } = await execAsync('swaymsg -t get_tree');
      const tree = JSON.parse(stdout);
      const focused = findFocusedNode(tree);
      if (focused) {
        result.windowId = String(focused.id || '');
        result.title = focused.name || '';
        result.appName = focused.app_id || '';
        result.wmClass = focused.app_id || '';
        result.pid = focused.pid || 0;
      }
      return result;
    } catch { /* not Sway */ }

    // Try gdbus for GNOME (Mutter)
    try {
      const { stdout } = await execAsync(
        `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.display.focus_window ? JSON.stringify({title: global.display.focus_window.get_title(), wmClass: global.display.focus_window.get_wm_class(), pid: global.display.focus_window.get_pid()}) : '{}'"`
      );
      // Parse the D-Bus response
      const match = stdout.match(/\('true', '(.*)'\)/);
      if (match) {
        const info = JSON.parse(match[1].replace(/\\'/g, "'"));
        result.title = info.title || '';
        result.appName = info.wmClass || '';
        result.wmClass = info.wmClass || '';
        result.pid = info.pid || 0;
      }
      return result;
    } catch { /* not GNOME */ }

    // Try KDE/KWin
    try {
      const { stdout } = await execAsync(
        `qdbus org.kde.KWin /KWin org.kde.KWin.activeWindow`
      );
      result.title = stdout.trim();
      return result;
    } catch { /* not KDE */ }

  } catch (err) {
    console.error(`getActiveWindowInfoWayland error: ${err.message}`);
  }
  return result;
}

function findFocusedNode(node) {
  if (node.focused) return node;
  if (node.nodes) {
    for (const child of node.nodes) {
      const found = findFocusedNode(child);
      if (found) return found;
    }
  }
  if (node.floating_nodes) {
    for (const child of node.floating_nodes) {
      const found = findFocusedNode(child);
      if (found) return found;
    }
  }
  return null;
}

// ============================================================
// Clipboard Operations
// ============================================================

/**
 * Get clipboard contents
 */
async function getClipboard() {
  try {
    if (displayServer === 'wayland' && tools.wlPaste) {
      const { stdout } = await execAsync('wl-paste --no-newline 2>/dev/null || true', { timeout: 2000 });
      return stdout;
    }
    if (tools.xclip) {
      const { stdout } = await execAsync('xclip -selection clipboard -o 2>/dev/null || true', { timeout: 2000 });
      return stdout;
    }
    if (tools.xsel) {
      const { stdout } = await execAsync('xsel --clipboard --output 2>/dev/null || true', { timeout: 2000 });
      return stdout;
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * Set clipboard contents
 */
async function setClipboard(text) {
  try {
    let cmd;
    if (displayServer === 'wayland' && tools.wlCopy) {
      cmd = 'wl-copy';
    } else if (tools.xclip) {
      cmd = 'xclip -selection clipboard';
    } else if (tools.xsel) {
      cmd = 'xsel --clipboard --input';
    } else {
      return;
    }

    return new Promise((resolve, reject) => {
      const proc = require('child_process').exec(cmd, { timeout: 2000 }, (err) => {
        if (err) reject(err); else resolve();
      });
      proc.stdin.write(text);
      proc.stdin.end();
    });
  } catch (err) {
    console.error(`[PASTE] setClipboard error: ${err.message}`);
  }
}

// ============================================================
// Text Paste
// ============================================================

/**
 * Paste text into the focused application
 * Strategy: set clipboard → Ctrl+V targeted at stored window → restore clipboard
 */
async function pasteText(text, _htmlText) {
  const startTime = Date.now();
  let success = false;

  try {
    // Set clipboard content (Electron already saves/restores clipboard itself)
    await setClipboard(text);

    // Wait for X server to register the clipboard ownership
    await sleep(80);

    // Simulate Ctrl+V on the currently focused window.
    // On a real Wayland compositor (even in XWayland mode), avoid xdotool
    // because its XTest requests trigger KDE Plasma's "Remote Control"
    // permission dialog. Use uinput/ydotool which bypass the compositor.
    if (isRealWayland()) {
      success = await pasteWithNativeWayland();
    } else if (displayServer === 'x11' && tools.xdotool) {
      await execAsync('xdotool key --clearmodifiers ctrl+v', { timeout: 2000 });
      success = true;
    } else {
      await simulateKeyCombo(['ctrl', 'v']);
      success = true;
    }
  } catch (err) {
    console.error(`[PASTE] error: ${err.message}`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[PASTE] ${text?.length || 0} chars, window=${storedWindowId || 'none'}, success=${success}, ${elapsed}ms`);

  return { success, timeElapsedMs: elapsed };
}

// ============================================================
// Key Simulation
// ============================================================

/**
 * Simulate a key press
 */
async function simulateKeyPress(keycode, _flags) {
  try {
    // On real Wayland, prefer ydotool to avoid KDE "Remote Control" dialog
    if (isRealWayland() && tools.ydotool) {
      await execAsync(`ydotool key ${keycode}`);
    } else if (displayServer === 'x11' && tools.xdotool) {
      const keyName = keycodeToXdotoolName(keycode);
      if (keyName) {
        await execAsync(`xdotool key ${keyName}`);
      }
    } else if (tools.ydotool) {
      await execAsync(`ydotool key ${keycode}`);
    }
  } catch (err) {
    console.error(`simulateKeyPress error: ${err.message}`);
  }
}

/**
 * Simulate a key combo like ['ctrl', 'v']
 */
async function simulateKeyCombo(keys) {
  const combo = keys.join('+');
  try {
    // On real Wayland (including XWayland mode), prefer ydotool/wtype
    // to avoid KDE "Remote Control" permission dialog from xdotool's XTest
    if (isRealWayland()) {
      if (tools.ydotool) {
        await execAsync(`ydotool key ${combo}`);
      } else if (commandExists('wtype')) {
        const modMap = { ctrl: '-M ctrl', shift: '-M shift', alt: '-M alt', super: '-M logo' };
        let cmd = 'wtype';
        for (const k of keys.slice(0, -1)) {
          cmd += ` ${modMap[k] || ''}`;
        }
        cmd += ` -k ${keys[keys.length - 1]}`;
        await execAsync(cmd);
      }
    } else if (displayServer === 'x11' && tools.xdotool) {
      await execAsync(`xdotool key --clearmodifiers ${combo}`);
    }
  } catch (err) {
    console.error(`simulateKeyCombo error: ${err.message}`);
  }
}

/**
 * Map Windows virtual keycodes to xdotool key names
 * See: https://docs.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes
 */
function keycodeToXdotoolName(keycode) {
  const vkMap = {
    0x08: 'BackSpace', 0x09: 'Tab', 0x0D: 'Return', 0x10: 'Shift_L',
    0x11: 'Control_L', 0x12: 'Alt_L', 0x13: 'Pause', 0x14: 'Caps_Lock',
    0x1B: 'Escape', 0x20: 'space', 0x21: 'Prior', 0x22: 'Next',
    0x23: 'End', 0x24: 'Home', 0x25: 'Left', 0x26: 'Up',
    0x27: 'Right', 0x28: 'Down', 0x2D: 'Insert', 0x2E: 'Delete',
    0x5B: 'Super_L', 0x5C: 'Super_R', 0x70: 'F1', 0x71: 'F2',
    0x72: 'F3', 0x73: 'F4', 0x74: 'F5', 0x75: 'F6',
    0x76: 'F7', 0x77: 'F8', 0x78: 'F9', 0x79: 'F10',
    0x7A: 'F11', 0x7B: 'F12',
  };

  // Letters (0x41-0x5A = A-Z)
  if (keycode >= 0x41 && keycode <= 0x5A) {
    return String.fromCharCode(keycode).toLowerCase();
  }
  // Numbers (0x30-0x39 = 0-9)
  if (keycode >= 0x30 && keycode <= 0x39) {
    return String.fromCharCode(keycode);
  }

  return vkMap[keycode] || null;
}

// ============================================================
// Window Focus Management
// ============================================================

let storedWindowId = null;

/**
 * Store the currently focused window
 */
async function storeFocusedWindow() {
  try {
    if (displayServer === 'x11' && tools.xdotool) {
      const { stdout } = await execAsync('xdotool getactivewindow', { timeout: 2000 });
      storedWindowId = stdout.trim();
    } else if (displayServer === 'wayland') {
      const info = await getActiveWindowInfo();
      storedWindowId = info.windowId;
    }
  } catch (err) {
    console.error(`[PASTE] storeFocusedWindow error: ${err.message}`);
  }
}

/**
 * Restore focus to the stored window
 */
async function focusStoredWindow() {
  if (!storedWindowId) return;
  // In native Wayland mode, apps can't steal focus — the compositor manages it.
  // In XWayland mode we still want xdotool-based focus restore.
  if (isNativeWaylandBackend()) return;
  try {
    if (displayServer === 'x11' && tools.xdotool) {
      await execAsync(`xdotool windowactivate --sync ${storedWindowId}`, { timeout: 1000 });
    }
  } catch (err) {
    console.error(`[PASTE] focusStoredWindow error: ${err.message}`);
  }
}

// ============================================================
// Selected Text
// ============================================================

/**
 * Get currently selected text via clipboard copy
 */
async function getSelectedTextViaCopy() {
  try {
    // Save clipboard
    const savedClipboard = await getClipboard();

    // Clear clipboard
    await setClipboard('');
    await sleep(50);

    // Simulate Ctrl+C
    await simulateKeyCombo(['ctrl', 'c']);
    await sleep(100);

    // Read clipboard (should have selected text now)
    const selectedText = await getClipboard();

    // Restore clipboard
    if (savedClipboard) {
      await setClipboard(savedClipboard);
    }

    return selectedText;
  } catch (err) {
    console.error(`getSelectedTextViaCopy error: ${err.message}`);
    return '';
  }
}

// ============================================================
// Utilities
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pasteWithNativeWayland() {
  try {
    await execAsync(`python3 "${UINPUT_SCRIPT}"`, { timeout: 3000 });
    return true;
  } catch (uinputError) {
    console.error(`[PASTE] uinput Ctrl+V failed: ${uinputError.message}`);
    if (!tools.ydotool) {
      return false;
    }
    await execAsync('ydotool key 29:1 47:1 47:0 29:0', { timeout: 3000 });
    return true;
  }
}

module.exports = {
  getDisplayServer,
  displayServer,
  tools,
  getActiveWindowInfo,
  getClipboard,
  setClipboard,
  pasteText,
  simulateKeyPress,
  simulateKeyCombo,
  storeFocusedWindow,
  focusStoredWindow,
  getSelectedTextViaCopy,
  sleep,
};
