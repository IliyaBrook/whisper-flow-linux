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

  // Run dependency check and report results
  const { checkDependencies } = require('./src/dep-check');
  const depReport = checkDependencies();

  // All dep-check output goes to stdout (not stderr) so that the Electron
  // frame-fix-wrapper can read it from child.stdout and show a dialog.
  console.log(`[dep-check] Session: ${depReport.session}, Desktop: ${depReport.desktop}`);

  if (!depReport.ok) {
    console.log('[dep-check] Missing critical dependencies:');
    for (const m of depReport.missing) {
      console.log(`[dep-check]   - ${m.tool}: ${m.reason}`);
    }
    if (depReport.installCommand) {
      console.log(`[dep-check] Install with: ${depReport.installCommand}`);
    }
  }

  for (const w of depReport.warnings) {
    console.log(`[dep-check] WARNING: ${w}`);
  }

  // Initialize handler and IPC
  const handler = new Handler();
  const ipc = new IPC(handler);
  ipc.start();

  // Send dependency report to Electron so it can show a user-friendly dialog
  // (sent as a HelperAPIRequest that the Electron side can intercept)
  if (!depReport.ok || depReport.warnings.length > 0) {
    setTimeout(() => {
      ipc.sendRequest({
        DependencyReport: {
          ok: depReport.ok,
          session: depReport.session,
          desktop: depReport.desktop,
          missing: depReport.missing,
          warnings: depReport.warnings,
          installCommand: depReport.installCommand,
        }
      });
    }, 500);
  }

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
