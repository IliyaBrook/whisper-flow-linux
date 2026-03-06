// Frame fix wrapper for Wispr Flow on Linux
// Intercepts BrowserWindow creation to force native window frames
// and fix keyboard/focus issues. Loaded before the main app.
const Module = require('module');
const originalRequire = Module.prototype.require;

console.log('[Frame Fix] Wrapper loaded');

Module.prototype.require = function(id) {
	const module = originalRequire.apply(this, arguments);

	if (id === 'electron' || id === 'electron/main') {
		const OriginalBrowserWindow = module.BrowserWindow;
		const OriginalMenu = module.Menu;

		if (OriginalBrowserWindow && !OriginalBrowserWindow.__wispr_patched) {
			module.BrowserWindow = class BrowserWindowWithFrame extends OriginalBrowserWindow {
				constructor(options) {
					options = options || {};

					// Detect overlay/popup windows (status indicator, context menu, scratchpad)
					// These use alwaysOnTop, transparent, or skipTaskbar — keep them frameless
					const isPopup = options.alwaysOnTop
						|| options.transparent
						|| options.skipTaskbar
						|| (options.frame === false && !options.minWidth && !options.width);

					if (process.platform === 'linux' && !isPopup) {
						const originalFrame = options.frame;
						options.frame = true;
						options.autoHideMenuBar = true;
						delete options.titleBarStyle;
						delete options.titleBarOverlay;
						console.log(`[Frame Fix] Window frame: ${originalFrame} -> true (size: ${options.width}x${options.height})`);
					} else if (process.platform === 'linux' && isPopup) {
						console.log(`[Frame Fix] Popup window kept frameless (alwaysOnTop: ${options.alwaysOnTop}, transparent: ${options.transparent})`);
					}

					super(options);

					if (process.platform === 'linux' && !isPopup) {
						this.setMenuBarVisibility(false);
					}
				}
			};

			// Copy static methods and properties
			for (const key of Object.getOwnPropertyNames(OriginalBrowserWindow)) {
				if (key !== 'prototype' && key !== 'length' && key !== 'name') {
					try {
						const descriptor = Object.getOwnPropertyDescriptor(OriginalBrowserWindow, key);
						if (descriptor) {
							Object.defineProperty(module.BrowserWindow, key, descriptor);
						}
					} catch (e) {
						// Ignore non-configurable properties
					}
				}
			}

			module.BrowserWindow.__wispr_patched = true;
			console.log('[Frame Fix] BrowserWindow patched');
		}

		// Hide menu bar when application menu is set
		if (OriginalMenu && !OriginalMenu.__wispr_patched) {
			const originalSetAppMenu = OriginalMenu.setApplicationMenu.bind(OriginalMenu);
			module.Menu.setApplicationMenu = function(menu) {
				originalSetAppMenu(menu);
				if (process.platform === 'linux') {
					for (const win of module.BrowserWindow.getAllWindows()) {
						win.setMenuBarVisibility(false);
					}
				}
			};
			OriginalMenu.__wispr_patched = true;
		}
	}

	return module;
};
