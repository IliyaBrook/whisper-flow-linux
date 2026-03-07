// Frame fix wrapper for Wispr Flow on Linux
// Intercepts BrowserWindow creation to force native window frames
// and fix keyboard/focus issues. Loaded before the main app.
const Module = require('module');
const originalRequire = Module.prototype.require;

// Detect overlay/popup windows that should stay frameless.
// Overlays have type:"toolbar" or alwaysOnTop+skipTaskbar.
// The hub window is the only one WITHOUT these overlay properties.
function isOverlayWindow(options) {
	if (!options) return false;
	if (options.type === 'toolbar') return true;
	if (options.alwaysOnTop && options.skipTaskbar) return true;
	return false;
}

// CSS to fix sidebar scrolling on Linux
const LINUX_SIDEBAR_CSS = `
  .KsLRKbYTWPTkbHC7lssN > .cHx1jPbInzLdZs5bVsGu > .DYfDg1NbrLuoPJVIlR_w {
    overflow-y: auto !important;
  }
`;

// Resolve the Wispr Flow logo for window icon
function getAppIconPath() {
	try {
		const path = require('path');
		const fs = require('fs');
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
						isOverlay = isOverlayWindow(options);
						if (process.env.WISPR_DEBUG === '1') {
							console.log(`[BrowserWindow] ${isOverlay ? 'OVERLAY' : 'MAIN'} w=${options.width} h=${options.height} type=${options.type} alwaysOnTop=${options.alwaysOnTop} transparent=${options.transparent} focusable=${options.focusable} skipTaskbar=${options.skipTaskbar} show=${options.show}`);
						}

						if (!isOverlay) {
							// Main/settings window: force native managed frame
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
						} else {
							// Overlay windows on Linux:
							// Remove type:"toolbar" — it binds the window to its parent.
							// Keep focusable:true so overlay buttons can be clicked.
							if (options.type === 'toolbar') {
								delete options.type;
							}
							if (options.focusable === false) {
								options.focusable = true;
							}
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
							// Linux: emulate {forward: true} for setIgnoreMouseEvents.
							// {forward: true} is macOS-only — on Linux it's silently ignored,
							// so the overlay either blocks everything (if we no-op) or is
							// never interactive (if we strip forward).
							//
							// Fix: poll cursor position via xdotool (Electron's
							// getCursorScreenPoint returns stale values when cursor isn't
							// over an Electron window). When cursor is over non-transparent
							// overlay content (checked via capturePage alpha), make the
							// window interactive. The renderer's existing mouseenter/
							// mouseleave logic then handles toggling back.
							const { screen: screenModule } = require('electron');
							const { execFile } = require('child_process');
							const origSetIgnore = this.setIgnoreMouseEvents.bind(this);
							let ignoring = false;
							let polling = false;
							const debug = process.env.WISPR_DEBUG === '1';
							const win = this;

							this.setIgnoreMouseEvents = (ignore, _opts) => {
								origSetIgnore(ignore);
								ignoring = ignore;
								if (ignore) startPolling();
							};

							// xdotool works reliably on X11 even when no Electron
							// window is under the cursor. Falls back to Electron API.
							const getMousePos = () => new Promise((resolve) => {
								execFile('xdotool', ['getmouselocation', '--shell'],
									{ timeout: 500 },
									(err, stdout) => {
										if (!err && stdout) {
											const mx = parseInt((stdout.match(/X=(\d+)/) || [])[1]);
											const my = parseInt((stdout.match(/Y=(\d+)/) || [])[1]);
											if (!isNaN(mx) && !isNaN(my)) {
												return resolve({ x: mx, y: my });
											}
										}
										resolve(screenModule.getCursorScreenPoint());
									}
								);
							});

							async function pollTick() {
								if (win.isDestroyed()) { polling = false; return; }
								try {
									if (win.isVisible()) {
										let cursor;
										if (ignoring) {
											cursor = await getMousePos();
										} else {
											cursor = screenModule.getCursorScreenPoint();
										}

										const b = win.getBounds();
										const inside = cursor.x >= b.x && cursor.x < b.x + b.width &&
										               cursor.y >= b.y && cursor.y < b.y + b.height;

										if (ignoring && inside) {
											const relX = Math.max(0, Math.min(cursor.x - b.x, b.width - 1));
											const relY = Math.max(0, Math.min(cursor.y - b.y, b.height - 1));
											const img = await win.webContents.capturePage({
												x: relX, y: relY, width: 1, height: 1
											});
											if (!win.isDestroyed() && ignoring) {
												const bmp = img.toBitmap();
												if (bmp.length >= 4 && bmp[3] > 10) {
													if (debug) console.log(`[Overlay] hit (${relX},${relY}) a=${bmp[3]} — interactive`);
													origSetIgnore(false);
													ignoring = false;
												}
											}
										} else if (!ignoring && !inside) {
											if (debug) console.log('[Overlay] cursor left bounds — click-through');
											origSetIgnore(true);
											ignoring = true;
										}
									}
								} catch (e) {
									if (debug) console.log('[Overlay] poll:', e.message);
								}
								if (!win.isDestroyed() && polling) {
									setTimeout(pollTick, ignoring ? 100 : 50);
								} else {
									polling = false;
								}
							}

							function startPolling() {
								if (polling) return;
								polling = true;
								setTimeout(pollTick, 50);
							}

							win.on('closed', () => { polling = false; });
						}

						if (!isOverlay) {
							this.setMenuBarVisibility(false);

							// Set window icon
							const iconPath = getAppIconPath();
							if (iconPath) {
								try {
									const { nativeImage } = require('electron');
									this.setIcon(nativeImage.createFromPath(iconPath));
								} catch (e) { /* ignore */ }
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
