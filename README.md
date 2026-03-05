# Wispr Flow for Linux

Unofficial Linux port of [Wispr Flow](https://wisprflow.ai) — AI-powered voice typing application.

This project downloads the official Windows Electron build, extracts the application code, patches it for Linux compatibility, and repackages it with a native Linux helper process.

## How It Works

1. **Download** — Fetches the official Windows Squirrel installer
2. **Extract** — Extracts the nupkg → Electron app files → app.asar
3. **Patch** — Modifies the webpack bundle for Linux:
   - Replaces Windows Helper path with Linux Helper
   - Removes Windows-specific native modules (win-ca, crypt32)
   - Adjusts process spawning for Linux
4. **Rebuild** — Rebuilds native Node.js modules (sqlite3) for Linux
5. **Package** — Combines with Linux Electron binary into .deb or AppImage

## Linux Helper

The Windows version uses a native C#/.NET helper process for:
- Text paste (clipboard + Ctrl+V simulation)
- Active window detection
- Text field monitoring (accessibility)
- Global keyboard shortcuts
- Selected text extraction

Our Linux Helper (`linux-helper/`) reimplements this using:
- **xdotool** / **ydotool** — Key simulation, window management
- **xclip** / **wl-clipboard** — Clipboard operations
- **AT-SPI2** (via pyatspi2) — Accessibility / text field monitoring
- **X11** / **Wayland** — Display server integration

Supports both X11 and Wayland (GNOME, KDE, Sway, Hyprland).

## Prerequisites

```bash
# Build tools
sudo apt install p7zip-full curl

# Runtime dependencies (X11)
sudo apt install xdotool xclip libgtk-3-0 libnss3 libxss1 libxtst6 libatspi2.0-0

# Runtime dependencies (Wayland)
sudo apt install wl-clipboard ydotool

# For accessibility features
sudo apt install python3-gi gir1.2-atspi-2.0

# For building native modules
sudo apt install build-essential python3 node-gyp
```

## Build

```bash
# Install dependencies
npm install

# Full build (download → extract → patch → rebuild → package .deb)
npm run build

# Or step by step:
npm run download        # Download Windows installer
npm run extract         # Extract app from installer
npm run patch           # Patch for Linux
npm run rebuild-native  # Rebuild sqlite3 for Linux
npm run package-deb     # Create .deb package
npm run package-appimage # Create AppImage (alternative)

# Clean all build artifacts
npm run clean
```

## Install

```bash
# Install .deb
sudo dpkg -i dist/wispr-flow_*.deb
sudo apt-get install -f  # Fix dependencies if needed

# Or run AppImage directly
chmod +x dist/Wispr_Flow-*-x86_64.AppImage
./dist/Wispr_Flow-*-x86_64.AppImage
```

## Run

```bash
wispr-flow
# Or with Wayland:
wispr-flow --ozone-platform-hint=wayland
# Or without sandbox (if chrome-sandbox issues):
wispr-flow --no-sandbox
```

## Architecture

```
wispr-flow-linux/
├── scripts/
│   ├── download.js          # Download Windows installer
│   ├── extract.js           # Extract Electron app
│   ├── patch.js             # Patch for Linux compatibility
│   ├── rebuild-native.js    # Rebuild native modules
│   ├── package-deb.js       # Create .deb package
│   └── package-appimage.js  # Create AppImage
├── linux-helper/
│   ├── main.js              # Helper entry point
│   └── src/
│       ├── ipc.js           # IPC protocol (stdin/fd3, pipe-delimited JSON)
│       ├── handler.js       # Request handler (routes all HelperAPI commands)
│       ├── x11-utils.js     # X11/Wayland: clipboard, paste, focus, keys
│       ├── accessibility.js # AT-SPI2: text fields, context
│       ├── shortcuts.js     # Global keyboard shortcuts
│       └── hardware.js      # Hardware info
├── docs/
│   └── HELPER_IPC_PROTOCOL.md  # Full IPC protocol documentation
├── patches/                 # Additional patches (future)
└── resources/               # Additional resources (future)
```

## IPC Protocol

The Helper communicates with the Electron main process via stdio:
- **stdin** (fd 0): Receives JSON requests from Electron
- **fd 3** (pipe): Sends JSON responses to Electron
- Messages are pipe-delimited (`|`) with `+` escaping

See [docs/HELPER_IPC_PROTOCOL.md](docs/HELPER_IPC_PROTOCOL.md) for the full protocol specification.

## Known Limitations

- Windows Helper features that depend on Windows UI Automation may have reduced functionality on Linux
- Wayland support varies by compositor (best on GNOME, KDE, Sway, Hyprland)
- Some Electron features may require `--no-sandbox` flag
- Audio input relies on PulseAudio/PipeWire (usually works out of the box)

## License

This project provides build tooling for running Wispr Flow on Linux. Wispr Flow itself is proprietary software by Wispr AI. Please respect their terms of service.
