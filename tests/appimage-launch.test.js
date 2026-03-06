/**
 * AppImage launch test
 * Verifies the existing AppImage starts without fatal errors.
 * Requires: AppImage already built in dist/
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const LOG_FILE = path.join(
  process.env.XDG_CACHE_HOME || path.join(process.env.HOME, '.cache'),
  'wispr-flow', 'launcher.log'
);

function findAppImage() {
  if (!fs.existsSync(DIST_DIR)) return null;
  const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.AppImage'));
  return files.length > 0 ? path.join(DIST_DIR, files[0]) : null;
}

describe('AppImage launch', () => {
  const appImage = findAppImage();

  beforeAll(() => {
    if (!appImage) {
      throw new Error('No AppImage found in dist/. Run "make build-appimage" first.');
    }
    // Clear old log
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
  });

  test('starts without fatal errors', () => {
    // Launch AppImage, wait 10s, kill. Output goes to launcher.log via AppRun.
    try {
      execSync(`timeout 10 "${appImage}" 2>/dev/null || true`, {
        encoding: 'utf8',
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: '1',
          WISPR_DEBUG: '1',
          DISPLAY: process.env.DISPLAY || ':0',
        },
        timeout: 20000,
      });
    } catch {
      // timeout exit code is expected
    }

    expect(fs.existsSync(LOG_FILE)).toBe(true);
    const log = fs.readFileSync(LOG_FILE, 'utf8');

    // App must have started (launcher log header present)
    expect(log).toContain('Wispr Flow AppImage Start');

    // Check first few lines for main process fatal errors.
    // Helper subprocess sandbox errors are non-fatal for the main app.
    const lines = log.split('\n');
    const mainProcessLines = lines.filter(l =>
      !l.includes('Helper service stderr:') &&
      !l.includes('helper stderr:')
    );
    const mainOutput = mainProcessLines.join('\n');

    // These indicate the main Electron process failed to start
    const fatalErrors = [
      'A JavaScript error occurred in the main process',
      'SyntaxError:',
      'Cannot find module',
      'MODULE_NOT_FOUND',
    ];

    for (const fatal of fatalErrors) {
      expect(mainOutput).not.toContain(fatal);
    }

    // Positive signals that the app loaded successfully
    const successSignals = [
      'Sentry Init',       // Sentry initialized
      'SQLite WAL mode',   // Database ready
      'migrated',          // Migrations ran
    ];
    const hasSuccess = successSignals.some(s => log.includes(s));
    expect(hasSuccess).toBe(true);
  }, 30000);

  test('no sandbox error in main process', () => {
    if (!fs.existsSync(LOG_FILE)) return;
    const log = fs.readFileSync(LOG_FILE, 'utf8');

    // Filter out helper subprocess lines
    const mainLines = log.split('\n').filter(l =>
      !l.includes('Helper service stderr:') &&
      !l.includes('helper stderr:')
    ).join('\n');

    expect(mainLines).not.toContain(
      'The SUID sandbox helper binary was found, but is not configured correctly'
    );
  });
});
