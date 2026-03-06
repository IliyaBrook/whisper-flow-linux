/**
 * Global keyboard monitoring for Linux Helper
 * Monitors key events via xinput (X11/XWayland) and forwards them
 * to Electron main process as KeypressEvent IPC messages.
 *
 * The main process expects Windows VK codes (since isMac=false on Linux),
 * so we map X11 keycodes to Windows VK codes.
 */

const { spawn } = require('child_process');
const { displayServer } = require('./x11-utils');

// X11 evdev keycode → Windows Virtual Key code
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

class ShortcutManager {
  constructor() {
    this.xinputProcess = null;
    this.active = false;
    this.eventIndex = 0;
    this.ipc = null;
    this._currentEventType = null;
  }

  setIPC(ipc) {
    this.ipc = ipc;
  }

  async updateShortcuts() {
    // Shortcuts are managed by Electron main process.
    // We forward raw key events and it handles matching.
  }

  start() {
    if (this.active) return;
    this.active = true;
    // xinput works on both X11 and XWayland (default Wayland mode)
    this._startX11KeyMonitor();
  }

  stop() {
    this.active = false;
    if (this.xinputProcess) {
      this.xinputProcess.kill();
      this.xinputProcess = null;
    }
  }

  _startX11KeyMonitor() {
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
        if (this.active) {
          console.log(`xinput exited (${code}), restarting in 1s...`);
          setTimeout(() => this._startX11KeyMonitor(), 1000);
        }
      });
    } catch (err) {
      console.error(`Failed to start X11 key monitor: ${err.message}`);
    }
  }

  _parseXinputLine(line) {
    // xinput test-xi2 --root output is multiline:
    //   EVENT type 13 (RawKeyPress)
    //       detail: 38
    //   EVENT type 14 (RawKeyRelease)
    //       detail: 38
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

  _sendKeyEvent(eventType, vkCode) {
    if (!this.ipc) return;

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
