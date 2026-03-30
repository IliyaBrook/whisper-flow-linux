// Frame fix wrapper for Wispr Flow on Linux
// Intercepts BrowserWindow creation to force native window frames
// and fix keyboard/focus issues. Loaded before the main app.
const Module = require('module');
const originalRequire = Module.prototype.require;

// Detect Wayland vs X11 for platform-specific overlay behavior
const _isWayland = (process.env.XDG_SESSION_TYPE === 'wayland') || !!process.env.WAYLAND_DISPLAY;

// --- Dependency check: intercept helper process spawn to read dep-check output ---
if (process.platform === 'linux') {
  const cp = require('child_process');
  const origSpawn = cp.spawn;

  let depDialogShown = false;

  cp.spawn = function patchedSpawn(...args) {
    const child = origSpawn.apply(this, args);

    // Detect the linux-helper process by checking args for linux-helper/main.js
    const spawnArgs = args[1] || [];
    const isHelper = (typeof args[0] === 'string' && args[0].includes && args[0].includes('linux-helper')) ||
      (Array.isArray(spawnArgs) && spawnArgs.some(a => typeof a === 'string' && a.includes('linux-helper')));

    if (isHelper && child.stdout) {
      let buffer = '';
      const missingLines = [];
      const warningLines = [];
      let installCmd = '';
      let sessionType = '';
      const fixCommandLines = [];

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);

          if (line.includes('[dep-check] Session:')) {
            const m = line.match(/Session:\s*(\w+)/);
            if (m) sessionType = m[1];
          }
          if (line.includes('[dep-check]   -')) {
            const toolMatch = line.match(/- (\S+): (.+)/);
            if (toolMatch) missingLines.push(`${toolMatch[1]} — ${toolMatch[2]}`);
          }
          if (line.includes('[dep-check] Install with:')) {
            installCmd = line.replace(/.*Install with:\s*/, '');
          }
          if (line.includes('[dep-check] WARNING:')) {
            warningLines.push(line.replace(/.*WARNING:\s*/, ''));
          }
          if (line.includes('[dep-check] Fix command:')) {
            fixCommandLines.push(line.replace(/.*Fix command:\s*/, ''));
          }
        }
      });

      // After helper has had time to start and report, show dialog if needed
      setTimeout(() => {
        if (depDialogShown) return;
        if (missingLines.length === 0 && warningLines.length === 0) return;
        depDialogShown = true;

        try {
          const electron = require('electron');
          const { app, dialog } = electron;

          const showDepDialog = () => {
            const isCritical = missingLines.length > 0;
            const message = isCritical
              ? 'Wispr Flow is missing required dependencies for your system.'
              : 'Wispr Flow detected potential configuration issues.';

            // Build all commands to copy (install + fix commands like usermod)
            const allCommands = [];
            if (installCmd) allCommands.push(installCmd);
            for (const cmd of fixCommandLines) allCommands.push(cmd);

            let detail = '';
            if (sessionType) {
              detail += `Display server: ${sessionType}\n\n`;
            }

            if (missingLines.length > 0) {
              detail += 'Missing packages:\n';
              for (const l of missingLines) detail += `  \u2022 ${l}\n`;
              detail += '\n';
            }

            if (warningLines.length > 0) {
              detail += 'Warnings:\n';
              for (const w of warningLines) {
                // Clean up multi-line warnings for dialog display
                detail += `  \u2022 ${w.replace(/\\n/g, '\n    ')}\n`;
              }
              detail += '\n';
            }

            if (allCommands.length > 0) {
              detail += 'Run these commands to fix:\n';
              for (const cmd of allCommands) detail += `  ${cmd}\n`;
            }

            detail += '\nText insertion and other features may not work without these fixes.';

            const copyText = allCommands.join(' && ');

            dialog.showMessageBox({
              type: isCritical ? 'error' : 'warning',
              title: 'Wispr Flow \u2014 Missing Dependencies',
              message,
              detail,
              buttons: allCommands.length > 0 ? ['Copy Fix Commands', 'OK'] : ['OK'],
              defaultId: 0,
              noLink: true,
            }).then((result) => {
              if (allCommands.length > 0 && result.response === 0) {
                electron.clipboard.writeText(copyText);
              }
            }).catch(() => {});
          };

          if (app.isReady()) {
            showDepDialog();
          } else {
            app.whenReady().then(showDepDialog);
          }
        } catch (e) {
          console.error('[dep-check] Failed to show dialog:', e.message);
        }
      }, 3000);
    }

    return child;
  };
}

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

			// --- Overlay position offset (shared state) ---
			let overlayOffsetX = 0;
			let overlayOffsetY = 0;
			let overlayConfigPath = null;
			const activeOverlays = [];
			let contextMenuWin = null;
			let positionWindow = null;

			function loadOverlayConfig() {
				if (overlayConfigPath !== null) return;
				try {
					const path = require('path');
					const fs = require('fs');
					overlayConfigPath = path.join(
						result.app.getPath('userData'),
						'linux-overlay-position.json'
					);
					const data = JSON.parse(fs.readFileSync(overlayConfigPath, 'utf8'));
					if (typeof data.offsetX === 'number') overlayOffsetX = data.offsetX;
					if (typeof data.offsetY === 'number') overlayOffsetY = data.offsetY;
				} catch {
					if (!overlayConfigPath) {
						try {
							overlayConfigPath = require('path').join(
								result.app.getPath('userData'),
								'linux-overlay-position.json'
							);
						} catch { /* ignore */ }
					}
				}
			}

			function saveOverlayConfig() {
				if (!overlayConfigPath) return;
				try {
					const fs = require('fs');
					const path = require('path');
					fs.mkdirSync(path.dirname(overlayConfigPath), { recursive: true });
					fs.writeFileSync(
						overlayConfigPath,
						JSON.stringify({ offsetX: overlayOffsetX, offsetY: overlayOffsetY }),
						'utf8'
					);
				} catch { /* ignore */ }
			}

			// --- Main window position persistence ---
			let mainWindowBoundsPath = null;

			function loadMainWindowBounds() {
				try {
					const path = require('path');
					const fs = require('fs');
					mainWindowBoundsPath = path.join(
						result.app.getPath('userData'),
						'linux-window-bounds.json'
					);
					const data = JSON.parse(fs.readFileSync(mainWindowBoundsPath, 'utf8'));
					if (typeof data.x === 'number' && typeof data.y === 'number' &&
						typeof data.width === 'number' && typeof data.height === 'number') {
						return data;
					}
				} catch {
					if (!mainWindowBoundsPath) {
						try {
							mainWindowBoundsPath = require('path').join(
								result.app.getPath('userData'),
								'linux-window-bounds.json'
							);
						} catch { /* ignore */ }
					}
				}
				return null;
			}

			function saveMainWindowBounds(bounds) {
				if (!mainWindowBoundsPath) return;
				try {
					const fs = require('fs');
					fs.writeFileSync(
						mainWindowBoundsPath,
						JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
						'utf8'
					);
				} catch { /* ignore */ }
			}

			function moveAllOverlays(dx, dy) {
				overlayOffsetX += dx;
				overlayOffsetY += dy;
				saveOverlayConfig();
				for (const o of activeOverlays) o.applyOffset();
			}

			function openOverlayPositionWindow() {
				if (positionWindow && !positionWindow.isDestroyed()) {
					positionWindow.focus();
					return;
				}
				positionWindow = new OriginalBrowserWindow({
					width: 250, height: 230,
					resizable: false, minimizable: false, maximizable: false,
					alwaysOnTop: true, title: 'Overlay Position',
					autoHideMenuBar: true,
					webPreferences: { sandbox: true }
				});
				positionWindow.setMenuBarVisibility(false);
				positionWindow.loadURL('about:blank');

				const updateDisplay = () => {
					if (positionWindow && !positionWindow.isDestroyed()) {
						positionWindow.webContents.executeJavaScript(
							`u(${overlayOffsetX},${overlayOffsetY})`
						).catch(() => {});
					}
				};

				positionWindow.webContents.on('did-finish-load', () => {
					positionWindow.webContents.executeJavaScript(`
						document.documentElement.innerHTML = '<head><style>' +
						'*{margin:0;padding:0;box-sizing:border-box}' +
						'body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;' +
						'align-items:center;justify-content:center;height:100vh;background:#1e1e1e;color:#ddd;user-select:none}' +
						'.info{font-size:13px;color:#aaa;margin-bottom:12px}.info b{color:#fff}' +
						'.grid{display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,40px);gap:4px}' +
						'button{border:1px solid #444;background:#333;color:#eee;border-radius:5px;cursor:pointer;' +
						'font-size:18px;display:flex;align-items:center;justify-content:center}' +
						'button:hover{background:#444}button:active{background:#555}' +
						'.e{border:none;background:none;cursor:default}' +
						'.rst{margin-top:14px;padding:6px 24px;font-size:12px;border-radius:4px}' +
						'</style></head><body>' +
						'<div class="info">X = <b id="ox">0</b> &nbsp; Y = <b id="oy">0</b></div>' +
						'<div class="grid">' +
						'<div class="e"></div><button onclick="m(0,-20)">\u25B2</button><div class="e"></div>' +
						'<button onclick="m(-50,0)">\u25C0</button><button onclick="r()" style="font-size:11px">\u27F2</button><button onclick="m(50,0)">\u25B6</button>' +
						'<div class="e"></div><button onclick="m(0,20)">\u25BC</button><div class="e"></div>' +
						'</div>' +
						'<button class="rst" onclick="r()">Reset</button></body>';
						function u(x,y){document.getElementById('ox').textContent=x;document.getElementById('oy').textContent=y}
						function m(dx,dy){console.log('OVL:move:'+dx+':'+dy)}
						function r(){console.log('OVL:reset')}
						u(${overlayOffsetX},${overlayOffsetY});
					`);
				});

				positionWindow.webContents.on('console-message', (_e, _level, msg) => {
					if (!msg.startsWith('OVL:')) return;
					const p = msg.split(':');
					if (p[1] === 'move') {
						moveAllOverlays(parseInt(p[2]) || 0, parseInt(p[3]) || 0);
					} else if (p[1] === 'reset') {
						overlayOffsetX = 0; overlayOffsetY = 0;
						saveOverlayConfig();
						for (const o of activeOverlays) o.applyOffset();
					}
					updateDisplay();
				});

				positionWindow.on('closed', () => { positionWindow = null; });
			}

			PatchedBrowserWindow = class BrowserWindowWithFrame extends OriginalBrowserWindow {
				constructor(options) {
					options = options || {};
					let isOverlay = false;
					const origTransparent = !!(options && options.transparent);

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
							// Remove type:"toolbar" \u2014 it binds the window to its parent.
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
							const { screen: screenModule } = require('electron');
							const { execFile } = require('child_process');
							const debug = process.env.WISPR_DEBUG === '1';
							const win = this;

							// Ensure DevTools opens for overlay (dom-ready may not
							// fire reliably for overlay windows loaded via app code)
							if (debug) {
								win.webContents.on('did-finish-load', () => {
									if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) {
										win.webContents.openDevTools({ mode: 'detach' });
									}
								});
							}

							// Save all original methods before any patching
							const origSetIgnore = this.setIgnoreMouseEvents.bind(this);
							const origSetBounds = this.setBounds.bind(this);
							const origSetPos = this.setPosition.bind(this);
							const origGetBounds = this.getBounds.bind(this);
							const origGetPos = this.getPosition.bind(this);

							// --- Mouse event forwarding emulation ---
							// {forward: true} is macOS-only. Poll cursor and keep click-through
							// enabled unless we are over visible/interactive overlay pixels.
							let ignoring = false;
							let polling = false;
							let missCount = 0;

							this.setIgnoreMouseEvents = (ignore, _opts) => {
								if (_isWayland) {
									// On Wayland, never set click-through mode.
									// Wayland doesn't support global cursor position queries
									// (getCursorScreenPoint returns 0,0; xdotool unavailable),
									// so our polling system can't detect when to re-enable
									// mouse events. Keep overlay always interactive instead;
									// CSS hover works natively without polling.
									origSetIgnore(false);
									ignoring = false;
									return;
								}
								origSetIgnore(ignore);
								ignoring = ignore;
								if (ignore) startPolling();
							};

							const toDipPoint = (point) => {
								if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
									return screenModule.getCursorScreenPoint();
								}
								if (typeof screenModule.screenToDipPoint === 'function') {
									try {
										return screenModule.screenToDipPoint(point);
									} catch { /* fallback below */ }
								}
								return point;
							};

							const getMousePos = () => new Promise((resolve) => {
								execFile('xdotool', ['getmouselocation', '--shell'],
									{ timeout: 500 },
									(err, stdout) => {
										if (!err && stdout) {
											const mx = parseInt((stdout.match(/X=(\d+)/) || [])[1], 10);
											const my = parseInt((stdout.match(/Y=(\d+)/) || [])[1], 10);
											if (!isNaN(mx) && !isNaN(my)) {
												return resolve(toDipPoint({ x: mx, y: my }));
											}
										}
										resolve(screenModule.getCursorScreenPoint());
									}
								);
							});

							const domHitTest = (x, y) => win.webContents.executeJavaScript(
								`(() => {
									const els = document.elementsFromPoint ? document.elementsFromPoint(${x}, ${y}) : [];
									const list = els && els.length ? els : [document.elementFromPoint(${x}, ${y})].filter(Boolean);
									for (const e of list) {
										if (!e || e === document.documentElement || e === document.body) continue;
										const cs = getComputedStyle(e);
										if (!cs || cs.pointerEvents === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || '1') === 0) continue;
										if (e.closest('[data-testid],[data-indicator-state],button,[role="button"],[aria-label],a,input,textarea,select')) return true;
										const r = e.getBoundingClientRect();
										if (r.width < 2 || r.height < 2) continue;
										const full = r.width >= (window.innerWidth * 0.9) && r.height >= (window.innerHeight * 0.9);
										const painted = (
											cs.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
											cs.backgroundColor !== 'transparent'
										) || (
											cs.borderTopWidth !== '0px' ||
											cs.borderRightWidth !== '0px' ||
											cs.borderBottomWidth !== '0px' ||
											cs.borderLeftWidth !== '0px'
										) || (cs.boxShadow && cs.boxShadow !== 'none');
										if (!full && painted) return true;
									}
									return false;
								})()`
							);

							async function pollTick() {
								if (win.isDestroyed()) { polling = false; return; }
								try {
									if (win.isVisible()) {
										const cursor = ignoring ? await getMousePos() : screenModule.getCursorScreenPoint();
										const b = origGetBounds();
										const inside = cursor.x >= b.x && cursor.x < b.x + b.width &&
											cursor.y >= b.y && cursor.y < b.y + b.height;

										if (inside) {
											const relX = Math.max(0, Math.min(cursor.x - b.x, b.width - 1));
											const relY = Math.max(0, Math.min(cursor.y - b.y, b.height - 1));

											let isHit = false;
											try {
												const img = await win.webContents.capturePage({ x: relX, y: relY, width: 1, height: 1 });
												const bmp = img.toBitmap();
												if (bmp.length >= 4 && bmp[3] > 10) {
													isHit = true;
													if (debug) console.log(`[Overlay] capturePage hit (${relX},${relY}) a=${bmp[3]}`);
												}
											} catch { /* capturePage failed */ }

											if (!isHit && !win.isDestroyed()) {
												try {
													isHit = await domHitTest(relX, relY);
													if (isHit && debug) console.log(`[Overlay] DOM hit (${relX},${relY})`);
												} catch { /* ignore */ }
											}

											if (!win.isDestroyed() && ignoring && isHit) {
												if (debug) console.log('[Overlay] making interactive');
												origSetIgnore(false);
												ignoring = false;
												missCount = 0;
												if (!_isWayland) {
													win.moveTop();
													execFile('xdotool', ['mousemove_relative', '--', '1', '0'], { timeout: 500 }, () => {
														execFile('xdotool', ['mousemove_relative', '--', '-1', '0'], { timeout: 500 }, () => {});
													});
												}
											} else if (!win.isDestroyed() && !ignoring) {
												if (!isHit) {
													missCount += 1;
													if (missCount >= 2) {
														if (debug) console.log('[Overlay] transparent area inside bounds - click-through');
														origSetIgnore(true);
														ignoring = true;
														missCount = 0;
													}
												} else {
													missCount = 0;
												}
											}
										} else if (!ignoring) {
											if (debug) console.log('[Overlay] cursor left bounds - click-through');
											origSetIgnore(true);
											ignoring = true;
											missCount = 0;
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

							// --- Wayland: dynamic input shape ---
							// "resting" / "active_popo": tight shape around indicator.
							// "ready" (hover) or any other state: full window shape
							// so all expanded controls are visible and interactive
							// (same as before shape support was added).
							if (_isWayland) {
								const SHAPE_PAD = 8;
								let lastShapeKey = '';

								const setFullShape = () => {
									if (win.isDestroyed()) return;
									const b = origGetBounds();
									try {
										win.setShape([{ x: 0, y: 0, width: b.width, height: b.height }]);
									} catch {}
								};

								win.webContents.on('did-finish-load', () => {
									if (win.isDestroyed()) return;
									win.webContents.executeJavaScript(`
										(() => {
											let _last = '';
											function _check() {
												const ind = document.querySelector('[data-indicator-state]');
												if (!ind) return;
												const state = ind.getAttribute('data-indicator-state');
												if (state === 'resting') {
													const r = ind.getBoundingClientRect();
													if (r.width < 1 || r.height < 1) return;
													const key = 'small:' + Math.floor(r.left) + ':' +
														Math.floor(r.top) + ':' + Math.ceil(r.width) + ':' +
														Math.ceil(r.height);
													if (key !== _last) { _last = key; console.log('OVL:shape:' + key); }
												} else if (state === 'context-menu') {
													if (_last !== 'ctx') { _last = 'ctx'; console.log('OVL:shape:ctx'); }
												} else {
													if (_last !== 'full') { _last = 'full'; console.log('OVL:shape:full'); }
												}
											}
											const _obs = new MutationObserver(() => requestAnimationFrame(_check));
											_obs.observe(document.body, {
												childList: true, subtree: true,
												attributes: true, attributeFilter: ['class','style','data-indicator-state']
											});
											setInterval(_check, 500);
											_check();
										})()
									`).catch(() => {});
								});

								win.webContents.on('console-message', (_e, _level, msg) => {
									if (!msg.startsWith('OVL:shape:') || win.isDestroyed()) return;
									const payload = msg.slice(10);
									if (payload === 'ctx') {
										// context-menu: hide overlay so context menu is
										// fully visible and clickable (Wayland can't
										// reliably re-focus popup windows)
										if (lastShapeKey !== 'ctx') {
											lastShapeKey = 'ctx';
											setFullShape();
											win.hide();
											if (contextMenuWin && !contextMenuWin.isDestroyed()) {
												contextMenuWin.moveTop();
												contextMenuWin.focus();
											}
											if (debug) console.log('[Overlay] hidden for context-menu');
										}
									} else if (payload === 'full') {
										if (lastShapeKey !== 'full') {
											const wasCtx = lastShapeKey === 'ctx';
											lastShapeKey = 'full';
											setFullShape();
											if (wasCtx && !win.isDestroyed()) {
												win.show();
												if (debug) console.log('[Overlay] restored after context-menu');
											}
											if (debug) console.log('[Overlay] shape: full window');
										}
									} else if (payload.startsWith('small:')) {
										const wasCtx = lastShapeKey === 'ctx';
										const p = payload.slice(6).split(':').map(Number);
										if (p.length === 4 && p[2] > 0 && p[3] > 0) {
											const key = payload;
											if (lastShapeKey !== key) {
												lastShapeKey = key;
												if (wasCtx && !win.isDestroyed()) {
													win.show();
													if (debug) console.log('[Overlay] restored after context-menu');
												}
												try {
													win.setShape([{
														x: Math.max(0, p[0] - SHAPE_PAD),
														y: Math.max(0, p[1] - SHAPE_PAD),
														width: p[2] + SHAPE_PAD * 2,
														height: p[3] + SHAPE_PAD * 2
													}]);
												} catch {}
												if (debug) console.log(`[Overlay] shape: ${p[2]}x${p[3]} at ${p[0]},${p[1]}`);
											}
										}
									}
								});
							}

							// --- Overlay position offset ---
							loadOverlayConfig();
							let baseBounds = null;

							const applyOffset = () => {
								if (win.isDestroyed()) return;
								const b = baseBounds || origGetBounds();
								origSetBounds({
									...b,
									x: b.x + overlayOffsetX,
									y: b.y + overlayOffsetY
								});
							};

							// Intercept setBounds/setPosition: store base, apply offset
							this.setBounds = (bounds, animate) => {
								baseBounds = { ...bounds };
								origSetBounds({
									...bounds,
									x: bounds.x + overlayOffsetX,
									y: bounds.y + overlayOffsetY
								}, animate);
							};

							this.setPosition = (x, y, animate) => {
								if (!baseBounds) baseBounds = origGetBounds();
								baseBounds.x = x;
								baseBounds.y = y;
								origSetPos(
									x + overlayOffsetX,
									y + overlayOffsetY,
									animate
								);
							};

							// Return base (pre-offset) position so the app
							// doesn't compound offsets on read\u2192write cycles.
							this.getBounds = () => {
								if (baseBounds) return { ...baseBounds };
								return origGetBounds();
							};

							this.getPosition = () => {
								if (baseBounds) return [baseBounds.x, baseBounds.y];
								return origGetPos();
							};

							// Apply saved offset to initial position, then watch
							// for app/WM-initiated repositioning permanently.
							// On X11, WMs can reposition windows at any time (not just
							// during startup), so we keep the listener active.
							this.once('show', () => {
								if (!baseBounds) baseBounds = origGetBounds();
								if (overlayOffsetX !== 0 || overlayOffsetY !== 0) {
									applyOffset();
								}

								// Permanent move watcher: re-applies offset when
								// app or WM repositions the overlay bypassing our
								// patched setBounds/setPosition interceptors.
								let reapplyGuard = false;
								let reapplyDebounce = null;
								win.on('move', () => {
									if (overlayOffsetX === 0 && overlayOffsetY === 0) return;
									if (reapplyGuard) return;
									if (reapplyDebounce) clearTimeout(reapplyDebounce);
									reapplyDebounce = setTimeout(() => {
										if (win.isDestroyed()) return;
										const actual = origGetBounds();
										const expectedX = baseBounds.x + overlayOffsetX;
										const expectedY = baseBounds.y + overlayOffsetY;
										if (Math.abs(actual.x - expectedX) > 2 || Math.abs(actual.y - expectedY) > 2) {
											// App/WM repositioned the overlay \u2014 adopt new base, re-apply offset
											baseBounds = { x: actual.x, y: actual.y, width: actual.width, height: actual.height };
											reapplyGuard = true;
											applyOffset();
											setTimeout(() => { reapplyGuard = false; }, 300);
										}
									}, 200);
								});
							});

							// Track overlay for bulk repositioning
							const overlayRef = { win, applyOffset };
							activeOverlays.push(overlayRef);

							win.on('closed', () => {
								const idx = activeOverlays.indexOf(overlayRef);
								if (idx >= 0) activeOverlays.splice(idx, 1);
							});
						}

						// --- Wayland: fix transparent popup windows (context menu etc.) ---
						// The context menu is a separate BrowserWindow. On Wayland:
						// 1) setIgnoreMouseEvents({forward:true}) doesn't work → override
						// 2) Menu renders behind overlay → shift up with persistent observer
						// 3) Can't click menu → focus via overlay state detection
						if (_isWayland && !isOverlay && origTransparent) {
							const debug = process.env.WISPR_DEBUG === '1';
							const popupWin = this;
							const origPopupSetIgnore = this.setIgnoreMouseEvents.bind(this);

							if (debug) console.log('[ContextMenu] window created, saving reference');
							contextMenuWin = popupWin;

							this.setIgnoreMouseEvents = (ignore, _opts) => {
								origPopupSetIgnore(false);
							};

							popupWin.setAlwaysOnTop(true, 'pop-up-menu');

							popupWin.on('closed', () => {
								if (contextMenuWin === popupWin) contextMenuWin = null;
							});
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

							// --- Main window position persistence ---
							const savedBounds = loadMainWindowBounds();
							if (savedBounds) {
								const restoreBounds = () => {
									if (this.isDestroyed()) return;
									try {
										const { screen: screenMod } = require('electron');
										const displays = screenMod.getAllDisplays();
										const isVisible = displays.some(d => {
											const b = d.bounds;
											return savedBounds.x < b.x + b.width &&
												savedBounds.x + savedBounds.width > b.x &&
												savedBounds.y < b.y + b.height &&
												savedBounds.y + savedBounds.height > b.y;
										});
										if (isVisible) {
											this.setBounds(savedBounds);
										}
									} catch { /* ignore */ }
								};
								this.once('ready-to-show', () => {
									restoreBounds();
									// Re-apply after frame calibration completes
									setTimeout(() => restoreBounds(), 200);
								});
							}

							let boundsTimer = null;
							const debounceSaveBounds = () => {
								if (boundsTimer) clearTimeout(boundsTimer);
								boundsTimer = setTimeout(() => {
									if (!this.isDestroyed() && !this.isMaximized() && !this.isFullScreen()) {
										saveMainWindowBounds(this.getBounds());
									}
								}, 500);
							};

							this.on('move', debounceSaveBounds);
							this.on('resize', debounceSaveBounds);
							this.on('close', () => {
								if (!this.isMaximized() && !this.isFullScreen()) {
									saveMainWindowBounds(this.getBounds());
								}
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

			// Inject "Overlay Position..." item into the tray context menu
			if (process.platform === 'linux' && result.Tray) {
				const origSetCtxMenu = result.Tray.prototype.setContextMenu;
				result.Tray.prototype.setContextMenu = function(menu) {
					if (menu) {
						const MARKER = 'Overlay Position';
						const hasOurs = menu.items.some(i => i.label === MARKER);
						if (!hasOurs) {
							const { MenuItem } = require('electron');
							menu.append(new MenuItem({ type: 'separator' }));
							menu.append(new MenuItem({
								label: MARKER,
								click: () => openOverlayPositionWindow()
							}));
						}
					}
					return origSetCtxMenu.call(this, menu);
				};
			}

			// --- Linux autostart (Launch at Login) ---
			if (process.platform === 'linux') {
				const _fs = require('fs');
				const _path = require('path');
				const _os = require('os');

				const autostartPath = _path.join(
					process.env.XDG_CONFIG_HOME || _path.join(_os.homedir(), '.config'),
					'autostart', 'wispr-flow.desktop'
				);

				const getExecPath = () => process.env.APPIMAGE || process.execPath;

				result.app.setLoginItemSettings = (settings) => {
					try {
						if (settings.openAtLogin) {
							const content = [
								'[Desktop Entry]',
								'Type=Application',
								'Name=Wispr Flow',
								'Comment=Voice-typing made perfect',
								`Exec="${getExecPath()}" --opened-at-login`,
								'Terminal=false',
								'X-GNOME-Autostart-enabled=true',
								'StartupNotify=false',
								''
							].join('\n');
							_fs.mkdirSync(_path.dirname(autostartPath), { recursive: true });
							_fs.writeFileSync(autostartPath, content);
						} else {
							_fs.unlinkSync(autostartPath);
						}
					} catch (e) { /* ignore */ }
				};

				result.app.getLoginItemSettings = () => ({
					openAtLogin: _fs.existsSync(autostartPath),
					wasOpenedAtLogin: process.argv.includes('--opened-at-login')
				});

				// Update autostart entry path on each launch (handles moved AppImage)
				result.app.whenReady().then(() => {
					try {
						if (_fs.existsSync(autostartPath)) {
							result.app.setLoginItemSettings({ openAtLogin: true });
						}
					} catch (e) { /* ignore */ }
				});
			}
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
