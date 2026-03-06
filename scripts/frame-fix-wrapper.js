// Frame fix wrapper for Wispr Flow on Linux
// Intercepts BrowserWindow creation to force native window frames
// and fix keyboard/focus issues. Loaded before the main app.
const Module = require('module');
const originalRequire = Module.prototype.require;

console.log('[Frame Fix] Wrapper loaded');

// Detect overlay/popup windows that should stay frameless.
// Wispr Flow window types (from debug logs):
//   440x300  alwaysOnTop, transparent, skipTaskbar, type:"toolbar" → recording indicator
//   1281x720 alwaysOnTop, transparent, skipTaskbar, type:"toolbar" → scratchpad/transcript
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

// Build the patched BrowserWindow class and Menu interceptor once,
// on first require('electron'), then reuse via Proxy on every access.
let PatchedBrowserWindow = null;
let patchedSetApplicationMenu = null;

Module.prototype.require = function(id) {
	const result = originalRequire.apply(this, arguments);

	if (id === 'electron' || id === 'electron/main') {
		// Build patches once from the real electron module
		if (!PatchedBrowserWindow) {
			const OriginalBrowserWindow = result.BrowserWindow;
			const OriginalMenu = result.Menu;

			PatchedBrowserWindow = class BrowserWindowWithFrame extends OriginalBrowserWindow {
				constructor(options) {
					options = options || {};
					let isOverlay = false;

					if (process.platform === 'linux') {
						// Log options for debugging
						const debugOpts = {
							width: options.width, height: options.height,
							minWidth: options.minWidth, minHeight: options.minHeight,
							frame: options.frame, transparent: options.transparent,
							alwaysOnTop: options.alwaysOnTop, skipTaskbar: options.skipTaskbar,
							focusable: options.focusable, titleBarStyle: options.titleBarStyle,
							titleBarOverlay: options.titleBarOverlay, type: options.type,
							resizable: options.resizable, show: options.show,
						};
						console.log('[Frame Fix] BrowserWindow options:', JSON.stringify(debugOpts));

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
							// Remove type:"toolbar" override (if any) — it makes windows unmanaged by KWin
							if (options.type) {
								delete options.type;
							}
							console.log(`[Frame Fix] MAIN window: frame=${orig.frame}->true, transparent=${orig.transparent}->false, focusable=${orig.focusable}->${options.focusable} (${options.width}x${options.height})`);
						} else {
							console.log(`[Frame Fix] OVERLAY window kept as-is (${options.width}x${options.height}, type=${options.type}, alwaysOnTop=${options.alwaysOnTop})`);
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

						if (!isOverlay) {
							// Hide menu bar after window creation
							this.setMenuBarVisibility(false);

							// Ensure menu bar stays hidden on show events
							this.on('show', () => {
								this.setMenuBarVisibility(false);
							});

							// Patch getContentBounds() to bypass Chromium's stale layout cache.
							// Tiling WMs (KWin corner-snap, Sway) don't set _NET_WM_STATE atoms
							// so the cache never invalidates. getSize() always reflects reality.
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

							// Re-emit resize on state transitions so layout updates
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

							// One-time layout jiggle + frame overhead calibration
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

							// KDE Plasma: clear flash-frame on focus
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
					} catch (e) {
						// Ignore errors for non-configurable properties
					}
				}
			}

			// Intercept Menu.setApplicationMenu to hide menu bar on Linux
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

			console.log('[Frame Fix] Patches built successfully');
		}

		// Return a Proxy that intercepts property access on the electron module.
		// Electron's exports use non-configurable getters, so Proxy is needed.
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
