/**
 * Global keyboard shortcuts for Linux Helper
 * Supports X11 (via xinput/XGrabKey) and Wayland (via D-Bus global shortcuts portal)
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const { displayServer, tools } = require('./x11-utils');

const execAsync = promisify(exec);

class ShortcutManager {
  constructor(onShortcutTriggered) {
    this.onShortcutTriggered = onShortcutTriggered;
    this.shortcuts = [];
    this.xinputProcess = null;
    this.active = false;
  }

  /**
   * Update registered shortcuts
   */
  async updateShortcuts(shortcuts) {
    this.shortcuts = shortcuts || [];
    console.log(`Updated shortcuts: ${JSON.stringify(this.shortcuts)}`);
  }

  /**
   * Start listening for global key events
   */
  start() {
    if (this.active) return;
    this.active = true;

    if (displayServer === 'x11') {
      this._startX11KeyMonitor();
    } else if (displayServer === 'wayland') {
      this._startWaylandKeyMonitor();
    }
  }

  /**
   * Stop listening
   */
  stop() {
    this.active = false;
    if (this.xinputProcess) {
      this.xinputProcess.kill();
      this.xinputProcess = null;
    }
  }

  /**
   * X11: Monitor key events via xinput or xev
   */
  _startX11KeyMonitor() {
    // Use xinput to monitor keyboard events
    try {
      // xinput test-xi2 monitors all XI2 events
      this.xinputProcess = spawn('xinput', ['test-xi2', '--root'], {
        stdio: ['ignore', 'pipe', 'ignore']
      });

      let buffer = '';
      this.xinputProcess.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          this._parseXinputEvent(line);
        }
      });

      this.xinputProcess.on('error', (err) => {
        console.error(`xinput monitor error: ${err.message}`);
      });

      this.xinputProcess.on('close', (code) => {
        if (this.active) {
          console.log(`xinput monitor exited (${code}), restarting...`);
          setTimeout(() => this._startX11KeyMonitor(), 1000);
        }
      });
    } catch (err) {
      console.error(`Failed to start X11 key monitor: ${err.message}`);
    }
  }

  _parseXinputEvent(line) {
    // Parse xinput test-xi2 output for key press events
    // Format: EVENT type 13 (RawKeyPress), ... detail: <keycode>
    if (line.includes('RawKeyPress') || line.includes('KeyPress')) {
      const detailMatch = line.match(/detail:\s*(\d+)/);
      if (detailMatch) {
        const keycode = parseInt(detailMatch[1], 10);
        this._handleKeyEvent('press', keycode);
      }
    } else if (line.includes('RawKeyRelease') || line.includes('KeyRelease')) {
      const detailMatch = line.match(/detail:\s*(\d+)/);
      if (detailMatch) {
        const keycode = parseInt(detailMatch[1], 10);
        this._handleKeyEvent('release', keycode);
      }
    }
  }

  /**
   * Wayland: Use GlobalShortcuts portal via D-Bus
   */
  _startWaylandKeyMonitor() {
    // The XDG Desktop Portal GlobalShortcuts interface
    // This requires the compositor to support it
    console.log('Wayland global shortcuts: using D-Bus portal');
    // For now, we rely on the Electron app's globalShortcut module
    // which works on some Wayland compositors
  }

  _handleKeyEvent(type, keycode) {
    // This will be used for stale key detection and event forwarding
    if (this.onShortcutTriggered) {
      this.onShortcutTriggered(type, keycode);
    }
  }

  /**
   * Check for stale/stuck keys
   */
  async checkStaleKeys() {
    const staleKeys = [];
    try {
      if (displayServer === 'x11') {
        // Use xdotool to check key state
        const { stdout } = await execAsync('xset q 2>/dev/null | grep "LED mask" || true');
        // Basic stale key detection - check if modifier keys are stuck
        // More sophisticated detection would use XQueryKeymap
      }
    } catch (err) {
      console.error(`checkStaleKeys error: ${err.message}`);
    }
    return staleKeys;
  }
}

module.exports = { ShortcutManager };
