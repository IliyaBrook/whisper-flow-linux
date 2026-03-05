#!/usr/bin/env node
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
  console.log(`  PID: ${process.pid}`);
  console.log(`  Node: ${process.version}`);
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Display: ${process.env.DISPLAY || process.env.WAYLAND_DISPLAY || 'none'}`);
  console.log(`  XDG_SESSION_TYPE: ${process.env.XDG_SESSION_TYPE || 'unset'}`);

  // Check for required tools
  const { tools, displayServer } = require('./src/x11-utils');
  console.log(`  Display server: ${displayServer}`);
  console.log(`  Available tools:`);
  for (const [tool, available] of Object.entries(tools)) {
    if (available) console.log(`    - ${tool}`);
  }

  const missingCritical = [];
  if (displayServer === 'x11') {
    if (!tools.xdotool) missingCritical.push('xdotool');
    if (!tools.xclip && !tools.xsel) missingCritical.push('xclip or xsel');
  } else if (displayServer === 'wayland') {
    if (!tools.wlCopy && !tools.wlPaste) missingCritical.push('wl-clipboard (wl-copy/wl-paste)');
  }

  if (missingCritical.length > 0) {
    console.error(`WARNING: Missing critical tools: ${missingCritical.join(', ')}`);
    console.error('Some features may not work. Install them with:');
    if (displayServer === 'x11') {
      console.error('  sudo apt install xdotool xclip');
    } else {
      console.error('  sudo apt install wl-clipboard ydotool');
    }
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
