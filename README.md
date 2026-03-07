<p align="center">
  <img src="https://cdn.prod.website-files.com/682f84b3838c89f8ff7667db/683b9b328bdb48594a3514e5_Flow%20New.svg" alt="Wispr Flow" width="160" />
</p>

<h1 align="center">Wispr Flow for Linux</h1>

<p align="center">
  Unofficial Linux repackage of <a href="https://wisprflow.ai">Wispr Flow</a> — the AI-powered voice typing app.<br/>
  Works on both <b>X11</b> and <b>Wayland</b>.
</p>

<p align="center">
  <a href="https://github.com/IliyaBrook/whisper-flow-linux/releases"><img src="https://img.shields.io/github/v/release/IliyaBrook/whisper-flow-linux?style=flat-square&label=Download" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platform-Linux%20x86__64-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/display-X11%20%7C%20Wayland-green?style=flat-square" alt="Display Server" />
  <img src="https://img.shields.io/github/license/IliyaBrook/whisper-flow-linux?style=flat-square" alt="License" />
</p>

---

## About

[Wispr Flow](https://wisprflow.ai) is a fantastic AI voice typing application that supports Android, iOS, macOS, and Windows — but not Linux.

After a long search for a similar solution on Linux and being disappointed that no official Linux support exists, I decided to take matters into my own hands. Having prior experience with repackaging Electron-based applications, I built this project to bring Wispr Flow to Linux.

This project takes the official Windows Electron build of Wispr Flow, extracts it, patches it for Linux compatibility, and repackages it with a custom native Linux helper process. The result is a fully functional Linux build that has been tested on both **X11** and **Wayland** desktop environments.

> **Note:** Wispr Flow itself is proprietary software by [Wispr AI](https://wisprflow.ai). This repository only contains the repackaging tooling and the Linux-native helper — not the application source code.

## Features

- **Full Wispr Flow experience on Linux** — voice-to-text dictation powered by Wispr AI
- **X11 & Wayland support** — automatically detects your display server and uses the appropriate tools (`xdotool`/`xclip` for X11, `ydotool`/`wl-clipboard` for Wayland)
- **Overlay position customization** — right-click the tray icon and select **"Overlay Position"** to reposition the status overlay anywhere on your screen. The setting is saved persistently across sessions.
- **System tray integration** — left-click or right-click the tray icon for quick access to all controls
- **AppImage & .deb packaging** — choose your preferred installation method

## Installation

### Option 1: Download AppImage (Recommended)

1. Go to the [Releases](https://github.com/IliyaBrook/whisper-flow-linux/releases) page
2. Download the latest `.AppImage` file
3. Make it executable and run:

```bash
chmod +x Wispr_Flow-*-x86_64.AppImage
./Wispr_Flow-*-x86_64.AppImage
```

### Option 2: Build from Source

#### Prerequisites

- **Node.js** (v18+)
- **yarn** package manager
- **Build tools**: `make`, `git`

**Runtime dependencies (X11):**
```bash
sudo apt install xdotool xclip libgtk-3-0 libnss3 libxss1 libxtst6 libatspi2.0-0
```

**Runtime dependencies (Wayland):**
```bash
sudo apt install wl-clipboard ydotool
```

#### Build Steps

```bash
# Clone the repository
git clone https://github.com/IliyaBrook/whisper-flow-linux.git
cd whisper-flow-linux

# Install project dependencies
yarn install

# Download the official Wispr Flow Windows build
yarn download

# Build AppImage
make build-appimage

# Or build .deb package
make build
```

#### Install .deb Package

```bash
make install
```

#### Run

```bash
# Run the built AppImage
make run

# Run in debug mode
make run-debug
```

### Rebuilding After Code Changes

If you modify any source files (`scripts/` or `linux-helper/`), use the rebuild command which re-extracts, re-patches, and repackages without re-downloading:

```bash
make rebuild
```

## Usage

1. **Launch** the application (AppImage or from the system menu if installed via .deb)
2. **Sign in** to your Wispr Flow account
3. **Use the global shortcut** to start/stop voice dictation
4. **Right-click the tray icon** to access settings, including **Overlay Position** to move the recording status indicator to your preferred location

### Overlay Position

The status overlay shows the recording state while dictating. On Linux, you can customize its position:

1. Right-click the **tray icon** in your system tray
2. Select **"Overlay Position"**
3. Use the arrow buttons to move the overlay in any direction
4. Click **Reset** to return to the default position
5. Your position is saved automatically and persists across restarts

## How It Works

The build pipeline performs the following steps:

1. **Download** — Fetches the official Windows Squirrel installer
2. **Extract** — Unpacks the Electron app from the `.nupkg` inside the installer
3. **Patch** — Applies regex-based patches to the minified webpack bundle:
   - Redirects the helper process to the custom Linux helper
   - No-ops Windows-specific native modules (`crypt32`, `win-ca`, `mac-ca`)
   - Disables Windows auto-updater (`electron-squirrel-startup`)
   - Fixes tray icon behavior for Linux
4. **Rebuild** — Recompiles native Node modules (`sqlite3`) for Linux
5. **Package** — Creates `.deb` or `.AppImage` distribution

The **Linux helper** (`linux-helper/`) is a Node.js process that replaces the Windows-native helper, implementing:
- IPC communication with the Electron main process
- Clipboard and paste operations via system tools
- Global keyboard shortcut registration
- Display server detection (X11/Wayland)
- AT-SPI2 accessibility integration

## License

MIT — see [LICENSE](LICENSE) for details.

The repackaging tooling and Linux helper are open source. Wispr Flow itself is proprietary software by [Wispr AI](https://wisprflow.ai).
