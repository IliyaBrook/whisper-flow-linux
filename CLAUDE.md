# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Unofficial Linux port of Wispr Flow (AI voice typing app). The project extracts the official Windows Electron build, patches it for Linux compatibility, and repackages it with a native Linux helper process. Wispr Flow itself is proprietary — this repo only provides the repackaging tooling and Linux-native helper.

## Build Commands

```bash
yarn install              # Install dependencies
yarn build                # Full pipeline: download → extract → patch → rebuild → package .deb
yarn build:appimage       # Same but produces AppImage instead of .deb
yarn test                 # Run all tests (Jest)
yarn test -- --testPathPattern=ipc  # Run a single test file
yarn clean                # Remove build/, dist/, tmp/

# Individual build steps:
yarn download             # Download Windows installer to tmp/
yarn extract              # Extract Electron app from installer
yarn patch                # Patch webpack bundle for Linux
yarn rebuild-native       # Rebuild sqlite3 for Linux
yarn package-deb          # Create .deb package
yarn package-appimage     # Create AppImage
```

Makefile wraps the same commands: `make build`, `make test`, `make install`, `make run`, `make run-debug`.

## Architecture

The project has two main parts:

### 1. Build Scripts (`scripts/`)

Sequential pipeline that transforms Windows Electron app into Linux app:

- `download.js` — Fetches Windows Squirrel installer (.exe) to `tmp/`
- `extract.js` — Extracts nupkg → Electron files → unpacks app.asar to `tmp/app/asar-content/`
- `patch.js` — **Core patching logic**. Modifies the minified webpack bundle (`tmp/app/asar-content/.webpack/main/index.js`) with regex-based patches:
  - Adds Linux branch for helper process path (points to `linux-helper/main.js`)
  - Changes spawn call to use `process.execPath` (node) for .js helper on Linux
  - No-ops Windows native modules (crypt32, win-ca, mac-ca)
  - Disables electron-squirrel-startup
- `rebuild-native.js` — Rebuilds native Node modules (sqlite3) for Linux
- `package-deb.js` / `package-appimage.js` — Final packaging

### 2. Linux Helper (`linux-helper/`)

Node.js process that replaces the Windows C#/.NET helper. Communicates with Electron main process via custom IPC protocol (stdin/fd3, pipe-delimited escaped JSON).

- `main.js` — Entry point, tool detection, signal handling
- `src/ipc.js` — IPC protocol: message encoding/decoding, stdin reading, fd3 writing
- `src/handler.js` — Routes all HelperAPI commands (PasteText, GetAppInfo, GetTextBoxInfo, etc.)
- `src/x11-utils.js` — X11/Wayland abstraction: clipboard (xclip/wl-clipboard), paste (xdotool/ydotool), window focus
- `src/accessibility.js` — AT-SPI2 text field monitoring
- `src/shortcuts.js` — Global keyboard shortcut registration
- `src/hardware.js` — Hardware info from /proc

Full IPC protocol spec: `docs/HELPER_IPC_PROTOCOL.md`

### Key Directories

- `tmp/` — Build artifacts (downloaded installer, extracted app). Gitignored.
- `tmp/app/asar-content/` — Unpacked Electron app, where patching happens
- `dist/` — Final .deb/.AppImage output. Gitignored.
- `tests/` — Jest tests for the Linux helper components

## Important Patterns

- **Patching is regex-based** against minified webpack. Patterns in `patch.js` are fragile and tied to the specific Wispr Flow version. When updating, verify patterns still match.
- **IPC message format**: JSON encoded with `+`/`|` escaping, pipe-delimited. See `src/ipc.js` and `docs/HELPER_IPC_PROTOCOL.md`.
- **Display server detection**: Helper auto-detects X11 vs Wayland and uses appropriate tools. Both paths must be maintained.
- **Package manager**: yarn (not npm).

## Runtime Dependencies

X11: xdotool, xclip, libgtk-3, libnss3, libxss1, libxtst6, libatspi2.0-0
Wayland: wl-clipboard, ydotool
Accessibility: python3-gi, gir1.2-atspi-2.0
