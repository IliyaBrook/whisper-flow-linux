#!/usr/bin/env node
// Increase libuv thread pool BEFORE any I/O — we need enough threads
// for multiple blocking evdev reads + other async file operations.
process.env.UV_THREADPOOL_SIZE = '16';

/**
 * Wispr Flow Linux Helper
 *
 * Native helper process for Wispr Flow on Linux.
 * Replaces the Windows Helper executable with Linux-native implementations
 * using xdotool, xclip, AT-SPI2 and other Linux tools.
 *
 * Communication protocol:
 *   stdin (fd 0)  - Receives JSON requests from Electron
 *   fd 3 (pipe)   - Sends JSON responses to Electron
 *   stdout (fd 1) - Logging
 *   stderr (fd 2) - Error logging
 *
 * Message format: escaped JSON delimited by "|"
 */

const { IPC } = require('./src/ipc');
const { Handler } = require('./src/handler');

function main() {
  console.log('Wispr Flow Linux Helper starting...');

  // Check for required tools
  const { tools, displayServer } = require('./src/utils');

  const missingCritical = [];
  if (displayServer === 'x11') {
    if (!tools.xdotool) missingCritical.push('xdotool');
    if (!tools.xclip && !tools.xsel) missingCritical.push('xclip or xsel');
  } else if (displayServer === 'wayland') {
    if (!tools.wlCopy && !tools.wlPaste) missingCritical.push('wl-clipboard (wl-copy/wl-paste)');
  }

  // On Wayland sessions (even in XWayland mode), ydotool is required for
  // input simulation — xdotool's XTest triggers KDE "Remote Control" dialog
  const realSession = process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : '');
  if (realSession === 'wayland' && !tools.ydotool) {
    missingCritical.push('ydotool (required on Wayland for input simulation)');
  }

  if (missingCritical.length > 0) {
    console.error(`Missing critical tools: ${missingCritical.join(', ')}`);
  }

  // Initialize handler and IPC
  const handler = new Handler();
  const ipc = new IPC(handler);
  ipc.start();

  console.log('Linux Helper ready, waiting for commands...');

  // Handle process signals
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    handler._stopIntervals();
    handler.shortcutManager.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    handler._stopIntervals();
    handler.shortcutManager.stop();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    console.error(`Uncaught exception: ${err.message}`);
    console.error(err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`Unhandled rejection: ${reason}`);
  });
}

main();
