<p align="center">
  <img src="https://cdn.prod.website-files.com/682f84b3838c89f8ff7667db/683b9b328bdb48594a3514e5_Flow%20New.svg" alt="Wispr Flow" width="160" />
</p>

<h1 align="center">Wispr Flow for Linux</h1>

<p align="center">
  Unofficial Linux repackage of <a href="https://wisprflow.ai">Wispr Flow</a> — the AI-powered voice typing app.<br/>
  Works on both <b>X11</b> and <b>Wayland</b>.
</p>

<p align="center">
  <a href="https://github.com/IliyaBrook/whisper-flow-linux/releases/latest"><img src="https://img.shields.io/github/v/release/IliyaBrook/whisper-flow-linux?style=for-the-badge&label=Release&color=blue" alt="Release" /></a>
  &nbsp;
  <img src="https://img.shields.io/badge/Platform-Linux%20x86__64-orange?style=for-the-badge&logo=linux&logoColor=white" alt="Platform" />
  &nbsp;
  <img src="https://img.shields.io/badge/Display-X11%20%7C%20Wayland-green?style=for-the-badge" alt="Display Server" />
  &nbsp;
  <a href="https://github.com/IliyaBrook/whisper-flow-linux/blob/main/LICENSE"><img src="https://img.shields.io/github/license/IliyaBrook/whisper-flow-linux?style=for-the-badge" alt="License" /></a>
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
- **yarn** package manager, enabled with `corepack enable`
- **Build tools**: `make`, `git`
- **For `.deb` builds**: `dpkg` (`dpkg-deb`)

Enable Yarn via Corepack before installing dependencies:

```bash
corepack enable
```

Install base build tools and the `.deb` packager:

**Debian / Ubuntu**
```bash
sudo apt install make git dpkg
```

**Fedora / RHEL**
```bash
sudo dnf install make git dpkg
```

Required runtime dependencies for the packaged app:

**Debian / Ubuntu**
```bash
sudo apt install libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libsecret-1-0 xinput xdotool xclip
```

**Fedora / RHEL**
```bash
sudo dnf install gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libsecret xinput xdotool xclip
```

**Required on Wayland sessions** (including the default XWayland mode):

```bash
# Debian / Ubuntu
sudo apt install ydotool

# Fedora / RHEL
sudo dnf install ydotool
```

On Wayland, `ydotool` is used for input simulation instead of `xdotool` to avoid compositor permission dialogs (e.g. KDE Plasma's "Remote Control" prompt). You also need to add your user to the `input` group for `ydotool` and global hotkeys to work:

```bash
sudo usermod -aG input $USER
# Log out and back in (or reboot) for the group change to take effect
```

Optional native Wayland helper tools (when using `WISPR_USE_WAYLAND=1`):

**Debian / Ubuntu**
```bash
sudo apt install wl-clipboard
```

**Fedora / RHEL**
```bash
sudo dnf install wl-clipboard
```

#### Build Steps

```bash
# Clone the repository
git clone https://github.com/IliyaBrook/whisper-flow-linux.git
cd whisper-flow-linux

# Enable Yarn via Corepack
corepack enable

# Install project dependencies
yarn install

# Download the official Wispr Flow Windows build
yarn download

# Build AppImage
make build-appimage

# Or build .deb package
make build
```

`make build` requires `dpkg-deb` to be installed. If you do not want to install `dpkg`, use `make build-appimage` instead.

`make build-appimage` now checks the runtime dependencies required to actually run Wispr Flow and stops early with the correct `apt` or `dnf` install command if they are missing. Native Wayland helper tools are checked only when `WISPR_USE_WAYLAND=1`.

#### Install .deb Package

```bash
make install
```

`make install` automatically installs the required runtime dependencies on Debian/Ubuntu before running `dpkg -i`.

On Fedora/RHEL, `make install` installs the runtime dependencies and then points you to the AppImage artifact, which is the supported runtime format there.

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
