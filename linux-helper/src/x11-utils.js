/**
 * X11/Wayland utilities for Linux Helper
 * Handles: window focus, app info, key simulation, clipboard, text paste
 */

const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Detect display server (X11 or Wayland)
 */
function getDisplayServer() {
  const xdgSession = process.env.XDG_SESSION_TYPE || '';
  if (xdgSession === 'wayland') return 'wayland';
  if (xdgSession === 'x11') return 'x11';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'unknown';
}

const displayServer = getDisplayServer();

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
      const windowId = (await execAsync('xdotool getactivewindow')).stdout.trim();
      result.windowId = windowId;

      const name = (await execAsync(`xdotool getactivewindow getwindowname`)).stdout.trim();
      result.title = name;

      const pid = (await execAsync(`xdotool getactivewindow getwindowpid`)).stdout.trim();
      result.pid = parseInt(pid, 10) || 0;
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
        const cmdline = fs.readFileSync(`/proc/${result.pid}/comm`, 'utf8').trim();
        result.appName = cmdline;
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
    if (displayServer === 'wayland' && tools.wlCopy) {
      const { exec: execCb } = require('child_process');
      return new Promise((resolve, reject) => {
        const proc = execCb('wl-copy', (err) => err ? reject(err) : resolve());
        proc.stdin.write(text);
        proc.stdin.end();
      });
    }
    if (tools.xclip) {
      return new Promise((resolve, reject) => {
        const proc = require('child_process').exec(
          'xclip -selection clipboard',
          (err) => err ? reject(err) : resolve()
        );
        proc.stdin.write(text);
        proc.stdin.end();
      });
    }
    if (tools.xsel) {
      return new Promise((resolve, reject) => {
        const proc = require('child_process').exec(
          'xsel --clipboard --input',
          (err) => err ? reject(err) : resolve()
        );
        proc.stdin.write(text);
        proc.stdin.end();
      });
    }
  } catch (err) {
    console.error(`setClipboard error: ${err.message}`);
  }
}

// ============================================================
// Text Paste
// ============================================================

/**
 * Paste text into the focused application
 * Strategy: save clipboard → set clipboard → Ctrl+V → restore clipboard
 */
async function pasteText(text, htmlText) {
  const startTime = Date.now();
  let success = false;

  console.log(`[pasteText] Starting paste, text length: ${text?.length || 0}, display: ${displayServer}`);

  try {
    // Save current clipboard
    const savedClipboard = await getClipboard();
    console.log(`[pasteText] Saved clipboard, length: ${savedClipboard?.length || 0}`);

    // Set new clipboard content
    await setClipboard(text);
    console.log(`[pasteText] Clipboard set with new text`);

    // Small delay to ensure clipboard is set
    await sleep(50);

    // Verify clipboard was set
    const verify = await getClipboard();
    console.log(`[pasteText] Clipboard verify: ${verify === text ? 'OK' : 'MISMATCH'} (${verify?.length || 0} chars)`);

    // Get focused window before paste
    let focusedWindow = '';
    try {
      if (tools.xdotool) {
        const { stdout } = await execAsync('xdotool getactivewindow getwindowname 2>/dev/null || echo "unknown"', { timeout: 2000 });
        focusedWindow = stdout.trim();
      }
    } catch { /* ignore */ }
    console.log(`[pasteText] Focused window before paste: "${focusedWindow}"`);

    // Simulate Ctrl+V
    console.log(`[pasteText] Sending Ctrl+V via ${displayServer === 'x11' && tools.xdotool ? 'xdotool' : 'other'}`);
    await simulateKeyCombo(['ctrl', 'v']);

    // Wait for paste to complete
    await sleep(100);

    // Restore clipboard
    if (savedClipboard) {
      await sleep(200);
      await setClipboard(savedClipboard);
      console.log(`[pasteText] Clipboard restored`);
    }

    success = true;
    console.log(`[pasteText] Paste completed in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error(`pasteText error: ${err.message}`);
    console.error(err.stack);
  }

  return {
    success,
    timeElapsedMs: Date.now() - startTime
  };
}

// ============================================================
// Key Simulation
// ============================================================

/**
 * Simulate a key press
 */
async function simulateKeyPress(keycode, flags) {
  try {
    if (displayServer === 'x11' && tools.xdotool) {
      const keyName = keycodeToXdotoolName(keycode, flags);
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
    if (displayServer === 'x11' && tools.xdotool) {
      await execAsync(`xdotool key --clearmodifiers ${combo}`);
    } else if (displayServer === 'wayland') {
      if (tools.ydotool) {
        // ydotool uses keycodes, need to translate
        await execAsync(`ydotool key ${combo}`);
      } else if (tools.wlCopy) {
        // For Ctrl+V specifically, we can try wtype
        if (commandExists('wtype')) {
          const modMap = { ctrl: '-M ctrl', shift: '-M shift', alt: '-M alt', super: '-M logo' };
          let cmd = 'wtype';
          for (const k of keys.slice(0, -1)) {
            cmd += ` ${modMap[k] || ''}`;
          }
          cmd += ` -k ${keys[keys.length - 1]}`;
          await execAsync(cmd);
        }
      }
    }
  } catch (err) {
    console.error(`simulateKeyCombo error: ${err.message}`);
  }
}

/**
 * Map Windows virtual keycodes to xdotool key names
 * See: https://docs.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes
 */
function keycodeToXdotoolName(keycode, flags) {
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
      // Log window name for debugging
      try {
        const { stdout: name } = await execAsync(`xdotool getwindowname ${storedWindowId}`, { timeout: 2000 });
        console.log(`[storeFocusedWindow] Stored window: ${storedWindowId} ("${name.trim()}")`);
      } catch {
        console.log(`[storeFocusedWindow] Stored window: ${storedWindowId}`);
      }
    } else if (displayServer === 'wayland') {
      const info = await getActiveWindowInfo();
      storedWindowId = info.windowId;
      console.log(`[storeFocusedWindow] Stored window: ${storedWindowId} ("${info.title}")`);
    }
  } catch (err) {
    console.error(`storeFocusedWindow error: ${err.message}`);
  }
}

/**
 * Restore focus to the stored window
 */
async function focusStoredWindow() {
  if (!storedWindowId) {
    console.log('[focusStoredWindow] No stored window ID, skipping');
    return;
  }
  try {
    if (displayServer === 'x11' && tools.xdotool) {
      console.log(`[focusStoredWindow] Activating window: ${storedWindowId}`);
      await execAsync(`xdotool windowactivate --sync ${storedWindowId}`, { timeout: 3000 });
      // Verify focus was restored
      const { stdout } = await execAsync('xdotool getactivewindow', { timeout: 2000 });
      const currentId = stdout.trim();
      if (currentId === storedWindowId) {
        console.log(`[focusStoredWindow] Focus restored successfully`);
      } else {
        console.log(`[focusStoredWindow] Focus mismatch: expected ${storedWindowId}, got ${currentId}`);
      }
    }
    // Wayland: depends on compositor, generally harder
  } catch (err) {
    console.error(`focusStoredWindow error: ${err.message}`);
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
