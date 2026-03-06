// Frame fix wrapper for Wispr Flow on Linux
// Intercepts BrowserWindow creation to force native window frames
// and fix keyboard/focus issues. Loaded before the main app.
const Module = require('module');
const originalRequire = Module.prototype.require;

console.log('[Frame Fix] Wrapper loaded');

// Detect overlay/popup windows that should stay frameless.
// Wispr Flow window types (from debug logs):
//   440x300  alwaysOnTop, transparent, skipTaskbar, type:"toolbar" → recording indicator
//   1707x960 alwaysOnTop, transparent, skipTaskbar, type:"toolbar" → scratchpad/transcript
//   1350x850 frame:false, focusable:false                         → hub/settings (MAIN)
//   420x320  minWidth:300, alwaysOnTop, transparent, skipTaskbar   → quick entry popup
//
// Overlays have type:"toolbar" or alwaysOnTop+skipTaskbar.
// The hub window is the only one WITHOUT these overlay properties.
function isOverlayWindow(options) {
	if (!options) return false;
	if (options.type === 'toolbar') return true;
	if (options.alwaysOnTop && options.skipTaskbar) return true;
	return false;
}

// CSS to fix sidebar scrolling on Linux — the sidebar has no overflow
// set, so when the window is shorter than content, it clips.
const LINUX_SIDEBAR_CSS = `
  /* Fix sidebar scroll when window height < content */
  .KsLRKbYTWPTkbHC7lssN > .cHx1jPbInzLdZs5bVsGu > .DYfDg1NbrLuoPJVIlR_w {
    overflow-y: auto !important;
  }
`;

// Resolve the Wispr Flow logo for window icon
function getAppIconPath() {
	try {
		const path = require('path');
		const fs = require('fs');
		// In packaged app, process.resourcesPath = .../resources/
		// The logo is at resources/assets/logos/wispr-logo.png
		const p = path.join(process.resourcesPath || '', 'assets', 'logos', 'wispr-logo.png');
		if (fs.existsSync(p)) return p;
	} catch (e) { /* ignore */ }
	return null;
}

// Build patched classes once, reuse via Proxy.
let PatchedBrowserWindow = null;
let patchedSetApplicationMenu = null;

Module.prototype.require = function(id) {
	const result = originalRequire.apply(this, arguments);

	if (id === 'electron' || id === 'electron/main') {
		if (!PatchedBrowserWindow) {
			const OriginalBrowserWindow = result.BrowserWindow;
			const OriginalMenu = result.Menu;

			PatchedBrowserWindow = class BrowserWindowWithFrame extends OriginalBrowserWindow {
				constructor(options) {
					options = options || {};
					let isOverlay = false;

					if (process.platform === 'linux') {
						const debugOpts = {
							width: options.width, height: options.height,
							minWidth: options.minWidth, frame: options.frame,
							transparent: options.transparent, alwaysOnTop: options.alwaysOnTop,
							skipTaskbar: options.skipTaskbar, focusable: options.focusable,
							type: options.type, resizable: options.resizable,
						};
						console.log('[Frame Fix] BrowserWindow:', JSON.stringify(debugOpts));

						isOverlay = isOverlayWindow(options);

						if (!isOverlay) {
							// Main/settings window: force native managed frame
							const orig = { frame: options.frame, transparent: options.transparent, focusable: options.focusable };
							options.frame = true;
							options.transparent = false;
							options.autoHideMenuBar = true;
							if (options.focusable === false) {
								options.focusable = true;
							}
							delete options.titleBarStyle;
							delete options.titleBarOverlay;
							if (options.type) {
								delete options.type;
							}
							// Fit window to screen (title bar adds ~30px)
							try {
								const { screen } = require('electron');
								const display = screen.getPrimaryDisplay();
								const workArea = display.workAreaSize;
								if (options.height && options.height > workArea.height - 50) {
									options.height = workArea.height - 50;
								}
								if (options.width && options.width > workArea.width - 20) {
									options.width = workArea.width - 20;
								}
							} catch (e) { /* screen not ready */ }
							console.log(`[Frame Fix] MAIN: frame=${orig.frame}->true, focusable=${orig.focusable}->true (${options.width}x${options.height})`);
						} else {
							// Overlay windows on Linux:
							// 1. Remove type:"toolbar" — it binds the window to its parent,
							//    making it only interactive when parent is focused.
							// 2. Keep focusable:true so overlay buttons can be clicked.
							if (options.type === 'toolbar') {
								delete options.type;
							}
							if (options.focusable === false) {
								options.focusable = true;
							}
							console.log(`[Frame Fix] OVERLAY: ${options.width}x${options.height}, alwaysOnTop=${options.alwaysOnTop}`);
						}
					}

					super(options);

					if (process.platform === 'linux') {
						// Open DevTools for ALL windows in debug mode
						if (process.env.WISPR_DEBUG === '1') {
							this.webContents.on('dom-ready', () => {
								this.webContents.openDevTools({ mode: 'detach' });
							});
						}

						if (isOverlay) {
							// Fix setIgnoreMouseEvents on Linux.
							// The app calls setIgnoreMouseEvents(true, {forward: true}) to make
							// transparent areas click-through while forwarding mouse move events.
							// On Linux, {forward: true} is NOT supported (macOS-only).
							// This causes the overlay to be fully click-through with no way
							// for the app to detect mouse enter and toggle it back.
							// Fix: ignore setIgnoreMouseEvents calls entirely so the overlay
							// stays interactive. The transparent areas naturally pass through
							// clicks because the window is transparent.
							this.setIgnoreMouseEvents = (ignore, opts) => {
								// No-op on Linux — let transparency handle click-through
							};
						}

						if (!isOverlay) {
							this.setMenuBarVisibility(false);

							// Set window icon (fixes Safari icon in taskbar/Alt+Tab)
							const iconPath = getAppIconPath();
							if (iconPath) {
								try {
									const { nativeImage } = require('electron');
									this.setIcon(nativeImage.createFromPath(iconPath));
									console.log('[Frame Fix] Window icon set:', iconPath);
								} catch (e) {
									console.log('[Frame Fix] Could not set icon:', e.message);
								}
							}

							// Inject CSS to fix sidebar scrolling
							this.webContents.on('did-finish-load', () => {
								this.webContents.insertCSS(LINUX_SIDEBAR_CSS).catch(() => {});
							});

							this.on('show', () => {
								this.setMenuBarVisibility(false);
							});

							// Patch getContentBounds() for tiling WM compatibility
							let frameW = 0;
							let frameH = 0;
							let calibrated = false;
							const origGetContentBounds = this.getContentBounds.bind(this);

							this.getContentBounds = () => {
								if (calibrated && !this.isDestroyed()) {
									const [w, h] = this.getSize();
									const width = w - frameW;
									const height = h - frameH;
									if (width > 0 && height > 0) {
										return { x: 0, y: 0, width, height };
									}
								}
								return origGetContentBounds();
							};

							const reemitResize = () => {
								if (this.isDestroyed()) return;
								this.emit('resize');
								setTimeout(() => {
									if (!this.isDestroyed()) this.emit('resize');
								}, 16);
							};

							this.on('maximize', reemitResize);
							this.on('unmaximize', reemitResize);
							this.on('enter-full-screen', reemitResize);
							this.on('leave-full-screen', reemitResize);

							this.once('ready-to-show', () => {
								this.setMenuBarVisibility(false);
								const [w, h] = this.getSize();
								this.setSize(w + 1, h + 1);
								setTimeout(() => {
									if (this.isDestroyed()) return;
									this.setSize(w, h);
									setTimeout(() => {
										if (this.isDestroyed()) return;
										const [winW, winH] = this.getSize();
										const cb = origGetContentBounds();
										const fw = winW - cb.width;
										const fh = winH - cb.height;
										if (cb.width > 0 && cb.height > 0 && fw >= 0 && fh >= 0
											&& fw < 200 && fh < 200) {
											frameW = fw;
											frameH = fh;
											calibrated = true;
										}
									}, 100);
								}, 50);
							});

							this.on('focus', () => {
								this.flashFrame(false);
							});

							console.log('[Frame Fix] Main window patches applied');
						}
					}
				}
			};

			// Copy static methods and properties from original
			for (const key of Object.getOwnPropertyNames(OriginalBrowserWindow)) {
				if (key !== 'prototype' && key !== 'length' && key !== 'name') {
					try {
						const descriptor = Object.getOwnPropertyDescriptor(OriginalBrowserWindow, key);
						if (descriptor) {
							Object.defineProperty(PatchedBrowserWindow, key, descriptor);
						}
					} catch (e) { /* ignore non-configurable */ }
				}
			}

			// Intercept Menu.setApplicationMenu to hide menu bar
			const originalSetAppMenu = OriginalMenu.setApplicationMenu.bind(OriginalMenu);
			patchedSetApplicationMenu = function(menu) {
				originalSetAppMenu(menu);
				if (process.platform === 'linux') {
					for (const win of PatchedBrowserWindow.getAllWindows()) {
						if (win.isDestroyed()) continue;
						win.setMenuBarVisibility(false);
					}
				}
			};

			console.log('[Frame Fix] Patches built');
		}

		return new Proxy(result, {
			get(target, prop, receiver) {
				if (prop === 'BrowserWindow') return PatchedBrowserWindow;
				if (prop === 'Menu') {
					const originalMenu = target.Menu;
					return new Proxy(originalMenu, {
						get(menuTarget, menuProp) {
							if (menuProp === 'setApplicationMenu') return patchedSetApplicationMenu;
							return Reflect.get(menuTarget, menuProp);
						}
					});
				}
				return Reflect.get(target, prop, receiver);
			}
		});
	}

	return result;
};
