/**
 * Global keyboard monitoring for Linux Helper
 * Monitors key events and forwards them to Electron main process
 * as KeypressEvent IPC messages.
 *
 * On X11: uses xinput test-xi2 --root (captures all X11 key events)
 * On Wayland: reads from /dev/input/event* (evdev) for true global capture,
 *             falls back to xinput via XWayland if evdev is unavailable.
 *
 * The main process expects Windows VK codes (since isMac=false on Linux),
 * so we map keycodes to Windows VK codes.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Debug log to file (stderr is piped to Electron and not shown in terminal)
const DEBUG_LOG = path.join(require('os').tmpdir(), 'wispr-shortcuts-debug.log');
function dbg(msg) {
  try { fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`); } catch(e) {}
}

// For keyboard monitoring, detect the REAL session type (not the
// WISPR_DISPLAY_BACKEND override which is only for clipboard/window tools).
// On Wayland+XWayland, xinput only sees events for XWayland windows,
// so we must use evdev for true global key capture.
function getRealSessionType() {
  const xdg = process.env.XDG_SESSION_TYPE || '';
  if (xdg === 'wayland') return 'wayland';
  if (xdg === 'x11') return 'x11';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'unknown';
}
const sessionType = getRealSessionType();

// X11 evdev keycode → Windows Virtual Key code
// Note: evdev keycode = X11 keycode - 8
const X11_TO_VK = {
  9: 27,    // Escape
  10: 49, 11: 50, 12: 51, 13: 52, 14: 53, 15: 54, 16: 55, 17: 56, 18: 57, 19: 48, // 1-0
  20: 189, 21: 187, // Minus, Equals
  22: 8,   // Backspace
  23: 9,   // Tab
  24: 81, 25: 87, 26: 69, 27: 82, 28: 84, 29: 89, 30: 85, 31: 73, 32: 79, 33: 80, // q-p
  34: 219, 35: 221, // [ ]
  36: 13,  // Return
  37: 162, // Control_L
  38: 65, 39: 83, 40: 68, 41: 70, 42: 71, 43: 72, 44: 74, 45: 75, 46: 76, // a-l
  47: 186, 48: 222, 49: 192, // ; ' `
  50: 160, // Shift_L
  51: 220, // Backslash
  52: 90, 53: 88, 54: 67, 55: 86, 56: 66, 57: 78, 58: 77, // z-m
  59: 188, 60: 190, 61: 191, // , . /
  62: 161, // Shift_R
  63: 106, // KP_Multiply
  64: 164, // Alt_L
  65: 32,  // Space
  66: 20,  // Caps_Lock
  67: 112, 68: 113, 69: 114, 70: 115, 71: 116, 72: 117, 73: 118, 74: 119, 75: 120, 76: 121, // F1-F10
  77: 144, 78: 145, // Num_Lock, Scroll_Lock
  79: 103, 80: 104, 81: 105, // KP_7-9
  82: 109, // KP_Subtract
  83: 100, 84: 101, 85: 102, // KP_4-6
  86: 107, // KP_Add
  87: 97, 88: 98, 89: 99, // KP_1-3
  90: 96,  // KP_0
  91: 110, // KP_Decimal
  95: 122, 96: 123, // F11, F12
  104: 13, // KP_Enter
  105: 163, // Control_R
  106: 111, // KP_Divide
  107: 44,  // Print Screen
  108: 165, // Alt_R
  110: 36,  // Home
  111: 38,  // Up
  112: 33,  // Page_Up
  113: 37,  // Left
  114: 39,  // Right
  115: 35,  // End
  116: 40,  // Down
  117: 34,  // Page_Down
  118: 45,  // Insert
  119: 46,  // Delete
  133: 91, 134: 92, // Super_L, Super_R
  135: 93,  // Menu
};

// Evdev keycode → Windows VK code (evdev = X11 keycode - 8)
const EVDEV_TO_VK = {};
for (const [x11Code, vkCode] of Object.entries(X11_TO_VK)) {
  const evdevCode = parseInt(x11Code, 10) - 8;
  if (evdevCode >= 0) {
    EVDEV_TO_VK[evdevCode] = vkCode;
  }
}

// sizeof(struct input_event) on 64-bit Linux
const INPUT_EVENT_SIZE = 24;
const EV_KEY = 1;

class ShortcutManager {
  constructor() {
    this.xinputProcess = null;
    this.evdevStreams = [];
    this.active = false;
    this.eventIndex = 0;
    this.ipc = null;
    this._currentEventType = null;
    this._usingEvdev = false;
    this._pressedKeys = new Set(); // Track pressed keys to deduplicate across multiple evdev devices
  }

  setIPC(ipc) {
    this.ipc = ipc;
  }

  async updateShortcuts() {
    // Shortcuts are managed by Electron main process.
    // We forward raw key events and it handles matching.
  }

  start() {
    dbg(`start() called, active=${this.active}, session=${sessionType}`);
    if (this.active) return;
    this.active = true;

    if (sessionType === 'wayland') {
      // On Wayland, try evdev first (true global capture),
      // fall back to xinput via XWayland
      const evdevStarted = this._startEvdevKeyMonitor();
      if (!evdevStarted) {
        console.error('[Shortcuts] evdev unavailable on Wayland, falling back to xinput (XWayland). ' +
          'Hotkeys will only work when an XWayland window is focused. ' +
          'To fix: sudo usermod -aG input $USER && reboot');
        this._startXinputKeyMonitor();
      }
    } else {
      // X11: xinput works perfectly
      this._startXinputKeyMonitor();
    }
  }

  stop() {
    this.active = false;
    if (this.xinputProcess) {
      this.xinputProcess.kill();
      this.xinputProcess = null;
    }
    for (const stream of this.evdevStreams) {
      try { stream.destroy(); } catch (e) { /* ignore */ }
    }
    this.evdevStreams = [];
    this._pressedKeys.clear();
  }

  // ============================================================
  // Evdev monitor (Wayland — reads /dev/input/event* directly)
  // ============================================================

  _startEvdevKeyMonitor() {
    const keyboards = this._findKeyboardDevices();
    if (keyboards.length === 0) {
      console.error('[Shortcuts] No keyboard devices found in /dev/input/');
      return false;
    }

    let opened = 0;
    for (const device of keyboards) {
      if (this._openEvdevDevice(device)) opened++;
    }

    if (opened > 0) {
      this._usingEvdev = true;
      console.log(`[Shortcuts] evdev: monitoring ${opened} keyboard device(s) on Wayland`);
      return true;
    }
    console.error('[Shortcuts] Failed to open any keyboard device');
    return false;
  }

  _findKeyboardDevices() {
    const devices = [];

    // Method 1: /dev/input/by-path/*-kbd symlinks
    try {
      const byPath = '/dev/input/by-path/';
      if (fs.existsSync(byPath)) {
        const entries = fs.readdirSync(byPath);
        for (const entry of entries) {
          if (entry.includes('-kbd') && entry.includes('event')) {
            try {
              devices.push(fs.realpathSync(`${byPath}${entry}`));
            } catch (e) { /* broken symlink */ }
          }
        }
      }
    } catch (e) { /* ignore */ }

    if (devices.length > 0) return [...new Set(devices)];

    // Method 2: parse /proc/bus/input/devices for keyboards
    try {
      const content = fs.readFileSync('/proc/bus/input/devices', 'utf8');
      const sections = content.split('\n\n');
      for (const section of sections) {
        const evMatch = section.match(/B: EV=(\w+)/);
        const keyMatch = section.match(/B: KEY=.*(e0000|10000)/);
        if (evMatch && keyMatch) {
          const handlerMatch = section.match(/H: Handlers=.*?(event\d+)/);
          if (handlerMatch) {
            devices.push(`/dev/input/${handlerMatch[1]}`);
          }
        }
      }
    } catch (e) { /* ignore */ }

    return [...new Set(devices)];
  }

  _openEvdevDevice(devicePath) {
    // Read evdev device via fs.createReadStream with blocking reads.
    // Each read() blocks in libuv's thread pool until an event arrives,
    // then delivers exactly that event — no batching/buffering.
    // Requires UV_THREADPOOL_SIZE >= number of devices + headroom (set in spawn env).
    let fd;
    try {
      fd = fs.openSync(devicePath, 'r');
      dbg(`opened ${devicePath} fd=${fd} (stream)`);
    } catch (err) {
      dbg(`FAILED to open ${devicePath}: ${err.message}`);
      return false;
    }

    const stream = fs.createReadStream(null, {
      fd,
      highWaterMark: INPUT_EVENT_SIZE * 4,
      autoClose: true
    });

    let remainder = Buffer.alloc(0);

    stream.on('data', (chunk) => {
      dbg(`evdev data from ${devicePath}: ${chunk.length} bytes`);
      const data = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
      let offset = 0;

      while (offset + INPUT_EVENT_SIZE <= data.length) {
        const type = data.readUInt16LE(offset + 16);
        const code = data.readUInt16LE(offset + 18);
        const value = data.readInt32LE(offset + 20);
        offset += INPUT_EVENT_SIZE;

        if (type === EV_KEY) {
          const vkCode = EVDEV_TO_VK[code];
          dbg(`EV_KEY code=${code} value=${value} vkCode=${vkCode} ipc=${!!this.ipc}`);
          if (vkCode !== undefined) {
            if (value === 1) { // press
              if (!this._pressedKeys.has(vkCode)) {
                this._pressedKeys.add(vkCode);
                this._sendKeyEvent('key_event_press', vkCode);
              }
            } else if (value === 2) { // repeat (key held down) — ignore
            } else if (value === 0) { // release
              if (this._pressedKeys.has(vkCode)) {
                this._pressedKeys.delete(vkCode);
                this._sendKeyEvent('key_event_release', vkCode);
              }
            }
          }
        }
      }

      remainder = offset < data.length ? data.subarray(offset) : Buffer.alloc(0);
    });

    stream.on('error', (err) => {
      dbg(`evdev error ${devicePath}: ${err.message}`);
      this.evdevStreams = this.evdevStreams.filter(s => s !== stream);
    });

    stream.on('close', () => {
      dbg(`evdev closed ${devicePath}`);
      this.evdevStreams = this.evdevStreams.filter(s => s !== stream);
      if (this.active && this._usingEvdev) {
        setTimeout(() => {
          if (this.active) this._openEvdevDevice(devicePath);
        }, 2000);
      }
    });

    this.evdevStreams.push(stream);
    return true;
  }

  // ============================================================
  // Xinput monitor (X11 / XWayland fallback)
  // ============================================================

  _startXinputKeyMonitor() {
    try {
      this.xinputProcess = spawn('xinput', ['test-xi2', '--root'], {
        stdio: ['ignore', 'pipe', 'ignore']
      });

      let buffer = '';
      this.xinputProcess.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          this._parseXinputLine(line);
        }
      });

      this.xinputProcess.on('error', (err) => {
        console.error(`xinput monitor error: ${err.message}`);
      });

      this.xinputProcess.on('close', (code) => {
        if (this.active && !this._usingEvdev) {
          setTimeout(() => this._startXinputKeyMonitor(), 1000);
        }
      });
    } catch (err) {
      console.error(`Failed to start xinput key monitor: ${err.message}`);
    }
  }

  _parseXinputLine(line) {
    if (line.includes('RawKeyPress')) {
      this._currentEventType = 'key_event_press';
    } else if (line.includes('RawKeyRelease')) {
      this._currentEventType = 'key_event_release';
    } else if (this._currentEventType) {
      const detailMatch = line.match(/detail:\s*(\d+)/);
      if (detailMatch) {
        const x11Keycode = parseInt(detailMatch[1], 10);
        const vkCode = X11_TO_VK[x11Keycode];
        if (vkCode !== undefined) {
          this._sendKeyEvent(this._currentEventType, vkCode);
        }
        this._currentEventType = null;
      }
    }
  }

  // ============================================================
  // Common
  // ============================================================

  _sendKeyEvent(eventType, vkCode) {
    if (!this.ipc) {
      dbg(`_sendKeyEvent: NO IPC! event=${eventType} vk=${vkCode}`);
      return;
    }
    dbg(`SENDING ${eventType} vk=${vkCode}`);

    this.eventIndex++;
    this.ipc.sendRequest({
      uuid: `key-${Date.now()}-${this.eventIndex}`,
      KeypressEvent: {
        payload: {
          eventType,
          key: vkCode,
          index: this.eventIndex,
          inputType: 'keyboard',
        }
      }
    });
  }

  async checkStaleKeys() {
    return [];
  }
}

module.exports = { ShortcutManager };
