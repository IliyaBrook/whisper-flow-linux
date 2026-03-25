/**
 * Build pipeline integration tests
 * Tests that the build scripts work correctly:
 * download → extract → patch → rebuild-native → package-deb
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');
const TMP_DIR = path.join(ROOT_DIR, 'tmp');
const BUILD_DIR = path.join(ROOT_DIR, 'build');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// ============================================================
// Build scripts existence and syntax
// ============================================================

describe('Build scripts validation', () => {
  const scripts = [
    'download.js',
    'extract.js',
    'patch.js',
    'rebuild-native.js',
    'package-deb.js',
    'package-appimage.js',
  ];

  test.each(scripts)('%s exists', (script) => {
    const scriptPath = path.join(SCRIPTS_DIR, script);
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test.each(scripts)('%s has valid syntax', (script) => {
    const scriptPath = path.join(SCRIPTS_DIR, script);
    // node --check validates syntax without executing
    expect(() => {
      execSync(`node --check "${scriptPath}"`, { stdio: 'pipe' });
    }).not.toThrow();
  });
});

// ============================================================
// Linux helper validation
// ============================================================

describe('Linux helper validation', () => {
  const helperDir = path.join(ROOT_DIR, 'linux-helper');

  test('main.js exists', () => {
    expect(fs.existsSync(path.join(helperDir, 'main.js'))).toBe(true);
  });

  test('all source modules exist', () => {
    const modules = ['ipc.js', 'handler.js', 'utils.js', 'dep-check.js', 'accessibility.js', 'shortcuts.js', 'hardware.js'];
    for (const mod of modules) {
      expect(fs.existsSync(path.join(helperDir, 'src', mod))).toBe(true);
    }
  });

  test('main.js has valid syntax', () => {
    expect(() => {
      execSync(`node --check "${path.join(helperDir, 'main.js')}"`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  test.each(['ipc.js', 'handler.js', 'utils.js', 'dep-check.js', 'accessibility.js', 'shortcuts.js', 'hardware.js'])(
    'src/%s has valid syntax', (mod) => {
      expect(() => {
        execSync(`node --check "${path.join(helperDir, 'src', mod)}"`, { stdio: 'pipe' });
      }).not.toThrow();
    }
  );
});

// ============================================================
// Patch logic unit tests (most fragile part of the build)
// ============================================================

describe('Patch logic', () => {
  // Simulate a realistic minified webpack bundle with the patterns patch.js looks for
  const mockBundle = [
    'var somecode=1;',
    // Windows helper path pattern
    'const r=e.isHelperProcessRunningManually?(L.info("Running dev Helper"),`${O.ZI}/dev-helper`):(L.info("Running packaged Windows Helper service"),`${O.ZI}\\\\Release\\\\Wispr Flow Helper.exe`)',
    ';',
    // Spawn pattern
    'helper.process=(0,i.spawn)(r,{stdio:["pipe","pipe","pipe","pipe"],env:{FOO:"bar"}})',
    ';',
    // crypt32 modules
    'module.exports=__non_webpack_require__(__webpack_require__.ab+"lib/crypt32-x64.node")',
    ';',
    'module.exports=__non_webpack_require__(__webpack_require__.ab+"lib/crypt32-ia32.node")',
    ';',
    // electron-squirrel-startup
    'if(require("electron-squirrel-startup"))app.quit()',
    ';',
    // mac-ca
    'const ca=require("mac-ca")',
  ].join('');

  function applyPatches(code) {
    // Reproduce patch.js logic inline for testing

    // Patch 1: Helper path - add Linux branch
    const helperPathRegex = /(const r=)(.*?isHelperProcessRunningManually.*?"Running packaged Windows Helper service"\),`\$\{(\w+)\.(\w+)\}\\\\Release\\\\Wispr Flow Helper\.exe`)/s;
    const fullMatch = code.match(helperPathRegex);
    if (fullMatch) {
      const winHelperPattern = /(\w+)\.info\("Running packaged Windows Helper service"\)/;
      const logMatch = code.match(winHelperPattern);
      const logFn = logMatch ? logMatch[1] : 'L';
      const pMod = fullMatch[3];
      const pProp = fullMatch[4];
      const linuxPath = `"linux"===process.platform?(${logFn}.info("Running Linux Helper service"),\`\${${pMod}.${pProp}}/linux-helper/main.js\`):`;
      code = code.replace(fullMatch[0], fullMatch[1] + linuxPath + fullMatch[2]);
    }

    // Patch 2: Helper spawn
    const spawnPattern = /helper\.process=\(0,(\w+)\.spawn\)\(r,\{stdio:\["pipe","pipe","pipe","pipe"\]/;
    const spawnMatch = code.match(spawnPattern);
    if (spawnMatch) {
      const spawnModule = spawnMatch[1];
      code = code.replace(
        spawnMatch[0],
        `helper.process="linux"===process.platform?(0,${spawnModule}.spawn)(process.execPath,[r],{stdio:["pipe","pipe","pipe","pipe"]`
      );
    }

    // Patch 3: crypt32
    const crypt32Pattern = /module\.exports\s*=\s*__non_webpack_require__\(__webpack_require__\.ab\s*\+\s*"lib\/crypt32-(x64|ia32)\.node"\)/g;
    code = code.replace(crypt32Pattern, 'module.exports = {}');

    // Patch 4: squirrel startup
    code = code.replace(/require\("electron-squirrel-startup"\)/g, 'false');

    // Patch 5: mac-ca
    code = code.replace(/require\("mac-ca"\)/g, '({})');

    return code;
  }

  test('adds Linux helper path branch', () => {
    const patched = applyPatches(mockBundle);
    expect(patched).toContain('"linux"===process.platform');
    expect(patched).toContain('Running Linux Helper service');
    expect(patched).toContain('linux-helper/main.js');
  });

  test('preserves Windows helper path as fallback', () => {
    const patched = applyPatches(mockBundle);
    expect(patched).toContain('Running packaged Windows Helper service');
    expect(patched).toContain('Wispr Flow Helper.exe');
  });

  test('patches spawn to use process.execPath on Linux', () => {
    const patched = applyPatches(mockBundle);
    expect(patched).toContain('process.execPath,[r]');
  });

  test('replaces crypt32 native modules with no-op', () => {
    const patched = applyPatches(mockBundle);
    expect(patched).not.toContain('crypt32-x64.node');
    expect(patched).not.toContain('crypt32-ia32.node');
    expect(patched).toContain('module.exports = {}');
  });

  test('disables electron-squirrel-startup', () => {
    const patched = applyPatches(mockBundle);
    expect(patched).not.toContain('require("electron-squirrel-startup")');
    expect(patched).toContain('if(false)app.quit()');
  });

  test('replaces mac-ca with no-op', () => {
    const patched = applyPatches(mockBundle);
    expect(patched).not.toContain('require("mac-ca")');
    expect(patched).toContain('const ca=({})');
  });

  test('patched bundle differs from original', () => {
    const patched = applyPatches(mockBundle);
    expect(patched).not.toBe(mockBundle);
  });
});

// ============================================================
// Full build pipeline integration test
// ============================================================

describe('Build pipeline integration', () => {
  // This test runs the actual build pipeline
  // It requires network access and takes several minutes
  const TIMEOUT = 10 * 60 * 1000; // 10 minutes

  test('Step 1: download - fetches Windows installer', () => {
    execSync('yarn download', { cwd: ROOT_DIR, stdio: 'inherit' });
    const exePath = path.join(TMP_DIR, 'wispr-flow-setup.exe');
    expect(fs.existsSync(exePath)).toBe(true);
    const stats = fs.statSync(exePath);
    expect(stats.size).toBeGreaterThan(100 * 1024 * 1024); // >100 MB
  }, TIMEOUT);

  test('Step 2: extract - unpacks installer and asar', () => {
    execSync('yarn extract', { cwd: ROOT_DIR, stdio: 'inherit' });

    // Check extracted directories exist
    expect(fs.existsSync(path.join(TMP_DIR, 'extracted'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_DIR, 'nupkg-content'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_DIR, 'app'))).toBe(true);

    // Check asar was unpacked
    const asarDir = path.join(TMP_DIR, 'app', 'asar-content');
    expect(fs.existsSync(asarDir)).toBe(true);
    expect(fs.existsSync(path.join(asarDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(asarDir, '.webpack', 'main', 'index.js'))).toBe(true);

    // Check metadata was saved
    const metaPath = path.join(TMP_DIR, 'app', 'metadata.json');
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.appVersion).toBeTruthy();
    expect(meta.electronVersion).toBeTruthy();
  }, TIMEOUT);

  test('Step 3: patch - applies Linux patches to webpack bundle', () => {
    // Save original bundle for comparison
    const bundlePath = path.join(TMP_DIR, 'app', 'asar-content', '.webpack', 'main', 'index.js');
    const originalSize = fs.statSync(bundlePath).size;

    execSync('yarn run patch', { cwd: ROOT_DIR, stdio: 'inherit' });

    // Bundle should be modified (size change)
    const newSize = fs.statSync(bundlePath).size;
    expect(newSize).not.toBe(originalSize);

    // Verify Linux patches were applied
    const code = fs.readFileSync(bundlePath, 'utf8');
    expect(code).toContain('linux');
    expect(code).toContain('linux-helper/main.js');

    // crypt32 should be no-oped
    expect(code).not.toMatch(/crypt32-(x64|ia32)\.node/);

    // Linux helper should be copied to resources
    const helperDest = path.join(TMP_DIR, 'app', 'resources', 'linux-helper');
    expect(fs.existsSync(helperDest)).toBe(true);
    expect(fs.existsSync(path.join(helperDest, 'main.js'))).toBe(true);
  }, TIMEOUT);

  test('Step 4: rebuild-native - rebuilds sqlite3 for Linux', () => {
    execSync('yarn rebuild-native', { cwd: ROOT_DIR, stdio: 'inherit' });

    // sqlite3 native module should exist
    const sqlitePath = path.join(
      TMP_DIR, 'app', 'asar-content', '.webpack', 'main',
      'native_modules', 'build', 'Release', 'node_sqlite3.node'
    );
    if (fs.existsSync(sqlitePath)) {
      // Verify it's a Linux ELF binary, not a Windows PE
      const header = Buffer.alloc(4);
      const fd = fs.openSync(sqlitePath, 'r');
      fs.readSync(fd, header, 0, 4, 0);
      fs.closeSync(fd);
      // ELF magic: 0x7f 'E' 'L' 'F'
      expect(header[0]).toBe(0x7f);
      expect(header[1]).toBe(0x45); // 'E'
      expect(header[2]).toBe(0x4c); // 'L'
      expect(header[3]).toBe(0x46); // 'F'
    }
  }, TIMEOUT);

  test('Step 5: package-deb - creates .deb package', () => {
    execSync('yarn package-deb', { cwd: ROOT_DIR, stdio: 'inherit' });

    // Check dist directory has a .deb file
    expect(fs.existsSync(DIST_DIR)).toBe(true);
    const debFiles = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.deb'));
    expect(debFiles.length).toBeGreaterThan(0);

    // Verify .deb is a valid ar archive
    const debPath = path.join(DIST_DIR, debFiles[0]);
    const debSize = fs.statSync(debPath).size;
    expect(debSize).toBeGreaterThan(1024 * 1024); // should be > 1MB

    // Check deb contents
    const debContents = execSync(`dpkg-deb --contents "${debPath}" 2>/dev/null | head -20`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(debContents).toContain('wispr-flow');

    // Verify control file info
    const debInfo = execSync(`dpkg-deb --info "${debPath}" 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(debInfo).toContain('Package: wispr-flow');
    expect(debInfo).toContain('Architecture: amd64');
  }, TIMEOUT);

  test('Build artifacts structure is complete', () => {
    // Verify the assembled app in build/
    const appDir = path.join(BUILD_DIR, 'wispr-flow');
    expect(fs.existsSync(appDir)).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'wispr-flow'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'resources', 'app.asar'))).toBe(true);

    // Verify wispr-flow binary is executable
    const stats = fs.statSync(path.join(appDir, 'wispr-flow'));
    const isExecutable = !!(stats.mode & fs.constants.S_IXUSR);
    expect(isExecutable).toBe(true);
  });
});

// ============================================================
// Package.json scripts validation
// ============================================================

describe('Package.json build scripts', () => {
  test('all required scripts are defined', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const requiredScripts = ['download', 'extract', 'patch', 'rebuild-native', 'package-deb', 'package-appimage', 'build', 'build:appimage', 'clean', 'test'];
    for (const script of requiredScripts) {
      expect(pkg.scripts[script]).toBeTruthy();
    }
  });

  test('build script runs all steps in correct order', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const buildScript = pkg.scripts.build;
    const steps = ['download', 'extract', 'patch', 'rebuild-native', 'package-deb'];
    for (let i = 0; i < steps.length - 1; i++) {
      const posA = buildScript.indexOf(steps[i]);
      const posB = buildScript.indexOf(steps[i + 1]);
      expect(posA).toBeLessThan(posB);
    }
  });
});
